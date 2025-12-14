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

    const enabled = process.env.MCP_STATA_INTEGRATION === '1';
    let tempRoot;
    let workDir;
    let doDir;
    let doFile;
    let client;

    before(function () {
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
});
