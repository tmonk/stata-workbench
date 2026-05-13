const path = require('path');
const fs = require('fs');
const os = require('os');
const spawn = (bin, args, opts) => {
	const child = require('child_process').spawn(bin, args, opts);
	return child;
};

const SESSION_DIR = path.join(os.homedir(), '.cache', 'stata-agent', 'sessions');

class DaemonManager {
    constructor() {
        this._processes = new Map();  // sessionName -> ChildProcess
        this._crashCallbacks = new Map();  // sessionName -> [cb, ...]
    }

    async ensureRunning(sessionName = 'default', opts = {}) {
        // Check if meta file exists (daemon already running)
        const metaPath = path.join(SESSION_DIR, `${sessionName}.json`);
        if (fs.existsSync(metaPath)) {
            try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                const sockPath = meta.transport === 'unix' ? meta.path : null;
                if (sockPath && fs.existsSync(sockPath)) {
                    return; // Already running
                }
                if (meta.transport === 'tcp') {
                    // Can't easily check TCP; just return and let connect fail
                    return;
                }
            } catch {}
            // Stale meta file
            fs.unlinkSync(metaPath);
        }

        // Clean up any stale socket file from a previous aborted run
        const staleSock = path.join(SESSION_DIR, `${sessionName}.sock`);
        try {
            if (fs.existsSync(staleSock)) fs.unlinkSync(staleSock);
        } catch {}

        // Find the stata-agent binary (shared implementation with installer.js)
        const stataBin = this._findStataAgentBinary();

        const isWin = process.platform === 'win32';
        const transport = isWin ? 'tcp' : 'unix';

        const args = [
            'daemon', 'start',
            '--session', sessionName,
        ];
        if (isWin) {
            args.push('--transport', 'tcp');
        }
        if (opts.mock) {
            args.push('--mock');
        }

        return new Promise((resolve, reject) => {
            let proc;
            try {
                proc = spawn(stataBin, args, {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: { ...process.env },
                    detached: !isWin,
                });
            } catch (err) {
                return reject(err);
            }

            this._processes.set(sessionName, proc);

            let started = false;
            const timeout = setTimeout(() => {
                if (!started) {
                    reject(new Error(`Daemon start timed out for session '${sessionName}'`));
                }
            }, opts.timeout || 15000);

            proc.on('exit', (code) => {
                this._processes.delete(sessionName);
                if (!started) {
                    clearTimeout(timeout);
                    reject(new Error(`Daemon exited with code ${code}`));
                } else {
                    const cbs = this._crashCallbacks.get(sessionName) || [];
                    cbs.forEach(cb => cb(code));
                }
            });

            // Poll for meta file
            const poll = setInterval(() => {
                if (fs.existsSync(metaPath)) {
                    clearInterval(poll);
                    clearTimeout(timeout);
                    started = true;
                    resolve();
                }
            }, 200);
        });
    }

    async stop(sessionName = 'default') {
        const proc = this._processes.get(sessionName);
        if (proc) {
            proc.kill('SIGTERM');
            setTimeout(() => {
                if (this._processes.get(sessionName)) {
                    proc.kill('SIGKILL');
                }
            }, 3000);
        }

        // Also try NDJSON stop request
        try {
            const net = require('net');
            const metaPath = path.join(SESSION_DIR, `${sessionName}.json`);
            if (fs.existsSync(metaPath)) {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                const sock = meta.transport === 'unix'
                    ? net.createConnection({ path: meta.path })
                    : net.createConnection({ port: meta.port, host: meta.host || '127.0.0.1' });
                sock.write(JSON.stringify({ id: 'stop-1', method: 'stop', args: {} }) + '\n');
                sock.end();
                setTimeout(() => sock.destroy(), 1000);
            }
        } catch {}

        this._processes.delete(sessionName);
    }

    async health(sessionName = 'default') {
        const metaPath = path.join(SESSION_DIR, `${sessionName}.json`);
        if (!fs.existsSync(metaPath)) return null;
        try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            const net = require('net');
            return new Promise((resolve) => {
                const sock = meta.transport === 'unix'
                    ? net.createConnection({ path: meta.path })
                    : net.createConnection({ port: meta.port, host: meta.host || '127.0.0.1' });
                sock.write(JSON.stringify({ id: 'health-1', method: 'health', args: {} }) + '\n');
                sock.on('data', (data) => {
                    try {
                        const resp = JSON.parse(data.toString().trim());
                        sock.end();
                        resolve(resp.result || null);
                    } catch { sock.end(); resolve(null); }
                });
                sock.on('error', () => { resolve(null); });
                setTimeout(() => { sock.destroy(); resolve(null); }, 3000);
            });
        } catch {
            return null;
        }
    }

    onCrash(sessionName, cb) {
        const cbs = this._crashCallbacks.get(sessionName) || [];
        cbs.push(cb);
        this._crashCallbacks.set(sessionName, cbs);
    }

    _findStataAgentBinary() {
        // Check STATA_AGENT_PATH env directly (not STATA_PATH — that's for the Stata Corp binary)
        if (process.env.STATA_AGENT_PATH) {
            return process.env.STATA_AGENT_PATH;
        }

        // Delegate to the shared implementation in installer.js so that
        // DaemonManager and installer never disagree about whether
        // stata-agent is installed.
        try {
            const { findStataAgentBinary } = require('./installer');
            const bin = findStataAgentBinary();
            if (bin) return bin;
        } catch {}

        // Fallback: try basic discovery.
        const candidates = ['stata-agent', 'python3', 'python'];
        const { spawnSync } = require('child_process');
        for (const cmd of candidates) {
            try {
                const result = spawnSync(cmd, ['--version'], {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    timeout: 3000,
                });
                if (result.status === 0) return cmd;
            } catch {}
        }

        return 'stata-agent';
    }
}

module.exports = { DaemonManager };
