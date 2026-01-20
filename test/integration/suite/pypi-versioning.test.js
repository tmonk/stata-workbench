const vscode = require('vscode');

describe('McpClient PyPI Versioning Integration', () => {
    jest.setTimeout(60000);

    const enabled = process.env.MCP_STATA_INTEGRATION === '1';
    let logs = [];
    let originalSpec;
    let originalConfig;

    beforeAll(() => {
        if (!enabled) return;
        originalSpec = process.env.MCP_STATA_PACKAGE_SPEC;
        originalConfig = process.env.MCP_STATA_CONFIG;
    });

    afterAll(() => {
        process.env.MCP_STATA_PACKAGE_SPEC = originalSpec;
        process.env.MCP_STATA_CONFIG = originalConfig;
    });

    const runIfEnabled = enabled ? test : test.skip;

    runIfEnabled('dynamic versioning: fetches and logs version from PyPI', async () => {
        delete process.env.MCP_STATA_PACKAGE_SPEC;
        delete process.env.MCP_STATA_CONFIG;

        const { StataMcpClient } = require('../../../src/mcp-client');
        const client = new StataMcpClient();
        logs = [];
        client.setLogger((msg) => {
            logs.push(msg);
            console.log('[PyPI Dynamic Test Log]', msg);
        });

        // Mock workspace root to avoid picking up .vscode/mcp.json
        client._resolveWorkspaceRoot = () => null;

        try {
            await client.run('display 1');
        } catch (err) { }

        const versionLog = logs.find(l => l.includes('PyPI versions (latest 5)'));
        const resolvedLog = logs.find(l => l.includes('Resolved latest version'));
        const startingLog = logs.find(l => l.includes('Starting mcp-stata via uvx'));

        expect(versionLog).toBeDefined();
        expect(resolvedLog).toBeDefined();
        expect(startingLog).toContain('mcp-stata=='); // Should use exact version from PyPI

        await client.dispose();
    });

    runIfEnabled('forced latest: uses @latest instead of exact PyPI version', async () => {
        delete process.env.MCP_STATA_PACKAGE_SPEC;
        delete process.env.MCP_STATA_CONFIG;

        const { StataMcpClient } = require('../../../src/mcp-client');
        const client = new StataMcpClient();
        client._forceLatestServer = true;
        logs = [];
        client.setLogger((msg) => {
            logs.push(msg);
            console.log('[PyPI Forced Test Log]', msg);
        });

        client._resolveWorkspaceRoot = () => null;

        try {
            await client.run('display 1');
        } catch (err) { }

        const startingLog = logs.find(l => l.includes('Starting mcp-stata via uvx'));
        expect(startingLog).toContain('mcp-stata@latest');

        await client.dispose();
    });
});
