const { describe, it, expect, jest, beforeEach, afterEach } = require('bun:test');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

let extension;
let vscode;

describe('Bundled Binary Discovery', () => {
    let originalSpawnSync;
    let originalExistsSync;

    beforeEach(() => {
        // Reset cache to reload extension with mocks
        for (const key of Object.keys(require.cache)) {
            delete require.cache[key];
        }

        originalSpawnSync = cp.spawnSync;
        originalExistsSync = fs.existsSync;

        cp.spawnSync = jest.fn();
        fs.existsSync = jest.fn();

        // Basic VS Code mock
        vscode = require('vscode');
        
        // Load extension
        extension = require('../../src/extension');
    });

    afterEach(() => {
        cp.spawnSync = originalSpawnSync;
        fs.existsSync = originalExistsSync;
        jest.clearAllMocks();
    });

    it('finds bundled binary when system uv is missing', () => {
        const platform = process.platform;
        const arch = process.arch;
        const binName = platform === 'win32' ? 'uvx.exe' : 'uvx';
        
        // 1. System calls fail
        cp.spawnSync.mockImplementation((cmd, args) => {
            if (['uvx', 'uvx.exe', 'uv', 'uv.exe'].includes(cmd)) {
                return { error: new Error('ENOENT'), status: -1 };
            }
            // For the bundled binary check, it will call it with --version
            if (cmd.includes(path.join('bin', `${platform}-${arch}`, binName))) {
                return { status: 0, stdout: 'uv 0.5.0', stderr: '' };
            }
            return { status: 1 };
        });

        // 2. Mock filesystem
        fs.existsSync.mockImplementation((p) => {
            if (p.includes(path.join('bin', `${platform}-${arch}`, binName))) {
                return true;
            }
            return false;
        });

        // We need a mock context with extensionUri
        const mockContext = {
            extensionUri: { fsPath: '/mock/extension' },
            globalStoragePath: '/mock/storage',
            globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue() },
            subscriptions: []
        };

        // Re-inject globalContext which is set in activate
        // But findUvBinary is not exported, it's used inside activate.
        // Wait, activate calls ensureMcpCliAvailable which calls findUvBinary.

        // Actually, let's test ensureMcpCliAvailable via activate
        // We need to mock more things for activate to pass
        const mcpClient = require('../../src/mcp-client').client;
        mcpClient.onStatusChanged = jest.fn().mockReturnValue({ dispose: jest.fn() });
        mcpClient.setLogger = jest.fn();
        mcpClient.setTaskDoneHandler = jest.fn();

        extension.activate(mockContext);

        // It should have found the bundled binary
        // Based on the logic in extension.js:
        // process.env.MCP_STATA_UVX_CMD = uvCommand;
        const expectedPrefix = path.join('/mock/extension', 'bin', `${platform}-${arch}`, binName);
        expect(process.env.MCP_STATA_UVX_CMD).toContain(expectedPrefix);
    });
});
