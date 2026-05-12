# Test Coverage Plan: MCP → NDJSON Daemon Migration

## Background

The `workbench` branch replaces the previous MCP-over-stdio transport with a
direct NDJSON daemon socket. The two new JS modules are:

- **`src/daemon-manager.js`** — spawns/stops the Python daemon process,
  polls for the session meta file, fires crash callbacks.
- **`src/stata-client.js`** — connects to the daemon via `net.Socket`,
  serialises requests as NDJSON, resolves responses by request id.

`src/extension.js` was cut from ~1000 to ~1024 lines by deleting all MCP
installer/auto-update logic and replacing `mcpClient.*` calls with
`stataClient.*` and `daemonMgr.*`.

On the Python side (`mcp-stata/stata-agent/`), a new asyncio daemon
(`daemon.py`), a synchronous RPC client (`rpc_client.py`), a session manager
(`session.py`), a worker process (`worker.py`), a mock backend
(`mock_backend.py`), and a unified CLI (`cli.py`) were added.

The migration deleted ~5 950 lines of tests across 14 files and added ~1 830
lines in two new files. Many behaviours tested in the deleted files have no
equivalent tests on the new code path.

---

## Audit: What Exists vs What Is Missing

### JS test files that were **added**

| File | Covers | Quality notes |
|------|--------|---------------|
| `test/unit/stata-client.test.js` (366 ln) | `ensureConnected`, `disconnect`, `runCode`, `runFile`, `cancel`, `listVariables`, `getDataPage`, `readLogAtOffset`, `health`, status/error events | Good but incomplete — see gaps below |
| `test/unit/daemon-manager.test.js` (464 ln) | `constructor`, `ensureRunning` (unix, tcp, stale-meta, spawn, mock flag, exit-before-start, timeout), `stop` (SIGTERM, NDJSON stop, not-tracked, cleanup), `health` (all branches), `onCrash` (register, multi, per-session, fires-after-start, does-not-fire-before-start) | Comprehensive |

### JS test files that were **deleted** and their behaviours

| Deleted file | Critical behaviours no longer tested |
|---|---|
| `mcp-client.test.js` (1 497 ln) | `_normalizeResponse`, artifact parsing (`_parseArtifactLikeJson`), graph export fallback, log tail loop (`_tailLogLoop`, `_drainActiveRunLog`), background task helpers (`_awaitTaskDone`, `_awaitBackgroundResult`), `_onLoggingMessage` (graph_ready, help_ready), AbortError/cancellation, CWD resolution for `runFile`, ToolEnvelope extraction |
| `logging.test.js` (274 ln) | Raw stderr suppressed by default; `logStataCode` shows code; `showAllLogsInOutput` shows all; high-level connection events routed; `logRunToOutput` respects settings; VS Code config change updates mcpClient |
| `mcp-auto-refresh.test.js` (137 ln) | Auto-refresh when required tools missing; env preserved during forced refresh; error when tools still missing after refresh |
| `mcp-break-session.test.js` (152 ln) | Break-session sends break; treats AbortError as user cancellation |
| `mcp-queue.test.js` (162 ln) | Serial queueing of concurrent requests |
| `mcp-queue-cancel.test.js` (277 ln) | Queue cancellation, inflight-cancel, drain-on-cancel |
| `mcp-discovery.test.js` (78 ln) | MCP server discovery (now superseded by daemon approach) |
| `data-browser.test.js` (295 ln) | Data-browser frontend: Arrow parsing, filter UI, pagination, variable selector, `requestPage` / `requestVariables` / `filter` message roundtrips |
| `smcl_layout.test.js` (233 ln) | `smclToHtml` column alignment, `{col}`, `{p}`, `{text}`, truncation |
| `repro_clearing.test.js` (105 ln) | `safeSliceTail` HTML slicing invariants |
| `repro_loop.test.js` (89 ln) | Autocomplete loop bug regression |
| `ui_concurrency.test.js` (82 ln) | `DataBrowserPanel` concurrent request serialisation |
| `pypi-versioning.test.js` (139 ln) | Semantic-release config, package versioning logic |
| `rc10.test.js` (52 ln) | RC=10 (dataset-cleared) handling in terminal panel |

### Gaps in the two new JS test files

**`stata-client.test.js` — uncovered methods:**

- `validateFilterExpr` (both valid and invalid paths)
- `computeViewIndices`
- `listGraphs`
- `exportGraph`
- `getResults`
- `getLogTail`
- `searchLog`
- `getTaskStatus` (wait=false, wait=true)
- `cancelTask`
- `setRequestTimeout`
- `_onData` with fragmented/multi-chunk NDJSON (chunked delivery)
- `_scheduleReconnect` exceeding `_maxReconnectAttempts` → emits `error`
- Request timeout: promise rejects after `_requestTimeoutMs`
- Write error: socket write callback receives an error → promise rejects
- `_waitForMeta` timeout path (meta never appears after daemon starts)
- Multi-session isolation: two concurrent sessions don't collide

**`daemon-manager.test.js` — uncovered:**

- `_findStataBinary` with `STATA_PATH` set → returned immediately (currently
  the test *unsets* STATA_PATH before each test but never tests the set path)
- `stop()` with TCP meta transport
- `health()` with TCP transport meta
- Platform-specific `isWin=true` branch in `ensureRunning` (adds `--transport tcp`)

**`extension.test.js` — uncovered:**

- `migrateSettings()`: copies values from `stataMcp.*` to `stata.*`
- `updateStatusBar` with all four states: `reconnecting`, `idle`, `running`,
  `disconnected`
- `runFile` command handler end-to-end
- `terminalRunCommand` closure (happy path, error path)
- `variableListProvider` closure (happy path, thrown error → returns `[]`)
- `downloadGraphAsPdf` (happy path, stataClient.exportGraph error)
- `clearAllCommand` (happy path, error path)
- `withStataProgress` wrapper
- `loadStataOnStartup=true` actually calls `daemonMgr.ensureRunning`
- `onDidChangeConfiguration` fires when `stata.*` changes

**`panels.test.js` — uncovered after extension-harness refactor:**

