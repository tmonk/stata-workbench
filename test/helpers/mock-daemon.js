#!/usr/bin/env node
/**
 * Minimal mock stata-agent daemon for integration tests.
 *
 * Accepts: daemon start --session NAME [--mock]
 * Creates a Unix socket and responds to NDJSON RPCs with mock results.
 * Run as: node test/helpers/mock-daemon.js daemon start --session test [--mock]
 */
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SESSION_DIR = path.join(os.homedir(), '.cache', 'stata-agent', 'sessions');

function parseArgs() {
    const args = process.argv.slice(2);
    const cmd = args[0];
    const sub = args[1];
    const opts = {};
    for (let i = 2; i < args.length; i++) {
        if (args[i] === '--session' && i + 1 < args.length) opts.session = args[++i];
        if (args[i] === '--mock') opts.mock = true;
        if (args[i] === '--transport' && i + 1 < args.length) opts.transport = args[++i];
    }
    return { cmd, sub, opts };
}

function main() {
    const { cmd, sub, opts } = parseArgs();
    if (cmd !== 'daemon' || sub !== 'start') {
        console.error('Usage: mock-daemon daemon start --session NAME [--mock]');
        process.exit(1);
    }

    const sessionName = opts.session || 'default';
    const isWin = process.platform === 'win32';
    const transport = opts.transport || (isWin ? 'tcp' : 'unix');
    const sockName = sessionName;
    const metaPath = path.join(SESSION_DIR, `${sessionName}.json`);
    const sockPath = path.join(SESSION_DIR, `${sessionName}.sock`);

    // Create session directory
    try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch {}

    // Remove stale files
    try { if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath); } catch {}
    try { if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath); } catch {}

    let server;
    if (transport === 'unix') {
        server = net.createServer(handleConnection);
        server.listen(sockPath, () => {
            fs.chmodSync(sockPath, 0o600);
            writeMeta(metaPath, { transport: 'unix', path: sockPath });
        });
    } else {
        const port = opts.port || 0;
        server = net.createServer(handleConnection);
        server.listen(port, '127.0.0.1', () => {
            const addr = server.address();
            writeMeta(metaPath, { transport: 'tcp', port: addr.port, host: '127.0.0.1' });
        });
    }

    server.on('error', (err) => {
        console.error('Server error:', err.message);
        process.exit(1);
    });

    // Handle stop
    process.on('SIGTERM', () => {
        cleanup();
        process.exit(0);
    });
    process.on('SIGINT', () => {
        cleanup();
        process.exit(0);
    });

    function cleanup() {
        try { server?.close(); } catch {}
        try { if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath); } catch {}
        try { if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath); } catch {}
    }
}

function writeMeta(metaPath, meta) {
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

function handleConnection(sock) {
    let buf = '';

    sock.on('data', (data) => {
        buf += data.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (!line.trim()) continue;
            try {
                const req = JSON.parse(line);
                const response = handleRequest(req);
                sock.write(JSON.stringify(response) + '\n');
            } catch (e) {
                sock.write(JSON.stringify({ ok: false, error: `Parse error: ${e.message}` }) + '\n');
            }
        }
    });

    sock.on('error', () => {});
}

function handleRequest(req) {
    const { id, method, args } = req;

    switch (method) {
        case 'health':
            return { id, ok: true, result: { status: 'ok', pid: process.pid, sessions: ['default'] } };

        case 'run':
            return { id, ok: true, result: { ok: true, rc: 0, stdout: `. ${args?.code || ''}\n`, log_path: '/tmp/mock.log' } };

        case 'run_file':
            return { id, ok: true, result: { ok: true, rc: 0, stdout: 'Running file\n', log_path: '/tmp/mock.log' } };

        case 'break':
            return { id, ok: true, result: { acknowledged: true } };

        case 'inspect_describe':
            return {
                id, ok: true, result: {
                    variables: [
                        { name: 'price', type: 'float', label: 'Price', format: '%8.0g' },
                        { name: 'mpg', type: 'int', label: 'Mileage', format: '%8.0g' },
                        { name: 'rep78', type: 'int', label: 'Repair Record', format: '%8.0g' },
                    ],
                    obs_count: 74, var_count: 3, dataset_name: 'auto.dta'
                }
            };

        case 'inspect_get':
            return { id, ok: true, result: { path: '/tmp/mock-data.arrow', size_bytes: 256 } };

        case 'inspect_summary':
            return { id, ok: true, result: { stdout: 'Summary output', log_path: '/tmp/mock.log' } };

        case 'inspect_codebook':
            return { id, ok: true, result: { stdout: 'Codebook output', log_path: '/tmp/mock.log' } };

        case 'inspect_list':
            return { id, ok: true, result: { stdout: 'List output', log_path: '/tmp/mock.log' } };

        case 'graph_list':
            return { id, ok: true, result: { graph_names: ['gint', 'mygraph'] } };

        case 'graph_export':
            return { id, ok: true, result: { file_path: args?.out_path || '/tmp/graph.pdf', path: args?.out_path || '/tmp/graph.pdf' } };

        case 'results':
            return { id, ok: true, result: { 'r(N)': 74, 'r(mean)': 6165.26 } };

        case 'log_tail':
            return { id, ok: true, result: { text: 'Mock log output\n', log_path: '/tmp/mock.log', next_offset: 100, total_size: 500 } };

        case 'log_search':
            return { id, ok: true, result: { matches: ['line with pattern'] } };

        case 'log_read_at_offset':
            return { id, ok: true, result: { text: 'Mock data at offset\n', next_offset: (args?.offset || 0) + 100 } };

        case 'task_status':
            return { id, ok: true, result: { status: 'completed', task_id: args?.task_id } };

        case 'task_cancel':
            return { id, ok: true, result: { cancelled: true } };

        case 'validate_filter':
            return { id, ok: true, result: { valid: true } };

        case 'compute_view_indices':
            return { id, ok: true, result: { indices: [0, 1, 2] } };

        case 'stop':
            return { id, ok: true, result: { stopped: true } };

        default:
            return { id, ok: false, error: `Unknown method: ${method}` };
    }
}

main();
