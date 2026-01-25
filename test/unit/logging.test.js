const { describe, it, beforeEach, afterEach, expect, jest } = require('bun:test');
const vscode = require('vscode');

// Mock the global Sentry buffer
global.addLogToSentryBuffer = jest.fn();

const resetModules = () => {
    for (const key of Object.keys(require.cache)) {
        delete require.cache[key];
    }
};

const mockCjsModule = (modulePath, factory) => {
    const resolved = require.resolve(modulePath);
    const existing = require.cache[resolved];
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: factory()
    };
    return () => {
        if (existing) {
            require.cache[resolved] = existing;
        } else {
            delete require.cache[resolved];
        }
    };
};

describe('Logging behaviour tests', () => {
    let extension;
    let mcpClientMock;
    let restoreModuleMocks = [];
    let outputChannelMock;
    let fsOriginals;
    let cpOriginalSpawnSync;

    beforeEach(() => {
        resetModules();
        global.addLogToSentryBuffer.mockClear();

        // Stub builtin modules in-place to avoid unwanted side effects or hangs
        const fs = require('fs');
        fsOriginals = {
            existsSync: fs.existsSync,
            readFileSync: fs.readFileSync,
            writeFileSync: fs.writeFileSync,
            mkdirSync: fs.mkdirSync,
            statSync: fs.statSync,
            openSync: fs.openSync,
            readSync: fs.readSync,
            closeSync: fs.closeSync
        };
        fs.existsSync = jest.fn().mockReturnValue(true);
        fs.readFileSync = jest.fn().mockReturnValue('');
        fs.writeFileSync = jest.fn();
        fs.mkdirSync = jest.fn();
        fs.statSync = jest.fn().mockReturnValue({ size: 100 });
        fs.openSync = jest.fn().mockReturnValue(1);
        fs.readSync = jest.fn().mockReturnValue(0);
        fs.closeSync = jest.fn();

        const cp = require('child_process');
        cpOriginalSpawnSync = cp.spawnSync;
        cp.spawnSync = jest.fn().mockReturnValue({ status: 0, stdout: '1.0.0', stderr: '' });

        outputChannelMock = {
            appendLine: jest.fn(),
            append: jest.fn(),
            show: jest.fn(),
            dispose: jest.fn()
        };

        vscode.window.createOutputChannel.mockReturnValue(outputChannelMock);

        mcpClientMock = {
            setLogger: jest.fn(),
            onStatusChanged: jest.fn().mockReturnValue({ dispose: jest.fn() }),
            updateConfig: jest.fn(),
            hasConfig: jest.fn().mockReturnValue(true),
            getServerConfig: jest.fn().mockReturnValue({ command: 'uvx' }),
            connect: jest.fn().mockResolvedValue({})
        };

        restoreModuleMocks = [];
        restoreModuleMocks.push(mockCjsModule('../../src/mcp-client', () => ({
            StataMcpClient: jest.fn().mockImplementation(() => mcpClientMock),
            client: mcpClientMock
        })));
        restoreModuleMocks.push(mockCjsModule('../../src/terminal-panel', () => ({
            TerminalPanel: { setExtensionUri: jest.fn(), setLogProvider: jest.fn() }
        })));
        restoreModuleMocks.push(mockCjsModule('../../src/data-browser-panel', () => ({
            DataBrowserPanel: { setLogger: jest.fn() }
        })));

        extension = require('../../src/extension');
    });

    afterEach(() => {
        const fs = require('fs');
        Object.assign(fs, fsOriginals);
        const cp = require('child_process');
        cp.spawnSync = cpOriginalSpawnSync;

        vscode.workspace._configListeners = [];
        restoreModuleMocks.forEach(r => r());
        jest.clearAllMocks();
    });

    it('suppresses raw stderr logs by default but sends to Sentry', async () => {
        const config = {
            get: jest.fn().mockImplementation((key, def) => {
                if (key === 'showAllLogsInOutput') return false;
                if (key === 'logStataCode') return false;
                return def;
            })
        };
        vscode.workspace.getConfiguration.mockReturnValue(config);

        await extension.activate({
            subscriptions: [],
            globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue() },
            extensionUri: { fsPath: '/test' },
            extensionMode: vscode.ExtensionMode.Test
        });

        const loggerCallback = mcpClientMock.setLogger.mock.calls[0][0];
        expect(loggerCallback).toBeDefined();

        // 1. Raw stderr log
        loggerCallback('[mcp-stata stderr] some raw smack message');
        expect(outputChannelMock.appendLine).not.toHaveBeenCalledWith('[mcp-stata stderr] some raw smack message');
        expect(global.addLogToSentryBuffer).toHaveBeenCalled();

        // 2. Code log when disabled
        loggerCallback('[mcp-stata code] di "hello"');
        expect(outputChannelMock.appendLine).not.toHaveBeenCalledWith('[mcp-stata code] di "hello"');
    });

    it('shows code logs when logStataCode is true', async () => {
        const config = {
            get: jest.fn().mockImplementation((key, def) => {
                if (key === 'showAllLogsInOutput') return false;
                if (key === 'logStataCode') return true;
                return def;
            })
        };
        vscode.workspace.getConfiguration.mockReturnValue(config);

        await extension.activate({
            subscriptions: [],
            globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue() },
            extensionUri: { fsPath: '/test' },
            extensionMode: vscode.ExtensionMode.Test
        });

        const loggerCallback = mcpClientMock.setLogger.mock.calls[0][0];
        
        loggerCallback('[mcp-stata code] di "hello"');
        expect(outputChannelMock.appendLine).toHaveBeenCalledWith('[mcp-stata code] di "hello"');
    });

    it('shows everything when showAllLogsInOutput is true', async () => {
        const config = {
            get: jest.fn().mockImplementation((key, def) => {
                if (key === 'showAllLogsInOutput') return true;
                return def;
            })
        };
        vscode.workspace.getConfiguration.mockReturnValue(config);

        await extension.activate({
            subscriptions: [],
            globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue() },
            extensionUri: { fsPath: '/test' },
            extensionMode: vscode.ExtensionMode.Test
        });

        const loggerCallback = mcpClientMock.setLogger.mock.calls[0][0];
        
        loggerCallback('[mcp-stata stderr] chunk of smack');
        expect(outputChannelMock.appendLine).toHaveBeenCalledWith('[mcp-stata stderr] chunk of smack');
    });

    it('correctly routes high-level connection events by default', async () => {
        const config = {
            get: jest.fn().mockImplementation((key, def) => {
                if (key === 'showAllLogsInOutput') return false;
                return def;
            })
        };
        vscode.workspace.getConfiguration.mockReturnValue(config);

        await extension.activate({
            subscriptions: [],
            globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue() },
            extensionUri: { fsPath: '/test' },
            extensionMode: vscode.ExtensionMode.Test
        });

        const loggerCallback = mcpClientMock.setLogger.mock.calls[0][0];
        
        loggerCallback('mcp-stata connected (pid=123)');
        expect(outputChannelMock.appendLine).toHaveBeenCalledWith('mcp-stata connected (pid=123)');

        loggerCallback('[mcp-stata] INFO: Stata discovered');
        expect(outputChannelMock.appendLine).toHaveBeenCalledWith('[mcp-stata] INFO: Stata discovered');

        // General [mcp-stata] logs should be shown (per user preference)
        loggerCallback('[mcp-stata] starting operation: connect (pending: 1)');
        expect(outputChannelMock.appendLine).toHaveBeenCalledWith('[mcp-stata] starting operation: connect (pending: 1)');
    });

    it('logRunToOutput suppresses output on success when settings are off', async () => {
        const config = {
            get: jest.fn().mockImplementation((key, def) => {
                if (key === 'logStataCode') return false;
                if (key === 'showAllLogsInOutput') return false;
                return def;
            })
        };
        vscode.workspace.getConfiguration.mockReturnValue(config);

        const api = await extension.activate({
            subscriptions: [],
            globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue() },
            extensionUri: { fsPath: '/test' },
            extensionMode: vscode.ExtensionMode.Test
        });

        outputChannelMock.appendLine.mockClear();
        api.logRunToOutput({ success: true, rc: 0, stdout: 'should be hidden' }, 'Test Task');
        
        expect(outputChannelMock.appendLine).not.toHaveBeenCalled();
    });

    it('logRunToOutput shows output on failure even when settings are off', async () => {
        const config = {
            get: jest.fn().mockImplementation((key, def) => {
                if (key === 'logStataCode') return false;
                if (key === 'showAllLogsInOutput') return false;
                return def;
            })
        };
        vscode.workspace.getConfiguration.mockReturnValue(config);

        const api = await extension.activate({
            subscriptions: [],
            globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue() },
            extensionUri: { fsPath: '/test' },
            extensionMode: vscode.ExtensionMode.Test
        });

        outputChannelMock.appendLine.mockClear();
        api.logRunToOutput({ success: false, rc: 111, stderr: 'error message' }, 'Test Task');
        
        expect(outputChannelMock.appendLine).toHaveBeenCalled();
        expect(outputChannelMock.appendLine.mock.calls.some(call => call[0].includes('error message'))).toBe(true);
    });

    it('logRunToOutput shows output on success when logStataCode is on', async () => {
        const config = {
            get: jest.fn().mockImplementation((key, def) => {
                if (key === 'logStataCode') return true;
                if (key === 'showAllLogsInOutput') return false;
                return def;
            })
        };
        vscode.workspace.getConfiguration.mockReturnValue(config);

        const api = await extension.activate({
            subscriptions: [],
            globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue() },
            extensionUri: { fsPath: '/test' },
            extensionMode: vscode.ExtensionMode.Test
        });

        outputChannelMock.appendLine.mockClear();
        api.logRunToOutput({ success: true, rc: 0, stdout: 'should be visible' }, 'Test Task');
        
        expect(outputChannelMock.appendLine).toHaveBeenCalled();
        expect(outputChannelMock.appendLine.mock.calls.some(call => call[0].includes('should be visible'))).toBe(true);
    });

    it('updates mcpClient config when VS Code settings change', async () => {
        const config = {
            get: jest.fn().mockImplementation((key, def) => {
                if (key === 'logStataCode') return true;
                return def;
            })
        };
        vscode.workspace.getConfiguration.mockReturnValue(config);

        const api = await extension.activate({
            subscriptions: [],
            globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue() },
            extensionUri: { fsPath: '/test' },
            extensionMode: vscode.ExtensionMode.Test
        });

        expect(api.mcpClient).toBe(mcpClientMock);

        // Simulate config change event
        vscode.workspace._fireConfigChange({ affectsConfiguration: (section) => section === 'stataMcp' });

        expect(mcpClientMock.updateConfig).toHaveBeenCalledWith({
            logStataCode: true
        });
    });
});
