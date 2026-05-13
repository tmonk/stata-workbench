const { EventEmitter } = require('events');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

class StataClient extends EventEmitter {
    constructor(daemonManager) {
        super();
        this._daemonManager = daemonManager;
        this._sockets = new Map();      // sessionName -> net.Socket
        this._pending = new Map();       // id -> { resolve, reject, timer }
        this._bufs = new Map();          // sessionName -> string buffer
        this._requestTimeoutMs = 100000;
        this._reconnectAttempts = new Map();  // sessionName -> count
        this._maxReconnectAttempts = 3;
    }

    setRequestTimeout(ms) {
        this._requestTimeoutMs = ms;
    }

    // ---- Lifecycle ----

    async ensureConnected(sessionName = 'default') {
        const existing = this._sockets.get(sessionName);
        if (existing && existing.writable && !existing.destroyed) {
            return;
        }

        // Read meta file written by daemon
        const meta = this._readMeta(sessionName);
        if (!meta) {
            // Daemon not running — ask manager to start it
            await this._daemonManager.ensureRunning(sessionName);
            // Poll for meta file to appear (up to 10s)
            await this._waitForMeta(sessionName, 10000);
        }

        const finalMeta = this._readMeta(sessionName);
        if (!finalMeta) {
            throw new Error(`Cannot connect to daemon session '${sessionName}': no metadata`);
        }

        const sock = finalMeta.transport === 'unix'
            ? net.createConnection({ path: finalMeta.path })
            : net.createConnection({ port: finalMeta.port, host: finalMeta.host || '127.0.0.1' });

        this._bufs.set(sessionName, '');

        sock.on('data', (data) => {
            this._onData(sessionName, data);
        });

        sock.on('error', (err) => {
            this.emit('error', err);
        });

        sock.on('close', () => {
            this._markDisconnected(sessionName);
            this.emit('status', 'disconnected');
            this._scheduleReconnect(sessionName);
        });

        this._sockets.set(sessionName, sock);
        this.emit('status', 'connected');
    }

    async disconnect(sessionName = 'default') {
        const sock = this._sockets.get(sessionName);
        if (sock) {
            this._rejectAllPending(sessionName, new Error('Disconnected'));
            sock.end();
            sock.destroy();
            this._sockets.delete(sessionName);
            this._bufs.delete(sessionName);
        }
        this._reconnectAttempts.delete(sessionName);
    }

    isConnected(sessionName = 'default') {
        const sock = this._sockets.get(sessionName);
        return !!(sock && sock.writable && !sock.destroyed);
    }

    // ---- Execution ----

    async runCode(code, opts = {}) {
        const sessionName = opts.sessionName || 'default';
        const args = {
            code,
            echo: opts.echo !== false,
            strict: !!opts.strict,
            max_output_tokens: opts.maxOutputTokens || 1000,
            background: !!opts.background,
        };
        return this._call('run', args, sessionName);
    }

    async runFile(filePath, opts = {}) {
        const sessionName = opts.sessionName || 'default';
        return this._call('run_file', {
            path: filePath,
            echo: opts.echo !== false,
            strict: !!opts.strict,
        }, sessionName);
    }

    async cancel(sessionName = 'default') {
        return this._call('break', {}, sessionName);
    }

    async cancelTask(taskId, sessionName = 'default') {
        return this._call('task_cancel', { task_id: taskId }, sessionName);
    }

    // ---- Data Browser ----

    async listVariables(sessionName = 'default') {
        const result = await this._call('inspect_describe', {}, sessionName);
        return (result.variables || []).map(v => ({
            name: v.name,
            type: v.type,
            label: v.label || '',
            format: v.format || '',
        }));
    }

    async getDatasetState(sessionName = 'default') {
        const result = await this._call('inspect_describe', {}, sessionName);
        return {
            obs_count: result.obs_count || 0,
            var_count: result.var_count || 0,
            dataset_name: result.dataset_name || '',
        };
    }

    async getDataPage(start, count, varlist, sessionName = 'default') {
        const outPath = path.join(os.tmpdir(), `stata-arrow-${Date.now()}.arrow`);
        const result = await this._call('inspect_get', {
            format: 'arrow',
            out_path: outPath,
            varlist: Array.isArray(varlist) ? varlist.join(' ') : varlist,
            obs_range: `${start + 1}:${start + count}`,
        }, sessionName);
        if (result.path) {
            const buffer = fs.readFileSync(result.path);
            try { fs.unlinkSync(result.path); } catch (_) {}
            return buffer;
        }
        throw new Error('getDataPage: no path in response');
    }

    async computeViewIndices(filterExpr, sessionName = 'default') {
        const result = await this._call('compute_view_indices', {
            filter_expr: filterExpr,
        }, sessionName);
        return result.indices || [];
    }

