
const { describe, it, beforeEach, expect, jest } = require('bun:test');
const { mock: bunMock } = require('bun:test');
const sinon = require('sinon');
const path = require('path');
const os = require('os');
const { withTestContext } = require('../helpers/test-context');

// Reuse mocks from existing tests
class ClientMock {
    constructor() {
        this.connect = sinon.stub().resolves();
        this.request = sinon.stub().resolves({ content: [] });
        this.setNotificationHandler = sinon.stub();
        this.on = sinon.stub();
        this.close = sinon.stub().resolves();
    }
}

class StdioClientTransportMock {
    constructor(options) {
        this.options = options;
        this.close = sinon.stub().resolves();
    }
}

const dummySchema = { 
    parse: (x) => x, 
    safeParse: (x) => ({ success: true, data: x }),
    _def: {
        shape: () => ({
            method: { _def: { value: 'dummy' } }
        })
    }
};
// Add the shape property as well as some versions might look there directly
dummySchema.shape = dummySchema._def.shape();
bunMock.module('@modelcontextprotocol/sdk/client', () => ({ Client: ClientMock }));
bunMock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: StdioClientTransportMock }));
bunMock.module('@modelcontextprotocol/sdk/types', () => ({
    LoggingMessageNotificationSchema: dummySchema,
    ProgressNotificationSchema: dummySchema,
    CallToolResultSchema: dummySchema
}));

const cpMock = {
    spawnSync: sinon.stub().returns({ status: 0, stdout: 'uv 0.1.0', stderr: '' })
};
bunMock.module('child_process', () => cpMock);

const { StataMcpClient: McpClient } = require('../../src/mcp-client');

describe('Startup Do File Logic', () => {
    let client;
    let vscode;

    beforeEach(() => {
        client = new McpClient();
        vscode = require('vscode');
        // Reset VS Code mock state
        vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/test/workspace' } }];
    });

    describe('_resolvePath', () => {
        it('should resolve ${workspaceFolder}', () => {
            const resolved = client._resolvePath('${workspaceFolder}/my.do');
            expect(resolved).toBe(path.normalize('/test/workspace/my.do'));
        });

        it('should resolve ~ to home directory', () => {
            const home = os.homedir();
            const resolved = client._resolvePath('~/scripts/my.do');
            expect(resolved).toBe(path.normalize(path.join(home, 'scripts/my.do')));
        });

        it('should return absolute paths as is (normalized)', () => {
            const abs = path.join('/abs', 'path', 'to.do');
            const resolved = client._resolvePath(abs);
            expect(resolved).toBe(path.normalize(abs));
        });

        it('should resolve relative paths against workspace root', () => {
             const resolved = client._resolvePath('local.do');
             expect(resolved).toBe(path.normalize('/test/workspace/local.do'));
        });

        it('should return empty string for empty input', () => {
            expect(client._resolvePath('')).toBe('');
            expect(client._resolvePath('   ')).toBe('');
            expect(client._resolvePath(null)).toBe('');
        });
    });

    describe('_createClient environment', () => {
        it('should pass MCP_STATA_STARTUP_DO_FILE to transport', async () => {
            const config = {
                get: jest.fn().mockImplementation((key, def) => {
                    if (key === 'startupDoFile') return '${workspaceFolder}/startup.do';
                    if (key === 'setupTimeoutSeconds') return 60;
                    return def;
                })
            };
            vscode.workspace.getConfiguration = jest.fn().mockReturnValue(config);

            // Mock discovery result
            client._getMcpConfig = jest.fn().mockResolvedValue({
                command: 'uvx',
                args: ['mcp-stata']
            });

            const { transport } = await client._createClient();
            
            const params = transport._serverParams || transport.options;
            expect(params).toBeDefined();
            expect(params.env.MCP_STATA_STARTUP_DO_FILE).toBe(path.normalize('/test/workspace/startup.do'));
        });

        it('should NOT pass MCP_STATA_STARTUP_DO_FILE if setting is empty', async () => {
            const config = {
                get: jest.fn().mockImplementation((key, def) => {
                    if (key === 'startupDoFile') return '';
                    return def;
                })
            };
            vscode.workspace.getConfiguration = jest.fn().mockReturnValue(config);
            client._getMcpConfig = jest.fn().mockResolvedValue({ command: 'uvx', args: [] });

            const { transport } = await client._createClient();
            
            const params = transport._serverParams || transport.options;
            expect(params.env.MCP_STATA_STARTUP_DO_FILE).toBeUndefined();
        });
    });
});
