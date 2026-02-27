/**
 * Integration-style test: MCP config install/cleanup with REAL file I/O.
 * Verifies that user settings are NEVER touched - only mcp_stata is added/removed.
 *
 * Run: bun run test --testPathPattern="mcp-config-immutability"
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { describe, it, expect, beforeAll, afterAll } = require('bun:test');
const { withTestContext } = require('../helpers/test-context');
const { createExtensionHarness } = require('../helpers/extension-harness');

describe('MCP config immutability (real file I/O)', () => {
    let TEMP_ROOT;
    let harness;

    beforeAll(() => {
        TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-immutability-'));
        harness = createExtensionHarness();
    });

    afterAll(() => {
        if (TEMP_ROOT && fs.existsSync(TEMP_ROOT)) {
            fs.rmSync(TEMP_ROOT, { recursive: true });
        }
    });

    it('JSON install and remove: other servers and top-level keys preserved', () => {
        return withTestContext({
            vscode: harness.vscode,
            fs: { ...require('fs') },
            childProcess: harness.cp,
            mcpClient: harness.mcpClientMock
        }, () => {
            const ext = require('../../src/extension');
            const mcpPath = path.join(TEMP_ROOT, 'mcp.json');
            const userConfig = {
                inputs: [{ type: 'promptString', id: 'api-key', description: 'API Key' }],
                servers: {
                    github: { type: 'http', url: 'https://api.github.com/mcp' },
                    memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }
                }
            };
            fs.writeFileSync(mcpPath, JSON.stringify(userConfig, null, 2));

            harness.vscode.workspace.getConfiguration = () => ({
                get: (k, d) => (k === 'noReloadOnClear' ? false : d)
            });

            ext.writeMcpConfig({
                configPath: mcpPath,
                writeVscode: true,
                writeCursor: false
            });

            const written = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
            expect(written.inputs).toEqual(userConfig.inputs);
            expect(written.servers.github).toEqual(userConfig.servers.github);
            expect(written.servers.memory).toEqual(userConfig.servers.memory);
            expect(written.servers.mcp_stata).toBeDefined();

            ext.removeFromMcpConfig({ configPath: mcpPath, writeVscode: true, writeCursor: false });
            const afterRemove = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
            expect(afterRemove.servers.mcp_stata).toBeUndefined();
            expect(afterRemove.servers.github).toEqual(userConfig.servers.github);
            expect(afterRemove.inputs).toEqual(userConfig.inputs);
        });
    });

    it('TOML install and remove: other sections preserved', () => {
        return withTestContext({
            vscode: harness.vscode,
            fs: { ...require('fs') },
            childProcess: harness.cp,
            mcpClient: harness.mcpClientMock
        }, () => {
            const ext = require('../../src/extension');
            const codexDir = path.join(TEMP_ROOT, '.codex');
            fs.mkdirSync(codexDir, { recursive: true });
            const tomlPath = path.join(codexDir, 'config.toml');
            const originalToml = `# User comment
model = "gpt-5.2-codex"

[mcp_servers.memory]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-memory"]

[mcp_servers.github]
url = "https://api.github.com/mcp"
`;
            fs.writeFileSync(tomlPath, originalToml);

            harness.vscode.workspace.getConfiguration = () => ({
                get: (k, d) => (k === 'noReloadOnClear' ? false : d)
            });

            ext.writeCodexMcpConfig({ configPath: tomlPath });

            const written = fs.readFileSync(tomlPath, 'utf8');
            expect(written).toContain('# User comment');
            expect(written).toContain('model = "gpt-5.2-codex"');
            expect(written).toContain('[mcp_servers.memory]');
            expect(written).toContain('[mcp_servers.github]');
            expect(written).toContain('[mcp_servers.mcp_stata]');

            ext.removeFromCodexMcpConfig({ configPath: tomlPath });
            const afterRemove = fs.readFileSync(tomlPath, 'utf8');
            expect(afterRemove).not.toContain('[mcp_servers.mcp_stata]');
            expect(afterRemove).toContain('[mcp_servers.memory]');
            expect(afterRemove).toContain('[mcp_servers.github]');
            expect(afterRemove).toContain('model = "gpt-5.2-codex"');
        });
    });
});
