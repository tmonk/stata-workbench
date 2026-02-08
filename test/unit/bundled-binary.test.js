const { describe, it, expect, jest } = require('bun:test');
const path = require('path');
const { withTestContext } = require('../helpers/test-context');
const { createExtensionHarness } = require('../helpers/extension-harness');

describe('Bundled Binary Discovery', () => {
    it('finds bundled binary when system uv is missing', () => {
        const fs = {
            existsSync: jest.fn(),
            writeFileSync: jest.fn(),
            mkdirSync: jest.fn()
        };
        const cp = { spawnSync: jest.fn() };
        const mcpClientMock = {
            setLogger: jest.fn(),
            onStatusChanged: jest.fn().mockReturnValue({ dispose: jest.fn() }),
            dispose: jest.fn(),
            connect: jest.fn().mockResolvedValue({}),
            runSelection: jest.fn().mockResolvedValue({}),
            getUiChannel: jest.fn().mockResolvedValue(null),
            hasConfig: jest.fn().mockReturnValue(false),
            getServerConfig: jest.fn().mockReturnValue({ command: null, args: null, env: {}, configPath: null })
        };

        const { extension, vscode } = createExtensionHarness({ fs, cp });
        return withTestContext({
            vscode: vscode,
            fs,
            childProcess: cp,
            mcpClient: mcpClientMock
        }, (ctx) => {
            const env = ctx.env;
            delete env.MCP_STATA_UVX_CMD;

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

        const mockContext = {
            extensionUri: { fsPath: '/mock/extension' },
            globalStoragePath: '/mock/storage',
            globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue() },
            subscriptions: [],
            extensionMode: vscode.ExtensionMode.Test
        };

        // Activate extension to trigger uv discovery
            const api = extension.activate(mockContext);

        const expectedPrefix = path.join('/mock/extension', 'bin', `${platform}-${arch}`, binName);
            expect(env.MCP_STATA_UVX_CMD).toContain(expectedPrefix);
            expect(api).toBeTruthy();
        });
    });
});
