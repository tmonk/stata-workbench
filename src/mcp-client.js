const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const vscode = require('vscode');
const pkg = require('../package.json');
const { filterMcpLogs } = require('./log-utils');
const MCP_PACKAGE_NAME = 'mcp-stata';
const MCP_SERVER_ID = 'mcp_stata';
const MCP_PACKAGE_SPEC = process.env.MCP_STATA_PACKAGE_SPEC || `${MCP_PACKAGE_NAME}@latest`;

// The MCP SDK exposes a stdio client transport we can use for VS Code.
// For Cursor, we first try a built-in bridge command if available, then fall back to stdio.
let Client;
let StdioClientTransport;
let LoggingMessageNotificationSchema;
let ProgressNotificationSchema;
let CallToolResultSchema;
let sdkLoadError = null;

try {
    // Lazy-load to avoid crashing if dependency resolution fails before activation.
    ({ Client } = require('@modelcontextprotocol/sdk/client'));
    // Use the exported stdio transport path (requires .js to satisfy exports mapping).
    ({ StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js'));

    // Notification / result schemas are needed for streaming + low-level requests.
    // Prefer the standard export, but keep a fallback path for older exports mapping.
    try {
        ({ LoggingMessageNotificationSchema, ProgressNotificationSchema, CallToolResultSchema } = require('@modelcontextprotocol/sdk/types'));
    } catch (_err) {
        ({ LoggingMessageNotificationSchema, ProgressNotificationSchema, CallToolResultSchema } = require('@modelcontextprotocol/sdk/types.js'));
    }
} catch (error) {
    // Capture the error so we can surface the root cause during activation.
    sdkLoadError = error;
}

class StataMcpClient {
    constructor() {
        this._clientPromise = null;
        this._transport = null;
        this._cursorCommand = null;
        this._statusEmitter = new EventEmitter();
        this._queue = Promise.resolve();
        this._pending = 0;
        this._active = false;
        this._cancelSignal = false;
        this._activeCancellation = null;
        this._log = () => { };
        this._recentStderr = [];
        this._workspaceRoot = null;
        this._activeRun = null;
        this._runsByTaskId = new Map();
        this._runCleanupTimers = new Map();
        // Allow larger captured logs so long .do files and errors are preserved.
        this._maxLogBufferChars = 500_000_000; // 500 MB
        this._clientVersion = pkg?.version || 'dev';
        this._onTaskDone = null;
        this._availableTools = new Set();
        this._missingRequiredTools = [];
        this._forceLatestServer = false;
        this._forceLatestAttempted = false;
    }

    _attachStderrListener(stream, source) {
        if (!stream || typeof stream.on !== 'function') return false;
        if (this._stderrStreamAttached) {
            return false;
        }
        if (stream._stataListenerAttached) {
            return false;
        }
        stream._stataListenerAttached = true;
        this._stderrStreamAttached = true;
        stream.setEncoding?.('utf8');
        stream.on('data', (chunk) => this._handleStderrData(chunk, source));
        return true;
    }

    setLogger(logger) {
        this._log = typeof logger === 'function' ? logger : () => { };
        // Immediately test that logging works
        if (typeof logger === 'function') {
            try {
                logger('[mcp-stata] setLogger called - logger is now active');
            } catch (e) {
                console.error('[mcp-stata] Logger test failed:', e);
            }
        }
    }

    setTaskDoneHandler(handler) {
        this._onTaskDone = typeof handler === 'function' ? handler : null;
    }

    onStatusChanged(listener) {
        this._statusEmitter.on('status', listener);
        return { dispose: () => this._statusEmitter.off('status', listener) };
    }

    async runSelection(selection, options = {}) {
        const { normalizeResult, includeGraphs, onLog, onRawLog, onProgress, onGraphReady, onTaskDone, runId, cancellationToken: externalCancellationToken, ...rest } = options || {};
        const config = vscode.workspace.getConfiguration('stataMcp');
        const maxOutputLines = Number.isFinite(config.get('maxOutputLines', 0)) && config.get('maxOutputLines', 0) > 0
            ? config.get('maxOutputLines', 0)
            : (config.get('maxOutputLines', 0) || undefined);
        const cwd = typeof rest.cwd === 'string' ? rest.cwd : null;
        const meta = { command: selection, cwd };

        const cts = this._createCancellationSource(externalCancellationToken);
        this._activeCancellation = cts;

        const result = await this._enqueue('run_selection', { ...rest, cancellationToken: cts.token, deferArtifacts: true }, async (client) => {
            const args = { code: selection };
            if (maxOutputLines && maxOutputLines > 0) {
                args.max_output_lines = maxOutputLines;
            }
            if (cwd && cwd.trim()) {
                args.cwd = cwd;
            }

            const progressToken = (typeof onProgress === 'function')
                ? this._generateProgressToken()
                : null;

            const nowMs = Date.now();
            const resolvedOnTaskDone = (typeof onTaskDone === 'function')
                ? onTaskDone
                : (typeof this._onTaskDone === 'function' ? this._onTaskDone : null);
            const runState = { onLog, onRawLog, onProgress, onGraphReady, onTaskDone: resolvedOnTaskDone, progressToken, baseDir: cwd, _startMs: nowMs, _createdAt: nowMs, _runId: runId || null };
            const result = await this._withActiveRun(runState, async () => {
                const kickoff = await this._callTool(client, 'run_command_background', args, { progressToken, signal: cts.abortController.signal });
                return this._awaitBackgroundResult(client, runState, kickoff, cts);
            });
            if (!runState.logPath) {
                runState.logPath = this._extractLogPathFromResponse(result);
            }
            if (!runState._skipDrain) {
                await this._drainActiveRunLog(client, runState);
            }
            meta.logText = runState._logBuffer || '';
            meta.logPath = runState.logPath || null;
            if (result && typeof result === 'object') {
                result.streamedLog = true;
                if (Array.isArray(runState._graphArtifacts) && runState._graphArtifacts.length) {
                    result.graphArtifacts = runState._graphArtifacts;
                }
            }
            runState._cancelSubscription?.dispose?.();
            return result;
        }, meta, normalizeResult === true, includeGraphs === true);
        this._activeCancellation = null;
        return result;
    }

    _filterLogChunk(text) {
        return filterMcpLogs(text);
    }

    async runFile(filePath, options = {}) {
        const { normalizeResult, includeGraphs, onLog, onRawLog, onProgress, onGraphReady, onTaskDone, runId, cancellationToken: externalCancellationToken, ...rest } = options || {};
        // Resolve working directory (configurable, defaults to the .do file folder).
        // Allow caller to override CWD (important for running temp files while preserving original CWD).
        const cwd = (rest && typeof rest.cwd === 'string') ? rest.cwd : this._resolveRunFileCwd(filePath);
        const config = vscode.workspace.getConfiguration('stataMcp');
        const maxOutputLines = Number.isFinite(config.get('maxOutputLines', 0)) && config.get('maxOutputLines', 0) > 0
            ? config.get('maxOutputLines', 0)
            : (config.get('maxOutputLines', 0) || undefined);
        const meta = { command: `do "${filePath}"`, filePath, cwd };

        const cts = this._createCancellationSource(externalCancellationToken);
        this._activeCancellation = cts;

        const result = await this._enqueue('run_file', { ...rest, cancellationToken: cts.token, deferArtifacts: true }, async (client) => {
            const args = {
                // Use absolute path so the server can locate the file, but also
                // pass cwd so any relative includes resolve.
                path: filePath,
                cwd
            };
            if (maxOutputLines && maxOutputLines > 0) {
                args.max_output_lines = maxOutputLines;
            }

            const progressToken = (typeof onProgress === 'function')
                ? this._generateProgressToken()
                : null;

            const nowMs = Date.now();
            const resolvedOnTaskDone = (typeof onTaskDone === 'function')
                ? onTaskDone
                : (typeof this._onTaskDone === 'function' ? this._onTaskDone : null);
            const runState = { onLog, onRawLog, onProgress, onGraphReady, onTaskDone: resolvedOnTaskDone, progressToken, baseDir: cwd, _startMs: nowMs, _createdAt: nowMs, _runId: runId || null };
            const result = await this._withActiveRun(runState, async () => {
                const kickoff = await this._callTool(client, 'run_do_file_background', args, { progressToken, signal: cts.abortController.signal });
                return this._awaitBackgroundResult(client, runState, kickoff, cts);
            });
            if (!runState.logPath) {
                runState.logPath = this._extractLogPathFromResponse(result);
            }
            if (!runState._skipDrain) {
                await this._drainActiveRunLog(client, runState);
            }
            meta.logText = runState._logBuffer || '';
            meta.logPath = runState.logPath || null;
            if (result && typeof result === 'object') {
                result.streamedLog = true;
                if (Array.isArray(runState._graphArtifacts) && runState._graphArtifacts.length) {
                    result.graphArtifacts = runState._graphArtifacts;
                }
            }
            runState._cancelSubscription?.dispose?.();
            return result;
        }, meta, normalizeResult === true, includeGraphs === true);
        this._activeCancellation = null;
        return result;
    }

    async run(code, options = {}) {
        const { onLog, onRawLog, onProgress, onGraphReady, cancellationToken: externalCancellationToken, ...rest } = options || {};
        const config = vscode.workspace.getConfiguration('stataMcp');
        const maxOutputLines = options.max_output_lines ??
            (config.get('maxOutputLines', 0) || undefined);

        const cwd = typeof rest.cwd === 'string' ? rest.cwd : null;
        const meta = { command: code, cwd };
        const task = async (client) => {
            const args = { code };
            if (maxOutputLines && maxOutputLines > 0) {
                args.max_output_lines = maxOutputLines;
            }
            if (cwd && cwd.trim()) {
                args.cwd = cwd;
            }

            const progressToken = (typeof onProgress === 'function')
                ? this._generateProgressToken()
                : null;

            const runState = { onLog, onRawLog, onProgress, onGraphReady, progressToken, baseDir: cwd };
            const result = await this._withActiveRun(runState, async () => {
                const kickoff = await this._callTool(client, 'run_command_background', args, { progressToken, signal: cts.abortController.signal });
                return this._awaitBackgroundResult(client, runState, kickoff, cts);
            });
            if (!runState.logPath) {
                runState.logPath = this._extractLogPathFromResponse(result);
            }
            if (!runState._skipDrain) {
                await this._drainActiveRunLog(client, runState);
            }
            meta.logText = runState._logBuffer || '';
            meta.logPath = runState.logPath || null;
            if (result && typeof result === 'object') {
                result.streamedLog = true;
                if (Array.isArray(runState._graphArtifacts) && runState._graphArtifacts.length) {
                    result.graphArtifacts = runState._graphArtifacts;
                }
            }
            runState._cancelSubscription?.dispose?.();
            return result;
        };
        const cts = this._createCancellationSource(externalCancellationToken);
        this._activeCancellation = cts;

        const result = await this._enqueue('run_command', { ...rest, cancellationToken: cts.token, deferArtifacts: true }, task, meta, true, true);
        this._activeCancellation = null;
        return result;
    }

    async viewData(start = 0, count = 50, options = {}) {
        return this._enqueue('view_data', options, async (client) => {
            const response = await this._callTool(client, 'get_data', { start, count });
            return this._parseJson(response);
        });
    }

    async getUiChannel(options = {}) {
        return this._enqueue('get_ui_channel', options, async (client) => {
            const response = await this._callTool(client, 'get_ui_channel', {});
            const text = this._extractText(response);
            return this._tryParseJson(text) || this._parseJson(response);
        });
    }

    async getVariableList(options = {}) {
        return this._enqueue('get_variable_list', options, async (client) => {
            const response = await this._callTool(client, 'get_variable_list', {});
            return this._normalizeVariableList(response);
        });
    }

    async listGraphs(options = {}) {
        return this._enqueue('list_graphs', options, async (client) => {
            let raw;
            try {
                raw = await this._callTool(client, 'list_graphs', {});
            } catch (err) {
                this._log(`[mcp-stata] list_graphs failed: ${err}`);
                throw err;
            }
            const artifacts = await this._resolveArtifactsFromList(raw, options?.baseDir, client);
            return { graphs: artifacts };
        });
    }

    async fetchGraph(name, options = {}) {
        return this._enqueue('fetch_graph', options, async (client) => {
            // Respect requested format; default to server default (often SVG) unless format is provided.
            const preferredFormat = options.format || null;
            const baseArgs = { graph_name: name };
            const primaryArgs = preferredFormat ? { ...baseArgs, format: preferredFormat } : baseArgs;

            const primary = await this._callTool(client, 'export_graph', primaryArgs);
            let artifact = this._graphResponseToArtifact(primary, name, options.baseDir);

            // If the server returned a non-PDF artifact (e.g., SVG) and we need PDF, try again forcing PDF.
            const hasPdfPath = artifact?.path && /\.pdf$/i.test(artifact.path);
            if (preferredFormat === 'pdf' && !hasPdfPath) {
                try {
                    const fallback = await this._callTool(client, 'export_graph', { ...baseArgs, format: 'pdf' });
                    const fallbackArtifact = this._graphResponseToArtifact(fallback, name, options.baseDir);
                    if (fallbackArtifact && (fallbackArtifact.path && /\.pdf$/i.test(fallbackArtifact.path))) {
                        artifact = fallbackArtifact;
                    }
                } catch (err) {
                    this._log(`[mcp-stata fetchGraph pdf fallback] ${err?.message || err}`);
                }
            }

            return artifact;
        });
    }

    async exportAllGraphs(options = {}) {
        return this._enqueue('export_all_graphs', options, async (client) => {
            const artifacts = await this._collectGraphArtifacts(client, options);
            return { graphs: artifacts };
        });
    }

    async dispose() {
        if (this._transport && typeof this._transport.close === 'function') {
            try {
                await this._transport.close();
            } catch (error) {
                // Ignore shutdown issues
            }
        }
        this._clientPromise = null;
    }

    async cancelAll() {
        if (!this._clientPromise && !this._active && this._pending === 0) {
            return false;
        }
        this._cancelSignal = true;
        if (this._activeCancellation) {
            this._activeCancellation.cancel('user cancelled');
        }
        // Stop log tailing on any active run
        if (this._activeRun) {
            this._activeRun._tailCancelled = true;
            this._activeRun._cancelled = true;
        }
        if (this._activeRun?.taskId) {
            try {
                const client = await this._ensureClient();
                await this._cancelTask(client, this._activeRun.taskId);
            } catch (err) {
                this._log(`[mcp-stata] cancel_task failed: ${err?.message || err}`);
            }
        }
        this._statusEmitter.emit('status', this._pending > 0 ? 'queued' : 'connected');
        return true;
    }

    _createCancellationSource(externalCancellationToken) {
        const abortController = new AbortController();
        const listeners = new Set();
        const token = {
            isCancellationRequested: false,
            onCancellationRequested: (cb) => {
                if (typeof cb !== 'function') return { dispose: () => { } };
                listeners.add(cb);
                return { dispose: () => listeners.delete(cb) };
            }
        };

        const cancel = (reason = 'cancelled') => {
            if (token.isCancellationRequested) return false;
            token.isCancellationRequested = true;
            try {
                abortController.abort(reason);
            } catch (_err) {
                abortController.abort();
            }
            for (const cb of Array.from(listeners)) {
                try {
                    cb(reason);
                } catch (_err) {
                }
            }
            if (this._activeRun) {
                this._activeRun._tailCancelled = true;
                this._activeRun._cancelled = true;
            }
            return true;
        };

        if (externalCancellationToken) {
            if (externalCancellationToken.isCancellationRequested) {
                cancel('external cancellation');
            }
            if (typeof externalCancellationToken.onCancellationRequested === 'function') {
                externalCancellationToken.onCancellationRequested((e) => {
                    cancel(e?.message || 'external cancellation');
                });
            }
        }

        return { token, cancel, abortController };
    }

    async _ensureClient() {
        if (this._clientPromise) return this._clientPromise;
        this._clientPromise = this._createClient();
        return this._clientPromise;
    }

    async _createClient() {
        this._statusEmitter.emit('status', 'connecting');
        this._recentStderr = [];

        // Cursor: try a built-in bridge if present
        const commands = await vscode.commands.getCommands(true);
        const cursorBridge = commands.find(cmd => cmd.toLowerCase().includes('cursor') && cmd.toLowerCase().includes('mcp') && cmd.toLowerCase().includes('invoke'));
        if (cursorBridge) {
            this._cursorCommand = cursorBridge;
            this._statusEmitter.emit('status', 'connected');
            this._availableTools = new Set();
            return { type: 'cursor-bridge' };
        }

        if (!Client || !StdioClientTransport) {
            this._statusEmitter.emit('status', 'error');
            const detail = sdkLoadError?.message ? ` (${sdkLoadError.message})` : '';
            throw new Error(`MCP SDK not found. Please run \`bun install\` to fetch @modelcontextprotocol/sdk.${detail}`);
        }

        const config = vscode.workspace.getConfiguration('stataMcp');
        const setupTimeoutSeconds = (() => {
            if (process.env.STATA_SETUP_TIMEOUT) return process.env.STATA_SETUP_TIMEOUT;
            const val = Number(config.get('setupTimeoutSeconds', 60));
            if (Number.isFinite(val) && val > 0) return String(Math.round(val));
            return '60';
        })();

        const uvCommand = process.env.MCP_STATA_UVX_CMD || 'uvx';
        const serverConfig = this._loadServerConfig({ ignoreCommandArgs: this._forceLatestServer });

        // Use command/args from config if available, otherwise fall back to uvx with --refresh
        const finalCommand = serverConfig.command || uvCommand;
        const finalArgs = serverConfig.args || ['--refresh', '--refresh-package', MCP_PACKAGE_NAME, '--from', `${MCP_PACKAGE_NAME}@latest`, MCP_PACKAGE_NAME];
        const configuredEnv = serverConfig.env || {};

        // Log that we're creating the transport
        this._log(`[mcp-stata] Creating StdioClientTransport`);
        const configSource = serverConfig.configPath || 'defaults (uvx --refresh --refresh-package)';
        this._log(`[mcp-stata] Config source: ${configSource}`);
        if (this._forceLatestServer && serverConfig.configPath) {
            this._log('[mcp-stata] Forcing latest server: ignoring command/args from MCP config, preserving env only.');
        }
        this._log(`[mcp-stata] Command: ${finalCommand}`);
        this._log(`[mcp-stata] Args: ${JSON.stringify(finalArgs)}`);

        const transport = new StdioClientTransport({
            command: finalCommand,
            args: finalArgs,
            stderr: 'pipe',
            cwd: this._resolveWorkspaceRoot(),
            env: {
                ...process.env,
                ...configuredEnv,
                STATA_SETUP_TIMEOUT: setupTimeoutSeconds,
                // Force Python to not buffer output
                PYTHONUNBUFFERED: '1'
            }
        });

        // Guard against unhandled transport errors (e.g., spawn ENOENT when uvx is missing).
        const transportErrorHandler = (err) => {
            const message = err?.message || String(err);
            this._recentStderr.push(message);
            if (this._recentStderr.length > 10) this._recentStderr.shift();
            this._log(`[mcp-stata transport error] ${message}`);
            this._statusEmitter.emit('status', 'error');
        };
        if (typeof transport.on === 'function') {
            transport.on('error', transportErrorHandler);
        }

        // Debug: check what properties transport has
        this._log(`[mcp-stata] Transport created. Has stderr: ${!!transport.stderr}, type: ${typeof transport.stderr}`);
        this._log(`[mcp-stata] Transport keys: ${Object.keys(transport || {}).join(', ')}`);

        // Try to access the underlying process if available
        const proc = transport._process || transport.process || transport._serverProcess;
        if (proc) {
            this._log(`[mcp-stata] Found underlying process, setting up stderr capture`);
            this._attachStderrListener(proc.stderr, 'proc');
        }

        // Capture stderr from the MCP process for debugging (original approach as fallback).
        const stderrStream = transport.stderr;
        if (stderrStream && typeof stderrStream.on === 'function') {
            this._log(`[mcp-stata] Setting up transport.stderr listener`);
            this._attachStderrListener(stderrStream, 'transport');
        } else {
            this._log(`[mcp-stata] WARNING: transport.stderr not available for capture`);
        }

        this._log(`Starting mcp-stata via ${uvCommand} --refresh --refresh-package ${MCP_PACKAGE_NAME} --from ${MCP_PACKAGE_SPEC} ${MCP_PACKAGE_NAME} (ext v${this._clientVersion})`);
        const client = new Client({ name: 'stata-vscode', version: this._clientVersion });
        if (typeof client.on === 'function') {
            client.on('error', (err) => {
                const message = err?.message || String(err);
                this._recentStderr.push(message);
                if (this._recentStderr.length > 10) this._recentStderr.shift();
                this._log(`[mcp-stata client error] ${message}`);
                this._statusEmitter.emit('status', 'error');
            });
        }

        if (typeof client.setNotificationHandler === 'function') {
            if (LoggingMessageNotificationSchema) {
                client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
                    const text = String(notification?.params?.data ?? '');
                    if (!text) return;
                    const timestamp = new Date().toLocaleTimeString();
                    const parsed = this._tryParseJson(text);
                    const event = parsed?.event;
                    this._log(`[${timestamp}] Notification received: ${event || 'logMessage'}`);
                    const taskId = parsed?.task_id || parsed?.taskId;
                    let run = this._activeRun;
                    if (!run && taskId) {
                        run = this._runsByTaskId.get(String(taskId)) || null;
                    } else if (run && taskId && run.taskId && String(run.taskId) !== String(taskId)) {
                        run = this._runsByTaskId.get(String(taskId)) || null;
                    }
                    if (!run) return;
                    if (event === 'log_path' && parsed?.path) {
                        this._ensureLogTail(client, run, String(parsed.path)).catch(() => { });
                        return;
                    }

                    if (event === 'graph_ready') {
                        const graph = parsed?.graph;
                        if (graph) {
                            const artifact = this._graphToArtifact(graph, run.baseDir, parsed);
                            if (artifact) {
                                run._graphArtifacts.push(artifact);
                                if (typeof run.onGraphReady === 'function') {
                                    try {
                                        run.onGraphReady(artifact);
                                    } catch (_err) {
                                    }
                                }
                            }
                        }
                        return;
                    }

                    if (event === 'task_done') {
                        if (taskId) {
                            run._taskDonePayload = parsed;
                            run._taskDoneTaskId = String(taskId);
                            const hasOnTaskDone = typeof run.onTaskDone === 'function';
                            const taskPayload = {
                                taskId: String(taskId),
                                runId: run?._runId || null,
                                logPath: parsed?.log_path || parsed?.logPath || null,
                                status: parsed?.status || null,
                                rc: typeof parsed?.rc === 'number' ? parsed.rc : null
                            };
                            if (hasOnTaskDone) {
                                try {
                                    run.onTaskDone(taskPayload);
                                } catch (_err) {
                                }
                            } else if (typeof this._onTaskDone === 'function') {
                                try {
                                    this._onTaskDone(taskPayload);
                                } catch (_err) {
                                }
                            }
                            run._tailCancelled = true;
                            run._fastDrain = true;
                            if (typeof run._taskDoneResolve === 'function') {
                                run._taskDoneResolve(parsed);
                            }
                        }
                        return;
                    }

                    // Stream exclusively from the log file once available; ignore logMessage output
                    // to avoid duplicate streaming and reduce latency variance.
                    if (run.logPath || run._logOnly) return;

                    // LINE BUFFERING: 
                    // To ensure syntax highlighting and SMCL parsing are consistent, we must
                    // only process full lines. Chunks cutting through lines lead to "leaked" 
                    // unhighlighted text or broken tags in the webview.
                    run._lineBuffer = (run._lineBuffer || '') + text;
                    const lines = run._lineBuffer.split(/\r?\n/);

                    // The last element is either an empty string (if chunk ended in \n)
                    // or a partial line (if it didn't). We keep it in the buffer.
                    run._lineBuffer = lines.pop();

                    // SPECIAL: If the last complete line is just a prompt, move it back into buffer
                    // to allow it to be collapsed with the next chunk in smclToHtml
                    if (lines.length > 0) {
                        const lastLine = lines[lines.length - 1];
                        if (lastLine.trim() === '.') {
                            run._lineBuffer = lines.pop() + '\n' + (run._lineBuffer || '');
                        }
                    }

                    if (lines.length > 0) {
                        // Join back the completed lines with newlines
                        const completedText = lines.join('\n') + '\n';
                        if (typeof run.onRawLog === 'function') {
                            try {
                                run.onRawLog(completedText);
                            } catch (_err) {
                            }
                        }
                        const filtered = this._filterLogChunk(completedText);
                        if (!filtered) return;
                        run._appendLog?.(filtered);
                        if (typeof run.onLog === 'function') {
                            try {
                                run.onLog(filtered);
                            } catch (_err) {
                            }
                        }
                    }
                });
            }

            if (ProgressNotificationSchema) {
                client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
                    const timestamp = new Date().toLocaleTimeString();
                    this._log(`[${timestamp}] Notification received: progress`);
                    const run = this._activeRun;
                    if (!run || typeof run.onProgress !== 'function' || run.progressToken == null) return;
                    const token = notification?.params?.progressToken;
                    if (String(token ?? '') !== String(run.progressToken)) return;
                    const progress = notification?.params?.progress;
                    const total = notification?.params?.total;
                    const message = notification?.params?.message;
                    run.onProgress(progress, total, message);
                });
            }
        }
        try {
            await client.connect(transport);
        } catch (err) {
            this._resetClientState();
            const context = this._formatRecentStderr();
            const message = err?.message || String(err);
            throw new Error(`Failed to connect to mcp-stata: ${message}${context}`);
        }
        this._log(`mcp-stata connected (pid=${transport.pid ?? 'unknown'})`);

        // After connect, try again to capture stderr from the underlying process
        // The process might only be available after start()/connect()
        const postConnectProc = transport._process || transport.process || transport._serverProcess;
        if (postConnectProc && postConnectProc.stderr && !postConnectProc.stderr._stataListenerAttached) {
            this._log(`[mcp-stata] Post-connect: Found process stderr, attaching listener`);
            this._attachStderrListener(postConnectProc.stderr, 'post_connect');
        }

        // Discover available tools so downstream calls choose the right names.
        await this._refreshToolList(client);

        this._transport = transport;
        this._statusEmitter.emit('status', 'connected');
        return client;
    }

    async _refreshToolList(client) {
        if (!client || typeof client.listTools !== 'function') {
            this._availableTools = new Set();
            return;
        }

        try {
            const res = await client.listTools();
            const names = Array.isArray(res?.tools)
                ? res.tools.map(t => t?.name).filter(Boolean)
                : [];
            this._availableTools = new Set(names);
            if (names.length) {
                this._log(`[mcp-stata] available tools: ${names.join(', ')}`);
            }
            const missing = this._getMissingRequiredTools(this._availableTools);
            this._missingRequiredTools = missing;
            if (missing.length) {
                this._log(`[mcp-stata] Missing required tools: ${missing.join(', ')}`);
            }
        } catch (err) {
            this._availableTools = new Set();
            this._log(`[mcp-stata] listTools failed: ${err?.message || err}`);
        }
    }

    async _callTool(client, name, args, callOptions = {}) {
        const toolArgs = args ?? {};
        try {
            let activeClient = client;
            if (this._availableTools?.size && !this._availableTools.has(name)) {
                await this._ensureLatestServerForMissingTool(name);
                activeClient = await this._ensureClient();
                if (this._availableTools?.size && !this._availableTools.has(name)) {
                    throw new Error(this._formatMissingToolError(name));
                }
            }

            if (activeClient.type === 'cursor-bridge' && this._cursorCommand) {
                return vscode.commands.executeCommand(this._cursorCommand, {
                    server: 'stata',
                    tool: name,
                    args: toolArgs
                });
            }

            const progressToken = callOptions?.progressToken ?? null;
            const requestOptions = callOptions?.signal ? { signal: callOptions.signal } : undefined;
            const params = {
                method: 'tools/call',
                params: {
                    name,
                    arguments: toolArgs,
                    ...(progressToken != null ? { _meta: { progressToken } } : {})
                }
            };

            if (typeof activeClient.request === 'function' && CallToolResultSchema) {
                return activeClient.request(
                    params,
                    CallToolResultSchema,
                    requestOptions
                );
            }

            return activeClient.callTool({ name, arguments: toolArgs }, undefined, requestOptions);
        } catch (error) {
            if (this._isCancellationError(error)) {
                this._statusEmitter.emit('status', 'connected');
                throw new Error('Request cancelled');
            }
            this._statusEmitter.emit('status', 'error');
            const detail = error?.message || String(error);
            let hint = '';
            if (detail.includes('-32000') || detail.includes('Connection closed') || detail.includes('ECONNRESET')) {
                this._resetClientState();
                hint = '\n\nHint: This often happens if the mcp-stata server crashes during initialization or prints logs to its stdout pipe (breaking the MCP protocol).';
                const context = this._formatRecentStderr();
                if (context) hint += `\n\nRecent logs extension captured:${context}`;
            }
            throw new Error(`MCP tool ${name} failed: ${detail}${hint}`);
        }
    }

    _requiredToolNames() {
        return new Set([
            'run_command_background',
            'run_do_file_background',
            'read_log',
            'get_ui_channel'
        ]);
    }

    _getMissingRequiredTools(toolSet) {
        const required = this._requiredToolNames();
        const missing = [];
        for (const name of required) {
            if (!toolSet?.has?.(name)) missing.push(name);
        }
        return missing;
    }

    async _ensureLatestServerForMissingTool(name) {
        if (!this._requiredToolNames().has(name)) return;
        if (this._forceLatestAttempted) return;

        this._forceLatestAttempted = true;
        this._forceLatestServer = true;
        this._log(`[mcp-stata] Required tool "${name}" missing. Forcing refresh of ${MCP_PACKAGE_SPEC} and restarting MCP client.`);
        try {
            if (this._transport && typeof this._transport.close === 'function') {
                await this._transport.close();
            }
        } catch (_err) {
        }
        this._resetClientState();
    }

    _formatMissingToolError(name) {
        const available = this._availableTools?.size ? Array.from(this._availableTools).join(', ') : 'none';
        const required = Array.from(this._requiredToolNames()).join(', ');
        const specHint = MCP_PACKAGE_SPEC ? ` (package spec: ${MCP_PACKAGE_SPEC})` : '';
        return `MCP tool ${name} is not available in the connected server. Required tools: ${required}. Available tools: ${available}.${specHint}`;
    }

    async _withActiveRun(run, fn) {
        const prev = this._activeRun;
        if (run && typeof run === 'object') {
            if (!run._debugId) {
                run._debugId = `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
            }
            run.logPath = run.logPath || null;
            run.logOffset = typeof run.logOffset === 'number' ? run.logOffset : 0;
            run._tailCancelled = false;
            run._tailPromise = null;
            run._logBuffer = '';
            run._lineBuffer = '';
            run._fastDrain = false;
            run._skipDrain = false;
            run._graphArtifacts = [];
            run._appendLog = (text) => {
                const chunk = String(text ?? '');
                if (!chunk) return;
                run._logBuffer = this._appendBounded(run._logBuffer, chunk, this._maxLogBufferChars);
            };
            run._logOnly = true;
            run._taskDonePayload = null;
            run._taskDoneTaskId = null;
            run._taskDoneResolve = null;
        }
        this._activeRun = run;
        try {
            return await fn();
        } finally {
            // Restore previous run (defensive) rather than always clearing.
            this._activeRun = prev;
            if (run?.taskId) {
                this._scheduleRunCleanup(String(run.taskId));
            }
        }
    }

    _appendBounded(existing, chunk, maxChars) {
        const next = `${existing || ''}${chunk || ''}`;
        if (maxChars && next.length > maxChars) {
            // Trim from the front so the newest output/error is retained.
            return next.slice(-maxChars);
        }
        return next;
    }

    async _drainActiveRunLog(client, run) {
        if (!run || !run.logPath) return;
        run._tailCancelled = true;
        if (run._tailPromise) {
            try {
                await run._tailPromise;
            } catch (_err) {
            }
        }

        const maxEmptyReads = run._fastDrain ? 1 : 10;
        const maxIterations = run._fastDrain ? 6 : 200;
        const idleDelay = run._fastDrain ? 10 : 50;
        let emptyReads = 0;
        for (let i = 0; i < maxIterations; i++) {
            const slice = await this._readLogSlice(client, run.logPath, run.logOffset, 65536);
            if (!slice) break;
            if (typeof slice.next_offset === 'number') {
                run.logOffset = slice.next_offset;
            }
            const data = String(slice.data ?? '');
            if (data) {
                // LINE BUFFERING: Apply same logic here
                run._lineBuffer = (run._lineBuffer || '') + data;
                const lines = run._lineBuffer.split(/\r?\n/);
                run._lineBuffer = lines.pop();

                if (lines.length > 0) {
                    const lastLine = lines[lines.length - 1];
                    if (lastLine.trim() === '.') {
                        run._lineBuffer = lines.pop() + '\n' + (run._lineBuffer || '');
                    }
                }

                if (lines.length > 0) {
                    const completedText = lines.join('\n') + '\n';
                    if (typeof run.onRawLog === 'function') {
                        try {
                            run.onRawLog(completedText);
                        } catch (_err) {
                        }
                    }
                    const filtered = this._filterLogChunk(completedText);
                    if (filtered) {
                        run._appendLog?.(filtered);
                    }
                }
                emptyReads = 0;
            } else {
                emptyReads += 1;
                if (emptyReads >= maxEmptyReads) break;
                await this._delay(idleDelay);
            }
        }

        // FINAL FLUSH: If any partial line remains in buffer, flush it now
        if (run._lineBuffer) {
            if (typeof run.onRawLog === 'function') {
                try {
                    run.onRawLog(run._lineBuffer);
                } catch (_err) {
                }
            }
            const filtered = this._filterLogChunk(run._lineBuffer);
            if (filtered) {
                run._appendLog?.(filtered);
                if (typeof run.onLog === 'function') {
                    run.onLog(filtered);
                }
            }
            run._lineBuffer = '';
        }
    }

    async _ensureLogTail(client, run, logPath) {
        if (!run || !logPath) return;
        if (run.logPath && run.logPath === logPath && run._tailPromise) return;
        run.logPath = logPath;
        run.logOffset = typeof run.logOffset === 'number' ? run.logOffset : 0;
        run._tailCancelled = false;
        run._tailPromise = this._tailLogLoop(client, run).catch((err) => {
            this._log(`[mcp-stata] log tail error: ${err?.message || err}`);
        });
    }

    async _tailLogLoop(client, run) {
        while (run && !run._tailCancelled) {
            const slice = await this._readLogSlice(client, run.logPath, run.logOffset, 65536);
            if (!slice) {
                await this._delay(50);
                continue;
            }

            if (typeof slice.next_offset === 'number') {
                run.logOffset = slice.next_offset;
            }
            const data = String(slice.data ?? '');
            if (data) {
                run._lastLogAt = Date.now();
                run._idleLogged = false;
                // LINE BUFFERING: Apply same logic to tailing
                run._lineBuffer = (run._lineBuffer || '') + data;
                const lines = run._lineBuffer.split(/\r?\n/);
                run._lineBuffer = lines.pop();

                if (lines.length > 0) {
                    const lastLine = lines[lines.length - 1];
                    if (lastLine.trim() === '.') {
                        run._lineBuffer = lines.pop() + '\n' + (run._lineBuffer || '');
                    }
                }

                if (lines.length > 0) {
                    const completedText = lines.join('\n') + '\n';
                    if (typeof run.onRawLog === 'function') {
                        try {
                            run.onRawLog(completedText);
                        } catch (_err) {
                        }
                    }
                    const filtered = this._filterLogChunk(completedText);
                    if (filtered) {
                        run._appendLog?.(filtered);
                        if (typeof run.onLog === 'function') {
                            try {
                                run.onLog(filtered);
                            } catch (_err) {
                            }
                        }
                    } else {
                        // All lines were filtered out
                        await this._delay(50);
                    }
                } else {
                    // No full lines yet, need to wait for more data
                    await this._delay(25);
                }
            } else {
                const lastAt = run._lastLogAt || 0;
                if (!run._idleLogged && lastAt && Date.now() - lastAt > 500) {
                    run._idleLogged = true;
                }
                // No data at all, wait longer
                await this._delay(50);
            }
        }
    }

    async readLog(path, offset, maxBytes) {
        return this._enqueue('read_log', { timeoutMs: 10000 }, async (client) => {
            return this._readLogSlice(client, path, offset, maxBytes);
        });
    }

    async _readLogSlice(client, path, offset, maxBytes) {
        try {
            const resp = await this._callTool(client, 'read_log', { path, offset, max_bytes: maxBytes });
            const parsed = this._parseToolJson(resp);
            if (parsed && typeof parsed === 'object' && (parsed.data !== undefined || parsed.next_offset !== undefined)) {
                 return parsed;
            }
            this._log(`[mcp-stata] read_log returned unexpected format or failed to parse. resp type: ${typeof resp}`);
            return null;
        } catch (err) {
            this._log(`[mcp-stata] read_log failed: ${err?.message || err}`);
            return null;
        }
    }

    _extractText(response) {
        if (typeof response === 'string') return response;
        if (response?.text && typeof response.text === 'string') return response.text;
        if (Array.isArray(response?.content)) {
            const flattened = this._flattenContent(response.content);
            if (typeof flattened === 'string' && flattened.trim()) return flattened;
        }
        if (response?.structuredContent?.result && typeof response.structuredContent.result === 'string') {
            return response.structuredContent.result;
        }
        return '';
    }

    _extractLogPathFromResponse(response) {
        if (!response) return null;
        const direct = response?.log_path || response?.logPath || response?.structuredContent?.log_path;
        if (typeof direct === 'string' && direct.trim()) return direct;
        const text = this._extractText(response);
        const parsed = this._tryParseJson(text);
        const lp = parsed?.log_path || parsed?.logPath || parsed?.error?.log_path || parsed?.error?.logPath;
        if (typeof lp === 'string' && lp.trim()) return lp;
        return null;
    }

    _extractTaskIdFromResponse(response) {
        if (!response) return null;
        const direct = response?.task_id || response?.taskId || response?.structuredContent?.task_id;
        if (typeof direct === 'string' && direct.trim()) return direct;
        const text = this._extractText(response);
        const parsed = this._tryParseJson(text);
        const taskId = parsed?.task_id || parsed?.taskId || parsed?.error?.task_id || parsed?.error?.taskId;
        if (typeof taskId === 'string' && taskId.trim()) return taskId;
        return null;
    }

    _parseToolJson(response) {
        if (!response) return null;
        if (typeof response === 'object' && !Array.isArray(response)) {
            if (Array.isArray(response.content)) {
                const text = this._extractText(response);
                return this._tryParseJson(text);
            }
            return response;
        }
        const text = this._extractText(response);
        return this._tryParseJson(text);
    }

    _isTaskDone(status) {
        if (!status || typeof status !== 'object') return false;
        if (status.done === true) return true;
        if (status.running === true) return false;
        const value = String(status.status || status.state || '').toLowerCase();
        return ['done', 'completed', 'finished', 'error', 'failed', 'cancelled', 'canceled'].includes(value);
    }

    async _awaitBackgroundResult(client, runState, kickoff, cts) {
        if (!runState) return kickoff;
        const logPath = runState.logPath || this._extractLogPathFromResponse(kickoff);
        if (logPath) {
            await this._ensureLogTail(client, runState, logPath);
        }
        const taskId = this._extractTaskIdFromResponse(kickoff);
        if (taskId) {
            runState.taskId = taskId;
            this._trackRunForTask(taskId, runState);
        }
        this._attachTaskCancellation(client, runState, cts);
        if (!taskId) return kickoff;
        const taskDone = await this._awaitTaskDone(runState, taskId, cts?.token);
        runState._fastDrain = true;
        if (runState?._tailPromise) {
            runState._tailCancelled = true;
        }
        const taskPayload = taskDone?.result ?? taskDone;
        const parsedTask = this._parseToolJson(taskPayload);
        if (parsedTask && typeof parsedTask === 'object') {
            if (!parsedTask.log_path && logPath) parsedTask.log_path = logPath;
            if (!parsedTask.task_id) parsedTask.task_id = taskId;
            return parsedTask;
        }
        return kickoff;
    }

    _trackRunForTask(taskId, runState) {
        if (!taskId || !runState) return;
        const key = String(taskId);
        this._runsByTaskId.set(key, runState);
        const existingTimer = this._runCleanupTimers.get(key);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this._runCleanupTimers.delete(key);
        }
    }

    _scheduleRunCleanup(taskId, delayMs = 30000) {
        if (!taskId) return;
        const key = String(taskId);
        if (this._runCleanupTimers.has(key)) return;
        const timer = setTimeout(() => {
            this._runsByTaskId.delete(key);
            this._runCleanupTimers.delete(key);
        }, delayMs);
        this._runCleanupTimers.set(key, timer);
    }

    _attachTaskCancellation(client, runState, cts) {
        if (!runState || !cts?.token || typeof cts.token.onCancellationRequested !== 'function') return;
        if (!runState.taskId || runState._cancelSubscription) return;
        runState._cancelSubscription = cts.token.onCancellationRequested(async () => {
            runState._cancelled = true;
            if (!runState.taskId) return;
            try {
                await this._cancelTask(client, runState.taskId);
            } catch (err) {
                this._log(`[mcp-stata] cancel_task failed: ${err?.message || err}`);
            }
        });
    }

    async _cancelTask(client, taskId) {
        if (!client || !taskId) return;
        try {
            await this._callTool(client, 'cancel_task', { task_id: taskId });
        } catch (err) {
            throw err;
        }
    }

    async _awaitTaskDone(runState, taskId, cancellationToken) {
        if (!runState || !taskId) return null;
        const taskIdText = String(taskId);
        if (runState._taskDonePayload && (!runState._taskDoneTaskId || runState._taskDoneTaskId === taskIdText)) {
            return runState._taskDonePayload;
        }

        return new Promise((resolve, reject) => {
            let cancelSub = null;
            const finish = (payload) => {
                if (cancelSub?.dispose) cancelSub.dispose();
                resolve(payload);
            };

            runState._taskDoneResolve = finish;

            if (runState._taskDonePayload && (!runState._taskDoneTaskId || runState._taskDoneTaskId === taskIdText)) {
                return finish(runState._taskDonePayload);
            }

            if (cancellationToken?.onCancellationRequested) {
                cancelSub = cancellationToken.onCancellationRequested(() => {
                    reject(new Error('Request cancelled'));
                });
            }
        });
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _generateProgressToken() {
        return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }

    async _enqueue(label, options = {}, task, meta = {}, normalize = false, collectArtifacts = false) {
        const config = vscode.workspace.getConfiguration('stataMcp');
        const timeoutMs = options.timeoutMs ?? config.get('requestTimeoutMs', 45000);

        this._pending += 1;
        this._statusEmitter.emit('status', this._active ? 'running' : 'queued');

        const work = async () => {
            const startedAt = Date.now();
            if (this._cancelSignal || options?.cancellationToken?.isCancellationRequested) {
                const wasGlobal = this._cancelSignal;
                this._pending = Math.max(0, this._pending - 1);
                if (this._pending === 0) {
                    this._cancelSignal = false;
                }
                throw new Error('Request cancelled');
            }

            this._active = true;
            this._statusEmitter.emit('status', 'running');
            try {
                const client = await this._ensureClient();
                const result = await this._withTimeout(task(client), timeoutMs, label, options?.cancellationToken);
                const endedAt = Date.now();
                const normalizedMeta = { ...meta, startedAt, endedAt, durationMs: endedAt - startedAt, label };
                const processed = normalize
                    ? this._normalizeResponse(result, normalizedMeta)
                    : (typeof result === 'object' && result !== null ? result : { raw: result, ...normalizedMeta });
                if (collectArtifacts && !options?.deferArtifacts) {
                    const artifacts = await this._collectGraphArtifacts(client, meta);
                    if (artifacts.length) {
                        processed.artifacts = artifacts;
                        processed.graphArtifacts = artifacts;
                    }
                }
                return processed;
            } catch (error) {
                if (this._isCancellationError(error)) {
                    this._statusEmitter.emit('status', this._pending > 0 ? 'queued' : 'connected');
                } else {
                    this._statusEmitter.emit('status', 'error');
                    this._log(`[mcp-stata error] ${error?.message || error}`);
                }
                throw error;
            } finally {
                this._active = false;
                this._pending = Math.max(0, this._pending - 1);
                if (this._pending === 0) {
                    this._cancelSignal = false;
                }
                if (this._pending > 0) {
                    this._statusEmitter.emit('status', 'queued');
                } else {
                    this._statusEmitter.emit('status', 'connected');
                }
            }
        };

        const next = this._queue.then(work, work);
        this._queue = next.catch(() => { });
        return next;
    }

    async _withTimeout(promise, timeoutMs, label, cancellationToken) {
        if (!timeoutMs && !cancellationToken) return promise;

        return new Promise((resolve, reject) => {
            let timer = null;
            if (timeoutMs) {
                timer = setTimeout(() => {
                    const context = this._formatRecentStderr();
                    reject(new Error(`${label} timed out after ${timeoutMs}ms${context}`));
                }, timeoutMs);
            }

            const onCancel = () => {
                if (timer) clearTimeout(timer);
                reject(new Error(`${label} cancelled`));
            };

            if (cancellationToken && typeof cancellationToken.onCancellationRequested === 'function') {
                cancellationToken.onCancellationRequested(onCancel);
            }

            promise.then((value) => {
                if (timer) clearTimeout(timer);
                resolve(value);
            }).catch((error) => {
                if (timer) clearTimeout(timer);
                reject(error);
            });
        });
    }

    _normalizeResponse(response, meta = {}) {
        const startedAt = meta.startedAt ?? null;
        const endedAt = meta.endedAt ?? null;
        const durationMs = meta.durationMs ?? (endedAt && startedAt ? endedAt - startedAt : null);

        // Try to coerce strings/content into objects when possible.
        const flattenedContent = response?.content ? this._flattenContent(response.content) : '';
        const parsedFromContent = this._tryParseJson(flattenedContent);
        const parsedFromString = typeof response === 'string' ? this._tryParseJson(response) : null;
        const payload = typeof response === 'object' && !Array.isArray(response) ? response : {};
        const parsed = parsedFromString || parsedFromContent || {};

        const hasStructuredContent = !!(parsedFromContent || parsedFromString);
        const safeContentText = hasStructuredContent ? '' : flattenedContent;

        const logText = typeof meta.logText === 'string' ? meta.logText : '';

        const normalized = {
            success: true,
            rc: firstNumber([payload?.error?.rc, parsed?.error?.rc, payload.rc, parsed.rc]),
            command: meta.command || payload.command || parsed.command || meta.label,
            stdout: '',
            stderr: '',
            startedAt,
            endedAt,
            durationMs,
            label: meta.label,
            cwd: meta.cwd || (meta.filePath ? path.dirname(meta.filePath) : null),
            filePath: meta.filePath,
            contentText: safeContentText || parsed.stdout || '',
            logPath: meta.logPath || parsed.log_path || payload.log_path || payload?.error?.log_path || parsed?.error?.log_path || null,
            logSize: parsed.log_size || payload.log_size || parsed.logSize || payload.logSize || null,
            raw: response
        };

        const artifactList = firstArray([
            payload.graphArtifacts,
            parsed.graphArtifacts,
            payload.artifacts,
            parsed.artifacts
        ]);
        if (artifactList) {
            normalized.graphArtifacts = artifactList;
            if (Array.isArray(payload.artifacts) || Array.isArray(parsed.artifacts)) {
                normalized.artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : parsed.artifacts;
            } else {
                normalized.artifacts = artifactList;
            }
        }

        if (payload.success === false || parsed.success === false) normalized.success = false;
        if (typeof normalized.rc === 'number' && normalized.rc !== 0) normalized.success = false;

        const stdoutCandidate = firstText([
            parsed.stdout,
            payload.stdout,
            safeContentText,
            (typeof response === 'string' && !hasStructuredContent) ? response : null,
            payload.result,
            parsed.result
        ]);

        const stdoutCandidates = [logText, stdoutCandidate].filter((s) => typeof s === 'string' && s.trim());
        if (stdoutCandidates.length) {
            stdoutCandidates.sort((a, b) => b.length - a.length);
            normalized.stdout = stdoutCandidates[0];
        }

        const stderrCandidate = firstTextish([
            payload.stderr,
            parsed.stderr,
            payload.error?.stderr,
            parsed.error?.stderr,
            payload.error?.snippet,
            parsed.error?.snippet,
            payload.error?.message,
            parsed.error?.message
        ]);
        if (stderrCandidate) normalized.stderr = stderrCandidate;

        // If we still have no stderr but received a non-zero RC, fall back to the log tail
        // so the user can see the actual Stata error (e.g., type mismatch, r(109)).
        if (!normalized.stderr && typeof normalized.rc === 'number' && normalized.rc !== 0) {
            const tailSource = firstText([
                logText,
                stdoutCandidate,
                safeContentText,
                parsed.result,
                payload.result
            ]);
            if (tailSource) {
                const tail = tailSource.slice(-8000); // keep the recent context, bounded
                normalized.stderr = tail;
            }
        }

        if (payload.error || parsed.error) {
            normalized.success = false;
            const err = payload.error || parsed.error;
            const parts = [];
            if (err?.message) parts.push(err.message);
            if (err?.snippet) parts.push(err.snippet);
            if (!normalized.stderr && parts.length) normalized.stderr = parts.join('\n');
        }

        return normalized;

        function firstNumber(candidates) {
            for (const v of candidates) {
                if (typeof v === 'number' && !Number.isNaN(v)) return v;
            }
            return 0;
        }

        function firstText(candidates) {
            for (const v of candidates) {
                if (typeof v === 'string' && v.trim()) return v;
            }
            return '';
        }

        // Like firstText, but also understands objects that carry SCML/text payloads.
        function firstTextish(candidates) {
            for (const v of candidates) {
                if (typeof v === 'string' && v.trim()) return v;
                if (v && typeof v === 'object') {
                    const maybe = v.scml || v.text || v.value;
                    if (typeof maybe === 'string' && maybe.trim()) return maybe;
                }
            }
            return '';
        }

        function firstArray(candidates) {
            for (const v of candidates) {
                if (Array.isArray(v)) return v;
            }
            return null;
        }
    }

    _normalizeVariableList(response) {
        const parsed = this._parseJson(response?.text ?? response);
        const source = this._firstVarList(parsed) || this._firstVarList(response) || [];
        return source
            .map((v) => {
                if (typeof v === 'string') return { name: v, label: '' };
                if (!v || typeof v !== 'object') return null;
                const name = v.name || v.variable || v.var || v.key || v.label;
                if (!name) return null;
                const label = v.label || v.desc || v.description || '';
                return { name, label };
            })
            .filter(Boolean);
    }

    _firstVarList(candidate) {
        if (!candidate) return null;
        if (Array.isArray(candidate)) return candidate;
        if (Array.isArray(candidate?.variables)) return candidate.variables;
        if (Array.isArray(candidate?.vars)) return candidate.vars;
        if (Array.isArray(candidate?.data)) return candidate.data;
        if (Array.isArray(candidate?.list)) return candidate.list;
        if (Array.isArray(candidate?.content)) {
            for (const item of candidate.content) {
                const fromItem = this._firstVarList(item);
                if (fromItem) return fromItem;
                if (item?.text) {
                    const parsed = this._parseJson(item.text);
                    const fromParsed = this._firstVarList(parsed);
                    if (fromParsed) return fromParsed;
                }
            }
        }
        if (typeof candidate === 'string') {
            const parsed = this._tryParseJson(candidate);
            if (parsed) return this._firstVarList(parsed);
        }
        return null;
    }

    _parseJson(maybeJson) {
        if (typeof maybeJson === 'string') {
            try {
                return JSON.parse(maybeJson);
            } catch (_err) {
                return {};
            }
        }
        return maybeJson || {};
    }

    _flattenContent(content) {
        if (!Array.isArray(content)) return '';
        const lines = [];
        for (const item of content) {
            if (typeof item === 'string') {
                lines.push(item);
            } else if (item && typeof item === 'object' && typeof item.text === 'string') {
                lines.push(item.text);
            }
        }
        return lines.join('\n');
    }

    _resetClientState() {
        this._clientPromise = null;
        this._transport = null;
        this._availableTools = new Set();
        // NOTE: We don't always clear _recentStderr here because we might want to 
        // show it to the user in the error message immediately after this call.
        // It's cleared at the START of _createClient.
    }

    _handleStderrData(chunk, source = 'unknown') {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (!text?.trim()) return;
        const trimmed = text.trimEnd();

        // If we see a success message or new discovery, clear previous errors (ghost failures from other candidates)
        if (trimmed.includes('initialized successfully') ||
            trimmed.includes('stata_setup.config succeeded') ||
            trimmed.includes('Auto-discovered Stata') ||
            trimmed.includes('Discovery found Stata') ||
            trimmed.includes('Pre-flight succeeded')) {
            this._recentStderr = [];
        }

        this._log(`[mcp-stata stderr] ${trimmed}`);
        this._recentStderr.push(trimmed);
        if (this._recentStderr.length > 10) {
            this._recentStderr.shift();
        }
    }

    _formatRecentStderr() {
        if (!this._recentStderr?.length) return '';

        // Prioritize lines that look like fatal errors or runtime crashes
        const criticalLines = this._recentStderr.filter(line =>
            line.includes('FATAL') ||
            line.includes('ERROR') ||
            line.includes('RuntimeError') ||
            line.includes('PREFLIGHT_FAIL') ||
            line.includes('failed to initialize Stata')
        );

        const displayedLines = criticalLines.length > 0 ? criticalLines : this._recentStderr.slice(-5);
        return `\n\n>>> ${displayedLines.join('\n>>> ')}`;
    }

    _tryParseJson(text) {
        if (!text || typeof text !== 'string') return null;
        const trimmed = text.trim();
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
        try {
            return JSON.parse(trimmed);
        } catch (_err) {
            return null;
        }
    }


    _resolveWorkspaceRoot() {
        if (this._workspaceRoot) return this._workspaceRoot;
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            this._workspaceRoot = folders[0].uri.fsPath;
            return this._workspaceRoot;
        }
        return undefined;
    }

    _resolveRunFileCwd(filePath) {
        const fileDir = path.dirname(filePath);
        const config = vscode.workspace.getConfiguration('stataMcp');
        const rawTemplate = config.get('runFileWorkingDirectory', '');
        const template = typeof rawTemplate === 'string' ? rawTemplate : '';
        if (!template.trim()) return path.normalize(fileDir);

        const workspaceRoot = this._resolveWorkspaceRoot() || '';
        const replacements = {
            workspaceFolder: workspaceRoot,
            workspaceRoot,
            fileDir
        };

        const expanded = template.replace(/\$\{([^}]+)\}/g, (_m, key) => {
            if (Object.prototype.hasOwnProperty.call(replacements, key)) {
                return replacements[key] || '';
            }
            return '';
        }).trim();

        if (!expanded) return path.normalize(fileDir);

        const homeExpanded = expanded.startsWith('~')
            ? path.join(process.env.HOME || process.env.USERPROFILE || '', expanded.slice(1))
            : expanded;

        if (path.isAbsolute(homeExpanded)) {
            return path.normalize(homeExpanded);
        }

        if (workspaceRoot) {
            return path.normalize(path.join(workspaceRoot, homeExpanded));
        }

        return path.normalize(path.resolve(homeExpanded));
    }

    async _collectGraphArtifacts(client, meta = {}) {
        try {
            let response;
            let lastError = null;
            response = await this._callTool(client, 'export_graphs_all', {});
            this._log(`[mcp-stata graphs] export_graphs_all response: ${this._stringifySafe(response)}`);

            if (!response) {
                if (lastError) throw lastError;
                return [];
            }

            const resolved = await this._resolveArtifactsFromList(response, meta?.cwd, client);
            this._log(`[mcp-stata graphs] resolved artifacts.`); // : ${this._stringifySafe(resolved)}`);
            return resolved;
        } catch (error) {
            this._log(`[mcp-stata graph collection error] ${error?.message || error}`);
            return [];
        }
    }

    async _resolveArtifactsFromList(response, baseDir, client) {
        const graphs = this._firstGraphs(response);
        this._log(`[mcp-stata graphs] parsed graphs: ${this._stringifySafe(graphs)}`);
        const artifacts = [];
        if (!graphs || !Array.isArray(graphs)) return [];

        for (const g of graphs) {
            // Check if graph already has data (file_path, path, url, etc)
            const hasData = g && typeof g === 'object' && (g.file_path || g.path || g.url || g.href || g.link);

            if (hasData) {
                // Graph already has data, just convert it
                const artifact = this._graphToArtifact(g, baseDir, response);
                if (artifact) {
                    artifacts.push(artifact);
                    this._log(`[mcp-stata graphs] parsed artifact: ${this._stringifySafe(artifact)}`);
                }
            } else {
                // Graph needs to be exported - it only has metadata (name, active, etc)
                const graphName = (typeof g === 'string') ? g : (g?.name || g?.graph_name || g?.label);

                if (graphName && client) {
                    try {
                        // Export the graph to get actual file data
                        const exportResponse = await this._exportGraphPreferred(client, graphName);
                        const artifact = this._graphResponseToArtifact(exportResponse, graphName, baseDir);

                        if (artifact) {
                            artifacts.push(artifact);
                            this._log(`[mcp-stata graphs] exported artifact: ${this._stringifySafe(artifact)}`);
                        } else {
                            this._log(`[mcp-stata graphs] export returned no data for: ${graphName}`);
                        }
                    } catch (err) {
                        this._log(`[mcp-stata graphs] export failed for ${graphName}: ${err?.message || err}`);
                        artifacts.push({
                            label: graphName,
                            error: `Export failed: ${err.message || String(err)}`
                        });
                    }
                } else {
                    this._log(`[mcp-stata graphs] no graph name found in: ${this._stringifySafe(g)}`);
                }
            }
        }

        return artifacts;
    }

    _graphToArtifact(graph, baseDir, response) {
        if (!graph) return null;
        // Handle simple string responses (e.g., plain path).
        if (typeof graph === 'string') {
            const trimmed = graph.trim();
            if (!trimmed) return null;
            return this._artifactFromText(trimmed, baseDir || response?.baseDir || response?.base_dir || null);
        }

        // Handle text-wrapped payloads from MCP (e.g., { type: "text", text: "<path>" }).
        if (graph?.text && typeof graph.text === 'string') {
            const parsed = this._parseArtifactLikeJson(graph.text, baseDir || response?.baseDir || response?.base_dir || null);
            if (parsed) return parsed;
            const fromText = this._artifactFromText(graph.text, baseDir || response?.baseDir || response?.base_dir || null);
            if (fromText) return fromText;
        }

        const label = graph.name || graph.label || graph.graph_name || 'graph';
        const base = graph.baseDir || graph.base_dir || baseDir || response?.baseDir || response?.base_dir || null;
        const href = graph.file_path || graph.url || graph.href || graph.link || graph.path || graph.file || graph.filename || null;
        if (!href) return null;
        return {
            label,
            path: href,
            baseDir: base
        };
    }

    _graphResponseToArtifact(resp, label, baseDir) {
        if (!resp) return null;
        // If structuredContent carries a result string, try that first.
        const structured = resp?.structuredContent?.result;
        if (structured && typeof structured === 'string') {
            const parsed = this._parseArtifactLikeJson(structured, baseDir);
            if (parsed) {
                if (label) parsed.label = label;
                return parsed;
            }
            const fromStructured = this._artifactFromText(structured, baseDir);
            if (fromStructured) {
                if (label) fromStructured.label = label;
                return fromStructured;
            }
        }

        const fromResp = this._graphToArtifact(resp, baseDir, resp);
        if (fromResp) {
            // Force label override when provided (e.g. graph name "mygraph" instead of "mcp_stata_xyz.pdf")
            if (label) fromResp.label = label;
            return fromResp;
        }
        const content = Array.isArray(resp?.content) ? resp.content : [];
        for (const item of content) {
            const art = this._graphToArtifact(item, baseDir, resp);
            if (art) {
                if (label) art.label = label;
                return art;
            }
        }
        return null;
    }


    async _exportGraphPreferred(client, name) {
        // Prefer PDF export for durable artifacts; fall back to default.
        try {
            return await this._callTool(client, 'export_graph', { graph_name: name, format: 'pdf' });
        } catch (err) {
            this._log(`[mcp-stata export_graph pdf fallback] ${err?.message || err}`);
            return await this._callTool(client, 'export_graph', { graph_name: name });
        }
    }

    _firstGraphs(candidate) {
        if (!candidate) return [];

        const collected = [];
        const pushAll = (arr) => {
            if (!Array.isArray(arr) || arr.length === 0) return;
            collected.push(...arr);
        };

        const visit = (node) => {
            if (!node) return;
            if (Array.isArray(node)) {
                pushAll(node);
                return;
            }

            if (typeof node === 'string') {
                const parsed = this._tryParseJson(node);
                if (parsed) visit(parsed);
                return;
            }

            if (typeof node !== 'object') return;

            if (Array.isArray(node.graphs)) {
                pushAll(node.graphs);
            }

            // Some MCP servers put the primary JSON payload in structuredContent.result
            if (typeof node?.structuredContent?.result === 'string') {
                const parsed = this._tryParseJson(node.structuredContent.result);
                if (parsed) visit(parsed);
            }

            // Common MCP single-text-content pattern
            if (typeof node.text === 'string') {
                const parsed = this._tryParseJson(node.text);
                if (parsed) visit(parsed);
            }

            if (Array.isArray(node.content)) {
                for (const item of node.content) {
                    visit(item);
                }
            }
        };

        // Prefer explicit top-level graphs first, then walk for chunked content.
        if (Array.isArray(candidate.graphs)) {
            pushAll(candidate.graphs);
        }
        visit(candidate);

        if (!collected.length) return [];

        // Dedupe while preserving order.
        const seen = new Set();
        const out = [];
        for (const g of collected) {
            let key;
            if (typeof g === 'string') {
                key = `s:${g}`;
            } else {
                try {
                    key = `j:${JSON.stringify(g)}`;
                } catch (_err) {
                    key = `o:${String(g)}`;
                }
            }
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(g);
        }
        return out;
    }

    _artifactFromText(text, baseDir) {
        const trimmed = (text || '').trim();
        if (!trimmed) return null;
        const label = path.basename(trimmed) || 'graph';
        return {
            label,
            path: trimmed,
            baseDir: baseDir || null
        };
    }

    _parseArtifactLikeJson(text, baseDir) {
        const parsed = this._tryParseJson(typeof text === 'string' ? text : '');
        if (!parsed || typeof parsed !== 'object') return null;

        // Common shapes: { path, url, data, mimeType }, or nested in "graph" key.
        const candidate = parsed.graph || parsed;
        const href = candidate.url || candidate.path || candidate.file || candidate.href || null;
        if (!href) return null;
        return {
            label: candidate.name || candidate.label || candidate.graph_name || path.basename(href || '') || 'graph',
            path: href,
            baseDir: baseDir || null
        };
    }

    _stringifySafe(obj) {
        try {
            return JSON.stringify(obj);
        } catch (_err) {
            try {
                return String(obj);
            } catch (__err) {
                return '<unstringifiable>';
            }
        }
    }

    _isCancellationError(error) {
        if (!error) return false;
        if (error.name === 'AbortError') return true;
        const message = String(error?.message || error || '').toLowerCase();
        return message.includes('cancelled') || message.includes('canceled') || message.includes('abort');
    }

    _loadConfiguredEnv() {
        const env = {};
        for (const configPath of this._candidateMcpConfigPaths()) {
            if (!configPath) continue;
            try {
                if (!fs.existsSync(configPath)) continue;
                const raw = fs.readFileSync(configPath, 'utf8');
                const parsed = this._safeParseJson(raw);
                const entry = parsed?.servers?.[MCP_SERVER_ID] || parsed?.mcpServers?.[MCP_SERVER_ID];
                if (entry && typeof entry.env === 'object' && entry.env !== null) {
                    Object.assign(env, entry.env);
                }
            } catch (err) {
                this._log(`[mcp-stata] Failed to read MCP env from ${configPath}: ${err?.message || err}`);
            }
        }
        return env;
    }

    _loadServerConfig({ ignoreCommandArgs = false } = {}) {
        // Load full server configuration (command, args, env) from MCP config files
        for (const configPath of this._candidateMcpConfigPaths()) {
            if (!configPath) continue;
            try {
                if (!fs.existsSync(configPath)) continue;
                const raw = fs.readFileSync(configPath, 'utf8');
                const parsed = this._safeParseJson(raw);
                const entry = parsed?.servers?.[MCP_SERVER_ID] || parsed?.mcpServers?.[MCP_SERVER_ID];
                if (entry) {
                    const env = (typeof entry.env === 'object' && entry.env !== null) ? entry.env : {};
                    this._log(`[mcp-stata] Found server config in ${configPath}`);
                    return {
                        command: ignoreCommandArgs ? null : (entry.command || null),
                        args: ignoreCommandArgs ? null : (Array.isArray(entry.args) ? entry.args : null),
                        env,
                        configPath
                    };
                }
            } catch (err) {
                this._log(`[mcp-stata] Failed to read MCP config from ${configPath}: ${err?.message || err}`);
            }
        }
        return { command: null, args: null, env: {}, configPath: null };
    }

    _candidateMcpConfigPaths() {
        const paths = new Set();
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (workspaceRoot) {
            paths.add(path.join(workspaceRoot, '.vscode', 'mcp.json'));
        }

        const hostConfig = this._resolveHostMcpPath();
        if (hostConfig) {
            paths.add(hostConfig);
        }

        return Array.from(paths).filter(Boolean);
    }

    _resolveHostMcpPath() {
        const appName = (vscode.env?.appName || '').toLowerCase();
        const home = os.homedir();
        const platform = process.platform;
        const codePath = (codeDir) => {
            if (!home) return null;
            if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', codeDir, 'User', 'mcp.json');
            if (platform === 'win32') {
                const envAppData = (process.env.APPDATA && process.env.APPDATA !== 'undefined' && process.env.APPDATA !== 'null' && process.env.APPDATA !== '')
                    ? process.env.APPDATA
                    : null;
                const roaming = envAppData || (home ? path.join(home, 'AppData', 'Roaming') : null);
                if (!roaming) return null;
                return path.join(roaming, codeDir, 'User', 'mcp.json');
            }
            return path.join(home, '.config', codeDir, 'User', 'mcp.json');
        };

        if (appName.includes('cursor')) {
            return home ? path.join(home, '.cursor', 'mcp.json') : null;
        }

        if (appName.includes('windsurf')) {
            const isNext = appName.includes('next');
            const dirName = isNext ? 'windsurf-next' : 'windsurf';
            return home ? path.join(home, '.codeium', dirName, 'mcp_config.json') : null;
        }

        if (appName.includes('antigravity')) {
            if (!home) return null;
            if (platform === 'darwin') {
                return path.join(home, 'Library', 'Application Support', 'Antigravity', 'User', 'mcp.json');
            }
            if (platform === 'win32') {
                const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
                return path.join(roaming, 'Antigravity', 'User', 'mcp.json');
            }
            return path.join(home, '.antigravity', 'mcp.json');
        }

        const isInsiders = appName.includes('insider');
        const codeDir = isInsiders ? 'Code - Insiders' : 'Code';
        return codePath(codeDir);
    }

    _safeParseJson(raw) {
        if (!raw) return {};
        try {
            return JSON.parse(raw);
        } catch (_err) {
            try {
                const stripped = raw
                    .replace(/\/\*[^]*?\*\//g, '')
                    .replace(/(^|\s)\/\/.*$/gm, '')
                    .replace(/,\s*([}\]])/g, '$1');
                return JSON.parse(stripped);
            } catch (__err) {
                return {};
            }
        }
    }
}

let _sharedClient = null;

function getClient(options = {}) {
    if (!_sharedClient) {
        _sharedClient = new StataMcpClient();
    }
    if (options.logger) {
        _sharedClient.setLogger(options.logger);
    }
    return _sharedClient;
}

module.exports = {
    StataMcpClient,
    getClient,
    // Keep backward compat but with lazy init
    get client() { return getClient(); }
};