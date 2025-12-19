const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const vscode = require('vscode');
const pkg = require('../package.json');
const MCP_PACKAGE_NAME = 'mcp-stata';
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
        this._log = () => { };
        this._recentStderr = [];
        this._workspaceRoot = null;
        this._clientVersion = pkg?.version || '0.0.0';
        this._availableTools = new Set();
        this._activeRun = null;
        this._maxLogBufferChars = 500_000;
    }

    setLogger(logger) {
        this._log = typeof logger === 'function' ? logger : () => { };
    }

    onStatusChanged(listener) {
        this._statusEmitter.on('status', listener);
        return { dispose: () => this._statusEmitter.off('status', listener) };
    }

    async runSelection(selection, options = {}) {
        const { normalizeResult, includeGraphs, onLog, onProgress, ...rest } = options || {};
        const config = vscode.workspace.getConfiguration('stataMcp');
        const maxOutputLines = rest.max_output_lines ??
            (config.get('maxOutputLines', 0) || undefined);
        const cwd = typeof rest.cwd === 'string' ? rest.cwd : null;
        const meta = { command: selection, cwd };

        return this._enqueue('run_selection', rest, async (client) => {
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

            const runState = { onLog, onProgress, progressToken };
            const result = await this._withActiveRun(runState, async () => {
                return this._callTool(client, 'run_command', args, { progressToken });
            });
            if (!runState.logPath) {
                runState.logPath = this._extractLogPathFromResponse(result);
            }
            await this._drainActiveRunLog(client, runState);
            meta.logText = runState._logBuffer || '';
            meta.logPath = runState.logPath || null;
            return result;
        }, meta, normalizeResult === true, includeGraphs === true);
    }

    async runFile(filePath, options = {}) {
        const { normalizeResult, includeGraphs, onLog, onProgress, ...rest } = options || {};
        // Resolve working directory (configurable, defaults to the .do file folder).
        const cwd = this._resolveRunFileCwd(filePath);
        const config = vscode.workspace.getConfiguration('stataMcp');
        const maxOutputLines = rest.max_output_lines ??
            (config.get('maxOutputLines', 0) || undefined);
        const meta = { command: `do "${filePath}"`, filePath, cwd };

        return this._enqueue('run_file', rest, async (client) => {
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

            const runState = { onLog, onProgress, progressToken };
            const result = await this._withActiveRun(runState, async () => {
                return this._callTool(client, 'run_do_file', args, { progressToken });
            });
            if (!runState.logPath) {
                runState.logPath = this._extractLogPathFromResponse(result);
            }
            await this._drainActiveRunLog(client, runState);
            meta.logText = runState._logBuffer || '';
            meta.logPath = runState.logPath || null;
            return result;
        }, meta, normalizeResult === true, includeGraphs === true);
    }

    async run(code, options = {}) {
        const { onLog, onProgress, ...rest } = options || {};
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

            const runState = { onLog, onProgress, progressToken };
            const result = await this._withActiveRun(runState, async () => {
                return this._callTool(client, 'run_command', args, { progressToken });
            });
            if (!runState.logPath) {
                runState.logPath = this._extractLogPathFromResponse(result);
            }
            await this._drainActiveRunLog(client, runState);
            meta.logText = runState._logBuffer || '';
            meta.logPath = runState.logPath || null;
            return result;
        };
        // Normalize=true to parse standard MCP output, collectArtifacts=true to fetch graphs
        return this._enqueue('run_command', rest, task, meta, true, true);
    }

    async viewData(start = 0, count = 50, options = {}) {
        return this._enqueue('view_data', options, async (client) => {
            const response = await this._callTool(client, 'get_data', { start, count });
            return this._parseJson(response);
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
            const response = await this._exportGraphPreferred(client, name);
            return response;
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
        this._pending = 0;
        this._active = false;
        this._statusEmitter.emit('status', 'connected');
        return true;
    }

    async _ensureClient() {
        if (this._clientPromise) return this._clientPromise;
        this._clientPromise = this._createClient();
        return this._clientPromise;
    }

    async _createClient() {
        this._statusEmitter.emit('status', 'connecting');

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
            throw new Error(`MCP SDK not found. Please run \`npm install\` to fetch @modelcontextprotocol/sdk.${detail}`);
        }

        const config = vscode.workspace.getConfiguration('stataMcp');
        const setupTimeoutSeconds = (() => {
            if (process.env.STATA_SETUP_TIMEOUT) return process.env.STATA_SETUP_TIMEOUT;
            const val = Number(config.get('setupTimeoutSeconds', 60));
            if (Number.isFinite(val) && val > 0) return String(Math.round(val));
            return '60';
        })();

        const uvCommand = process.env.MCP_STATA_UVX_CMD || 'uvx';
        const transport = new StdioClientTransport({
            command: uvCommand,
            args: ['--from', MCP_PACKAGE_SPEC, MCP_PACKAGE_NAME],
            stderr: 'pipe',
            cwd: this._resolveWorkspaceRoot(),
            env: {
                ...process.env,
                STATA_SETUP_TIMEOUT: setupTimeoutSeconds
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

        // Capture stderr from the MCP process for debugging.
        const stderrStream = transport.stderr;
        if (stderrStream && typeof stderrStream.on === 'function') {
            stderrStream.setEncoding?.('utf8');
            stderrStream.on('data', (chunk) => {
                const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
                if (text?.trim()) {
                    const trimmed = text.trimEnd();
                    this._log(`[mcp-stata stderr] ${trimmed}`);
                    this._recentStderr.push(trimmed);
                    // Keep only the last few stderr lines for error reporting.
                    if (this._recentStderr.length > 10) {
                        this._recentStderr.shift();
                    }
                }
            });
        }

        this._log(`Starting mcp-stata via ${uvCommand} --from ${MCP_PACKAGE_SPEC} ${MCP_PACKAGE_NAME} (ext v${this._clientVersion})`);
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
                    const run = this._activeRun;
                    if (!run) return;
                    const text = String(notification?.params?.data ?? '');
                    if (!text) return;
                    const parsed = this._tryParseJson(text);
                    const event = parsed?.event;
                    if (event === 'log_path' && parsed?.path) {
                        this._ensureLogTail(client, run, String(parsed.path)).catch(() => { });
                        return;
                    }
                    run._appendLog?.(text);
                    if (typeof run.onLog === 'function') {
                        run.onLog(text);
                    }
                });
            }

            if (ProgressNotificationSchema) {
                client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
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
        await client.connect(transport);
        this._log(`mcp-stata connected (pid=${transport.pid ?? 'unknown'})`);

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
        } catch (err) {
            this._availableTools = new Set();
            this._log(`[mcp-stata] listTools failed: ${err?.message || err}`);
        }
    }

    _graphListToolOrder() {
        const preferred = [];
        // Prefer server-advertised tools first.
        if (this._availableTools?.has('export_graphs_all')) preferred.push('export_graphs_all');
        if (this._availableTools?.has('list_graphs')) preferred.push('list_graphs');

        // Default ordering when tool discovery is unavailable.
        if (!preferred.length) {
            preferred.push('export_graphs_all', 'list_graphs');
        }

        // Remove any falsy entries just in case.
        return preferred.filter(Boolean);
    }

    async _callTool(client, name, args, callOptions = {}) {
        const toolArgs = args ?? {};
        try {
            if (client.type === 'cursor-bridge' && this._cursorCommand) {
                return vscode.commands.executeCommand(this._cursorCommand, {
                    server: 'stata',
                    tool: name,
                    args: toolArgs
                });
            }

            const progressToken = callOptions?.progressToken ?? null;
            if (progressToken != null && typeof client.request === 'function' && CallToolResultSchema) {
                return client.request(
                    {
                        method: 'tools/call',
                        params: {
                            name,
                            arguments: toolArgs,
                            _meta: { progressToken }
                        }
                    },
                    CallToolResultSchema
                );
            }

            return client.callTool({ name, arguments: toolArgs });
        } catch (error) {
            this._statusEmitter.emit('status', 'error');
            const detail = error?.message || String(error);
            throw new Error(`MCP tool ${name} failed: ${detail}`);
        }
    }

    async _withActiveRun(run, fn) {
        const prev = this._activeRun;
        if (run && typeof run === 'object') {
            run.logPath = run.logPath || null;
            run.logOffset = typeof run.logOffset === 'number' ? run.logOffset : 0;
            run._tailCancelled = false;
            run._tailPromise = null;
            run._logBuffer = '';
            run._appendLog = (text) => {
                const chunk = String(text ?? '');
                if (!chunk) return;
                run._logBuffer = this._appendBounded(run._logBuffer, chunk, this._maxLogBufferChars);
            };
        }
        this._activeRun = run;
        try {
            return await fn();
        } finally {
            // Restore previous run (defensive) rather than always clearing.
            this._activeRun = prev;
        }
    }

    _appendBounded(existing, chunk, maxChars) {
        const next = `${existing || ''}${chunk || ''}`;
        if (maxChars && next.length > maxChars) {
            return next.slice(next.length - maxChars);
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

        let emptyReads = 0;
        for (let i = 0; i < 200; i++) {
            const slice = await this._readLogSlice(client, run.logPath, run.logOffset, 65536);
            if (!slice) break;
            if (typeof slice.next_offset === 'number') {
                run.logOffset = slice.next_offset;
            }
            const data = String(slice.data ?? '');
            if (data) {
                run._appendLog?.(data);
                emptyReads = 0;
            } else {
                emptyReads += 1;
                if (emptyReads >= 2) break;
                await this._delay(50);
            }
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
                await this._delay(200);
                continue;
            }

            if (typeof slice.next_offset === 'number') {
                run.logOffset = slice.next_offset;
            }
            const data = String(slice.data ?? '');
            if (data) {
                run._appendLog?.(data);
                if (typeof run.onLog === 'function') {
                    try {
                        run.onLog(data);
                    } catch (_err) {
                    }
                }
            } else {
                await this._delay(200);
            }
        }
    }

    async _readLogSlice(client, path, offset, maxBytes) {
        try {
            const resp = await this._callTool(client, 'read_log', { path, offset, max_bytes: maxBytes });
            const text = this._extractText(resp);
            const parsed = this._tryParseJson(text);
            if (!parsed || typeof parsed !== 'object') return null;
            return parsed;
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
                this._cancelSignal = false;
                this._pending = Math.max(0, this._pending - 1);
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
                if (collectArtifacts) {
                    const artifacts = await this._collectGraphArtifacts(client, meta);
                    if (artifacts.length) {
                        processed.artifacts = artifacts;
                        processed.graphArtifacts = artifacts;
                    }
                }
                return processed;
            } catch (error) {
                this._statusEmitter.emit('status', 'error');
                this._log(`[mcp-stata error] ${error?.message || error}`);
                throw error;
            } finally {
                this._active = false;
                this._pending = Math.max(0, this._pending - 1);
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

        const normalized = {
            success: true,
            rc: firstNumber([payload?.error?.rc, parsed?.error?.rc, payload.rc, parsed.rc]),
            command: meta.command || payload.command || parsed.command || meta.label,
            stdout: typeof meta.logText === 'string' ? meta.logText : '',
            stderr: '',
            startedAt,
            endedAt,
            durationMs,
            label: meta.label,
            cwd: meta.cwd || (meta.filePath ? path.dirname(meta.filePath) : null),
            filePath: meta.filePath,
            contentText: safeContentText || parsed.stdout || '',
            logPath: meta.logPath || parsed.log_path || payload.log_path || payload?.error?.log_path || parsed?.error?.log_path || null,
            raw: response
        };

        if (payload.success === false || parsed.success === false) normalized.success = false;
        if (typeof normalized.rc === 'number' && normalized.rc !== 0) normalized.success = false;

        if (typeof parsed.stdout === 'string' && parsed.stdout.trim()) {
            normalized.stdout = parsed.stdout;
        } else if (typeof payload.stdout === 'string' && payload.stdout.trim()) {
            normalized.stdout = payload.stdout;
        } else {
            const stdoutCandidate = firstText([safeContentText, typeof response === 'string' && !hasStructuredContent ? response : null, payload.result, parsed.result]);
            if (stdoutCandidate) normalized.stdout = stdoutCandidate;
        }

        const stderrCandidate = firstText([payload.stderr, parsed.stderr, payload.error?.snippet, parsed.error?.snippet]);
        if (stderrCandidate) normalized.stderr = stderrCandidate;

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

    _flattenContent(contentArray) {
        if (!Array.isArray(contentArray)) return String(contentArray);
        return contentArray
            .map(item => {
                if (typeof item === 'string') return item;
                if (item && typeof item === 'object' && typeof item.text === 'string') return item.text;
                return '';
            })
            .join('\n');
    }

    _formatRecentStderr() {
        if (!this._recentStderr?.length) return '';
        return ` (recent stderr: ${this._recentStderr.slice(-5).join(' | ')})`;
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
            const candidates = this._graphListToolOrder();
            let response;
            let lastError = null;
            const config = vscode.workspace.getConfiguration('stataMcp');
            const useBase64 = config.get('useBase64Graphs', false);

            for (const tool of candidates) {
                try {
                    const args = tool === 'export_graphs_all'
                        ? { use_base64: useBase64 }
                        : {};

                    response = await this._callTool(client, tool, args);
                    this._log(`[mcp-stata graphs] ${tool} response: ${this._stringifySafe(response)}`);
                    break;
                } catch (err) {
                    lastError = err;
                    this._log(`[mcp-stata graphs] ${tool} failed: ${err?.message || err}`);
                }
            }

            if (!response) {
                if (lastError) throw lastError;
                return [];
            }

            const resolved = await this._resolveArtifactsFromList(response, meta?.cwd, client);
            this._log(`[mcp-stata graphs] resolved artifacts: ${this._stringifySafe(resolved)}`);
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
            // Check if this candidate is already a fully formed artifact (has data/path)
            // If it is, we prefer that over re-exporting, EXCEPT if it's just a simple string without extension (which is likely a name).
            const isSimpleString = typeof g === 'string' && !g.includes('/') && !g.includes('\\') && !g.startsWith('data:') && !g.includes('.');
            const isObjectWithData = g && typeof g === 'object' && (g.data || g.url || g.path || g.dataUri);

            if (isObjectWithData) {
                const direct = this._graphToArtifact(g, baseDir, response);
                if (direct) {
                    artifacts.push(direct);
                    continue;
                }
            }

            // Identify potential graph name
            const graphName = (typeof g === 'string') ? g : (g?.name || g?.graph_name || g?.label);

            // Try export if we have a name and a client
            if (graphName && client) {
                // If it's a simple string or strictly a name-only object, we DEFINITELY want to try export.
                // Or if we fell through from above.
                try {
                    // Double fetch: PDF for the main artifact (durable), PNG for the preview.
                    const [pdfExport, pngExport] = await Promise.all([
                        this._exportGraphPreferred(client, graphName),
                        this._callTool(client, 'export_graph', { graph_name: graphName, format: 'png' }).catch(() => null)
                    ]);

                    const art = this._graphResponseToArtifact(pdfExport, graphName, baseDir);
                    if (art) {
                        if (pngExport) {
                            const pngArt = this._graphResponseToArtifact(pngExport, graphName, baseDir);
                            if (pngArt) {
                                // If we have a local path but no dataUri, try to read the file
                                if (pngArt.path && !pngArt.dataUri) {
                                    try {
                                        if (fs.existsSync(pngArt.path)) {
                                            const buf = fs.readFileSync(pngArt.path);
                                            pngArt.dataUri = `data:image/png;base64,${buf.toString('base64')}`;
                                        }
                                    } catch (e) {
                                        this._log(`[mcp-stata] Failed to read preview file: ${e}`);
                                    }
                                }

                                if (pngArt.dataUri || pngArt.path) {
                                    art.previewDataUri = pngArt.dataUri || pngArt.path;
                                }
                            }
                        }
                        artifacts.push(art);
                        this._log(`[mcp-stata graphs] export_graph(${graphName}) -> ${this._stringifySafe(art)}`);
                        continue; // Successfully exported
                    }
                } catch (err) {
                    this._log(`[mcp-stata export_graph error] ${err?.message || err}`);
                    // Fall through to try direct conversion as fallback
                    // If we have a name but export failed, create an error placeholder so it's not invisible
                    artifacts.push({
                        label: graphName,
                        error: `Export failed: ${err.message || String(err)}`
                    });
                    continue;
                }
            }

            // Fallback: try interpret as direct artifact (e.g. string path with extension)
            if (!isObjectWithData) {
                const direct = this._graphToArtifact(g, baseDir, response);
                if (direct) artifacts.push(direct);
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
        const dataUri = this._toDataUri(graph) || (href && href.startsWith('data:') ? href : null);
        const pathOrData = href || dataUri;
        if (!pathOrData) return null;
        return {
            label,
            path: pathOrData,
            dataUri: dataUri || (href && href.startsWith('data:') ? href : null),
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
        if (Array.isArray(candidate)) return candidate;
        if (candidate.graphs && Array.isArray(candidate.graphs)) return candidate.graphs;
        // Check direct text property on candidate (common MCP single-text-content pattern)
        if (candidate.text && typeof candidate.text === 'string') {
            const parsed = this._tryParseJson(candidate.text);
            if (parsed) {
                const fromParsed = this._firstGraphs(parsed);
                if (fromParsed.length) return fromParsed;
            }
        }

        if (candidate.content && Array.isArray(candidate.content)) {
            for (const item of candidate.content) {
                const nested = this._firstGraphs(item);
                if (nested.length) return nested;
                if (item?.text) {
                    const parsed = this._tryParseJson(item.text);
                    if (parsed) {
                        const fromParsed = this._firstGraphs(parsed);
                        if (fromParsed.length) return fromParsed;
                    }
                }
                if (typeof item === 'string') {
                    const parsed = this._tryParseJson(item);
                    if (parsed) {
                        const fromString = this._firstGraphs(parsed);
                        if (fromString.length) return fromString;
                    }
                }
            }
        }
        if (typeof candidate === 'string') {
            const parsed = this._tryParseJson(candidate);
            if (parsed) return this._firstGraphs(parsed);
        }
        return [];
    }

    _toDataUri(graph) {
        if (!graph || typeof graph !== 'object') return null;
        if (graph.data && graph.mimeType) return `data:${graph.mimeType};base64,${graph.data}`;
        if (graph.image && graph.image.data && graph.image.mimeType) {
            return `data:${graph.image.mimeType};base64,${graph.image.data}`;
        }
        const content = Array.isArray(graph.content) ? graph.content : [];
        for (const item of content) {
            if (item?.data && item?.mimeType) return `data:${item.mimeType};base64,${item.data}`;
            if (item?.url && item.url.startsWith('data:')) return item.url;
            if (item?.text) {
                const parsed = this._parseArtifactLikeJson(item.text, null);
                if (parsed?.dataUri) return parsed.dataUri;
            }
        }
        return null;
    }

    _artifactFromText(text, baseDir) {
        const trimmed = (text || '').trim();
        if (!trimmed) return null;
        const isData = trimmed.startsWith('data:');
        const label = path.basename(trimmed) || 'graph';
        return {
            label,
            path: trimmed,
            dataUri: isData ? trimmed : null,
            baseDir: baseDir || null
        };
    }

    _parseArtifactLikeJson(text, baseDir) {
        const parsed = this._tryParseJson(typeof text === 'string' ? text : '');
        if (!parsed || typeof parsed !== 'object') return null;

        // Common shapes: { path, url, data, mimeType }, or nested in "graph" key.
        const candidate = parsed.graph || parsed;
        const href = candidate.url || candidate.path || candidate.file || candidate.href || null;
        const dataUri = this._toDataUri(candidate) || (href && href.startsWith('data:') ? href : null);
        if (!href && !dataUri) return null;
        return {
            label: candidate.name || candidate.label || candidate.graph_name || path.basename(href || '') || 'graph',
            path: href || dataUri,
            dataUri: dataUri || null,
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
}

// Export the class for testing and the singleton for the extension
module.exports = {
    StataMcpClient,
    client: new StataMcpClient()
};

