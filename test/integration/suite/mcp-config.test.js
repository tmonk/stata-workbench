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
        assert.property(json, 'mcpServers');
        assert.property(json.mcpServers, 'mcp_stata');
        assert.notProperty(json, 'servers');
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
        assert.property(json, 'mcpServers');
        assert.property(json.mcpServers, 'mcp_stata');
        assert.notProperty(json, 'servers');
        assert.strictEqual(target.configPath, path.join(tempRoot, 'AppData', 'Roaming', 'Antigravity', 'User', 'mcp.json'));
    });

    test('preserves existing env and custom fields when updating', () => {
        const ctx = {
            mcpPlatformOverride: 'linux',
            mcpHomeOverride: path.join(tempRoot, 'home', 'dev'),
            mcpAppNameOverride: 'Visual Studio Code'
        };

        const target = getMcpConfigTarget(ctx);
        fs.mkdirSync(path.dirname(target.configPath), { recursive: true });

        const initial = `{
            "servers": {
                "mcp_stata": {
                    "type": "stdio",
                    "command": "uvx",
                    "args": ["--from", "mcp-stata@latest", "mcp-stata"],
                    "env": { "STATA_PATH": "/opt/stata" },
                    "note": "keep-me",
                }
            },
            "mcpServers": {
                "mcp_stata": {
                    "command": "uvx",
                    "args": ["--from", "mcp-stata@latest", "mcp-stata"],
                    "env": { "STATA_LICENSE": "abc" },
                    "retry": 2,
                }
            }
        }`;

        fs.writeFileSync(target.configPath, initial, 'utf8');

        writeMcpConfig(target);

        const json = JSON.parse(fs.readFileSync(target.configPath, 'utf8'));
        const server = json.servers.mcp_stata;

        // Env should be merged from any legacy cursor entry.
        assert.deepEqual(server.env, { STATA_LICENSE: 'abc', STATA_PATH: '/opt/stata' }, 'env should merge legacy entries');
        assert.equal(server.note, 'keep-me', 'custom server fields should be preserved');
        assert.deepEqual(server.args.slice(0, 2), ['--refresh', '--from'], 'server args should be updated with refresh');
        assert.notProperty(json, 'mcpServers', 'legacy cursor entry should be removed when targeting VS Code');
    });

    test('does not touch other server entries', () => {
        const ctx = {
            mcpPlatformOverride: 'linux',
            mcpHomeOverride: path.join(tempRoot, 'home', 'dev'),
            mcpAppNameOverride: 'Visual Studio Code'
        };

        const target = getMcpConfigTarget(ctx);
        fs.mkdirSync(path.dirname(target.configPath), { recursive: true });

        const initial = {
            servers: {
                mcp_stata: {
                    type: 'stdio',
                    command: 'uvx',
                    args: ['--from', 'mcp-stata@latest', 'mcp-stata'],
                    env: { STATA_PATH: '/opt/stata' }
                },
                other_server: {
                    type: 'stdio',
                    command: 'foo',
                    args: ['bar'],
                    env: { KEEP: 'me' }
                }
            },
            mcpServers: {
                other_server: {
                    command: 'baz',
                    args: ['qux'],
                    env: { ALSO: 'keep' }
                }
            }
        };

        fs.writeFileSync(target.configPath, JSON.stringify(initial, null, 2), 'utf8');

        writeMcpConfig(target);

        const json = JSON.parse(fs.readFileSync(target.configPath, 'utf8'));
        // mcp-stata should be present only under servers for VS Code host
        assert.property(json.servers, 'mcp_stata');
        assert.notProperty(json.mcpServers, 'mcp_stata', 'mcp_stata should be removed from mcpServers for VS Code host');

        // Non-mcp-stata entries remain untouched
        assert.deepEqual(json.servers.other_server, initial.servers.other_server, 'other server entry should be unchanged');
        // Ensure cursor-style other server was not deleted
        assert.property(json, 'mcpServers');
        assert.deepEqual(json.mcpServers.other_server, initial.mcpServers.other_server, 'other mcpServer entry should be unchanged');
    });
});