- `DataBrowserPanel` constructor receives `stataClient` and stores it
- `requestVariables` webview message → calls `listVariables` + `getDatasetState`,
  posts `variables` message
- `requestPage` webview message → calls `getDataPage`, posts `arrow-page` message
- `filter` webview message (valid expr → computeViewIndices; invalid → error)
- Error handling in all three message handlers (stataClient throws → posts
  `error` message)

### Python-side gaps

**`daemon.py` / `StataDaemon` — no unit tests at all:**

- `JsonProtocol.data_received` with a complete NDJSON line
- `JsonProtocol.data_received` with a fragmented line (split across two calls)
- `JsonProtocol._handle` routes to `StataDaemon.dispatch`, wraps exception in
  error envelope
- `StataDaemon.dispatch("health")` returns pid + session names
- `StataDaemon.dispatch("stop")` sets `_shutdown_event`
- `StataDaemon.dispatch("break")` delegates to `sessions.send_break`
- `StataDaemon.dispatch("run")` foreground path
- `StataDaemon.dispatch("run")` background path: returns task_id immediately,
  stores in `_background_tasks`
- `StataDaemon.dispatch("task_status")` with / without tail_lines
- `StataDaemon.dispatch("task_cancel")`
- `StataDaemon.dispatch("log_read_at_offset")`
- `StataDaemon.dispatch("graph_export")` auto-generates out_path when absent
- `StataDaemon._call_worker` timeout branch
- `StataDaemon.start()` writes meta file (unix transport)
- `StataDaemon.start()` writes meta file (tcp transport)
- Idle timeout: `_last_active` is updated on each dispatch; `_idle_check`
  fires `_shutdown_event` after timeout
- `_cleanup_temps` removes files past their TTL
- `dispatch` unknown method raises `ValueError`

**`rpc_client.py` / `RpcClient` — no unit tests at all:**

- `_connect` finds Unix socket → connects
- `_connect` falls back to TCP meta file when socket missing
- `_connect` raises `FileNotFoundError` when neither exists
- `call()` sends correct NDJSON and parses success response
- `call()` raises `RpcError` on `ok: false` response
- `call()` raises `RpcError("Connection closed")` when server closes without
  newline
- `is_alive()` returns `True` on healthy daemon, `False` on any exception
- `is_daemon_running()` checks socket file existence

**`mock_backend.py` / `MockDaemon` — no unit tests:**

- `_load_canned_responses` with responses dir present / absent
- `_route_command` exact match → returns canned output, updates state
- `_route_command` for `sysuse auto` → populates dataset state
- `dispatch("inspect_describe")` returns dataset variables from state
- `dispatch("graph_list")` returns session graphs
- `dispatch` statest scalar injection for failure patterns
- `MockDaemon.start()` writes meta file same as `StataDaemon`

**Integration: JS → Python — no cross-stack tests:**

- `DaemonManager.ensureRunning('default', { mock: true })` actually starts
  `MockDaemon` subprocess; `StataClient.ensureConnected` can then send a
  `health` request and receive a response.
- Full `runCode` round-trip through `StataClient` → mock daemon → canned
  response.

---

## Implementation Plan

The work is split into five tasks. Each task is independent of the others
except Task 5 (integration) which builds on Tasks 1–4.

---

### Task 1 — Fill gaps in `stata-client.test.js`

**File:** `test/unit/stata-client.test.js`

Add the following `describe` blocks **after** the existing `health` block.
All use the same `beforeEach` fixture already in the file (mock `net`,
mock `fs`, mock daemon manager).

#### 1a. `validateFilterExpr`

```text
describe('validateFilterExpr')
  it('returns { valid: true } on success response')
    - call validateFilterExpr('price > 5000')
    - emit success response { ok: true, result: {} }
    - assert result.valid === true && result.error === null

  it('returns { valid: false, error } when stataClient throws')
    - override _call to reject with Error('syntax error')
    - assert result.valid === false && result.error === 'syntax error'
```

#### 1b. `computeViewIndices`

```text
describe('computeViewIndices')
  it('sends compute_view_indices and returns indices array')
    - call computeViewIndices('price > 5000')
    - emit { ok: true, result: { indices: [1, 3, 7] } }
    - assert result === [1, 3, 7]

  it('returns empty array when result has no indices key')
    - emit { ok: true, result: {} }
    - assert result deep-equals []
```

#### 1c. `listGraphs`

```text
describe('listGraphs')
  it('calls graph_list and returns result')
    - emit { ok: true, result: { graph_names: ['mygraph'] } }
    - assert result.graph_names[0] === 'mygraph'
```

#### 1d. `exportGraph`

```text
describe('exportGraph')
  it('calls graph_export with name, format, out_path')
    - call exportGraph('mygraph', 'pdf', '/tmp/out.pdf')
    - capture written request; assert method='graph_export',
      args.name='mygraph', args.format='pdf', args.out_path='/tmp/out.pdf'
    - emit success; assert promise resolves
```

#### 1e. `getResults`

```text
describe('getResults')
  it('calls results with class=r by default')
    - assert request args.class === 'r'

  it('passes supplied resultClass to args.class')
    - call getResults('e')
    - assert request args.class === 'e'
```

#### 1f. `getLogTail`

```text
describe('getLogTail')
  it('calls log_tail with lines=50 by default')
    - assert request args.lines === 50

  it('passes custom line count')
    - call getLogTail(100)
    - assert request args.lines === 100
```

#### 1g. `searchLog`

```text
describe('searchLog')
  it('calls log_search with pattern')
    - call searchLog('r(111)')
    - assert request args.pattern === 'r(111)'
```

#### 1h. `getTaskStatus`

```text
describe('getTaskStatus')
  it('calls task_status with wait=false by default')
    - assert request args.wait === false

  it('passes wait=true and timeout when opts supplied')
    - call getTaskStatus('tid', { wait: true, timeout: 60 })
    - assert args.wait === true, args.timeout === 60
```

#### 1i. `cancelTask`

```text
describe('cancelTask')
  it('sends task_cancel with task_id')
    - call cancelTask('tid-123')
    - assert method='task_cancel', args.task_id='tid-123'
```

#### 1j. `setRequestTimeout`

