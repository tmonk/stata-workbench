const { describe, it, expect, jest } = require('bun:test');
const { withTestContext } = require('../helpers/test-context');
const { createExtensionHarness } = require('../helpers/extension-harness');

describe('extension initialization log', () => {
    const itWithHarness = (name, fn) => it(name, async () => {
        const harness = createExtensionHarness();
        return withTestContext({
            vscode: harness.vscode,
            fs: harness.fs,
            childProcess: harness.cp,
            mcpClient: harness.mcpClientMock
        }, (ctx) => fn(harness));
    });

    itWithHarness('displays (local) in Development mode', async (h) => {
        const context = {
            subscriptions: [],
            globalState: { get: jest.fn().mockReturnValue(true), update: jest.fn().mockResolvedValue() },
            globalStoragePath: '/tmp/globalStorage',
            extensionUri: { fsPath: '/path/to/extension' },
            extensionMode: h.vscode.ExtensionMode.Development
        };

        // The harness already creates the output channel when activate is called
        // We need to trigger activate
        await h.extension.activate(context);

        const outputChannel = h.vscode.window.createOutputChannel.mock.results[0]?.value;
        expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('ready (extension v'));
        expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('(local)'));
    });

    itWithHarness('displays (local) when running from debug path', async (h) => {
        const context = {
            subscriptions: [],
            globalState: { get: jest.fn().mockReturnValue(true), update: jest.fn().mockResolvedValue() },
            globalStoragePath: '/tmp/globalStorage',
            extensionUri: { fsPath: '/Users/tom/.vscode/extensions/stata-workbench-debug' },
            extensionMode: h.vscode.ExtensionMode.Production
        };

        await h.extension.activate(context);

        const outputChannel = h.vscode.window.createOutputChannel.mock.results[0]?.value;
        expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('ready (extension v'));
        expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('(local)'));
    });

    itWithHarness('does not display (local) in Production mode', async (h) => {
        const context = {
            subscriptions: [],
            globalState: { get: jest.fn().mockReturnValue(true), update: jest.fn().mockResolvedValue() },
            globalStoragePath: '/tmp/globalStorage',
            extensionUri: { fsPath: '/path/to/extension' },
            extensionMode: h.vscode.ExtensionMode.Production
        };

        await h.extension.activate(context);

        const outputChannel = h.vscode.window.createOutputChannel.mock.results[0]?.value;
        expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('ready (extension v'));
        expect(outputChannel.appendLine).not.toHaveBeenCalledWith(expect.stringContaining('(local)'));
    });
});
