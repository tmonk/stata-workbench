const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const Sentry = require("@sentry/node");
const path = require('path');
const fs = require('fs');
const os = require('os');
const vscode = require('vscode');
const { getEnv } = require('./runtime-context');
const pkg = require('../package.json');
const https = require('https');
const { filterMcpLogs } = require('./log-utils');
const MCP_PACKAGE_NAME = 'mcp-stata';
const MCP_PACKAGE_SPEC = 'mcp-stata'; // Default spec for logging/errors
const MCP_SERVER_ID = 'mcp_stata';

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
    Sentry.captureException(error);
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
        this._activeCancellation = null;
        this._log = () => { };
        this._recentStderr = [];
        this._workspaceRoot = null;
        this._activeRun = null;
        this._runsByTaskId = new Map();
        this._runCleanupTimers = new Map();
        this._cancellationSourcesByRunId = new Map();
        // Allow larger captured logs so long .do files and errors are preserved.
        this._maxLogBufferChars = 500_000_000; // 500 MB
        this._clientVersion = pkg?.version || 'dev';
        this._onTaskDone = null;
        this._availableTools = new Set();
        this._toolMapping = new Map();
        this._missingRequiredTools = [];
        this._forceLatestServer = false;
        this._forceLatestAttempted = false;
        this._pypiVersion = null;
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
                Sentry.captureException(e);
                console.error('[mcp-stata] Logger test failed:', e);
            }
        }
    }

    setTaskDoneHandler(handler) {
        this._onTaskDone = typeof handler === 'function' ? handler : null;
    }

    updateConfig(opts) {
        if (!opts) return;
        if (typeof opts.logStataCode === 'boolean') {
            // We read from vscode directly in _enqueue so this is mostly for non-vscode callers 
            // or explicit state tracking if we move away from direct vscode usage in deeper logic.
        }
    }

    /**
     * Returns true if a server configuration for mcp-stata exists in any candidate mcp.json.
     */
    hasConfig() {
        const config = this._loadServerConfig();
        return !!config.configPath;
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

        const result = await this._enqueue('run_selection', { ...rest, runId, cancellationToken: cts.token, cancellationSource: cts, deferArtifacts: true }, async (client) => {
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
            
            // Mark the run as started in the UI if we have a callback
            if (typeof options.onStarted === 'function') {
                options.onStarted();
            }

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

        const result = await this._enqueue('run_file', { ...rest, runId, cancellationToken: cts.token, cancellationSource: cts, deferArtifacts: true }, async (client) => {
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
            
            // Mark the run as started in the UI if we have a callback
            if (typeof options.onStarted === 'function') {
                options.onStarted();
            }

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
        return result;
    }

    async run(code, options = {}) {
        const { onLog, onRawLog, onProgress, onGraphReady, cancellationToken: externalCancellationToken, ...rest } = options || {};
        const config = vscode.workspace.getConfiguration('stataMcp');
        const maxOutputLines = options.max_output_lines ??
            (config.get('maxOutputLines', 0) || undefined);

        const cwd = typeof rest.cwd === 'string' ? rest.cwd : null;
        const meta = { command: code, cwd };
        const cts = this._createCancellationSource(externalCancellationToken);

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
            
            if (typeof options.onStarted === 'function') {
                options.onStarted();
            }

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

        const result = await this._enqueue('run_command', { ...rest, cancellationToken: cts.token, cancellationSource: cts, deferArtifacts: true }, task, meta, true, true);
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
            const raw = await this._callTool(client, 'list_graphs', {});
            const artifacts = await this._resolveArtifactsFromList(raw, options?.baseDir, client);
            return { graphs: artifacts };
        });
    }

    /**
     * Explicitly start the MCP client connection if not already connected.
     * Useful for startup loading.
     */
    async connect() {
        return this._enqueue('connect', { timeoutMs: 30000 }, async (client) => {
            return client;
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
                const fallback = await this._callTool(client, 'export_graph', { ...baseArgs, format: 'pdf' });
                const fallbackArtifact = this._graphResponseToArtifact(fallback, name, options.baseDir);
                if (fallbackArtifact && (fallbackArtifact.path && /\.pdf$/i.test(fallbackArtifact.path))) {
                    artifact = fallbackArtifact;
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

        // 1. Capture what's currently active/queued
        const activeRun = this._activeRun;
        const currentSources = Array.from(this._cancellationSourcesByRunId.values());

        // 2. Mark active run as cancelled immediately so logs stop
        if (activeRun) {
            activeRun._tailCancelled = true;
            activeRun._cancelled = true;
        }

        // 3. Trigger all currently known cancellation sources
        if (this._activeCancellation) {
            this._activeCancellation.cancel('user cancelled');
        }

        for (const source of currentSources) {
            try {
                source.cancel('user cancelled all');
            } catch (_err) { }
        }

        // 4. Send break_session to the server
        try {
            const client = await this._ensureClient();
            await this._breakSession(client, 'default');
        } catch (err) {
            this._log(`[mcp-stata] break_session failed: ${err?.message || err}`);
        }
        
        this._statusEmitter.emit('status', this._pending > 0 ? 'queued' : 'connected');
        return true;
    }

    async cancelRun(runId) {
        if (!runId) return false;
        const source = this._cancellationSourcesByRunId.get(String(runId));
        if (source) {
            source.cancel('user cancelled specific run');
            // If it's already the active run, also mark it as cancelled for log suppression
            if (this._activeRun && String(this._activeRun._runId) === String(runId)) {
                this._activeRun._cancelled = true;
            }
            return true;
        }
        
        // If it's already the active run, cancel it via the active source
        if (this._activeRun && String(this._activeRun._runId) === String(runId)) {
            this._activeRun._cancelled = true;
            if (this._activeCancellation) {
                this._activeCancellation.cancel('user cancelled active run');
                return true;
            }
        }
        
        return false;
    }

    _createCancellationSource(externalCancellationToken) {
        const abortController = new AbortController();
        const listeners = new Set();
        const token = {
            isCancellationRequested: false,
            onCancellationRequested: (cb) => {
                if (typeof cb !== 'function') return { dispose: () => { } };
                if (token.isCancellationRequested) {
                    setTimeout(cb, 0);
                    return { dispose: () => { } };
                }
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

        // Try to fetch latest version from PyPI before connecting, if not already fetched.
        // We do this here so it only happens once per client lifecycle.
        const env = getEnv();
        if (!this._pypiVersion && !env.MCP_STATA_PACKAGE_SPEC) {
            try {
                const { latest, all } = await this._fetchLatestVersion();
                this._pypiVersion = latest;

                // Log top 5 versions found on PyPI
                const top5 = this._sortVersions(all).slice(0, 5);
                this._log(`[mcp-stata] PyPI versions (latest 5): ${top5.join(', ')}`);
                this._log(`[mcp-stata] Resolved latest version: ${this._pypiVersion}`);
            } catch (err) {
                Sentry.captureException(err);
                this._log(`[mcp-stata] PyPI version fetch failed, using fallback: ${err.message}`);
            }
        }

        this._clientPromise = (async () => {
            const { client, transport, setupTimeoutSeconds } = await this._createClient();
            
            try {
                const connectTimeoutMs = (parseInt(setupTimeoutSeconds, 10) || 60) * 1000;
                let timeoutId;
                const timeoutPromise = new Promise((_, reject) => {
                    timeoutId = setTimeout(() => {
                        const error = new Error(`Connection timed out after ${setupTimeoutSeconds} seconds. The mcp-stata server may be hanging while trying to initialize Stata.`);
                        error.isTimeout = true;
                        reject(error);
                    }, connectTimeoutMs);
                });

                await Promise.race([
                    client.connect(transport),
                    timeoutPromise
                ]);
                if (timeoutId) clearTimeout(timeoutId);
            } catch (err) {
                this._captureMcpError(err);

                // Explicitly close transport to kill the orphaned process if it's still alive.
                try {
                    if (transport && typeof transport.close === 'function') {
                        await transport.close();
                    }
                } catch (closeErr) {
                    this._log(`[mcp-stata] Failed to close transport after connect error: ${closeErr.message}`);
                }

                this._resetClientState();
                const context = this._formatRecentStderr();
                let message = err?.message || String(err);

                // Enhance error message for common Python/Stata missing issues found in stderr context
                const stderrText = context.toLowerCase();
                if (stderrText.includes('modulenotfounderror') && (stderrText.includes('pystata') || stderrText.includes('stata_setup'))) {
                    message += "\n\nCRITICAL: The 'pystata' or 'stata_setup' Python package is missing. Ensure they are installed in your Python environment (e.g., 'pip install pystata').";
                } else if (stderrText.includes('stata system information not found') || stderrText.includes('stata not found')) {
                    message += "\n\nCRITICAL: Stata could not be found or initialized. This usually means 'stata_setup' is configured but cannot find your Stata installation.";
                } else if (err.isTimeout) {
                    message += "\n\nHint: This often happens if 'stata_setup' is trying to initialize Stata but hangs (e.g., waiting for a license or stuck in a loop).";
                }

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
        })();
        return this._clientPromise;
    }

    async _fetchLatestVersion(timeoutMs = 2000) {
        return new Promise((resolve, reject) => {
            const url = 'https://pypi.org/pypi/mcp-stata/json';
            const req = https.get(url, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`PyPI returned ${res.statusCode}`));
                    return;
                }
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const version = json?.info?.version;
                        const all = Object.keys(json?.releases || {});
                        if (version) {
                            resolve({ latest: version, all });
                        } else {
                            reject(new Error('Version not found in PyPI JSON'));
                        }
                    } catch (e) {
                        Sentry.captureException(e);
                        reject(e);
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(timeoutMs, () => {
                req.destroy();
                reject(new Error('PyPI request timed out'));
            });
        });
    }

    _sortVersions(versions) {
        return [...versions].sort((a, b) => {
            const pa = a.split('.').map(v => parseInt(v, 10));
            const pb = b.split('.').map(v => parseInt(v, 10));
            for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                const va = pa[i] || 0;
                const vb = pb[i] || 0;
                if (va !== vb) return vb - va;
            }
            return b.localeCompare(a); // Fallback for pre-releases or identical numbers
        });
    }


    async _createClient() {
        this._statusEmitter.emit('status', 'connecting');
        this._recentStderr = [];

        // Determine if we are using uvx or a local command
        const config = vscode.workspace.getConfiguration('stataMcp');
        const env = getEnv();
        const uvCommand = env.MCP_STATA_UVX_CMD || 'uvx';
        const serverConfig = this._loadServerConfig({ ignoreCommandArgs: this._forceLatestServer });

        const fallbackSpec = MCP_PACKAGE_NAME;
        const resolvedSpec = this._pypiVersion ? `${MCP_PACKAGE_NAME}==${this._pypiVersion}` : fallbackSpec;
        const currentSpec = env.MCP_STATA_PACKAGE_SPEC || (this._forceLatestServer ? `${MCP_PACKAGE_NAME}@latest` : resolvedSpec);

        let finalCommand = serverConfig.command || uvCommand;
        let finalArgs = serverConfig.args || ['--refresh', '--refresh-package', MCP_PACKAGE_NAME, '--from', currentSpec, MCP_PACKAGE_NAME];

        this._log(`Starting mcp-stata via ${finalCommand} ${finalArgs.join(' ')} (ext v${this._clientVersion})`);

        // Cursor: try a built-in bridge if present
        const commands = await vscode.commands.getCommands(true);
        const cursorBridge = commands.find(cmd => cmd.toLowerCase().includes('cursor') && cmd.toLowerCase().includes('mcp') && cmd.toLowerCase().includes('invoke'));
        if (cursorBridge) {
            this._log(`[mcp-stata] Found Cursor MCP bridge: ${cursorBridge}`);
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

        const setupTimeoutSeconds = (() => {
            if (env.STATA_SETUP_TIMEOUT) return env.STATA_SETUP_TIMEOUT;
            const val = Number(config.get('setupTimeoutSeconds', 60));
            if (Number.isFinite(val) && val > 0) return String(Math.round(val));
            return '60';
        })();

        // Perform a pre-flight check to avoid ENOENT crashes in the transport layer.
        // On Windows, spawnSync handles .cmd/.exe suffixing when shell is not used if the command is on PATH.
        try {
            let check = spawnSync(finalCommand, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
            
            // Check if the initial command choice is broken
            let stderr = (check.stderr || '').toString();
            const isBroken = !!(check.error || check.status !== 0 || stderr.includes('command not found'));

            if (isBroken && serverConfig.command && serverConfig.command !== uvCommand) {
                 // The user's configured command is broken. Try falling back to the extension's detected uvCommand.
                 this._log(`[mcp-stata] Configured command failed pre-flight: ${serverConfig.command}. Falling back to extension-detected command: ${uvCommand}`);
                 finalCommand = uvCommand;
                 finalArgs = ['--refresh', '--refresh-package', MCP_PACKAGE_NAME, '--from', currentSpec, MCP_PACKAGE_NAME];
                 // Re-run pre-flight for the fallback
                 check = spawnSync(finalCommand, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
                 stderr = (check.stderr || '').toString();
            }

            if (check.error) {
                if (check.error.code === 'ENOENT') {
                    throw new Error(`Command not found: ${finalCommand}. Ensure 'uv' (which provides 'uvx') is installed and on your PATH.`);
                }
                throw check.error;
            }

            // Handle broken shims that might exit 0 but fail on stderr (e.g. missing realpath on Mac)
            if (check.status !== 0 || stderr.includes('command not found')) {
                let message = `Command failed to execute: ${finalCommand}`;
                if (check.status !== 0) message += ` (exit ${check.status})`;
                
                if (stderr.includes('realpath: command not found')) {
                    message += ". It appears your 'uv' installation is broken or missing 'realpath' (common on some macOS setups). Try installing 'uv' via Homebrew ('brew install uv').";
                } else if (stderr) {
                    message += `: ${stderr.trim().split('\n')[0]}`;
                }
                throw new Error(message);
            }

            // On Windows with shell:true, the process might start but the command fails
            if (process.platform === 'win32' && check.status !== 0 && stderr.includes('is not recognized')) {
                throw new Error(`Command not found: ${finalCommand}. Ensure 'uv' (which provides 'uvx') is installed and on your PATH.`);
            }
        } catch (err) {
            if (err.message.includes('Command not found') || err.message.includes('failed to execute')) throw err;
            // Ignore other pre-flight errors to let the transport try anyway (it might succeed if we misdetected something)
        }

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
                ...env,
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

        const client = new Client({ name: 'stata-vscode', version: this._clientVersion });
        if (typeof client.on === 'function') {
            client.on('error', (err) => {
                this._captureMcpError(err);
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
                    this._onLoggingMessage(client, notification);
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
        return { client, transport, setupTimeoutSeconds };
    }

    async _refreshToolList(client) {
        if (!client || typeof client.listTools !== 'function') {
            this._availableTools = new Set();
            this._toolMapping = new Map();
            return;
        }

        try {
            const res = await client.listTools();
            const tools = Array.isArray(res?.tools) ? res.tools : [];
            const names = tools.map(t => t?.name).filter(Boolean);
            this._availableTools = new Set(names);
            this._toolMapping = new Map();

            // Populate mapping for common tools
            for (const fullName of names) {
                // Handle prefixes like mcp_mcp_stata_run_command -> run_command
                const shortName = fullName.split('_').filter(part => !['mcp', 'stata'].includes(part.toLowerCase())).join('_');
                if (shortName && !this._toolMapping.has(shortName)) {
                    this._toolMapping.set(shortName, fullName);
                }
                // Also handle direct suffix matches
                const suffixMatch = ['run_command_background', 'run_do_file_background', 'get_ui_channel', 'break_session', 'stop_session', 'describe', 'codebook', 'get_data', 'get_variable_list', 'list_graphs', 'fetch_graph', 'export_all_graphs']
                    .find(s => fullName.endsWith(s));
                if (suffixMatch && !this._toolMapping.has(suffixMatch)) {
                    this._toolMapping.set(suffixMatch, fullName);
                }
            }

            if (names.length) {
                this._log(`[mcp-stata] available tools: ${names.join(', ')}`);
            }
            const missing = this._getMissingRequiredTools(this._availableTools);
            this._missingRequiredTools = missing;
            if (missing.length) {
                this._log(`[mcp-stata] Missing required tools: ${missing.join(', ')}`);
            }
        } catch (err) {
            this._captureMcpError(err);
            this._availableTools = new Set();
            this._toolMapping = new Map();
            const context = this._formatRecentStderr();
            this._log(`[mcp-stata] listTools failed: ${err?.message || err}${context}`);
        }
    }

    _resolveToolName(name) {
        if (this._availableTools?.has(name)) return name;
        if (this._toolMapping?.has(name)) return this._toolMapping.get(name);
        return name;
    }

    async _callTool(client, name, args, callOptions = {}) {
        const toolName = name;
        const resolvedName = this._resolveToolName(toolName);
        if (resolvedName === 'read_log') {
            this._log('[mcp-stata] read_log tool call blocked: local file access only');
            throw new Error('read_log tool call disabled; local file access only');
        }
        return Sentry.startSpan({ name: `mcp.tool:${toolName}`, op: 'mcp.tool_call' }, async () => {
            const toolArgs = args ?? {};
            const startMs = Date.now();

            try {
                let activeClient = client;
                if (!this._availableTools?.has(resolvedName)) {
                    await this._ensureLatestServerForMissingTool(toolName);
                    activeClient = await this._ensureClient();
                    if (!this._availableTools?.has(resolvedName)) {
                        throw new Error(this._formatMissingToolError(toolName));
                    }
                }

                let result;
                if (activeClient.type === 'cursor-bridge' && this._cursorCommand) {
                    result = await vscode.commands.executeCommand(this._cursorCommand, {
                        server: 'stata',
                        tool: resolvedName,
                        args: toolArgs
                    });
                } else {
                    const progressToken = callOptions?.progressToken ?? null;
                    const requestOptions = callOptions?.signal ? { signal: callOptions.signal } : undefined;
                    const params = {
                        method: 'tools/call',
                        params: {
                            name: resolvedName,
                            arguments: toolArgs,
                            ...(progressToken != null ? { _meta: { progressToken } } : {})
                        }
                    };

                    if (typeof activeClient.request === 'function' && CallToolResultSchema) {
                        result = await activeClient.request(
                            params,
                            CallToolResultSchema,
                            requestOptions
                        );
                    } else {
                        result = await activeClient.callTool({ name: resolvedName, arguments: toolArgs }, undefined, requestOptions);
                    }
                }

                const durationMs = Date.now() - startMs;
                this._log(`[mcp-stata] tool ${name} completed in ${durationMs}ms`);
                return result;
            } catch (error) {
                const durationMs = Date.now() - startMs;
                if (this._isCancellationError(error)) {
                    this._log(`[mcp-stata] tool ${name} cancelled after ${durationMs}ms`);
                    this._statusEmitter.emit('status', 'connected');
                    throw new Error('Request cancelled');
                }
                
                const detail = error?.message || String(error);
                this._log(`[mcp-stata] tool ${name} failed after ${durationMs}ms: ${detail}`);
                this._captureMcpError(error);
                this._statusEmitter.emit('status', 'error');
                
                let hint = '';
                if (detail.includes('-32000') || detail.includes('Connection closed') || detail.includes('ECONNRESET')) {
                    this._resetClientState();
                    hint = '\n\nHint: This often happens if the mcp-stata server crashes during initialization or prints logs to its stdout pipe (breaking the MCP protocol).';
                    const context = this._formatRecentStderr();
                    if (context) hint += `\n\nRecent logs extension captured:${context}`;
                }
                throw new Error(`MCP tool ${name} failed: ${detail}${hint}`);
            }
        });
    }

    _requiredToolNames() {
        return new Set([
            'run_command_background',
            'run_do_file_background',
            'get_ui_channel',
            'break_session'
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
        this._log(`[mcp-stata] Required tool "${name}" missing. Forcing refresh of ${MCP_PACKAGE_NAME} and restarting MCP client.`);
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
        if (run._cancelled) return;
        run._tailCancelled = true;
        if (run._tailPromise) {
            try {
                await run._tailPromise;
            } catch (_err) {
            }
        }

        const maxEmptyReads = run._fastDrain ? 1 : 10;
        const maxIterations = run._fastDrain ? 20 : 200;
        const idleDelay = run._fastDrain ? 5 : 50;
        let emptyReads = 0;
        for (let i = 0; i < maxIterations; i++) {
            const slice = await this._readLogSlice(client, run.logPath, run.logOffset, 262144);
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
                        const poppedLine = lines.pop();
                        run._lineBuffer = poppedLine + '\n' + (run._lineBuffer || '');
                    }
                }

                if (lines.length > 0) {
                    const completedText = lines.join('\n') + '\n';
                    if (typeof run.onRawLog === 'function') {
                        try {
                            run.onRawLog(completedText);
                        } catch (err) {
                            this._log(`[mcp-stata tail] onRawLog callback error for run ${run._runId || 'unknown'}: ${err.message}`);
                            Sentry.captureException(err);
                        }
                    }
                    const filtered = this._filterLogChunk(completedText);
                    if (filtered) {
                        run._appendLog?.(filtered);
                        if (typeof run.onLog === 'function') {
                            try {
                                run.onLog(filtered);
                            } catch (err) {
                                this._log(`[mcp-stata tail] onLog callback error for run ${run._runId || 'unknown'}: ${err.message}`);
                                Sentry.captureException(err);
                            }
                        }
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
                } catch (err) {
                    this._log(`[mcp-stata tail] onRawLog final flush error for run ${run._runId || 'unknown'}: ${err.message}`);
                    Sentry.captureException(err);
                }
            }
            const filtered = this._filterLogChunk(run._lineBuffer);
            if (filtered && !run._cancelled) {
                run._appendLog?.(filtered);
                if (typeof run.onLog === 'function') {
                    try {
                        run.onLog(filtered);
                    } catch (err) {
                        this._log(`[mcp-stata tail] onLog final flush error for run ${run._runId || 'unknown'}: ${err.message}`);
                        Sentry.captureException(err);
                    }
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
        let emptyCycles = 0;
        while (run && (!run._tailCancelled || (run._fastDrain && emptyCycles < 5))) {
            if (run._cancelled) break;
            const slice = await this._readLogSlice(client, run.logPath, run.logOffset, 262144);
            if (!slice || !slice.data) {
                if (run._tailCancelled) {
                    emptyCycles++;
                    if (!run._fastDrain || emptyCycles >= 5) break;
                }
                const delay = run._fastDrain ? 10 : 50;
                await this._delay(delay);
                continue;
            }
            emptyCycles = 0;

            if (typeof slice.next_offset === 'number') {
                run.logOffset = slice.next_offset;
            }
            const data = String(slice.data ?? '');
            if (data) {
                run._lastLogAt = Date.now();
                run._idleLogged = false;
                // LINE BUFFERING: Apply logic to tailing to avoid splitting SMCL tags.
                run._lineBuffer = (run._lineBuffer || '') + data;
                const lines = run._lineBuffer.split(/\r?\n/);
                run._lineBuffer = lines.pop(); // Keep partial line in buffer

                if (lines.length > 0) {
                    const completedText = lines.join('\n') + '\n';
                    if (typeof run.onRawLog === 'function') {
                        try {
                            run.onRawLog(completedText);
                        } catch (err) {
                            this._log(`[mcp-stata tail] onRawLog error for ${run._runId || 'unknown'}: ${err.message}`);
                            Sentry.captureException(err);
                        }
                    }
                    const filtered = this._filterLogChunk(completedText);
                    if (filtered && !run._cancelled) {
                        run._appendLog?.(filtered);
                        if (typeof run.onLog === 'function') {
                            try {
                                run.onLog(filtered);
                            } catch (err) {
                                this._log(`[mcp-stata tail] onLog error for ${run._runId || 'unknown'}: ${err.message}`);
                                Sentry.captureException(err);
                            }
                        }
                    }
                } else {
                    // No full lines yet, need to wait for more data
                    await this._delay(run._fastDrain ? 5 : 10);
                }
            } else {
                if (run._tailCancelled && !run._fastDrain) break;
                const lastAt = run._lastLogAt || 0;
                if (!run._idleLogged && lastAt && Date.now() - lastAt > 500) {
                    run._idleLogged = true;
                }
                // No data at all, wait longer
                await this._delay(run._fastDrain ? 10 : 50);
            }
        }

        // FINAL FLUSH: Handle any remaining buffer
        if (run && run._lineBuffer) {
            const text = run._lineBuffer;
            run._lineBuffer = '';
            if (typeof run.onRawLog === 'function') {
                try {
                    run.onRawLog(text);
                } catch (err) {
                    this._log(`[mcp-stata tail] onRawLog final error for ${run._runId || 'unknown'}: ${err.message}`);
                    Sentry.captureException(err);
                }
            }
            const filtered = this._filterLogChunk(text);
            if (filtered && !run._cancelled) {
                run._appendLog?.(filtered);
                if (typeof run.onLog === 'function') {
                    try {
                        run.onLog(filtered);
                    } catch (err) {
                        this._log(`[mcp-stata tail] onLog final error for ${run._runId || 'unknown'}: ${err.message}`);
                        Sentry.captureException(err);
                    }
                }
            }
        }
    }

    async readLog(path, offset, maxBytes) {
        return this._readLogSlice(null, path, offset, maxBytes);
    }

    async _readLogSlice(client, path, offset, maxBytes) {
        try {
            const logPath = typeof path === 'string' ? path : '';
            if (!logPath) {
                this._log('[mcp-stata] read_log skipped: empty path');
                return null;
            }

            const safeOffset = Math.max(0, Number.isFinite(offset) ? offset : 0);
            const maxRead = Math.max(0, Number.isFinite(maxBytes) ? maxBytes : 262144);
            
            // Avoid statSync - just try reading. Most OS/FS will handle this faster.
            const fd = fs.openSync(logPath, 'r');
            try {
                const buffer = Buffer.allocUnsafe(maxRead);
                const bytesRead = fs.readSync(fd, buffer, 0, maxRead, safeOffset);
                
                if (bytesRead <= 0) {
                    return { data: '', next_offset: safeOffset };
                }
                
                const data = buffer.slice(0, bytesRead).toString('utf8');
                return { data, next_offset: safeOffset + bytesRead };
            } finally {
                fs.closeSync(fd);
            }
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            this._log(`[mcp-stata] read_log local file failed: ${err?.message || err}`);
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
        // Strictly prioritize 'path' for log_path events as requested by user.
        // Avoid 'smcl_path'.
        const direct = response?.path || response?.log_path || response?.logPath || response?.structuredContent?.path || response?.structuredContent?.log_path;
        if (typeof direct === 'string' && direct.trim()) return direct;
        const text = this._extractText(response);
        const parsed = this._tryParseJson(text);
        const lp = parsed?.path || parsed?.log_path || parsed?.logPath || parsed?.error?.path || parsed?.error?.log_path || parsed?.error?.logPath;
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
        const taskDone = await this._awaitTaskDone(client, runState, taskId, cts?.token);
        runState._fastDrain = true;
        if (runState?._tailPromise) {
            runState._tailCancelled = true;
            await runState._tailPromise.catch(() => {});
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
            runState._tailCancelled = true;
            try {
                this._log(`[mcp-stata] Sending break_session (run ${runState._runId || 'unknown'})`);
                await this._breakSession(client);
            } catch (err) {
                this._log(`[mcp-stata] break_session failed: ${err?.message || err}`);
            }
        });
    }

    async _breakSession(client, sessionId = 'default') {
        if (!client) return;
        try {
            await this._callTool(client, 'break_session', { session_id: sessionId });
        } catch (err) {
            throw err;
        }
    }

    async _awaitTaskDone(client, runState, taskId, cancellationToken) {
        if (!runState || !taskId) return null;
        const taskIdText = String(taskId);
        if (runState._taskDonePayload && (!runState._taskDoneTaskId || runState._taskDoneTaskId === taskIdText)) {
            return runState._taskDonePayload;
        }

        return new Promise((resolve, reject) => {
            let cancelSub = null;
            let pollInterval = null;
            let isFinished = false;

            const finish = (payload) => {
                if (isFinished) return;
                isFinished = true;
                if (cancelSub?.dispose) cancelSub.dispose();
                if (pollInterval) clearInterval(pollInterval);
                resolve(payload);
            };

            runState._taskDoneResolve = finish;

            if (runState._taskDonePayload && (!runState._taskDoneTaskId || runState._taskDoneTaskId === taskIdText)) {
                return finish(runState._taskDonePayload);
            }

            if (cancellationToken?.onCancellationRequested) {
                cancelSub = cancellationToken.onCancellationRequested(() => {
                    if (isFinished) return;
                    isFinished = true;
                    if (pollInterval) clearInterval(pollInterval);
                    reject(new Error('Request cancelled'));
                });
            }

            // Polling fallback: if notifications are missed or delayed, poll every 2.5s
            pollInterval = setInterval(async () => {
                if (isFinished) return;
                if (runState._taskDonePayload) {
                    return finish(runState._taskDonePayload);
                }
                
                try {
                    // Call get_task_status tool for this specific task
                    const res = await this._callTool(client, 'get_task_status', { task_id: taskIdText });
                    const status = this._parseToolJson(res);
                    if (this._isTaskDone(status)) {
                        const resultRes = await this._callTool(client, 'get_task_result', { task_id: taskIdText });
                        finish(this._parseToolJson(resultRes) || status);
                    }
                } catch (_err) {
                    // Ignore polling errors to let it try again or wait for notification
                }
            }, 2500);
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
        let timeoutMs = options.timeoutMs ?? config.get('requestTimeoutMs', 10000);

        // Metadata/UI commands are expected to be fast and should always have a timeout.
        // All other commands (assumed to be Stata execution) have no timeout by default (opt-in via config).
        const isMetadata = [
            'connect',
            'view_data',
            'get_ui_channel',
            'get_variable_list',
            'get_data',
            'describe',
            'codebook',
            'list_graphs',
            'export_graph',
            'export_all_graphs',
            'export_graphs_all',
            'get_task_status',
            'get_task_result',
            'get_help',
            'get_stored_results',
            'read_log',
            'find_in_log',
            'break_session',
            'stop_session'
        ].includes(label);

        if (!isMetadata && !config.get('enableExecuteTimeout', false)) {
            timeoutMs = 0;
        }

        const bypassQueue = !!(options.bypassQueue || isMetadata);

        const internalRunId = options.runId || `internal-${Math.random().toString(36).slice(2, 9)}`;
        this._pending += 1;
        // Improve status: if we have more than 1 pending, we are definitely queued.
        this._statusEmitter.emit('status', this._pending > 1 ? 'queued' : (this._active ? 'running' : 'idle'));

        // Always ensure we have a cancellation source so we can cancel through cancelAll
        const source = options.cancellationSource || new vscode.CancellationTokenSource();
        this._cancellationSourcesByRunId.set(String(internalRunId), source);

        let cancelReject;
        const cancelPromise = new Promise((_, reject) => {
            cancelReject = reject;
        });

        const onCancel = (reason) => {
            if (cancelReject) {
                const r = cancelReject;
                cancelReject = null;
                // Use a microtask to allow the caller to attach a .catch() if they haven't yet,
                // which often happens with sequential runSelection calls in tests.
                Promise.resolve().then(() => {
                    r(new Error(`${reason || 'Request cancelled'}`));
                }).catch(() => {}); // ignore if already handled
            }
        };

        let sub;
        // Connect the source to our onCancel logic
        sub = source.token.onCancellationRequested(() => onCancel('Request cancelled'));

        // If an external token was also provided, link it to our source
        if (options.cancellationToken && options.cancellationToken !== source.token) {
            options.cancellationToken.onCancellationRequested(() => source.cancel());
            if (options.cancellationToken.isCancellationRequested) {
                source.cancel();
            }
        }

        const work = async () => {
            return Sentry.startSpan({ name: `mcp.operation:${label}`, op: 'mcp.operation' }, async () => {
                const startedAt = Date.now();
                if (source.token.isCancellationRequested) {
                    this._pending = Math.max(0, this._pending - 1);
                    this._cancellationSourcesByRunId.delete(String(internalRunId));
                    this._statusEmitter.emit('status', this._pending > 0 ? 'queued' : 'connected');
                    throw new Error('Request cancelled');
                }

                this._active = true;
                // Update active cancellation to the one currently running
                this._activeCancellation = source;

                this._statusEmitter.emit('status', 'running');
                this._log(`[mcp-stata] starting operation: ${label} (pending: ${this._pending})`);
                if (config.get('logStataCode', false) && meta.command) {
                    this._log(`[mcp-stata code] ${meta.command}`);
                }
                
                try {
                    const client = await this._ensureClient();
                    const result = await this._withTimeout(task(client), timeoutMs, label, source.token);
                    const endedAt = Date.now();
                    const durationMs = endedAt - startedAt;
                    const normalizedMeta = { ...meta, startedAt, endedAt, durationMs, label };

                    this._log(`[mcp-stata] operation ${label} completed in ${durationMs}ms`);

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
                    const durationMs = Date.now() - startedAt;
                    if (this._isCancellationError(error)) {
                        this._log(`[mcp-stata] operation ${label} cancelled after ${durationMs}ms`);
                    } else {
                        const context = this._formatRecentStderr();
                        this._log(`[mcp-stata] operation ${label} failed after ${durationMs}ms: ${error?.message || error}${context}`);
                        Sentry.captureException(error);
                        this._statusEmitter.emit('status', 'error');
                    }
                    throw error;
                } finally {
                    this._active = false;
                    this._activeCancellation = null;
                    if (sub) sub.dispose();
                    this._pending = Math.max(0, this._pending - 1);
                    this._cancellationSourcesByRunId.delete(String(internalRunId));
                    if (this._pending === 0) {
                        this._statusEmitter.emit('status', 'connected');
                    } else {
                        this._statusEmitter.emit('status', 'queued');
                    }
                }
            });
        };

        const workPromise = (async () => {
            try {
                // Wait for the previous task to finish (or fail) before starting
                if (!bypassQueue) {
                    await this._queue.catch(() => { });
                }
                return await work();
            } finally {
                if (sub) {
                    sub.dispose();
                }
            }
        })();

        // Update the serial queue tail
        if (!bypassQueue) {
            this._queue = workPromise.catch(() => { });
        }

        // If cancelled while still in queue, Promise.race will reject immediately
        // while the workPromise still correctly honors the serial chain.
        const out = Promise.race([workPromise, cancelPromise]);

        // If normalization is requested, we catch errors here and return a success:false object.
        // This ensures callers using normalization (like the extension UI) get a structured error
        // instead of an unhandled rejection, even if they await it late.
        const finalOut = normalize ? out.catch(error => {
            if (error?.message === 'Request cancelled' || this._isCancellationError(error)) {
                return {
                    success: false,
                    rc: -1,
                    stderr: error?.message || 'Request cancelled',
                    error: { message: error?.message || 'Request cancelled' }
                };
            }
            // For execution commands (run/runSelection/runFile), we only normalize
            // cancellation errors to prevent UI timeouts and satisfy the test suite.
            // Real MCP tool failures (like "Missing Tool" or connection errors) should
            // still throw so the caller knows something went fundamentally wrong.
            throw error;
        }) : out;

        // Prevent unhandled rejection errors if the caller doesn't await immediately
        finalOut.catch(() => { });
        return finalOut;
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
            logPath: meta.logPath || parsed.path || parsed.log_path || payload.path || payload.log_path || payload?.error?.path || payload?.error?.log_path || parsed?.error?.path || parsed?.error?.log_path || null,
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

        const env = getEnv();
        const homeExpanded = expanded.startsWith('~')
            ? path.join(env.HOME || env.USERPROFILE || '', expanded.slice(1))
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
            this._log(`[mcp-stata] export_graph (pdf) failed for "${name}", falling back to default format: ${err?.message || err}`);
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
                this._captureMcpError(err);
                this._log(`[mcp-stata] Failed to read MCP env from ${configPath}: ${err?.message || err}`);
            }
        }
        return env;
    }

    getServerConfig(options = {}) {
        return this._loadServerConfig(options);
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

    /**
     * Captures an error to Sentry with mcp.json context attached.
     * @param {Error|any} error
     */
    _captureMcpError(error) {
        if (!error) return;
        Sentry.withScope(scope => {
            const configs = this._getMcpConfigsContext();
            for (const [path, content] of Object.entries(configs)) {
                // Sentry tag names are limited in length and characters
                const tagKey = `mcp_config_${path.replace(/[^a-zA-Z0-9]/g, '_').slice(-20)}`;
                scope.setContext(tagKey, { path, content });
            }
            Sentry.captureException(error);
        });
    }

    /**
     * Collects all candidate mcp.json files and their contents for error context.
     * @returns {Record<string, string>}
     */
    _getMcpConfigsContext() {
        const contexts = {};
        for (const configPath of this._candidateMcpConfigPaths()) {
            if (!configPath) continue;
            try {
                if (fs.existsSync(configPath)) {
                    contexts[configPath] = fs.readFileSync(configPath, 'utf8');
                } else {
                    contexts[configPath] = '<file not found>';
                }
            } catch (err) {
                contexts[configPath] = `<error reading file: ${err.message}>`;
            }
        }
        return contexts;
    }

    /**
     * Collects all potential mcp.json paths from workspace, Claude, and various IDEs.
     * @returns {string[]}
     */
    _candidateMcpConfigPaths() {
        const paths = new Set();
        const workspaceRoot = this._resolveWorkspaceRoot();
        const home = os.homedir();
        const platform = process.platform;
        const env = getEnv();

        // 1. Host-determined path (PRIORITY: always check the current IDE's config first)
        const hostConfig = this._resolveHostMcpPath();
        if (hostConfig) {
            paths.add(hostConfig);
        }

        // 2. Workspace
        if (workspaceRoot) {
            paths.add(path.join(workspaceRoot, '.vscode', 'mcp.json'));
            paths.add(path.join(workspaceRoot, '.mcp.json'));
        }

        // 3. Claude Desktop (Very common source of MCP servers)
        if (home) {
            paths.add(path.join(home, '.claude.json'));
            if (platform === 'darwin') {
                paths.add(path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
            } else if (platform === 'win32') {
                const appData = env.APPDATA || (home ? path.join(home, 'AppData', 'Roaming') : null);
                if (appData) paths.add(path.join(appData, 'Claude', 'claude_desktop_config.json'));
            } else {
                paths.add(path.join(home, '.config', 'Claude', 'claude_desktop_config.json'));
            }
        }

        // 4. Known AI IDEs (Cursor, Windsurf, etc.)
        if (home) {
            paths.add(path.join(home, '.cursor', 'mcp.json'));
            paths.add(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'));
            paths.add(path.join(home, '.codeium', 'windsurf-next', 'mcp_config.json'));
            paths.add(path.join(home, '.antigravity', 'mcp.json'));
        }

        // 5. VS Code (Stable and Insiders) - User Application Support
        const codePath = (codeDir) => {
            if (!home) return null;
            if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', codeDir, 'User', 'mcp.json');
            if (platform === 'win32') {
                const roaming = env.APPDATA || (home ? path.join(home, 'AppData', 'Roaming') : null);
                return roaming ? path.join(roaming, codeDir, 'User', 'mcp.json') : null;
            }
            return path.join(home, '.config', codeDir, 'User', 'mcp.json');
        };
        paths.add(codePath('Code'));
        paths.add(codePath('Code - Insiders'));

        return Array.from(paths).filter(Boolean);
    }

    _resolveHostMcpPath() {
        const appName = (vscode.env?.appName || '').toLowerCase();
        const home = os.homedir();
        const platform = process.platform;
        const env = getEnv();
        const codePath = (codeDir) => {
            if (!home) return null;
            if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', codeDir, 'User', 'mcp.json');
            if (platform === 'win32') {
                const envAppData = (env.APPDATA && env.APPDATA !== 'undefined' && env.APPDATA !== 'null' && env.APPDATA !== '')
                    ? env.APPDATA
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
                const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
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

    _onLoggingMessage(client, notification) {
        const data = notification?.params?.data;
        if (!data) return;

        const timestamp = new Date().toLocaleTimeString();
        let parsed = null;
        let text = '';

        if (typeof data === 'object') {
            parsed = data;
            text = JSON.stringify(data);
        } else {
            text = String(data);
            parsed = this._tryParseJson(text);
        }

        const event = parsed?.event;
        this._log(`[${timestamp}] Notification received: ${event || 'logMessage'}`);
        const taskId = parsed?.task_id || parsed?.taskId || parsed?.request_id || parsed?.requestId || parsed?.run_id || parsed?.runId;
        
        let run = null;
        if (taskId) {
            run = this._runsByTaskId.get(String(taskId)) || null;
            // If we found a run by ID but it's not the "active" run (e.g. it's a tail from 
            // a just-cancelled run), that's fine, we still associate it.
        }
        
        // Falling back to _activeRun if no taskId is present
        if (!run && this._activeRun) {
            // If the active run has an assigned taskId, we should be VERY careful 
            // about adopting logs that DON'T have a taskId.
            // Background tasks in mcp-stata prioritize task_id for all their logs.
            if (!this._activeRun.taskId || event === 'progress' || event === 'log_path') {
                run = this._activeRun;
            }
        }

        if (run && run._cancelled) {
            return;
        }

        const lp = parsed?.path || parsed?.log_path || parsed?.logPath;
        if (run && event === 'log_path' && lp) {
            this._log(`[mcp-stata] log_path payload=${text}`);
            this._log(`[mcp-stata] log_path event matched for run ${run._runId || 'unknown'}, path=${lp}`);
            this._ensureLogTail(client, run, String(lp)).catch((err) => {
                this._log(`[mcp-stata] failed to ensure log tail: ${err?.message || err}`);
            });
            return;
        }

        if (!run) {
            if (event && event !== 'progress' && event !== 'log_path' && event !== 'logMessage') {
                this._log(`[mcp-stata] Info: received notification ${event} but no active run found and no taskId in payload.`);
            }
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
                        } catch (err) {
                            this._log(`[mcp-stata notification] onGraphReady error for run ${run._runId || 'unknown'}: ${err.message}`);
                            Sentry.captureException(err);
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
                    logPath: parsed?.path || parsed?.log_path || parsed?.logPath || null,
                    status: parsed?.status || null,
                    rc: typeof parsed?.rc === 'number' ? parsed.rc : null
                };
                if (hasOnTaskDone) {
                    try {
                        run.onTaskDone(taskPayload);
                    } catch (err) {
                        this._log(`[mcp-stata notification] onTaskDone error for run ${run._runId || 'unknown'}: ${err.message}`);
                        Sentry.captureException(err);
                    }
                } else if (typeof this._onTaskDone === 'function') {
                    try {
                        this._onTaskDone(taskPayload);
                    } catch (err) {
                        this._log(`[mcp-stata notification] global onTaskDone error: ${err.message}`);
                        Sentry.captureException(err);
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
        if (run.logPath) return;

        // Relaxed suppression: if we were told it's log only but don't have a path yet,
        // keep streaming via notifications so user sees something while disk tail builds up.
        // if (run._logOnly) return; 

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
                } catch (err) {
                    this._log(`[mcp-stata notification] onRawLog error for run ${run._runId || 'unknown'}: ${err.message}`);
                    Sentry.captureException(err);
                }
            }
            const filtered = this._filterLogChunk(completedText);
            if (!filtered || run._cancelled) return;
            run._appendLog?.(filtered);
            if (typeof run.onLog === 'function') {
                try {
                    run.onLog(filtered);
                } catch (err) {
                    this._log(`[mcp-stata notification] onLog error for run ${run._runId || 'unknown'}: ${err.message}`);
                    Sentry.captureException(err);
                }
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