```text
describe('setRequestTimeout')
  it('updates _requestTimeoutMs')
    - client.setRequestTimeout(5000)
    - assert client._requestTimeoutMs === 5000
```

#### 1k. NDJSON fragmentation in `_onData`

```text
describe('_onData fragmentation')
  it('handles response split across two data events')
    - connect client
    - send first chunk: first half of JSON line (no newline)
    - send second chunk: rest of JSON + '\n'
    - assert promise resolves with correct result

  it('processes multiple responses in a single data event')
    - send two complete JSON lines concatenated in one Buffer
    - assert both promises resolve
```

#### 1l. Request timeout

```text
describe('request timeout')
  it('rejects with timeout error when no response arrives within _requestTimeoutMs')
    - use jest.useFakeTimers()
    - client.setRequestTimeout(100)
    - initiate runCode; advance timers by 101ms
    - assert promise rejects with message containing 'timed out'
    - restore real timers in afterEach
```

#### 1m. Write error path

```text
describe('socket write error')
  it('rejects the pending promise when socket.write callback receives an error')
    - override mockSocket.write to call cb(new Error('EPIPE'))
    - assert runCode promise rejects with EPIPE error
    - assert request is removed from _pending
```

#### 1n. Reconnect exhaustion

```text
describe('_scheduleReconnect')
  it('emits error after _maxReconnectAttempts consecutive failures')
    - set _maxReconnectAttempts = 1
    - spy on client.emit
    - call _scheduleReconnect('default') twice (simulating all retries fail)
    - assert 'error' event emitted with message containing 'failed to restart'
```

#### 1o. Multi-session isolation

```text
describe('multi-session')
  it('maintains independent sockets for two sessions')
    - connect 'session-a' and 'session-b' (two separate net.createConnection calls)
    - assert isConnected('session-a') && isConnected('session-b')
    - disconnect 'session-a'
    - assert !isConnected('session-a') && isConnected('session-b')
```

---

### Task 2 — Fill gaps in `daemon-manager.test.js`

**File:** `test/unit/daemon-manager.test.js`

Add the following `describe` blocks inside the outer `describe('DaemonManager')`.

#### 2a. `_findStataBinary` with STATA_PATH set

```text
describe('_findStataBinary — STATA_PATH env')
  it('returns STATA_PATH when set')
    - process.env.STATA_PATH = '/custom/stata'
    - const bin = manager._findStataBinary()
    - assert bin === '/custom/stata'
    - delete process.env.STATA_PATH in afterEach
```

#### 2b. Windows TCP transport in `ensureRunning`

```text
describe('ensureRunning — windows TCP branch')
  it('appends --transport tcp args when process.platform is win32')
    - stub Object.defineProperty(process, 'platform', { value: 'win32' })
    - run a successful ensureRunning (meta appears after 4 polls)
    - assert cp.spawn args contains '--transport' and 'tcp'
    - restore platform in afterEach
```

#### 2c. `stop` with TCP meta

```text
describe('stop — TCP transport')
  it('creates TCP connection when meta transport is tcp')
    - fs.readFileSync returns JSON with transport='tcp', port=9876, host='127.0.0.1'
    - run manager.stop('default') with a tracked process
    - assert net.createConnection called with { port: 9876, host: '127.0.0.1' }
```

#### 2d. `health` with TCP meta

```text
describe('health — TCP transport')
  it('connects via TCP when meta transport is tcp')
    - fs.readFileSync returns JSON with transport='tcp', port=8765
    - mockSocket triggers 'data' with health response
    - assert result equals the health data
    - assert net.createConnection called with { port: 8765 }
```

---

### Task 3 — Fill gaps in `extension.test.js` and `panels.test.js`

#### 3a. `migrateSettings` in `extension.test.js`

```text
describe('migrateSettings')
  itWithHarness('copies a value from stataMcp.* to stata.* when not already set')
    - vscode.workspace.getConfiguration('stataMcp').inspect('requestTimeoutMs')
      returns { globalValue: 120000 }
    - vscode.workspace.getConfiguration('stata').inspect('requestTimeoutMs')
      returns { globalValue: undefined }
    - activate extension
    - assert vscode.workspace.getConfiguration('stata').update called with
      ('requestTimeoutMs', 120000, Global)

  itWithHarness('does not overwrite existing stata.* value')
    - both inspect calls return globalValue defined
    - assert update NOT called for that key
```

#### 3b. `updateStatusBar` in `extension.test.js`

The status bar is wired to `stataClient.on('status', updateStatusBar)`.
The test must emit a `status` event on the mock stataClient's EventEmitter.

```text
describe('updateStatusBar')
  itWithHarness('shows loading spinner for reconnecting state')
    - activate; get stataClient from api
    - emit status 'reconnecting' on stataClient
    - assert barItem.text contains 'Starting'

  itWithHarness('shows check for idle/ready state')
    - emit 'idle'
    - assert barItem.text contains 'Ready'
    - assert barItem.command === 'stata-workbench.showDaemonStatus'

  itWithHarness('shows spinner and cancel command for running state')
    - emit 'running'
    - assert barItem.text contains 'Running'
    - assert barItem.command === 'stata-workbench.cancelRequest'

  itWithHarness('shows circle-slash and restart command for disconnected state')
    - emit 'disconnected'
    - assert barItem.text contains 'Not running'
    - assert barItem.command === 'stata-workbench.restartDaemon'
```

For this to work `stataClient` exposed on the test API must be a real
`EventEmitter` (or the harness mock must expose an `emit` method). Update
`extension-harness.js` to extend `EventEmitter` in the mock, or make the
stataClient mock use `require('events').EventEmitter.prototype`.

#### 3c. `runFile` handler in `extension.test.js`

```text
describe('runFile command')
  itWithHarness('calls stataClient.runFile with the active editor file path')
    - set vscode.window.activeTextEditor with uri.fsPath='/tmp/test.do'
    - stub api.stataClient.runFile to resolve with { ok: true, rc: 0, stdout: '' }
    - invoke handlers.get('stata-workbench.runFile')()
    - assert mockRunFile called with '/tmp/test.do'

  itWithHarness('shows error message when runFile rejects')
    - stub api.stataClient.runFile to reject with Error('File not found')
    - invoke handler
    - assert vscode.window.showErrorMessage called
```

