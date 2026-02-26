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
});
