// Import with `import * as Sentry from "@sentry/node"` if you are using ESM
const Sentry = require("@sentry/node");
const pkg = require("../package.json");
const path = require("path");

// Set the binary directory for native modules to the current directory (dist/)
// This allows the Sentry profiler to find its platform-specific .node files
// when running from a bundled VS Code extension.
process.env.SENTRY_PROFILER_BINARY_DIR = __dirname;

const isBun = !!process.versions.bun;
let nodeProfilingIntegration;
let profilingError = null;

try {
    const profiling = isBun 
        ? { nodeProfilingIntegration: () => ({ name: 'MockProfiling' }) }
        : require("@sentry/profiling-node");
    nodeProfilingIntegration = profiling.nodeProfilingIntegration;
} catch (e) {
    // If native profiling fails to load (e.g. missing .node file), 
    // we still want the rest of Sentry to work so we can report it.
    profilingError = e;
    console.warn("Sentry profiling integration failed to load:", e);
}

Sentry.init({
    dsn: "https://97f5f46047e65ebbf758c0e9e4ffe6c5@o4510744386732032.ingest.de.sentry.io/4510744389550160",
    release: process.env.SENTRY_RELEASE || `v${pkg.version}`,
    environment: process.env.NODE_ENV || "production",
    integrations: isBun ? [] : (nodeProfilingIntegration ? [nodeProfilingIntegration()] : []),

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
        const error = hint.originalException;
        if (error) {
            const msg = (error.message || String(error)).toLowerCase();
            // Ignore errors with Stata return codes (e.g. r(198);) 
            // These are usually results of user commands, not extension bugs.
            if (/r\(\d+\);/.test(msg) || /\[rc\s+\d+\]/.test(msg)) {
                return null;
            }
            // Ignore SMCL error markers which indicate Stata output slipped into an error message
            if (msg.includes('{err}') || msg.includes('stata error:')) {
                return null;
            }
            // Ignore VS Code shutdown noise or cancellation during host termination
            if (msg.includes('channel has been closed') || msg.includes('canceled: canceled') || msg === 'canceled') {
                return null;
            }
            // Ignore errors occurring during shutdown/disposal (stack trace contains .terminate or .dispose)
            if (error.stack && /\.(terminate|dispose)/.test(error.stack)) {
                return null;
            }
            // Ignore transient network environment changes
            if (msg.includes('err_network_changed')) {
                return null;
            }
            // Ignore socket hang-ups or parties ending the connection (common during shutdown or network loss)
            if (msg.includes('socket has been ended by the other party') || msg.includes('socket hang up') || msg.includes('econnreset')) {
                return null;
            }
        }

        // Global noise filter: only allow events that are clearly related to our extension
        // This stops noise from other extensions sharing the same host (e.g. Copilot, Claude).
        const isFromOurExtension = (event.exception?.values || []).some(ex => {
            const hasOurFrame = ex.stacktrace?.frames?.some(frame => 
                frame.filename && (
                    frame.filename.includes('stata-workbench') || 
                    frame.filename.includes('mcp-stata') ||
                    frame.filename.includes('tmonk')
                )
            );
            if (hasOurFrame) return true;

            const val = (ex.value || "").toLowerCase();
            return val.includes('stata-workbench') || val.includes('tmonk') || val.includes('mcp-stata');
        });

        // Always allow our own initialization failures (e.g. profiling failures)
        const isOurInitFailure = event.tags && event.tags.type === "initialization_failure";

        if (!isFromOurExtension && !isOurInitFailure) {
            return null;
        }

        return event;
    },
});

if (profilingError) {
    Sentry.captureException(profilingError, {
        tags: { type: "initialization_failure", component: "profiling-node" }
    });
}