#### 3d. `terminalRunCommand` closure

```text
describe('terminalRunCommand')
  itWithHarness('resolves with result from stataClient.runCode')
    - activate; get api.stataClient
    - stub runCode to resolve { ok: true, rc: 0, stdout: 'done' }
    - call the internal terminalRunCommand via the TerminalPanel show callback
    - OR expose it on the test API and call directly
    - assert result.ok === true

  itWithHarness('returns error envelope instead of throwing when stataClient throws')
    - stub runCode to reject with Error('conn error')
    - call terminalRunCommand
    - assert returned object has ok: false, error.message: 'conn error'
```

*Implementation note:* To test this closure, either expose
`terminalRunCommand` on the test API (add it to `moduleExports`), or
extract it to a named export. Either approach is acceptable; exposing it on
the test API is least-invasive.

#### 3e. `variableListProvider` closure

```text
describe('variableListProvider')
  itWithHarness('returns variable list from stataClient.listVariables')
    - stub listVariables to resolve [{ name: 'price' }]
    - call variableListProvider
    - assert result[0].name === 'price'

  itWithHarness('returns [] and does not throw when listVariables rejects')
    - stub listVariables to reject
    - assert result is []
```

#### 3f. `downloadGraphAsPdf` closure

```text
describe('downloadGraphAsPdf')
  itWithHarness('calls exportGraph and returns {path, url, label}')
    - stub exportGraph to resolve { file_path: '/tmp/g.pdf' }
    - call downloadGraphAsPdf('mygraph', '/tmp')
    - assert result.path === '/tmp/g.pdf' && result.label === 'mygraph'

  itWithHarness('shows error message when exportGraph throws')
    - stub exportGraph to reject with Error('export failed')
    - call downloadGraphAsPdf
    - assert vscode.window.showErrorMessage called with message containing 'export failed'
```

#### 3g. `loadStataOnStartup` actually calls ensureRunning

```text
describe('loadStataOnStartup setting')
  itWithHarness('calls daemonMgr.ensureRunning when loadStataOnStartup is true')
    - set getConfiguration('stata').get('loadStataOnStartup') = true
    - activate
    - await a tick (Promise.resolve())
    - assert api.daemonMgrMock.ensureRunning called with 'default'

  itWithHarness('does NOT call ensureRunning when loadStataOnStartup is false')
    - set loadStataOnStartup = false
    - activate
    - assert ensureRunning not called
```

#### 3h. `onDidChangeConfiguration` in `extension.test.js`

```text
describe('onDidChangeConfiguration')
  itWithHarness('calls debugLog when stata.* setting changes')
    - activate
    - find the onDidChangeConfiguration listener registered via
      vscode.workspace.onDidChangeConfiguration
    - call listener({ affectsConfiguration: (s) => s === 'stata' })
    - assert no error thrown (behaviour is currently just a debugLog)
```

#### 3i. `DataBrowserPanel` message handlers in `panels.test.js`

**File:** `test/unit/panels.test.js`

The `loadDataBrowserPanel` helper already exists in `panels.test.js` but the
proxy it uses stubs `mcp-client`. For workbench the panel uses
`DataBrowserPanel._stataClient`. Update the helper:

```js
const loadDataBrowserPanel = (stataClientMock) => proxyquire('../../src/data-browser-panel', {
    // no mcp-client dependency any more — just pass through
});
```

Then create a minimal stataClient mock and set it on `DataBrowserPanel._stataClient`.

```text
describe('DataBrowserPanel — webview message handlers')

  it('requestVariables: calls listVariables + getDatasetState, posts variables message')
    - create DataBrowserPanel instance with mock stataClient that returns
      { variables: [{name:'price'}], obs_count:74, var_count:1, dataset_name:'auto' }
    - trigger webview message { type: 'requestVariables' }
    - assert webview.postMessage called with { type: 'variables', variables: [...] }

  it('requestVariables: posts error message when listVariables throws')
    - stub listVariables to reject with Error('timeout')
    - trigger 'requestVariables'
    - assert postMessage called with { type: 'error', message: 'timeout' }

  it('requestPage: calls getDataPage, posts arrow-page message')
    - stub getDataPage to resolve Buffer.from([1, 2, 3])
    - trigger { type: 'requestPage', start: 0, count: 50, varlist: 'price mpg' }
    - assert postMessage called with { type: 'arrow-page', data: [1, 2, 3] }

  it('filter — valid expr: validates, computes indices, posts filterResult')
    - stub validateFilterExpr to resolve { valid: true, error: null }
    - stub computeViewIndices to resolve [1, 5, 10]
    - trigger { type: 'filter', expr: 'price > 5000' }
    - assert postMessage called with { type: 'filterResult', valid: true, indices: [1,5,10] }

  it('filter — invalid expr: posts filterResult with valid=false and error')
    - stub validateFilterExpr to resolve { valid: false, error: 'syntax error' }
    - trigger filter message
    - assert postMessage called with { type: 'filterResult', valid: false, error: 'syntax error' }

  it('filter — stataClient throws: posts filterResult with valid=false')
    - stub validateFilterExpr to reject
    - trigger filter message
    - assert postMessage called with { type: 'filterResult', valid: false }
```

---

### Task 4 — Restore deleted JS tests for still-living code

Several deleted test files covered code that still exists in the codebase but
is now untested.

#### 4a. Restore `smcl_layout` tests

**File:** `test/unit/smcl_layout.test.js` (new file, recreated)

`src/ui-shared/main.js` still exports `smclToHtml`. The old test used JSDOM
to load the module. Re-create the test file with the full set of layout cases
from the deleted version:

- `{col N}` aligns to column N
- `{p N M L}` paragraph indentation
- `{text:...}` text tag
- Nested `{err}` / `{com}` / `{txt}` tags stripped cleanly
- Very long lines with `{col}` don't overflow buffer
- Empty and null input returns empty string

Copy the original test logic from the git history:
```bash
git show main:test/unit/smcl_layout.test.js > test/unit/smcl_layout.test.js
```
Then verify all assertions pass on the unchanged `src/ui-shared/main.js`.

