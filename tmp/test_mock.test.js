const { describe, it, expect } = require('bun:test');
const { jest } = require('bun:test');
const { createExtensionHarness } = require('../test/helpers/extension-harness');
const { withTestContext } = require('../test/helpers/test-context');

describe('debug harness', () => {
    it('harness terminalPanel has setHandlersFactory', () => {
        const h = createExtensionHarness();
        console.log('keys:', Object.keys(h.terminalPanel).join(', '));
        expect(typeof h.terminalPanel.setHandlersFactory).toBe('function');
    });

    it('check what is in extension.js', async () => {
        const h = createExtensionHarness();
        // Monkey-patch to intercept calls by value, not by mock tracking
        let interceptedCalls = { setExtensionUri: 0, setHandlersFactory: 0, setLogProvider: 0 };
        const origSEU = h.terminalPanel.setExtensionUri;
        const origSHF = h.terminalPanel.setHandlersFactory;
        const origSLP = h.terminalPanel.setLogProvider;
        h.terminalPanel.setExtensionUri = (...a) => { interceptedCalls.setExtensionUri++; return origSEU(...a); };
        h.terminalPanel.setHandlersFactory = (...a) => { interceptedCalls.setHandlersFactory++; return origSHF(...a); };
        h.terminalPanel.setLogProvider = (...a) => { interceptedCalls.setLogProvider++; return origSLP(...a); };

        h.vscode.window.registerWebviewPanelSerializer = jest.fn();
        let err = null;
        await withTestContext(
            { vscode: h.vscode, fs: h.fs, childProcess: h.cp, mcpClient: h.mcpClientMock },
            async () => {
                try {
                    await h.extension.activate({
                        subscriptions: [],
                        globalState: { get: jest.fn().mockReturnValue(true), update: jest.fn().mockResolvedValue() },
                        globalStoragePath: '/tmp',
                        extensionUri: { fsPath: '/ext' },
                        extensionPath: '/workspace',
                        extensionMode: 2
                    });
                } catch(e) { err = e.message; }
            }
        );

        if (err) console.log('ERROR:', err.slice(0, 500));
        console.log('monkey-patch interceptedCalls:', JSON.stringify(interceptedCalls));
        console.log('setExtensionUri .mock.calls.length:', origSEU.mock?.calls?.length);
        console.log('setHandlersFactory .mock.calls.length:', origSHF.mock?.calls?.length);
        
        // So: if interceptedCalls > 0, extension.js IS using the mock object (proxyquire works)
        // but the mock functions aren't tracking via .mock because of how reassignment happened
        // If interceptedCalls === 0, extension.js uses a DIFFERENT object entirely
        
        expect(interceptedCalls.setHandlersFactory).toBeGreaterThanOrEqual(1);
    });
});

