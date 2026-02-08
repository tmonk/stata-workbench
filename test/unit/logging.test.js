const { describe, it, expect, jest } = require('bun:test');
const { withTestContext } = require('../helpers/test-context');
const { createExtensionHarness } = require('../helpers/extension-harness');
const { createVscodeMock } = require('../mocks/vscode');

const setupHarness = (overrides = {}) => {
    global.addLogToSentryBuffer = jest.fn();

    const outputChannelMock = {
        appendLine: jest.fn(),
        append: jest.fn(),
        show: jest.fn(),
        dispose: jest.fn()
    };

    const vscode = overrides.vscode || createVscodeMock();
    vscode.window.createOutputChannel.mockReturnValue(outputChannelMock);

    const fs = overrides.fs || {
        existsSync: jest.fn().mockReturnValue(true),
        readFileSync: jest.fn().mockReturnValue(''),
        writeFileSync: jest.fn(),
        mkdirSync: jest.fn(),
        statSync: jest.fn().mockReturnValue({ size: 100 }),
        openSync: jest.fn().mockReturnValue(1),
        readSync: jest.fn().mockReturnValue(0),
        closeSync: jest.fn()
    };

    const cp = overrides.cp || {
        spawnSync: jest.fn().mockReturnValue({ status: 0, stdout: '1.0.0', stderr: '' })
    };

    const mcpClientMock = overrides.mcpClientMock || {
        setLogger: jest.fn(),
        onStatusChanged: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        updateConfig: jest.fn(),
        hasConfig: jest.fn().mockReturnValue(true),
        getServerConfig: jest.fn().mockReturnValue({ command: 'uvx' }),
        connect: jest.fn().mockResolvedValue({})
    };

    const harness = createExtensionHarness({
        vscode,
        fs,
        cp,
        mcpClientMock,
        terminalPanel: { setExtensionUri: jest.fn(), setLogProvider: jest.fn() },
        dataBrowserPanel: { setLogger: jest.fn() }
    });

    return { ...harness, outputChannelMock, mcpClientMock, fs, cp, vscode };
};

const itWithHarness = (name, fn) => it(name, () => {
    const harness = setupHarness();
    return withTestContext({
        vscode: harness.vscode,
        fs: harness.fs,
        childProcess: harness.cp,
        mcpClient: harness.mcpClientMock
    }, () => fn(harness));
});

describe('Logging behaviour tests', () => {
    itWithHarness('suppresses raw stderr logs by default but sends to Sentry', async ({ extension, outputChannelMock, mcpClientMock, vscode }) => {

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

    itWithHarness('shows code logs when logStataCode is true', async ({ extension, outputChannelMock, mcpClientMock, vscode }) => {

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

    itWithHarness('shows everything when showAllLogsInOutput is true', async ({ extension, outputChannelMock, mcpClientMock, vscode }) => {

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

    itWithHarness('correctly routes high-level connection events by default', async ({ extension, outputChannelMock, mcpClientMock, vscode }) => {

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

    itWithHarness('logRunToOutput suppresses output on success when settings are off', async ({ extension, outputChannelMock, vscode }) => {

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

    itWithHarness('logRunToOutput shows output on failure even when settings are off', async ({ extension, outputChannelMock, vscode }) => {

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

    itWithHarness('logRunToOutput shows output on success when logStataCode is on', async ({ extension, outputChannelMock, vscode }) => {

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

    itWithHarness('updates mcpClient config when VS Code settings change', async ({ extension, mcpClientMock, vscode }) => {

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

        // Simulate config change event
        vscode.workspace._fireConfigChange({ affectsConfiguration: (section) => section === 'stataMcp' });

        expect(mcpClientMock.updateConfig).toHaveBeenCalledWith({
            logStataCode: true
        });
    });
});