#### 4b. Restore `repro_clearing` tests

**File:** `test/unit/repro_clearing.test.js`

`safeSliceTail` logic still lives in `src/terminal-panel.js`. If the function
is not exported, either export it or test it indirectly.

```bash
git show main:test/unit/repro_clearing.test.js > test/unit/repro_clearing.test.js
```

Adjust the import path. Verify all 7 test cases pass.

#### 4c. Restore `rc10` handling test

**File:** `test/unit/rc10.test.js`

RC=10 (dataset cleared) was tested to confirm the terminal panel marks it as
an error. Extract the relevant assertion from git history and add it to
`panels.test.js` if the original file is too small to justify a standalone
file, otherwise recreate it:

```bash
git show main:test/unit/rc10.test.js > test/unit/rc10.test.js
```

#### 4d. Add `data-browser.js` frontend tests

**File:** `test/unit/data-browser.test.js` (new, replaces deleted version)

The old test used JSDOM + `tableToIPC`/`tableFromArrays` to drive
`src/ui-shared/data-browser.js`. The JS module still exists but now receives
Arrow data from `StataClient.getDataPage()` via a webview message rather than
via an HTTP endpoint. The test structure stays the same; only the message
origin changes.

Key cases to include:

```text
describe('data-browser.js — Arrow rendering')
  it('renders column headers from Arrow schema')
  it('renders cells from Arrow RecordBatch')
  it('shows loading overlay during fetch')
  it('hides loading overlay on success')
  it('shows error banner when arrow-page message carries no data')

describe('data-browser.js — pagination')
  it('btn-next increments page and re-requests')
  it('btn-prev decrements page and re-requests')
  it('page-info text reflects current page and total')

describe('data-browser.js — variable selector')
  it('btn-variables toggles dropdown visibility')
  it('var-search-input filters the variable list')
  it('btn-select-all checks all variables')
  it('btn-select-none unchecks all variables')

describe('data-browser.js — filter')
  it('apply-filter sends filter message to extension with expr text')
  it('shows error text when filterResult.valid is false')
  it('re-renders grid when filterResult.valid is true with indices')
```

Use the same JSDOM + `vscode.postMessage` mock approach as the old file.
Retrieve the old scaffolding from git history:
```bash
git show main:test/unit/data-browser.test.js > /tmp/old-data-browser.test.js
```

Reuse the DOM setup verbatim; replace the HTTP-based response triggering with
direct calls to the webview `message` event handler.

#### 4e. Restore logging behaviour tests

The deleted `logging.test.js` tested `debugLog`, `appendLine`, and
`logRunToOutput` behaviour under different VS Code settings. These functions
are still in `extension.js` and their behaviour is unchanged.

**File:** Add a `describe('logging behaviour')` block to `extension.test.js`:

```text
  itWithHarness('suppresses debug logs by default (only sends to Sentry buffer)')
    - getConfiguration returns showAllLogsInOutput=false
    - activate; trigger an internal debugLog call
    - assert outputChannel.appendLine NOT called

  itWithHarness('shows all logs when showAllLogsInOutput=true')
    - set showAllLogsInOutput=true
    - trigger debugLog
    - assert outputChannel.appendLine called

  itWithHarness('writes to output when result has error and settings are off')
    - logRunToOutput equivalent: emit a result with rc != 0 via terminalRunCommand
    - assert outputChannel.appendLine called

  itWithHarness('suppresses output on success when settings are off')
    - result with rc=0
    - assert outputChannel.appendLine NOT called with stdout content
```

---

### Task 5 — Python-side unit tests for new daemon stack

#### 5a. `test_daemon_unit.py` — `JsonProtocol` and `StataDaemon.dispatch`

**File:** `mcp-stata/tests/server/test_daemon_unit.py` (new file)

Use `asyncio` + `unittest.mock` throughout. Do not require a real Stata
installation (`pytestmark = pytest.mark.not_requires_stata` or just no mark).

```python
"""Unit tests for daemon.py — no real Stata needed."""
import asyncio, json, os, time
from unittest.mock import MagicMock, patch, AsyncMock
import pytest

from stata_agent.daemon import StataDaemon, JsonProtocol
```

**Protocol tests:**

```python
@pytest.mark.asyncio
async def test_json_protocol_complete_line():
    """data_received with a complete NDJSON line calls dispatch and sends response."""

@pytest.mark.asyncio
async def test_json_protocol_fragmented_line():
    """data_received with a split line buffers until newline arrives."""

@pytest.mark.asyncio
async def test_json_protocol_invalid_json_sends_parse_error():
    """data_received with invalid JSON sends PARSE_ERROR response."""

@pytest.mark.asyncio
async def test_json_protocol_dispatch_exception_wrapped():
    """If dispatch raises, _handle sends ok=false envelope."""
```

**Dispatch tests (mock SessionManager):**