    async validateFilterExpr(filterExpr, sessionName = 'default') {
        try {
            const result = await this._call('validate_filter', {
                filter_expr: filterExpr,
            }, sessionName);
            return { valid: true, error: null };
        } catch (err) {
            return { valid: false, error: err.message };
        }
    }

    // ---- Graphs ----

    async listGraphs(sessionName = 'default') {
        return this._call('graph_list', {}, sessionName);
    }

    async exportGraph(name, format, outPath, sessionName = 'default') {
        return this._call('graph_export', {
            name,
            format,
            out_path: outPath,
        }, sessionName);
    }

    // ---- Results / Log ----

    async getResults(resultClass = 'r', sessionName = 'default') {
        return this._call('results', { class: resultClass }, sessionName);
    }

    async getLogTail(lines = 50, sessionName = 'default') {
        return this._call('log_tail', { lines }, sessionName);
    }

    async searchLog(pattern, sessionName = 'default') {
        return this._call('log_search', { pattern }, sessionName);
    }

    async readLogAtOffset(logPath, offset, maxBytes = 32768) {
        return this._call('log_read_at_offset', {
            log_path: logPath,
            offset,
            max_bytes: maxBytes,
        }, 'default');
    }

    // ---- Background Tasks ----

    async getTaskStatus(taskId, opts = {}) {
        return this._call('task_status', {
            task_id: taskId,
            wait: !!opts.wait,
            timeout: opts.timeout || 300,
            tail_lines: opts.tailLines || 0,
        }, opts.sessionName || 'default');
    }

    // ---- Health ----

    async health(sessionName = 'default') {
        return this._call('health', {}, sessionName);
    }

    // ---- Internals ----

    async _call(method, args, sessionName = 'default') {
        await this.ensureConnected(sessionName);

        const id = uuid();
        const sock = this._sockets.get(sessionName);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(id);
                reject(new Error(`Request '${method}' timed out after ${this._requestTimeoutMs}ms`));
            }, this._requestTimeoutMs);

            this._pending.set(id, { resolve, reject, timer });

            const request = JSON.stringify({ id, method, args }) + '\n';
            sock.write(request, 'utf8', (err) => {
                if (err) {
                    clearTimeout(timer);
                    this._pending.delete(id);
                    reject(err);
                }
            });
        });
    }

    _onData(sessionName, data) {
        let buf = this._bufs.get(sessionName) || '';
        buf += data.toString('utf8');

        let newlineIdx;
        while ((newlineIdx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, newlineIdx);
            buf = buf.slice(newlineIdx + 1);

            if (!line.trim()) continue;

            try {
                const response = JSON.parse(line);
                const id = response.id;
                if (id && this._pending.has(id)) {
                    const { resolve, reject, timer } = this._pending.get(id);
                    clearTimeout(timer);
                    this._pending.delete(id);

                    if (response.ok) {
                        resolve(response.result || {});
                    } else {
                        const err = new Error(response.error || 'Unknown error');
                        err.errorCode = response.error_code;
                        err.details = response.details;
                        reject(err);
                    }
                }
            } catch (e) {
                this.emit('error', new Error(`Failed to parse NDJSON: ${e.message}`));
            }
        }

        this._bufs.set(sessionName, buf);
    }

    _markDisconnected(sessionName) {
        this._rejectAllPending(sessionName, new Error('Socket closed'));
        this._sockets.delete(sessionName);
        this._bufs.delete(sessionName);
    }

    _rejectAllPending(sessionName, err) {
        for (const [id, entry] of this._pending) {
            clearTimeout(entry.timer);
            entry.reject(err);
            this._pending.delete(id);
        }
    }

    _scheduleReconnect(sessionName, attempt = 0) {
        const count = this._reconnectAttempts.get(sessionName) || 0;
        if (count >= this._maxReconnectAttempts) {
            this.emit('error', new Error(`Daemon crashed; failed to restart after ${this._maxReconnectAttempts} attempts`));
            this.emit('status', 'disconnected');
            return;
        }
        this._reconnectAttempts.set(sessionName, count + 1);
        this.emit('status', 'reconnecting');

        setTimeout(async () => {
            try {
                await this._daemonManager.ensureRunning(sessionName);
                await this.ensureConnected(sessionName);
                this._reconnectAttempts.delete(sessionName);
                this.emit('status', 'connected');
            } catch {
                this._scheduleReconnect(sessionName, attempt + 1);
            }
        }, 2000);
    }

    _readMeta(sessionName) {
        const metaPath = path.join(os.homedir(), '.cache', 'stata-agent', 'sessions', `${sessionName}.json`);
        try {
            const content = fs.readFileSync(metaPath, 'utf8');
            return JSON.parse(content);
        } catch {
            return null;
        }
    }

    async _waitForMeta(sessionName, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const meta = this._readMeta(sessionName);
            if (meta) return;
            await sleep(200);
        }
    }
}

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { StataClient };
