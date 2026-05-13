const fs = require('fs');
const os = require('os');
const path = require('path');
const { DaemonManager } = require('../../../src/daemon-manager');
const { StataClient } = require('../../../src/stata-client');

describe('StataClient integration', () => {
    jest.setTimeout(180000); // 3 minutes for slow Stata startups

    let tempRoot;
    let workDir;
    let doDir;
    let doFile;
    let daemonMgr;
    let client;
    let logLines = [];

    beforeAll(async () => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stata-wb-int-'));
        workDir = path.join(tempRoot, 'workdir');
        doDir = path.join(tempRoot, 'scripts');
        fs.mkdirSync(workDir, { recursive: true });
        fs.mkdirSync(doDir, { recursive: true });
        doFile = path.join(doDir, 'integration.do');
        fs.writeFileSync(doFile, [
            'display "integration-ok"',
        ].join('\n'));

        daemonMgr = new DaemonManager();
        client = new StataClient(daemonMgr);
        client.setRequestTimeout(60000);

        client.on('error', (err) => {
            logLines.push(`[error] ${err.message}`);
        });
        client.on('status', (status) => {
            logLines.push(`[status] ${status}`);
        });

        // Start mock daemon and ensure connection before tests
        await daemonMgr.ensureRunning('default', { mock: true });
        await client.ensureConnected('default');
    });

    afterAll(async () => {
        if (client) {
            await client.disconnect();
        }
        if (daemonMgr) {
            await daemonMgr.stop();
        }
        if (tempRoot && fs.existsSync(tempRoot)) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    test('runs .do file', async () => {
        const result = await client.runFile(doFile, { strict: false });
        expect(result.ok).toBe(true);
        expect(result.rc).toBe(0);
        const stdout = result.stdout || '';
        expect(typeof stdout).toBe('string');
    });

    test('returns variables after sysuse auto', async () => {
        const load = await client.runCode('sysuse auto', { strict: false });
        expect(load.ok).toBe(true);

        const vars = await client.listVariables();
        expect(Array.isArray(vars)).toBe(true);
        expect(vars.length).toBeGreaterThanOrEqual(1);
        const names = vars.map(v => v.name);
        expect(names).toContain('price');
    });

    test('streams output via log path', async () => {
        const result = await client.runCode('display "background-log-ok"', { strict: false });
        expect(result.ok).toBe(true);
        expect(result.stdout).toContain('background-log-ok');
        expect(result.log_path).toBeTruthy();
    });

    test('does not poll task status or result', async () => {
        logLines.length = 0;
        const result = await client.runCode('display "no-poll"', { strict: false });
        expect(result.ok).toBe(true);
        const combined = logLines.join('\n');
        // The NDJSON protocol is direct RPC — no polling needed
        expect(combined).not.toContain('stata_task_status');
        expect(combined).not.toContain('get_task_result');
    });

    test('serializes multiple rapid runCode calls', async () => {
        const p1 = client.runCode('display "msg1"', { strict: false });
        const p2 = client.runCode('display "msg2"', { strict: false });
        const p3 = client.runCode('display "msg3"', { strict: false });

        const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);
        expect(r3.ok).toBe(true);

        expect(r1.stdout).toContain('msg1');
        expect(r2.stdout).toContain('msg2');
        expect(r3.stdout).toContain('msg3');
    });

    test('cancels execution via break', async () => {
        // Run a simple command first to verify the session is active
        const r1 = await client.runCode('display "pre-cancel"', { strict: false });
        expect(r1.ok).toBe(true);

        // Send break — the daemon acknowledges it and resets
        const cancelResult = await client.cancel();
        expect(cancelResult).toBeDefined();
        expect(cancelResult.acknowledged).toBe(true);

        // Verify the session still works after break
        const r2 = await client.runCode('display "post-cancel"', { strict: false });
        expect(r2.ok).toBe(true);
        expect(r2.stdout).toContain('post-cancel');
    });

    test('exports a graph to PDF', async () => {
        // Load auto dataset for mock compatibility
        await client.runCode('sysuse auto', { strict: false });

        const result = await client.exportGraph('gint', 'pdf');
        expect(result).toBeDefined();
        // Mock returns file_path; real daemon returns path — either is acceptable
        const filePath = result.file_path || result.path || '';
        expect(filePath).toMatch(/\.pdf$/i);
    });
});
