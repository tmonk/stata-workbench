const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { spawnSync } = require('child_process');

describe('McpClient integration (VS Code host)', () => {
    jest.setTimeout(180000); // 3 minutes for slow Stata startups

    const enabled = process.env.MCP_STATA_INTEGRATION === '1';
    let tempRoot;
    let workDir;
    let doDir;
    let doFile;
    let client;

    beforeAll(async () => {
        if (!enabled) {
            return;
        }

        const uvxCmd = process.env.MCP_STATA_UVX_CMD || 'uvx';
        const uvxProbe = spawnSync(uvxCmd, ['--version'], { encoding: 'utf8' });
        if (uvxProbe.status !== 0) {
            console.warn('[INTEGRATION] uvx not found, tests will be skipped or fail.');
            return;
        }

        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stata-wb-int-'));
        workDir = path.join(tempRoot, 'workdir');
        doDir = path.join(tempRoot, 'scripts');
        fs.mkdirSync(workDir, { recursive: true });
        fs.mkdirSync(doDir, { recursive: true });
        doFile = path.join(doDir, 'integration.do');
        fs.writeFileSync(doFile, [
            'display "integration-ok"'
        ].join('\n'));

        const config = vscode.workspace.getConfiguration('stataMcp');
        await config.update('runFileWorkingDirectory', workDir, vscode.ConfigurationTarget.Workspace);
        await config.update('requestTimeoutMs', 60000, vscode.ConfigurationTarget.Workspace);

        const { StataMcpClient } = require('../../../src/mcp-client');
        client = new StataMcpClient();
    });

    afterAll(async () => {
        if (client?.dispose) {
            await client.dispose();
        }
        if (enabled) {
            const config = vscode.workspace.getConfiguration('stataMcp');
            await config.update('runFileWorkingDirectory', '', vscode.ConfigurationTarget.Workspace);
        }
        if (tempRoot && fs.existsSync(tempRoot)) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    const runIfEnabled = enabled ? test : test.skip;

    runIfEnabled('runs .do file with configured working directory', async () => {
        const result = await client.runFile(doFile, { normalizeResult: true, includeGraphs: false });
        expect(result.success).toBe(true);
        expect(result.rc).toBe(0);
        const stdout = result.stdout || result.contentText || '';
        expect(stdout).toContain('integration-ok');
        // Match path separator for consistency
        expect(result.cwd.toLowerCase()).toBe(workDir.toLowerCase());
    });

    runIfEnabled('returns variables after sysuse auto', async () => {
        const load = await client.runSelection('sysuse auto', { normalizeResult: true, includeGraphs: false });
        expect(load.success).toBe(true);

        const vars = await client.getVariableList();
        expect(Array.isArray(vars)).toBe(true);
        expect(vars.length).toBeGreaterThanOrEqual(1);
        const names = vars.map(v => v.name);
        expect(names).toContain('price');
    });

    runIfEnabled('streams output via log path and read_log', async () => {
        const result = await client.runSelection('display "background-log-ok"', { normalizeResult: true, includeGraphs: false });
        expect(result.success).toBe(true);
        expect(result.stdout).toContain('background-log-ok');
        expect(result.logPath).toBeTruthy();
    });



    runIfEnabled('exports a graph to PDF', async () => {
        // Create a graph
        await client.runSelection('sysuse auto', { normalizeResult: true, includeGraphs: false });
        await client.runSelection('twoway scatter price mpg, name(gint, replace)', { normalizeResult: true, includeGraphs: true });

        const result = await client.fetchGraph('gint', { format: 'pdf' });
        expect(result).toBeDefined();
        expect(result.path).toMatch(/\.pdf$/i);
        expect(result.path.startsWith('data:')).toBe(false);
        expect(fs.existsSync(result.path)).toBe(true);
    });
});
