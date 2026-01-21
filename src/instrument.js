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
const vscode = require('vscode');

const isBun = !!process.versions.bun;
let nodeProfilingIntegration = null;
let profilingError = null;

// Telemetry check: respect user settings
let telemetryEnabled = true;
try {
    // Attempt to check VS Code configuration
    // This may be partially functional even before activation
    const config = vscode.workspace?.getConfiguration?.('stata-workbench');
    if (config) {
        telemetryEnabled = config.get('telemetry.enabled', true);
    }
} catch (_err) {
    // If we can't check, default to enabled to capture startup errors
}

// Pre-flight check: see if we have the binary for this platform/abi
// This prevents "Cannot find module" errors on unsupported environments (like new Electron/Node versions)
let hasProfilingBinary = false;
if (!isBun && telemetryEnabled) {
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

if (telemetryEnabled) {
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
}

// Collector for VS Code Output Logs to attach to Sentry errors
const logBuffer = [];
const MAX_LOG_LINES = 1000;

/**
 * Scrubs a log line of identifiable PII (like absolute file paths)
 * and verbose internal MCP debug noise before storage for Sentry.
 * This ensures that logs attached to Sentry remain anonymous and focused on extension logic.
 * 
 * NOTE: Sentry is also configured to scrub PII data server-side, but this function 
 * provides a critical first line of defense to prevent sensitive local data from 
 * being transmitted at all.
 * 
 * CRITICAL: This function must be updated if new PII-leaking patterns are identified.
 * IT STRIPS:
 * - Local absolute paths (MacOS, Linux, Windows) containing usernames.
 * - Verbose MCP/SDK internal debug messages (Request/Response objects).
 * - Stata code and output blocks (anything between {smcl} tags).
 */
function scrubLogLine(msg) {
    if (!msg) return null;
    let line = (typeof msg === 'string') ? msg : JSON.stringify(msg);

    // 1. Filter out verbose internal MCP/SDK noise (noisy stderr)
    // Examples to remove:
    // [mcp-stata stderr] [mcp.server.lowlevel.server] DEBUG: Received message: <...object at 0x...>
    // INFO: Processing request of type CallToolRequest
    if (
        line.includes('mcp.server.lowlevel.server') ||
        line.includes('Processing request of type CallToolRequest') ||
        line.includes('Dispatching request of type CallToolRequest') ||
        line.includes('RequestResponder object at 0x')
    ) {
        return null;
    }

    // 2. Scrub absolute paths (PII / Identifiable Data)
    // We replace any absolute path that appears to be in a user directory 
    // with <path> to avoid leaking usernames, project names, or directory structures.
    // This covers MacOS (/Users/...), Linux (/home/...), and Windows (C:\Users\...).
    line = line.replace(/(\/Users\/|\/home\/|[a-zA-Z]:\\Users\\)[^ "']+/g, '<path>');

    // 3. Scrub Stata Code & Output (SMCL)
    // Stata output often wraps sensitive code or results in {smcl} blocks.
    // We only scrub content that is explicitly between two {smcl} tags, 
    // preserving any log metadata or extension context that might follow.
    if (line.includes('{smcl}')) {
        line = line.replace(/\{smcl\}[\s\S]*?\{smcl\}/g, '{smcl} <scrubbed stata content> {smcl}');
    }

    // 4. Scrub potential project identifiers from common headers
    // Example: === 2026-01-21... - do "private_project.do" ===
    line = line.replace(/(=== .* — do ")(.*)(" ===)/g, '$1<file>$3');

    return line;
}

global.addLogToSentryBuffer = (msg) => {
    try {
        if (!telemetryEnabled) return;

        const line = scrubLogLine(msg);
        if (!line) return; // Skip filtered/empty lines

        const timestamp = new Date().toISOString();
        logBuffer.push(`[${timestamp}] ${line}`);
        if (logBuffer.length > MAX_LOG_LINES) {
            logBuffer.shift();
        }
    } catch (_err) {
        // Log collector should never crash
    }
};

global.getSentryLogBuffer = () => logBuffer.join('\n');

if (telemetryEnabled) {
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
        // For example, automatic IP address collection on events.
        // Note: Sentry is configured to automatically scrub sensitive PII 
        // from events server-side (e.g., credit cards, passwords).
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

            // 3. Attach extension logs if available
            try {
                const logs = global.getSentryLogBuffer?.();
                if (logs && hint) {
                    hint.attachments = hint.attachments || [];
                    // Check if already attached to avoid duplicates
                    if (!hint.attachments.some(a => a.filename === "stata-workbench.log")) {
                        hint.attachments.push({
                            filename: "stata-workbench.log",
                            data: logs,
                            contentType: "text/plain",
                        });
                    }
                }
            } catch (_err) {
                // Never let log attachment crash beforeSend
            }

            return event;
        },
    });

    if (profilingError) {
        Sentry.captureException(profilingError, {
            tags: { type: "initialization_failure", component: "profiling-node" }
        });
    }
}
