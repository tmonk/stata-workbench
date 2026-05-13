const { describe, it, beforeAll, afterAll, expect } = require('bun:test');
const { DaemonManager } = require('../../src/daemon-manager');
const { StataClient } = require('../../src/stata-client');
const cp = require('child_process');
const path = require('path');

/**
 * Check whether the `stata` CLI (from the stata-agent package) is available.
 * This is the binary that DaemonManager._findStataBinary() uses to spawn the daemon.
 */
const STATA_AVAILABLE = (() => {
    try {
        const r = cp.spawnSync('stata', ['--version'], { timeout: 3000 });
        if (r.status === 0) return true;
    } catch {}
    // Fallback: check via uv in the stata-agent project directory
    try {
        const r = cp.spawnSync('uv', ['run', 'stata', '--version'], {
            cwd: path.join(process.env.HOME, 'projects', 'stata-agent'),
            timeout: 5000,
        });
        if (r.status === 0) return true;
    } catch {}
    return false;
})();

const itIfAvailable = STATA_AVAILABLE ? it : it.skip;
const describeIfAvailable = STATA_AVAILABLE ? describe : describe.skip;

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
        expect(result.status).toBe('running');
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