```python
@pytest.fixture
def daemon_with_mock_sessions():
    d = StataDaemon(session_name="default")
    d.sessions = MagicMock()
    d.sessions.get_session_names.return_value = ["default"]
    d.sessions.get_or_create.return_value = MagicMock()
    return d

@pytest.mark.asyncio
async def test_dispatch_health(daemon_with_mock_sessions):
    result = await daemon_with_mock_sessions.dispatch("health", {})
    assert result["status"] == "ok"
    assert result["pid"] == os.getpid()

@pytest.mark.asyncio
async def test_dispatch_stop_sets_shutdown(daemon_with_mock_sessions):
    d = daemon_with_mock_sessions
    d._shutdown_event = asyncio.Event()
    d.sessions.stop_all = MagicMock()
    result = await d.dispatch("stop", {})
    assert d._shutdown_event.is_set()
    assert result["acknowledged"] is True

@pytest.mark.asyncio
async def test_dispatch_break_delegates_to_sessions(daemon_with_mock_sessions):
    ...

@pytest.mark.asyncio
async def test_dispatch_run_foreground(daemon_with_mock_sessions):
    ...

@pytest.mark.asyncio
async def test_dispatch_run_background_returns_task_id_immediately(daemon_with_mock_sessions):
    # background=True → returns task_id without waiting for worker
    ...

@pytest.mark.asyncio
async def test_dispatch_task_status_known_task(daemon_with_mock_sessions):
    ...

@pytest.mark.asyncio
async def test_dispatch_task_cancel(daemon_with_mock_sessions):
    ...

@pytest.mark.asyncio
async def test_dispatch_log_read_at_offset(daemon_with_mock_sessions):
    ...

@pytest.mark.asyncio
async def test_dispatch_graph_export_auto_out_path(daemon_with_mock_sessions):
    # out_path absent → tempfile created; registered in _temp_files
    ...

@pytest.mark.asyncio
async def test_dispatch_unknown_method_raises(daemon_with_mock_sessions):
    with pytest.raises(ValueError, match="Unknown method"):
        await daemon_with_mock_sessions.dispatch("nonexistent", {})

def test_call_worker_timeout(daemon_with_mock_sessions):
    """_call_worker raises TimeoutError when worker does not respond."""
    handle = daemon_with_mock_sessions.sessions.get_or_create("default")
    handle.conn.poll.return_value = False  # never ready
    with pytest.raises(TimeoutError):
        daemon_with_mock_sessions._call_worker(handle, "run", {}, timeout=0.01)

@pytest.mark.asyncio
async def test_start_writes_unix_meta_file(tmp_path, monkeypatch):
    """start() creates the session meta JSON for unix transport."""
    monkeypatch.setattr("stata_agent.daemon.SESSION_DIR", tmp_path / "sessions")
    d = StataDaemon(session_name="test", transport="unix")
    d.sessions = MagicMock()
    d.sessions.get_or_create.return_value = MagicMock()
    d._shutdown_event = asyncio.Event()
    # Start then immediately signal shutdown
    asyncio.get_event_loop().call_soon(d._shutdown_event.set)
    await d.start()
    meta = json.loads((tmp_path / "sessions" / "test.json").read_text())
    assert meta["transport"] == "unix"
    assert "path" in meta

@pytest.mark.asyncio
async def test_idle_check_fires_shutdown(daemon_with_mock_sessions):
    """_idle_check sets _shutdown_event when idle > timeout."""
    d = daemon_with_mock_sessions
    d._shutdown_event = asyncio.Event()
    d._idle_timeout = 0  # trigger immediately
    d._last_active = 0.0  # long ago
    # Run one iteration of idle check
    task = asyncio.create_task(d._idle_check_once())  # extract helper or patch sleep
    await asyncio.sleep(0.05)
    assert d._shutdown_event.is_set()
```

*Note:* `_idle_check` is currently an inner coroutine inside `start()`. Either
extract it as a method `_run_idle_check()` or patch `asyncio.sleep` to
advance time instantly. The cleaner approach is extraction.

#### 5b. `test_rpc_client_unit.py`

**File:** `mcp-stata/tests/server/test_rpc_client_unit.py` (new file)

All tests use `socket.socket` mocks (or `socketpair`) — no daemon needed.

```python
"""Unit tests for rpc_client.py."""
import json, socket, threading
from pathlib import Path
from unittest.mock import MagicMock, patch
import pytest
from stata_agent.rpc_client import RpcClient, RpcError

def _make_response(ok: bool, result=None, error="err"):
    payload = {"ok": ok}
    if ok:
        payload["result"] = result or {}
    else:
        payload["error"] = error
        payload["error_code"] = "TEST_ERROR"
    return (json.dumps(payload) + "\n").encode()

def test_connect_unix_socket(tmp_path, monkeypatch):
    """_connect uses Unix socket when .sock file exists."""
    sock_path = tmp_path / "default.sock"
    sock_path.touch()
    monkeypatch.setattr("stata_agent.rpc_client.SESSION_DIR", tmp_path)
    with patch("socket.socket") as mock_sock_cls:
        mock_sock = MagicMock()
        mock_sock_cls.return_value = mock_sock
        client = RpcClient(session="default")
        client._connect()
        mock_sock.connect.assert_called_once_with(str(sock_path))

def test_connect_tcp_fallback(tmp_path, monkeypatch):
    """_connect falls back to TCP when only meta file with tcp transport exists."""
    meta_path = tmp_path / "default.json"
    meta_path.write_text(json.dumps({"transport": "tcp", "host": "127.0.0.1", "port": 9999}))
    monkeypatch.setattr("stata_agent.rpc_client.SESSION_DIR", tmp_path)
    with patch("socket.socket") as mock_sock_cls:
        mock_sock = MagicMock()
        mock_sock_cls.return_value = mock_sock
        RpcClient(session="default")._connect()
        mock_sock.connect.assert_called_once_with(("127.0.0.1", 9999))

def test_connect_raises_when_nothing_exists(tmp_path, monkeypatch):
    monkeypatch.setattr("stata_agent.rpc_client.SESSION_DIR", tmp_path)
    with pytest.raises(FileNotFoundError):
        RpcClient(session="default")._connect()

def test_call_success(tmp_path, monkeypatch):
    sock_path = tmp_path / "default.sock"
    sock_path.touch()
    monkeypatch.setattr("stata_agent.rpc_client.SESSION_DIR", tmp_path)
    mock_sock = MagicMock()
    mock_sock.recv.return_value = _make_response(True, result={"status": "ok"})
    with patch("socket.socket", return_value=mock_sock):
        result = RpcClient(session="default").call("health")
    assert result == {"status": "ok"}
    mock_sock.close.assert_called()

def test_call_raises_rpc_error_on_failure(tmp_path, monkeypatch):
    sock_path = tmp_path / "default.sock"
    sock_path.touch()
    monkeypatch.setattr("stata_agent.rpc_client.SESSION_DIR", tmp_path)
    mock_sock = MagicMock()
    mock_sock.recv.return_value = _make_response(False, error="syntax error")
    with patch("socket.socket", return_value=mock_sock):
        with pytest.raises(RpcError, match="syntax error"):
            RpcClient(session="default").call("run", {"code": "bad"})

def test_call_raises_on_connection_closed(tmp_path, monkeypatch):
    sock_path = tmp_path / "default.sock"
    sock_path.touch()
    monkeypatch.setattr("stata_agent.rpc_client.SESSION_DIR", tmp_path)
    mock_sock = MagicMock()
    mock_sock.recv.return_value = b""  # EOF
    with patch("socket.socket", return_value=mock_sock):
        with pytest.raises(RpcError, match="Connection closed"):
            RpcClient(session="default").call("health")

def test_is_alive_true(tmp_path, monkeypatch):
    sock_path = tmp_path / "default.sock"
    sock_path.touch()
    monkeypatch.setattr("stata_agent.rpc_client.SESSION_DIR", tmp_path)
    mock_sock = MagicMock()
    mock_sock.recv.return_value = _make_response(True, {"status": "ok"})
    with patch("socket.socket", return_value=mock_sock):
        assert RpcClient("default").is_alive() is True

def test_is_alive_false_on_error(tmp_path, monkeypatch):
    monkeypatch.setattr("stata_agent.rpc_client.SESSION_DIR", tmp_path)
    # No socket → FileNotFoundError → is_alive returns False
    assert RpcClient("default").is_alive() is False

def test_is_daemon_running(tmp_path, monkeypatch):
    monkeypatch.setattr("stata_agent.rpc_client.SESSION_DIR", tmp_path)
    assert RpcClient.is_daemon_running("default") is False
    (tmp_path / "default.sock").touch()
    assert RpcClient.is_daemon_running("default") is True
```

