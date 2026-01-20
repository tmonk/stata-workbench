const path = require("path");

// Set the binary directory for native modules to the current directory (dist/)
// This allows the Sentry profiler to find its platform-specific .node files
// when running from a bundled VS Code extension.
// IMPORTANT: This must be set BEFORE any @sentry imports, as some Sentry 
// modules might trigger the profiler's top-level loading logic.
process.env.SENTRY_PROFILER_BINARY_DIR = __dirname;

const Sentry = require("@sentry/node");
const pkg = require("../package.json");
const fs = require("fs");

const isBun = !!process.versions.bun;
let nodeProfilingIntegration = null;
let profilingError = null;

// Pre-flight check: see if we have the binary for this platform/abi
// This prevents "Cannot find module" errors on unsupported environments (like new Electron/Node versions)
let hasProfilingBinary = false;
if (!isBun) {
    try {
        const abi = process.versions.modules;
        const arch = process.arch;
        const platform = process.platform;
        // Sentry binaries are named: sentry_cpu_profiler-<platform>-<arch>-<stdlib>-<abi>.node
        // stdlib is only present on Linux (glibc/musl).
        const files = fs.readdirSync(__dirname);
        hasProfilingBinary = files.some(f => 
            f.startsWith('sentry_cpu_profiler-') && 
            f.includes(platform) && 
            f.includes(arch) && 
            f.endsWith(`-${abi}.node`)
        );
    } catch (e) {
        // Ignored
    }
}

try {
    if (isBun) {
        nodeProfilingIntegration = () => ({ name: 'MockProfiling' });
    } else if (hasProfilingBinary) {
        const profiling = require("@sentry/profiling-node");
        nodeProfilingIntegration = profiling.nodeProfilingIntegration;
    } else {
        // Skip loading if binary is missing to avoid noisy errors
        // We'll still report it to Sentry once initialized (below)
        profilingError = new Error(`No Sentry profiling binary found for ABI ${process.versions.modules} (${process.platform}-${process.arch})`);
    }
} catch (e) {
    // If native profiling fails to load (e.g. missing .node file), 
    // we still want the rest of Sentry to work so we can report it.
    profilingError = e;
}

Sentry.init({
    dsn: "https://97f5f46047e65ebbf758c0e9e4ffe6c5@o4510744386732032.ingest.de.sentry.io/4510744389550160",
    release: process.env.SENTRY_RELEASE || `${pkg.name}@${pkg.version}`,
    environment: process.env.NODE_ENV || "production",
    integrations: isBun ? [] : (nodeProfilingIntegration ? [nodeProfilingIntegration()] : []),
    tracePropagationTargets: ["localhost", /^\//, /^\/api\//],

    // Release Health / Session Tracking
    autoSessionTracking: true,

    // Send structured logs to Sentry
    enableLogs: true,
    // Tracing
    tracesSampleRate: 1.0, //  Capture 100% of the transactions
    // Set sampling rate for profiling - this is evaluated only once per SDK.init call
    profileSessionSampleRate: 1.0,
    // Trace lifecycle automatically enables profiling during active traces
    profileLifecycle: 'trace',
    // Setting this option to true will send default PII data to Sentry.
    // For example, automatic IP address collection on events
    sendDefaultPii: true,
    // Capture stack traces for all messages
    attachStacktrace: true,
    // Maximum number of breadcrumbs to keep
    maxBreadcrumbs: 100,

    // Filter out Stata user errors (not system failures)
    beforeSend(event, hint) {
        // Identify the core error message
        const error = hint.originalException;
        const msg = (error?.message || event.message || (event.exception?.values?.[0]?.value) || "").toLowerCase();

        // 1. If it's an exception, ensure it originates from our extension
        if (event.exception && event.exception.values) {
            const isOurExtension = event.exception.values.some(ex => {
                // Check stack frames for our extension identifiers
                const hasOurFrame = ex.stacktrace?.frames?.some(frame => 
                    frame.filename && (
                        frame.filename.includes('stata-workbench') || 
                        frame.filename.includes('mcp-stata') ||
                        frame.filename.includes('tmonk')
                    )
                );
                if (hasOurFrame) return true;

                // If frames are missing or ambiguous (e.g. loader errors), 
                // check if the message identifies our extension.
                const val = (ex.value || "").toLowerCase();
                return val.includes('stata-workbench') || val.includes('tmonk');
            });
            
            // Always allow our own initialization failures (like profiling-node failures)
            const isOurInitFailure = event.tags && event.tags.type === "initialization_failure";

            if (!isOurExtension && !isOurInitFailure) {
                return null;
            }
        }

        if (msg) {
            // Ignore errors with Stata return codes (e.g. r(198);) 
            // These are usually results of user commands, not extension bugs.
            if (/r\(\d+\);/.test(msg) || /\[rc\s+\d+\]/.test(msg)) {
                return null;
            }
            // Ignore SMCL error markers which indicate Stata output slipped into an error message
            if (msg.includes('{err}') || msg.includes('stata error:')) {
                return null;
            }
            // Ignore VS Code "Canceled" errors and internal disposal tracking warnings
            if (msg === 'canceled' || msg.includes('canceled') || msg.includes('leaking disposables')) {
                return null;
            }
            // Ignore internal Cursor/VS Code workbench errors and channel closures
            if (
                msg.includes('_chat.') || 
                msg.includes('channel has been closed') || 
                /command '.*' not found/.test(msg) ||
                msg.includes('extension host terminated')
            ) {
                return null;
            }
            // Ignore common background tools that aren't ours
            if (msg.includes('git') || msg.includes('ripgrep') || msg.includes('rg ')) {
                // If it's a child_process error for git/rg, we don't own it.
                return null;
            }
        }

        // Additional check for subprocess events (from Sentry breadcrumbs or extra context)
        const extra = event.extra;
        if (extra && extra.spawnfile) {
            const spawnfile = String(extra.spawnfile).toLowerCase();
            if (spawnfile.includes('git') || spawnfile.includes('rg') || spawnfile.includes('ripgrep')) {
                return null;
            }
        }

        return event;
    },
});

if (profilingError) {
    Sentry.captureException(profilingError, {
        tags: { type: "initialization_failure", component: "profiling-node" }
    });
}
