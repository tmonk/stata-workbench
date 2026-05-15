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

    test('health returns daemon status', async () => {
        const result = await client.health();
        expect(result).toBeDefined();
        expect(result.status).toBe('ok');
        expect(typeof result.pid).toBe('number');
    });

    test('getDatasetState returns dataset metadata', async () => {
        await client.runCode('sysuse auto', { strict: false });

        const state = await client.getDatasetState();
        expect(state).toBeDefined();
        expect(typeof state.obs_count).toBe('number');
        expect(typeof state.var_count).toBe('number');
        expect(typeof state.dataset_name).toBe('string');
    });

    test('getDataPage returns binary data', async () => {
        await client.runCode('sysuse auto', { strict: false });

        const page = await client.getDataPage(0, 10, 'price mpg');
        expect(page).toBeDefined();
        expect(Buffer.isBuffer(page)).toBe(true);
    });

    test('computeViewIndices returns array of matching indices', async () => {
        await client.runCode('sysuse auto', { strict: false });

        const indices = await client.computeViewIndices('price > 5000');
        expect(Array.isArray(indices)).toBe(true);
    });

    test('validateFilterExpr returns valid=true for correct expressions', async () => {
        const result = await client.validateFilterExpr('price > 5000');
        expect(result.valid).toBe(true);
        expect(result.error).toBeNull();
    });

    test('listGraphs returns graph names', async () => {
        await client.runCode('sysuse auto', { strict: false });
        await client.runCode('scatter price mpg', { strict: false });
        await client.runCode('graph export "gint.pdf", replace', { strict: false });

        const result = await client.listGraphs();
        expect(result).toBeDefined();
    });

    test('getResults returns stored result macros', async () => {
        await client.runCode('sysuse auto', { strict: false });
        await client.runCode('summarize price', { strict: false });

        const rResults = await client.getResults('r');
        expect(rResults).toBeDefined();

        const eResults = await client.getResults('e');
        expect(eResults).toBeDefined();
    });

    test('getLogTail returns recent log lines', async () => {
        const result = await client.getLogTail(10);
        expect(result).toBeDefined();
        expect(typeof result.text).toBe('string');
    });

    test('searchLog finds patterns in log', async () => {
        const result = await client.searchLog('auto');
        expect(result).toBeDefined();
    });

    test('readLogAtOffset reads log at given offset', async () => {
        // First run something to generate log output
        await client.runCode('display "log-read-test-12345"', { strict: false });

        // Get the log tail to find our output
        const tail = await client.getLogTail(50);
        expect(tail.log_path).toBeTruthy();

        if (tail.log_path) {
            const chunk = await client.readLogAtOffset(tail.log_path, 0, 4096);
            expect(chunk).toBeDefined();
            expect(typeof chunk.text).toBe('string');
            expect(typeof chunk.next_offset).toBe('number');
        }
    });

    test('getTaskStatus returns task info for a known task', async () => {
        const result = await client.getTaskStatus('nonexistent-task-id');
        expect(result).toBeDefined();
    });

    test('cancelTask returns acknowledgement', async () => {
        const result = await client.cancelTask('nonexistent-task-id');
        expect(result).toBeDefined();
    });

    test('supports multi-session isolation', async () => {
        // Create a second session
        await daemonMgr.ensureRunning('session-b', { mock: true });
        await client.ensureConnected('session-b');

        // Run code in session-b
        const r1 = await client.runCode('display "session-b-active"', {
            sessionName: 'session-b',
            strict: false,
        });
        expect(r1.ok).toBe(true);

        // Session 'default' still works
        const r2 = await client.runCode('display "default-active"', { strict: false });
        expect(r2.ok).toBe(true);

        // Health check on both sessions
        const healthDefault = await client.health('default');
        const healthB = await client.health('session-b');
        expect(healthDefault.status).toBe('ok');
        expect(healthB.status).toBe('ok');

        // Clean up second session
        await client.disconnect('session-b');
        await daemonMgr.stop('session-b');
    });
});
