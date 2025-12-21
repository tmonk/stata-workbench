const assert = require('chai').assert;
const fs = require('fs');
const os = require('os');
const path = require('path');
const proxyquire = require('proxyquire');
const { spawnSync } = require('child_process');

// Full integration test that exercises runFile against the real mcp-stata server.
// Requires: uvx + mcp-stata available, Stata licensed, and MCP_STATA_INTEGRATION=1.
describe('McpClient integration (requires mcp_stata)', function () {
    this.timeout(120000);

    let tempRoot;
    let workDir;
    let doDir;
    let doFile;
    let client;
    let enabled;

    before(function () {
        enabled = process.env.MCP_STATA_INTEGRATION === '1';
        if (!enabled) {
            this.skip();
            return;
        }

        const uvxCmd = process.env.MCP_STATA_UVX_CMD || 'uvx';
        const uvxProbe = spawnSync(uvxCmd, ['--version'], { encoding: 'utf8' });
        if (uvxProbe.status !== 0) {
            this.skip();
            return;
        }
        process.env.MCP_STATA_UVX_CMD = uvxCmd;

        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stata-wb-int-'));
        workDir = path.join(tempRoot, 'workdir');
        doDir = path.join(tempRoot, 'scripts');
        fs.mkdirSync(workDir, { recursive: true });
        fs.mkdirSync(doDir, { recursive: true });
        doFile = path.join(doDir, 'integration.do');
        fs.writeFileSync(doFile, [
            'capture log close _all',
            'log using "integration.log", replace text',
            'display "integration-ok"',
            'log close'
        ].join('\n'));

        const vscodeStub = {
            workspace: {
                workspaceFolders: [{ uri: { fsPath: tempRoot } }],
                getConfiguration: () => ({
                    get: (key, def) => {
                        if (key === 'runFileWorkingDirectory') return workDir;
                        if (key === 'requestTimeoutMs') return 60000;
                        return def;
                    }
                })
            },
            commands: {
                getCommands: () => Promise.resolve([]),
                executeCommand: () => Promise.resolve()
            }
        };

        const { StataMcpClient } = proxyquire.noPreserveCache().noCallThru()('../../src/mcp-client', { vscode: vscodeStub });
        client = new StataMcpClient();
    });

    after(async function () {
        if (client?.dispose) {
            await client.dispose();
        }
        if (tempRoot && fs.existsSync(tempRoot)) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('runs .do file with configured working directory', async () => {
        const result = await client.runFile(doFile, { normalizeResult: true, includeGraphs: false });
        assert.isTrue(result.success, 'runFile success flag');
        assert.strictEqual(result.rc, 0);
        const stdout = result.stdout || result.contentText || '';
        assert.include(stdout, 'integration-ok');
        assert.strictEqual(result.cwd, workDir, 'cwd metadata should reflect configured working directory');
    });

    it('returns variables after sysuse auto', async () => {
        if (!enabled) {
            this.skip();
            return;
        }

        const load = await client.runSelection('sysuse auto', { normalizeResult: true, includeGraphs: false });
        assert.isTrue(load.success, 'load dataset');

        const vars = await client.getVariableList();
        assert.isArray(vars, 'variable list should be array');
        assert.isAtLeast(vars.length, 1, 'variable list should not be empty');
        const names = vars.map(v => v.name);
        assert.include(names, 'price', 'should include known variable from auto dataset');
    });

    it('cancels a long-running command via cancelAll', async function () {
        if (!enabled) {
            this.skip();
            return;
        }

        // Fire a long-running command and cancel shortly after
        const runPromise = client.runSelection('sleep 5000', { normalizeResult: true, includeGraphs: false });
        // Give the request a moment to enqueue/start
        await new Promise(res => setTimeout(res, 150));
        const cancelled = await client.cancelAll();
        assert.isTrue(cancelled, 'cancelAll should report true');

        let errorCaught = false;
        try {
            await runPromise;
        } catch (err) {
            errorCaught = true;
            assert.match(err.message || String(err), /cancel/i);
        }
        assert.isTrue(errorCaught, 'run should reject after cancellation');
    });

    it('exports a graph to PDF without base64', async function () {
        if (!enabled) {
            this.skip();
            return;
        }

        // Create a graph
        await client.runSelection('sysuse auto', { normalizeResult: true, includeGraphs: false });
        await client.runSelection('twoway scatter price mpg, name(gint, replace)', { normalizeResult: true, includeGraphs: true });

        const result = await client.fetchGraph('gint', { format: 'pdf' });
        assert.isOk(result, 'fetchGraph returned result');
        assert.isString(result.path, 'graph path present');
        assert.match(result.path, /\.pdf$/i, 'graph path should be PDF');
        assert.isFalse(result.path.startsWith('data:'), 'should not return base64 data uri');
        assert.isTrue(fs.existsSync(result.path), 'exported PDF should exist on disk');
    });
});
