const { describe, it, beforeAll, afterAll, expect } = require('bun:test');
const { DaemonManager } = require('../../src/daemon-manager');
const { StataClient } = require('../../src/stata-client');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Check whether the `stata` CLI (from the stata-agent package) is available.
 * This is the binary that DaemonManager._findStataAgentBinary() uses to spawn the daemon.
 */
const STATA_AGENT_DIR = path.join(process.env.HOME, 'projects', 'stata-agent');

const STATA_AVAILABLE = (() => {
    try {
        const r = cp.spawnSync('stata-agent', ['--version'], { timeout: 3000 });
        if (r.status === 0 && r.stdout.toString().includes('stata-agent')) {
            return true;
        }
    } catch {}
    // Fallback: check via uv in the stata-agent project directory
    try {
        const r = cp.spawnSync('uv', ['run', 'stata-agent', '--version'], {
            cwd: STATA_AGENT_DIR,
            timeout: 5000,
        });
        if (r.status === 0 && r.stdout.toString().includes('stata-agent')) {
            // Set STATA_AGENT_PATH so DaemonManager can find it
            process.env.STATA_AGENT_PATH = '/Users/tom/projects/stata-agent/.venv/bin/stata-agent';
            return true;
        }
    } catch {}
    return false;
})();

const itIfAvailable = STATA_AVAILABLE ? it : it.skip;
const describeIfAvailable = STATA_AVAILABLE ? describe : describe.skip;

/**
 * Check whether a real Stata binary is available using the stata-agent
 * discovery module (same detection logic the daemon itself uses).
 */
const REAL_STATA_AVAILABLE = (() => {
    try {
        const r = cp.spawnSync(
            'uv',
            ['run', 'python', '-c',
             'from stata_agent.discovery import find_stata_candidates; '
             + 'import json; print(json.dumps([p for p, e in find_stata_candidates()]))'
            ],
            { cwd: STATA_AGENT_DIR, timeout: 10000 }
        );
        if (r.status === 0) {
            const candidates = JSON.parse(r.stdout.toString().trim());
            return Array.isArray(candidates) && candidates.length > 0;
        }
    } catch {}
    return false;
})();

const itIfRealAvailable = REAL_STATA_AVAILABLE ? it : it.skip;
const describeIfRealAvailable = REAL_STATA_AVAILABLE ? describe : describe.skip;

describeIfAvailable('DaemonManager + StataClient end-to-end (mock daemon)', () => {
    let daemonMgr;
    let stataClient;

    beforeAll(async () => {
        daemonMgr = new DaemonManager();
        stataClient = new StataClient(daemonMgr);
        await daemonMgr.ensureRunning('e2e-test', { mock: true, timeout: 30000 });
        await stataClient.ensureConnected('e2e-test');
    }, 35000);

    afterAll(async () => {
        try {
            if (stataClient) await stataClient.disconnect('e2e-test');
        } catch {}
        try {
            if (daemonMgr) await daemonMgr.stop('e2e-test');
        } catch {}
    }, 10000);

    itIfAvailable('health check returns ok', async () => {
        const result = await stataClient.health('e2e-test');
        expect(result.status).toBe('ok');
        expect(typeof result.pid).toBe('number');
    });

    itIfAvailable('runCode returns a result', async () => {
        const result = await stataClient.runCode('display 1+1', { sessionName: 'e2e-test' });
        expect(result).toBeDefined();
        expect(result.ok).toBe(true);
        expect(typeof result.stdout).toBe('string');
    });

    itIfAvailable('listVariables returns array', async () => {
        const vars = await stataClient.listVariables('e2e-test');
        expect(Array.isArray(vars)).toBe(true);
    });

    itIfAvailable('cancel returns acknowledged', async () => {
        const result = await stataClient.cancel('e2e-test');
        expect(result.acknowledged).toBe(true);
    });
});

describeIfRealAvailable('DaemonManager + StataClient end-to-end (real Stata daemon)', () => {
    let daemonMgr;
    let stataClient;

    beforeAll(async () => {
        daemonMgr = new DaemonManager();
        stataClient = new StataClient(daemonMgr);
        // Start WITHOUT --mock so it uses the real Stata binary
        await daemonMgr.ensureRunning('e2e-live-test', { mock: false, timeout: 60000 });
        await stataClient.ensureConnected('e2e-live-test');
    }, 65000);

    afterAll(async () => {
        try {
            if (stataClient) await stataClient.disconnect('e2e-live-test');
        } catch {}
        try {
            if (daemonMgr) await daemonMgr.stop('e2e-live-test');
        } catch {}
    }, 15000);

    itIfRealAvailable('health check returns ok', async () => {
        const result = await stataClient.health('e2e-live-test');
        expect(result.status).toBe('ok');
        expect(typeof result.pid).toBe('number');
    });

    itIfRealAvailable('runCode display hello executes against real Stata', async () => {
        const result = await stataClient.runCode('display "stata-live-ok"', { sessionName: 'e2e-live-test' });
        expect(result).toBeDefined();
        expect(result.ok).toBe(true);
        expect(result.stdout).toContain('stata-live-ok');
    });

    itIfRealAvailable('listVariables returns array', async () => {
        const vars = await stataClient.listVariables('e2e-live-test');
        expect(Array.isArray(vars)).toBe(true);
    });

    itIfRealAvailable('cancel returns acknowledged', async () => {
        const result = await stataClient.cancel('e2e-live-test');
        expect(result.acknowledged).toBe(true);
    });
});
