const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { runTests } = require('@vscode/test-electron');

// Use 'default' so the extension's StataClient (which defaults to sessionName='default')
// connects to the daemon we start here, instead of spawning a second daemon.
const SESSION_NAME = 'default';
const SESSION_DIR = path.join(os.homedir(), '.cache', 'stata-agent', 'sessions');
const STATA_AGENT_DIR = path.join(os.homedir(), 'projects', 'stata-agent');

async function main() {
    const shardTotal = Math.max(1, parseInt(process.env.TEST_SHARD_TOTAL || '1', 10));
    const shardIndexEnv = process.env.TEST_SHARD_INDEX;

    if (shardTotal > 1 && (shardIndexEnv === undefined || shardIndexEnv === null || shardIndexEnv === '')) {
        const shardIndices = Array.from({ length: shardTotal }, (_v, idx) => idx);
        const scriptPath = __filename;

        const runs = shardIndices.map((idx) => new Promise((resolve, reject) => {
            const env = { ...process.env, TEST_SHARD_TOTAL: String(shardTotal), TEST_SHARD_INDEX: String(idx) };
            const child = spawn(process.execPath, [scriptPath], { env, stdio: 'inherit' });
            child.on('exit', (code) => {
                if (code === 0) return resolve();
                reject(new Error(`Shard ${idx + 1}/${shardTotal} exited with code ${code}`));
            });
            child.on('error', reject);
        }));

        try {
            await Promise.all(runs);
            process.exit(0);
        } catch (err) {
            console.error('Integration shard run failed:', err.message || err);
            process.exit(1);
        }
        return;
    }

    let userDataDir;
    let extDir;
    let workspacePath;
    let daemonProcess = null;
    let restoredEnv = null;
    try {
        restoredEnv = sanitizeHostElectronEnv();

        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');
        process.stderr.write(`[INTEGRATION] extensionDevelopmentPath: ${extensionDevelopmentPath}\n`);
        process.stderr.write(`[INTEGRATION] extensionTestsPath: ${extensionTestsPath}\n`);

        // Use a real workspace folder so integration tests can write Workspace settings.
        workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'stata-wb-ws-'));

        // Use fresh temp dirs per run to avoid mutex/file-lock issues on Windows between runs.
        userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-test-user-'));
        extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-test-exts-'));

        // Start the stata-agent daemon (live Stata mode) before launching VS Code.
        daemonProcess = await startDaemon(SESSION_NAME);

        // Set env var for the spawned VS Code process so extension uses the correct daemon.
        process.env.STATA_AGENT_INTEGRATION = '1';

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: ['--user-data-dir', userDataDir, '--extensions-dir', extDir, workspacePath]
        });

        console.log('Test completed successfully. Dumping logs...');
        dumpLogs(userDataDir);
    } catch (err) {
        console.error('Failed to run integration tests', err);
        if (userDataDir) {
            dumpLogs(userDataDir);
        }
        process.exit(1);
    } finally {
        // Stop the daemon
        if (daemonProcess) {
            try {
                daemonProcess.kill('SIGTERM');
                // Also try NDJSON stop request
                try {
                    const metaPath = path.join(SESSION_DIR, `${SESSION_NAME}.json`);
                    if (fs.existsSync(metaPath)) {
                        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                        const net = require('net');
                        const sock = meta.transport === 'unix'
                            ? net.createConnection({ path: meta.path })
                            : net.createConnection({ port: meta.port, host: meta.host || '127.0.0.1' });
                        sock.write(JSON.stringify({ id: 'stop-int', method: 'stop', args: {} }) + '\n');
                        sock.end();
                        setTimeout(() => sock.destroy(), 1000);
                    }
                } catch {}
                // Give it a moment before forced kill
                await new Promise(r => setTimeout(r, 2000));
                try { daemonProcess.kill('SIGKILL'); } catch {}
            } catch {}
        }

        // Clean up temp workspace
        if (workspacePath && fs.existsSync(workspacePath)) {
            try {
                fs.rmSync(workspacePath, { recursive: true, force: true });
            } catch (_err) {}
        }

        if (typeof restoredEnv === 'function') {
            restoredEnv();
        }
    }
}