#### 5c. `test_mock_daemon_unit.py` — MockDaemon unit tests

**File:** `mcp-stata/tests/server/test_mock_daemon_unit.py` (new file)

```python
"""Unit tests for mock_backend.py."""
import asyncio, json, os
from unittest.mock import MagicMock
import pytest

from stata_agent.mock_backend import MockDaemon, _route_command, _load_canned_responses, _get_state, _session_state

def setup_function():
    _session_state.clear()

def test_load_canned_responses_returns_dict():
    responses = _load_canned_responses()
    assert isinstance(responses, dict)

def test_route_command_health_returns_ok():
    result = _route_command("display 1+1", "test")
    assert isinstance(result, dict)

def test_mock_dispatch_health():
    daemon = MockDaemon(session_name="unit")
    daemon._shutdown_event = asyncio.Event()
    result = asyncio.run(daemon.dispatch("health", {}))
    assert result["status"] == "running"
    assert result["pid"] == os.getpid()

def test_mock_dispatch_inspect_describe_empty_state():
    daemon = MockDaemon(session_name="unit-desc")
    daemon._shutdown_event = asyncio.Event()
    result = asyncio.run(daemon.dispatch("inspect_describe", {}))
    assert "variables" in result
    assert result["variables"] == []

def test_mock_dispatch_run_sysuse_populates_state():
    daemon = MockDaemon(session_name="unit-state")
    daemon._shutdown_event = asyncio.Event()
    asyncio.run(daemon.dispatch("run", {"code": "sysuse auto"}))
    result = asyncio.run(daemon.dispatch("inspect_describe", {}))
    assert result["var_count"] > 0
    assert any(v["name"] == "price" for v in result["variables"])

def test_mock_dispatch_graph_list_empty():
    daemon = MockDaemon(session_name="unit-graph")
    daemon._shutdown_event = asyncio.Event()
    result = asyncio.run(daemon.dispatch("graph_list", {}))
    assert result["graph_names"] == []

def test_mock_dispatch_unknown_method_raises():
    daemon = MockDaemon(session_name="unit-err")
    daemon._shutdown_event = asyncio.Event()
    with pytest.raises(ValueError):
        asyncio.run(daemon.dispatch("nonexistent_method", {}))

def test_mock_dispatch_break_returns_acknowledged():
    daemon = MockDaemon(session_name="unit-break")
    daemon._shutdown_event = asyncio.Event()
    result = asyncio.run(daemon.dispatch("break", {}))
    assert result["acknowledged"] is True

def test_mock_dispatch_task_status():
    daemon = MockDaemon(session_name="unit-task")
    daemon._shutdown_event = asyncio.Event()
    result = asyncio.run(daemon.dispatch("task_status", {"task_id": "x"}))
    assert result["status"] == "completed"
```

#### 5d. Integration: `DaemonManager` + `MockDaemon` + `StataClient`

**File:** `test/integration/daemon-e2e.test.js` (new file)

This test actually spawns a `MockDaemon` subprocess via `DaemonManager` and
exercises the full JS→Python round-trip. It requires Python and the
`stata_agent` package to be installed (skip otherwise).

```js
const { describe, it, beforeAll, afterAll, expect } = require('bun:test');
const { DaemonManager } = require('../../src/daemon-manager');
const { StataClient } = require('../../src/stata-client');
const cp = require('child_process');

const PYTHON_AVAILABLE = (() => {
    try {
        const r = cp.spawnSync('python3', ['-c', 'import stata_agent'], { timeout: 3000 });
        return r.status === 0;
    } catch { return false; }
})();

const itIfPython = PYTHON_AVAILABLE ? it : it.skip;

describe('DaemonManager + StataClient end-to-end (mock daemon)', () => {
    let daemonMgr;
    let stataClient;

    beforeAll(async () => {
        daemonMgr = new DaemonManager();
        stataClient = new StataClient(daemonMgr);
        await daemonMgr.ensureRunning('e2e-test', { mock: true, timeout: 15000 });
        await stataClient.ensureConnected('e2e-test');
    }, 20000);

    afterAll(async () => {
        await stataClient.disconnect('e2e-test');
        await daemonMgr.stop('e2e-test');
    }, 5000);

    itIfPython('health check returns ok', async () => {
        const result = await stataClient.health('e2e-test');
        expect(result.status).toBe('running');
        expect(typeof result.pid).toBe('number');
    });

    itIfPython('runCode returns a result', async () => {
        const result = await stataClient.runCode('display 1+1', { sessionName: 'e2e-test' });
        expect(result).toBeDefined();
    });

    itIfPython('listVariables returns array', async () => {
        const vars = await stataClient.listVariables('e2e-test');
        expect(Array.isArray(vars)).toBe(true);
    });

    itIfPython('cancel returns acknowledged', async () => {
        const result = await stataClient.cancel('e2e-test');
        expect(result.acknowledged).toBe(true);
    });
});
```

