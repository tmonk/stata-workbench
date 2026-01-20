These examples should be used as guidance when configuring Sentry functionality within a project.

# Error / Exception Tracking

Use `Sentry.captureException(error)` to capture an exception and log the error in Sentry.
Use this in try catch blocks or areas where exceptions are expected

# Tracing Examples

Spans should be created for meaningful actions within an applications like button clicks, API calls, and function calls
Ensure you are creating custom spans with meaningful names and operations
Use the `Sentry.startSpan` function to create a span
Child spans can exist within a parent span

## Custom Span instrumentation in component actions

```javascript
function TestComponent() {
  const handleTestButtonClick = () => {
    // Create a transaction/span to measure performance
    Sentry.startSpan(
      {
        op: "ui.click",
        name: "Test Button Click",
      },
      (span) => {
        const value = "some config";
        const metric = "some metric";

        // Metrics can be added to the span
        span.setAttribute("config", value);
        span.setAttribute("metric", metric);

        doSomething();
      },
    );
  };

  return (
    <button type="button" onClick={handleTestButtonClick}>
      Test Sentry
    </button>
  );
}
```

## Custom span instrumentation in API calls

```javascript
async function fetchUserData(userId) {
  return Sentry.startSpan(
    {
      op: "http.client",
      name: `GET /api/users/${userId}`,
    },
    async () => {
      const response = await fetch(`/api/users/${userId}`);
      const data = await response.json();
      return data;
    },
  );
}
```

# Logs

Where logs are used, ensure they are imported using `import * as Sentry from "@sentry/node"`
Enable logging in Sentry using `Sentry.init({ enableLogs: true })`
Reference the logger using `const { logger } = Sentry`
Sentry offers a consoleLoggingIntegration that can be used to log specific console error types automatically without instrumenting the individual logger calls

## Configuration

In Node.js the Sentry initialization is typically in `instrumentation.ts`

### Baseline

```javascript
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: "https://97f5f46047e65ebbf758c0e9e4ffe6c5@o4510744386732032.ingest.de.sentry.io/4510744389550160",

  // Send structured logs to Sentry
  enableLogs: true,
});
```

### Logger Integration

```javascript
Sentry.init({
  dsn: "https://97f5f46047e65ebbf758c0e9e4ffe6c5@o4510744386732032.ingest.de.sentry.io/4510744389550160",
  integrations: [
    // send console.log, console.warn, and console.error calls as logs to Sentry
    Sentry.consoleLoggingIntegration({ levels: ["log", "warn", "error"] }),
  ],
});
```

## Logger Examples

`logger.fmt` is a template literal function that should be used to bring variables into the structured logs.

```javascript
logger.trace("Starting database connection", { database: "users" });
logger.debug(logger.fmt`Cache miss for user: ${userId}`);
logger.info("Updated profile", { profileId: 345 });
logger.warn("Rate limit reached for endpoint", {
  endpoint: "/api/results/",
  isEnterprise: false,
});
logger.error("Failed to process payment", {
  orderId: "order_123",
  amount: 99.99,
});
logger.fatal("Database connection pool exhausted", {
  database: "users",
  activeConnections: 100,
});
```

## Error Filtering

We filter out Stata-specific user errors in `src/instrument.js` to avoid cluttering Sentry with non-fixable issues.

- **Stata Return Codes**: Errors matching `/r\(\d+\);/` (e.g., `r(198);`) are ignored.
- **SMCL Tags**: Errors containing `{err}` or `stata error:` are ignored.
- **Policy**: Only capture exceptions that represent bugs in the extension, the MCP client, or the server infrastructure.