/**
 * Start the stata-agent daemon for the given session.
 * Returns the ChildProcess once the daemon is ready (meta file exists).
 */
async function startDaemon(sessionName) {
    // Always use uv run from the dev directory so the latest development
    // version of stata-agent is used, even when not installed on PATH.
    const cmd = 'uv';
    const args = ['run', 'stata-agent', 'daemon', 'start', '--session', sessionName];

    console.error(`[INTEGRATION] Starting daemon: ${cmd} ${args.join(' ')} (cwd=${STATA_AGENT_DIR})`);

    const proc = spawn(cmd, args, {
        cwd: STATA_AGENT_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        detached: process.platform !== 'win32',
    });

    proc.stderr.on('data', (d) => {
        process.stderr.write(`[daemon:stderr] ${d}`);
    });
    proc.stdout.on('data', (d) => {
        process.stderr.write(`[daemon:stdout] ${d}`);
    });

    // Poll for the meta file to confirm daemon is ready
    const metaPath = path.join(SESSION_DIR, `${sessionName}.json`);
    const startTime = Date.now();
    const timeout = 30000;

    while (Date.now() - startTime < timeout) {
        if (fs.existsSync(metaPath)) {
            try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                if (meta.transport === 'unix' ? fs.existsSync(meta.path) : true) {
                    console.error(`[INTEGRATION] Daemon ready for session '${sessionName}'`);
                    return proc;
                }
            } catch {}
        }
        await new Promise(r => setTimeout(r, 200));
    }

    // Timeout — kill and throw
    try { proc.kill('SIGKILL'); } catch {}
    throw new Error(`Daemon failed to start within ${timeout}ms for session '${sessionName}'`);
}

function sanitizeHostElectronEnv() {
    const previous = {
        ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE
    };
    const removed = {};

    delete process.env.ELECTRON_RUN_AS_NODE;

    for (const key of Object.keys(process.env)) {
        if (key.startsWith('VSCODE_')) {
            removed[key] = process.env[key];
            delete process.env[key];
        }
    }

    return () => {
        if (previous.ELECTRON_RUN_AS_NODE !== undefined) {
            process.env.ELECTRON_RUN_AS_NODE = previous.ELECTRON_RUN_AS_NODE;
        }
        for (const [key, value] of Object.entries(removed)) {
            process.env[key] = value;
        }
    };
}

function dumpLogs(userDataDir) {
    try {
        const logsRoot = path.join(userDataDir, 'logs');
        if (!fs.existsSync(logsRoot)) {
            console.error(`No logs dir at ${logsRoot}`);
            return;
        }
        const stampDirs = fs.readdirSync(logsRoot).sort();
        const latestStamp = stampDirs[stampDirs.length - 1];
        const stampPath = path.join(logsRoot, latestStamp);
        const candidates = [];

        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir)) {
                const full = path.join(dir, entry);
                const stat = fs.statSync(full);
                if (stat.isDirectory()) {
                    walk(full);
                } else if (/Stata Workbench\.log$/i.test(entry)) {
                    candidates.push(full);
                }
            }
        };

        walk(stampPath);
        if (!candidates.length) {
            console.error(`No logs found under ${stampPath}`);
            return;
        }

        for (const file of candidates) {
            try {
                const content = fs.readFileSync(file, 'utf8');
                const lines = content.split(/\r?\n/);
                const tail = lines.slice(-200).join('\n');
                console.error(`\n--- Log tail: ${file} ---\n${tail}\n--- end log tail ---`);
            } catch (readErr) {
                console.error(`Failed to read log ${file}: ${readErr.message}`);
            }
        }
    } catch (logErr) {
        console.error(`Failed to dump logs: ${logErr.message}`);
    }
}

main();
