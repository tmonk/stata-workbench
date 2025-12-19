const assert = require('chai').assert;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getMcpConfigTarget, writeMcpConfig } = require('../../../src/extension');

suite('MCP Config Integration', function () {
    this.timeout(30000);

    const enabled = process.env.MCP_STATA_INTEGRATION === '1';

    let tempRoot;
    let originalAppData;

    setup(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stata-wb-mcp-'));
        originalAppData = process.env.APPDATA;
    });

    teardown(() => {
        process.env.APPDATA = originalAppData;
        if (tempRoot && fs.existsSync(tempRoot)) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    test('writes VS Code config on simulated windows host', () => {
        if (!enabled) {
            return;
        }
        process.env.APPDATA = path.join(tempRoot, 'AppData', 'Roaming');
        const ctx = {
            mcpPlatformOverride: 'win32',
            mcpHomeOverride: path.join(tempRoot, 'Users', 'Alice'),
            mcpAppNameOverride: 'Visual Studio Code'
        };

        const target = getMcpConfigTarget(ctx);
        writeMcpConfig(target);

        assert.isTrue(fs.existsSync(target.configPath), 'config file should exist');
        const json = JSON.parse(fs.readFileSync(target.configPath, 'utf8'));
        assert.property(json, 'servers');
        assert.property(json.servers, 'mcp_stata');
        assert.notProperty(json, 'mcpServers');
        assert.strictEqual(target.configPath, path.join(tempRoot, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json'));
    });

    test('writes Cursor config on simulated linux host', () => {
        const ctx = {
            mcpPlatformOverride: 'linux',
            mcpHomeOverride: path.join(tempRoot, 'home', 'alice'),
            mcpAppNameOverride: 'Cursor'
        };

        const target = getMcpConfigTarget(ctx);
        writeMcpConfig(target);

        assert.isTrue(fs.existsSync(target.configPath));
        const json = JSON.parse(fs.readFileSync(target.configPath, 'utf8'));
        assert.property(json, 'servers');
        assert.property(json.servers, 'mcp_stata');
        assert.property(json, 'mcpServers');
        assert.property(json.mcpServers, 'mcp_stata');
        assert.strictEqual(target.configPath, path.join(tempRoot, 'home', 'alice', '.cursor', 'mcp.json'));
    });

    test('writes Antigravity config on simulated windows host', () => {
        process.env.APPDATA = path.join(tempRoot, 'AppData', 'Roaming');
        const ctx = {
            mcpPlatformOverride: 'win32',
            mcpHomeOverride: path.join(tempRoot, 'Users', 'Carol'),
            mcpAppNameOverride: 'Antigravity'
        };

        const target = getMcpConfigTarget(ctx);
        writeMcpConfig(target);

        assert.isTrue(fs.existsSync(target.configPath));
        const json = JSON.parse(fs.readFileSync(target.configPath, 'utf8'));
        assert.property(json, 'servers');
        assert.property(json.servers, 'mcp_stata');
        assert.property(json, 'mcpServers');
        assert.property(json.mcpServers, 'mcp_stata');
        assert.strictEqual(target.configPath, path.join(tempRoot, 'AppData', 'Roaming', 'Antigravity', 'User', 'mcp.json'));
    });
});
