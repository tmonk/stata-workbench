const path = require('path');
const fs = require('fs');
const os = require('os');
const spawn = (bin, args, opts) => {
	const child = require('child_process').spawn(bin, args, opts);
	return child;
};

const SESSION_DIR = path.join(os.homedir(), '.cache', 'mcp-stata', 'sessions');

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

        // Find the stata binary
        const stataBin = this._findStataBinary();

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
            const proc = spawn(stataBin, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env },
                detached: !isWin,
            });

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

    _findStataBinary() {
        // Check STATA_PATH env
        if (process.env.STATA_PATH) {
            return process.env.STATA_PATH;
        }

        // Try python -m stata_agent.daemon (development mode)
        // Use 'stata' CLI as primary
        const candidates = ['stata', 'python3', 'python'];
        for (const cmd of candidates) {
            try {
                const result = require('child_process').spawnSync(cmd, ['--version'], {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    timeout: 2000,
                });
                if (result.status === 0) return cmd;
            } catch {}
        }

        // Look for the installed stata CLI
        if (process.platform !== 'win32') {
            for (const p of ['/usr/local/bin/stata', path.join(os.homedir(), '.local', 'bin', 'stata')]) {
                if (fs.existsSync(p)) return p;
            }
        }

        // Fall back to 'stata' (will fail gracefully with a clear error)
        return 'stata';
    }
}

module.exports = { DaemonManager };
