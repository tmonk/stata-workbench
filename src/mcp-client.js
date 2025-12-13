const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const vscode = require('vscode');
const pkg = require('../package.json');
const MCP_PACKAGE_NAME = 'mcp-stata';
const MCP_PACKAGE_SPEC = `${MCP_PACKAGE_NAME}@latest`;

// The MCP SDK exposes a stdio client transport we can use for VS Code.
// For Cursor, we first try a built-in bridge command if available, then fall back to stdio.
let Client;
let StdioClientTransport;
let sdkLoadError = null;

try {
    // Lazy-load to avoid crashing if dependency resolution fails before activation.
    ({ Client } = require('@modelcontextprotocol/sdk/client'));
    // Use the exported stdio transport path (requires .js to satisfy exports mapping).
    ({ StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js'));
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
    }

    setLogger(logger) {
        this._log = typeof logger === 'function' ? logger : () => { };
    }

    onStatusChanged(listener) {
        this._statusEmitter.on('status', listener);
        return { dispose: () => this._statusEmitter.off('status', listener) };
    }

    async runSelection(selection, options = {}) {
        const { normalizeResult, includeGraphs, ...rest } = options || {};
        return this._enqueue('run_selection', rest, async (client) => {
            const response = await this._callTool(client, 'run_command', { code: selection });
            return response;
        }, { command: selection }, normalizeResult === true, includeGraphs === true);
    }

    async runFile(filePath, options = {}) {
        const { normalizeResult, includeGraphs, ...rest } = options || {};
        // Set working directory to the do-file location so relative includes work.
        const cwd = path.dirname(filePath);
        return this._enqueue('run_file', rest, async (client) => {
            const response = await this._callTool(client, 'run_do_file', {
                // Use absolute path so the server can locate the file, but also
                // pass cwd so any relative includes resolve.
                path: filePath,
                cwd
            });
            return response;
        }, { command: `do "${filePath}"`, filePath, cwd }, normalizeResult === true, includeGraphs === true);
    }

    async run(code, options = {}) {
        const task = (client) => {
            return this._callTool(client, 'run', { code });
        };
        // Normalize=true to parse standard MCP output, collectArtifacts=true to fetch graphs
        return this._enqueue('run', options, task, {}, true, true);
    }

    async viewData(start = 0, count = 50, options = {}) {
        return this._enqueue('view_data', options, async (client) => {
            const response = await this._callTool(client, 'get_data', { start, count });
            return this._parseJson(response);
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
            return { type: 'cursor-bridge' };
        }

        if (!Client || !StdioClientTransport) {
            this._statusEmitter.emit('status', 'error');
            const detail = sdkLoadError?.message ? ` (${sdkLoadError.message})` : '';
            throw new Error(`MCP SDK not found. Please run \`npm install\` to fetch @modelcontextprotocol/sdk.${detail}`);
        }

        const uvCommand = process.env.STATA_MCP_UVX_CMD || 'uvx';
        const transport = new StdioClientTransport({
            command: uvCommand,
            args: ['--from', MCP_PACKAGE_SPEC, MCP_PACKAGE_NAME],
            stderr: 'pipe',
            cwd: this._resolveWorkspaceRoot()
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
        await client.connect(transport);
        this._log(`mcp-stata connected (pid=${transport.pid ?? 'unknown'})`);

        this._transport = transport;
        this._statusEmitter.emit('status', 'connected');
        return client;
    }

    async _callTool(client, name, args) {
        const toolArgs = args ?? {};
        try {
            if (client.type === 'cursor-bridge' && this._cursorCommand) {
                return vscode.commands.executeCommand(this._cursorCommand, {
                    server: 'stata',
                    tool: name,
                    args: toolArgs
                });
            }

            return client.callTool({ name, arguments: toolArgs });
        } catch (error) {
            this._statusEmitter.emit('status', 'error');
            const detail = error?.message || String(error);
            throw new Error(`MCP tool ${name} failed: ${detail}`);
        }
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

        const normalized = {
            success: true,
            rc: firstNumber([payload.rc, parsed.rc]),
            command: meta.command || payload.command || parsed.command || meta.label,
            stdout: '',
            stderr: '',
            startedAt,
            endedAt,
            durationMs,
            label: meta.label,
            cwd: meta.cwd || (meta.filePath ? path.dirname(meta.filePath) : null),
            filePath: meta.filePath,
            contentText: flattenedContent || parsed.stdout || '',
            raw: response
        };

        if (payload.success === false || parsed.success === false) normalized.success = false;
        if (typeof normalized.rc === 'number' && normalized.rc !== 0) normalized.success = false;

        if (typeof parsed.stdout === 'string') {
            normalized.stdout = parsed.stdout;
        } else if (typeof payload.stdout === 'string') {
            normalized.stdout = payload.stdout;
        } else {
            const stdoutCandidate = firstText([flattenedContent, typeof response === 'string' ? response : null, payload.result, parsed.result]);
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
            .map(item => (typeof item === 'string' ? item : item.text || JSON.stringify(item)))
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

    async _collectGraphArtifacts(client, meta = {}) {
        try {
            let response = await this._callTool(client, 'get_graph_list', {});
            this._log(`[mcp-stata graphs] get_graph_list response: ${this._stringifySafe(response)}`);
            // Fallback if server only supports list_graphs
            if (!response || (typeof response === 'object' && !response.graphs)) {
                response = await this._callTool(client, 'list_graphs', {});
                this._log(`[mcp-stata graphs] list_graphs response: ${this._stringifySafe(response)}`);
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
        const href = graph.url || graph.href || graph.link || graph.path || graph.file || graph.filename || null;
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

