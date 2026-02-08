// Import with `import * as Sentry from "@sentry/node"` if you are using ESM
const Sentry = require("@sentry/node");
const pkg = require("../package.json");

// Buffers the last 100 log lines to attach to Sentry events on failure.
const logBuffer = [];
global.addLogToSentryBuffer = (msg) => {
    if (!msg) return;
    logBuffer.push(msg);
    if (logBuffer.length > 200) logBuffer.shift();
};

Sentry.init({
    dsn: "https://97f5f46047e65ebbf758c0e9e4ffe6c5@o4510744386732032.ingest.de.sentry.io/4510744389550160",
    release: process.env.SENTRY_RELEASE || `v${pkg.version}`,
    environment: process.env.NODE_ENV || "production",

    // Release Health / Session Tracking
    autoSessionTracking: true,

    // Send structured logs to Sentry
    enableLogs: true,
    // Tracing
    tracesSampleRate: 1.0, //  Capture 100% of the transactions
    // Setting this option to true will send default PII data to Sentry.
    // For example, automatic IP address collection on events
    sendDefaultPii: true,
    // Capture stack traces for all messages
    attachStacktrace: true,
    // Maximum number of breadcrumbs to keep
    maxBreadcrumbs: 100,

    // Filter out Stata user errors (not system failures)
    beforeSend(event, hint) {
        // Attach recent logs to the event for better context
        if (logBuffer.length > 0) {
            event.extra = event.extra || {};
            event.extra.extension_logs = logBuffer.join('\n');
        }

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

        if (!isFromOurExtension) {
            return null;
        }

        return event;
    },
});