---

### Task 6 — Restore `smcl_layout` and preserve other UI tests

#### 6a. SMCL layout

Restore from git history as described in Task 4a. Additionally add one new case
for `{err}` tag rendering since SMCL parsing was moved from `terminal-panel.js`
to the daemon's `error_extractor.py`. Confirm `smclToHtml` still handles
`{err}` styling correctly in the browser.

#### 6b. Repro clearing

Restore from git history (Task 4b). If `safeSliceTail` is unexported, add:
```js
module.exports = { TerminalPanel, toEntry, normalizeArtifacts, safeSliceTail };
```
to `terminal-panel.js` (alongside the already-exported helpers).

---

## Coverage Summary Checklist

After all tasks are complete, verify the following are tested:

**JS unit tests:**
- [ ] `StataClient.validateFilterExpr` — valid and invalid paths
- [ ] `StataClient.computeViewIndices`
- [ ] `StataClient.listGraphs`
- [ ] `StataClient.exportGraph`
- [ ] `StataClient.getResults` — default and custom class
- [ ] `StataClient.getLogTail` — default and custom lines
- [ ] `StataClient.searchLog`
- [ ] `StataClient.getTaskStatus` — wait=false, wait=true
- [ ] `StataClient.cancelTask`
- [ ] `StataClient.setRequestTimeout`
- [ ] `StataClient._onData` fragmentation
- [ ] `StataClient` request timeout
- [ ] `StataClient` socket write error
- [ ] `StataClient._scheduleReconnect` exhaustion
- [ ] `StataClient` multi-session isolation
- [ ] `DaemonManager._findStataBinary` with STATA_PATH
- [ ] `DaemonManager.ensureRunning` Windows TCP branch
- [ ] `DaemonManager.stop` TCP transport
- [ ] `DaemonManager.health` TCP transport
- [ ] `extension.migrateSettings` — copy and skip-if-set paths
- [ ] `extension.updateStatusBar` — all four states
- [ ] `extension.runFile` handler — success and error
- [ ] `extension.terminalRunCommand` — success and error
- [ ] `extension.variableListProvider` — success and error
- [ ] `extension.downloadGraphAsPdf` — success and error
- [ ] `extension.loadStataOnStartup` — true and false
- [ ] `extension.onDidChangeConfiguration`
- [ ] `DataBrowserPanel` constructor stores stataClient
- [ ] `DataBrowserPanel.requestVariables` — success and error
- [ ] `DataBrowserPanel.requestPage` — success and error
- [ ] `DataBrowserPanel.filter` — valid, invalid, thrown
- [ ] `data-browser.js` Arrow rendering
- [ ] `data-browser.js` pagination
- [ ] `data-browser.js` variable selector
- [ ] `data-browser.js` filter interaction
- [ ] `smclToHtml` column alignment and tag rendering
- [ ] `safeSliceTail` HTML slicing
- [ ] Logging behaviour (suppression, showAllLogsInOutput, logRunToOutput)

**Python unit tests:**
- [ ] `JsonProtocol.data_received` — complete line
- [ ] `JsonProtocol.data_received` — fragmented line
- [ ] `JsonProtocol.data_received` — invalid JSON
- [ ] `StataDaemon.dispatch` — health, stop, break, run, run+background,
  task_status, task_cancel, log_read_at_offset, graph_export+auto-outpath,
  unknown method
- [ ] `StataDaemon._call_worker` timeout
- [ ] `StataDaemon.start` — unix meta file written
- [ ] `StataDaemon._idle_check` — shutdown after timeout
- [ ] `RpcClient._connect` — unix, tcp fallback, missing
- [ ] `RpcClient.call` — success, error response, connection closed
- [ ] `RpcClient.is_alive` — true, false
- [ ] `RpcClient.is_daemon_running`
- [ ] `MockDaemon.dispatch` — health, run, inspect_describe (with state),
  graph_list, break, task_status, unknown method

**Integration:**
- [ ] `DaemonManager` + `MockDaemon` + `StataClient` — health round-trip
- [ ] Full `runCode` round-trip through mock daemon
- [ ] `listVariables` round-trip
- [ ] `cancel` round-trip

---

## Notes for the Implementer

1. **`stataClient` mock needs EventEmitter.** `extension.test.js` tests that
   reference `updateStatusBar` require the harness's `stataClientMock` to be
   an actual `EventEmitter`. Update `test/helpers/extension-harness.js`:
   ```js
   const { EventEmitter } = require('events');
   // ...
   const stataClientMock = Object.assign(new EventEmitter(), {
       ensureConnected: jest.fn().mockResolvedValue(),
       // ...
   });
   ```

2. **Expose internal closures for testing.** `terminalRunCommand`,
   `variableListProvider`, `downloadGraphAsPdf` are currently module-internal.
   The lowest-friction approach is to add them to `moduleExports` alongside
   `daemonMgr` and `stataClient`, gated by `extensionMode === Test`:
   ```js
   if (context.extensionMode === vscode.ExtensionMode.Test) {
       moduleExports.terminalRunCommand = terminalRunCommand;
       moduleExports.variableListProvider = variableListProvider;
       moduleExports.downloadGraphAsPdf = downloadGraphAsPdf;
   }
   ```

3. **Python `_idle_check` refactor.** To make `test_idle_check_fires_shutdown`
   practical, extract the inner `_idle_check` coroutine from `start()` to a
   named instance method `_run_idle_check()`. No behaviour change; tests can
   then call it directly.

4. **Test runner registration.** Add the new e2e file to the integration suite
   by including `test/integration/daemon-e2e.test.js` in the glob pattern used
   by `test:integration`. Add the new Python test files under
   `mcp-stata/tests/server/` — they will be picked up automatically by pytest's
   `testpaths = tests` config.

5. **No real Stata required.** Every test in Tasks 1–5 uses mocks or the mock
   daemon. None require a live Stata licence. Mark Python tests that might
   accidentally import `sfi` with `pytest.importorskip('sfi')` as a guard.

6. **Run order.** Tasks 1–4 are independent. Task 5 (Python) is independent of
   Tasks 1–4. Task 5d (e2e) depends on Task 5a–5c being green first.
