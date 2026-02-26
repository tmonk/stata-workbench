const { describe, it, expect } = require('bun:test');
const proxyquire = require('proxyquire').noCallThru().noPreserveCache();
const { withTestContext } = require('../helpers/test-context');

const loadTerminalPanel = () => proxyquire('../../src/terminal-panel', {
    './artifact-utils': {
        openArtifact: () => { },
        revealArtifact: () => { },
        copyToClipboard: () => { },
        resolveArtifactUri: () => { }
    }
});

const itWithContext = (name, fn) => it(name, () => withTestContext({}, fn));

describe('TerminalPanel Serialization', () => {
    itWithContext('should restore panel using restorePanel and hook up listeners', () => {
        const { TerminalPanel } = loadTerminalPanel();
        let messageHandler = null;
        let disposedHandler = null;

        const mockWebviewPanel = {
            webview: {
                onDidReceiveMessage: (handler) => { messageHandler = handler; return { dispose: () => { } }; },
                html: '',
                asWebviewUri: (uri) => uri,
                cspSource: 'mock-csp-source'
            },
            onDidDispose: (handler) => { disposedHandler = handler; return { dispose: () => { } }; },
            __stataPanelId: null
        };

        // Call the static restorePanel method
        TerminalPanel.restorePanel(mockWebviewPanel, { chatHtml: '<div>restored terminal data</div>' });

        // Verify state is populated correctly
        expect(TerminalPanel.currentPanel).toBe(mockWebviewPanel);
        expect(TerminalPanel._webviewReady).toBe(false);
        expect(TerminalPanel._pendingWebviewMessages).toEqual([]);

        // Verify handlers are bound
        expect(typeof messageHandler).toBe('function');
        expect(typeof disposedHandler).toBe('function');

        // Verify the HTML gets re-rendered to trigger iframe load
        expect(mockWebviewPanel.webview.html).toContain('<!DOCTYPE html>');

        // Simulating the panel being disposed checks reset logic
        disposedHandler();
        expect(TerminalPanel.currentPanel).toBe(null);
        expect(TerminalPanel._webviewReady).toBe(true);
    });

    itWithContext('should buffer messages for active runs until the reparented webview is ready', async () => {
        const { TerminalPanel } = loadTerminalPanel();

        // 1. Initial panel setup
        let messageHandlerA = null;
        let disposedHandlerA = null;
        const panelA = {
            webview: {
                onDidReceiveMessage: (handler) => { messageHandlerA = handler; return { dispose: () => { } }; },
                html: '', asWebviewUri: (uri) => uri, cspSource: 'mock'
            },
            onDidDispose: (handler) => { disposedHandlerA = handler; return { dispose: () => { } }; },
            __stataPanelId: 1
        };
        TerminalPanel.restorePanel(panelA, { chatHtml: '' });
        TerminalPanel._webviewReady = true; // Simulating it finished loading

        // 2. User drags the panel to a new window - panel A is disposed
        disposedHandlerA();
        expect(TerminalPanel.currentPanel).toBeNull();

        // 3. VS Code restores the panel in the new window
        let messageHandlerB = null;
        const postedToB = [];
        const panelB = {
            webview: {
                onDidReceiveMessage: (handler) => { messageHandlerB = handler; return { dispose: () => { } }; },
                postMessage: (msg) => { postedToB.push(msg); },
                html: '', asWebviewUri: (uri) => uri, cspSource: 'mock'
            },
            onDidDispose: () => { return { dispose: () => { } }; },
            __stataPanelId: 2
        };
        TerminalPanel.restorePanel(panelB, { chatHtml: '...' });

        // Panel B is loading, not ready yet
        expect(TerminalPanel._webviewReady).toBe(false);

        // 4. Background Stata process streams new logs
        TerminalPanel._postMessage({ type: 'runLogAppend', text: 'Active Stream 1' });
        TerminalPanel._postMessage({ type: 'runLogAppend', text: 'Active Stream 2' });

        // Logs should not be sent immediately since panel is not ready, but should be buffered!
        expect(postedToB.length).toBe(0);
        expect(TerminalPanel._pendingWebviewMessages.length).toBe(2);
        expect(TerminalPanel._pendingWebviewMessages[0].text).toBe('Active Stream 1');

        // 5. The reparented iframe finishes rendering and sends the 'ready' signal
        await messageHandlerB({ type: 'ready' });

        // 6. Verification: the buffered stream logs are instantly flushed to the new UI
        expect(TerminalPanel._webviewReady).toBe(true);
        expect(TerminalPanel._pendingWebviewMessages.length).toBe(0);
        expect(postedToB.length).toBe(2);
        expect(postedToB[0].text).toBe('Active Stream 1');
        expect(postedToB[1].text).toBe('Active Stream 2');
    });
});
