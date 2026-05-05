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

// Track if the extension is currently shutting down to suppress cleanup noise.
let isShuttingDown = false;
global.setStataWorkbenchShuttingDown = () => { isShuttingDown = true; };

// Hook into standard process signals to catch shutdowns
['exit', 'SIGINT', 'SIGTERM'].forEach(sig => {
    process.on(sig, () => { isShuttingDown = true; });
});

Sentry.init({
    dsn: "https://97f5f46047e65ebbf758c0e9e4ffe6c5@o4510744386732032.ingest.de.sentry.io/4510744389550160",
    release: process.env.SENTRY_RELEASE || `v${pkg.version}`,
    environment: process.env.NODE_ENV || "production",

    // Release Health / Session Tracking
    autoSessionTracking: true,

    // Send structured logs to Sentry
    enableLogs: true,
    // Tracing
    tracesSampleRate: 0.2, //  Capture 20% of the transactions
    // Do not send PII data to Sentry (IP addresses, etc.)
    sendDefaultPii: false,
    // Capture stack traces for all messages
    attachStacktrace: true,
    // Maximum number of breadcrumbs to keep
    maxBreadcrumbs: 100,

    beforeBreadcrumb(breadcrumb) {
        // Filter out network requests from other extensions
        if (breadcrumb.type === "http" && breadcrumb.data && breadcrumb.data.url) {
            const url = String(breadcrumb.data.url);
            // Allow only our own infrastructure URLS
            const isOurs =
                url.includes("stata-workbench") ||
                url.includes("mcp-stata") ||
                url.includes("tmonk") ||
                url.includes("pypi.org/pypi/mcp-stata") ||
                url.includes("localhost") && (url.includes("get_ui_channel") || url.includes("stata_manage_session") || url.includes("stata"));

            if (!isOurs) return null;
        }
        return breadcrumb;
    },

    // Filter out transactions from other extensions sharing the host
    beforeSendTransaction(event) {
        const name = event.transaction || "";

        // Explicitly exclude known noise from other extensions sharing the process
        // This includes Exa, Cursor internals, AWS Q, CodeGPT, etc.
        const noiseMarkers = [
            "exa.", "ExtensionServerService",
            "kiro.", "agent-event", "AgentExecution", "Steering.",
            "readFile.readFileFromUri", "openTextDocument", "getDiagnostics",
            "QApi.QAPICall", "AsyncToolCallStart", "Graph.",
            "codegpt", "autocomplete", "api/autocomplete",
            "pdf.worker", "pdf.mjs", "viewer.html",
            "envelope", "sentry.io", "notifications.handleAgentEvent"
        ];

        if (noiseMarkers.some(marker => name.includes(marker))) {
            return null;
        }

        // Allowlist of our own transaction patterns
        const isOurTransaction =
            name.startsWith("stata.") ||
            name.includes("stata-workbench") ||
            name.includes("mcp-stata") ||
            name.includes("tmonk") ||
            name.includes("pypi.org/pypi/mcp-stata");

        return isOurTransaction ? event : null;
    },

    // Filter out noise and known non-issues
    beforeSend(event, hint) {
        // Attach recent logs to the event for better context
        if (logBuffer.length > 0) {
            event.extra = event.extra || {};
            event.extra.extension_logs = logBuffer.join('\n');
        }

        const error = hint.originalException;
        if (error) {
            const msg = (error.message || String(error)).toLowerCase();

            // 1. SHUTDOWN & CLEANUP NOISE (More general)
            // If we are shutting down, ignore almost all connection/lifecycle errors.
            const isLifecycleError =
                msg.includes('connection closed') ||
                msg.includes('channel has been closed') ||
                msg.includes('not connected') ||
                msg.includes('socket hang up') ||
                msg.includes('econnreset') ||
                msg.includes('request timed out') ||
                msg.includes('aborted') ||
                msg.includes('canceled') ||
                msg.includes('disposed') ||
                msg.includes('terminated');

            if (isShuttingDown && isLifecycleError) {
                return null;
            }

            // 2. TEST ENVIRONMENT NOISE
            const isTestFile = (event.exception?.values || []).some(ex =>
                ex.stacktrace?.frames?.some(frame =>
                    frame.filename && (
                        frame.filename.includes('test/') ||
                        frame.filename.includes('.test.') ||
                        frame.filename.includes('mcp-client.test') ||
                        frame.filename.includes('pypi-versioning.test')
                    )
                )
            );
            if (isTestFile) return null;

            // 3. USER INTERACTION & CANCELLATION (Always ignore)
            if (
                msg.includes('external cancellation') ||
                msg.includes('interrupted') ||
                msg.includes('canceled: canceled') ||
                msg === 'canceled'
            ) {
                return null;
            }

            // 4. TELEMETRY & THIRD-PARTY NOISE
            if (
                msg.includes('otlpexportererror') ||
                msg.includes('msgcenterweb') ||
                msg.includes('settemplatemcpservers') ||
                msg.includes('err_network_changed') ||
                msg.includes('socket has been ended by the other party')
            ) {
                return null;
            }

            // 5. USER SCRIPT ERRORS (Syntax errors in .R or .do files)
            if (
                (msg.includes('unexpected symbol') || msg.includes('unexpected token') || msg.includes('syntax error')) &&
                (msg.includes('.r:') || msg.includes('.do:') || msg.includes('.py:') || msg.includes('.sthlp:'))
            ) {
                return null;
            }

            // Generic check for errors in non-extension files
            const hasExternalFileRef = /\.[a-z0-9]+:\d+:\d+/i.test(msg);
            if (hasExternalFileRef && !msg.includes('stata-workbench') && !msg.includes('mcp-stata') && !msg.includes('tmonk')) {
                return null;
            }

            // 6. STATA USER ERRORS (not system failures)
            if (/r\(\d+\);/.test(msg) || /\[rc\s+\d+\]/.test(msg) || msg.includes('{err}') || msg.includes('stata error:')) {
                return null;
            }

            // 7. DISPOSAL NOISE
            if (error.stack && /\.(terminate|dispose)/.test(error.stack)) {
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
