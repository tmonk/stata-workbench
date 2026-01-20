const fs = require('fs');
const os = require('os');
const path = require('path');
const { getMcpConfigTarget, writeMcpConfig } = require('../../../src/extension');

describe('MCP Config Integration', () => {
    jest.setTimeout(60000);

    const enabled = process.env.MCP_STATA_INTEGRATION === '1';

    let tempRoot;
    let originalAppData;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stata-wb-mcp-'));
        originalAppData = process.env.APPDATA;
    });

    afterEach(() => {
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

        expect(fs.existsSync(target.configPath)).toBe(true);
        const json = JSON.parse(fs.readFileSync(target.configPath, 'utf8'));
        expect('servers' in json).toBeTruthy();
        expect('mcp_stata' in json.servers).toBeTruthy();
        expect('mcpServers' in json).toBeFalsy();
        expect(target.configPath).toBe(path.join(tempRoot, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json'));
    });

    test('writes Cursor config on simulated linux host', () => {
        const ctx = {
            mcpPlatformOverride: 'linux',
            mcpHomeOverride: path.join(tempRoot, 'home', 'alice'),
            mcpAppNameOverride: 'Cursor'
        };

        const target = getMcpConfigTarget(ctx);
        writeMcpConfig(target);

        expect(fs.existsSync(target.configPath)).toBe(true);
        const json = JSON.parse(fs.readFileSync(target.configPath, 'utf8'));
        expect('mcpServers' in json).toBeTruthy();
        expect('mcp_stata' in json.mcpServers).toBeTruthy();
        expect('servers' in json).toBeFalsy();
        expect(target.configPath).toBe(path.join(tempRoot, 'home', 'alice', '.cursor', 'mcp.json'));
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

        expect(fs.existsSync(target.configPath)).toBe(true);
        const json = JSON.parse(fs.readFileSync(target.configPath, 'utf8'));
        expect('mcpServers' in json).toBeTruthy();
        expect('mcp_stata' in json.mcpServers).toBeTruthy();
        expect('servers' in json).toBeFalsy();
        expect(target.configPath).toBe(
            path.join(tempRoot, 'AppData', 'Roaming', 'Antigravity', 'User', 'mcp.json')
        );
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
        expect(server.env).toEqual({ STATA_LICENSE: 'abc', STATA_PATH: '/opt/stata' });
        expect(server.note).toEqual('keep-me');
        expect(server.args).toEqual(['--refresh', '--from', 'mcp-stata@latest', 'mcp-stata', '--reinstall-package', 'mcp-stata']);
        expect('mcpServers' in json).toBeFalsy();
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
        expect('mcp_stata' in json.servers).toBeTruthy();
        expect('mcp_stata' in json.mcpServers).toBeFalsy();

        // Non-mcp-stata entries remain untouched
        expect(json.servers.other_server).toEqual(initial.servers.other_server);
        // Ensure cursor-style other server was not deleted
        expect('mcpServers' in json).toBeTruthy();
        expect(json.mcpServers.other_server).toEqual(initial.mcpServers.other_server);
    });
});
