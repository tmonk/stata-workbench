// Import with `import * as Sentry from "@sentry/node"` if you are using ESM
const Sentry = require("@sentry/node");
const pkg = require("../package.json");

const isBun = !!process.versions.bun;
const { nodeProfilingIntegration } = isBun 
    ? { nodeProfilingIntegration: () => ({ name: 'MockProfiling' }) }
    : require("@sentry/profiling-node");

Sentry.init({
    dsn: "https://97f5f46047e65ebbf758c0e9e4ffe6c5@o4510744386732032.ingest.de.sentry.io/4510744389550160",
    release: `stata-workbench@${pkg.version}`,
    environment: process.env.NODE_ENV || "production",
    integrations: isBun ? [] : [
        nodeProfilingIntegration(),
    ],

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
        }
        return event;
    },
});
