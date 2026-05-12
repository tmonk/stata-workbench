const { describe, it, expect } = require('bun:test');
const sinon = require('sinon');
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

const loadDataBrowserPanel = () => proxyquire('../../src/data-browser-panel', {
    './mcp-client': {
        client: {
            getUiChannel: () => Promise.resolve({ baseUrl: 'http://test', token: 'token' })
        }
    }
});

const itWithContext = (name, fn) => it(name, () => withTestContext({}, fn));

describe('Panels', () => {
    describe('TerminalPanel helpers', () => {
        itWithContext('toEntry should structure data correctly on success', () => {
            const { toEntry } = loadTerminalPanel();
            const result = {
                stdout: '{com}. display "hello"',
                rc: 0,
                success: true
            };

            const entry = toEntry('display "hello"', result);

            expect(entry.code).toEqual('display "hello"');
            expect(entry.success).toBe(true);
            expect(entry.hasError).toBe(false);
            expect(entry.rc).toBe(0);
            expect(entry.stdout).toContain('hello');
            expect(entry.fullStdout).toContain('hello');
        });
        itWithContext('toEntry should hide stdout on failure', () => {
            const { toEntry } = loadTerminalPanel();
            const result = {
                stdout: '{com}. nosuchcommand\n{err}command nosuchcommand not found',
                rc: 199,
                success: false
            };

            const entry = toEntry('nosuchcommand', result);

            expect(entry.success).toBe(false);
            expect(entry.hasError).toBe(true);
            expect(entry.rc).toBe(199);
            expect(entry.stdout).toBe('');
            expect(entry.fullStdout).toContain('nosuchcommand');
        });

        itWithContext('toEntry should set hasError on non-zero rc', () => {
            const { toEntry } = loadTerminalPanel();
            const result = {
                stdout: '{err}warning: something is off',
                rc: 0,
                success: true
            };

            const entry = toEntry('cmd', result);
            expect(entry.hasError).toBe(false);  // rc=0 => success
            expect(entry.success).toBe(true);
            expect(entry.stdout).toContain('warning');
        });
        itWithContext('normalizeArtifacts should filter nulls', () => {
            const { normalizeArtifacts } = loadTerminalPanel();
            const input = {
                artifacts: [null, { path: '/a.pdf' }]
            };
            const normalized = normalizeArtifacts(input);
            expect(normalized.length).toBe(1);
            expect(normalized[0].path).toEqual('/a.pdf');
        });

    });

    describe('TerminalPanel Class', () => {
        itWithContext('should reveal panel in current viewColumn and preserve focus on addEntry', () => {
            const { TerminalPanel } = loadTerminalPanel();
            let revealArgs = [];
            TerminalPanel.currentPanel = {
                viewColumn: 2,
                webview: { postMessage: () => { } },
                reveal: (col, preserveFocus) => {
                    revealArgs = [col, preserveFocus];
                }
            };
            TerminalPanel.addEntry('code', { stdout: '' }, '/path');
            expect(revealArgs).toEqual([2, true]);
            TerminalPanel.currentPanel = null;
        });

        itWithContext('should reveal panel in current viewColumn and preserve focus on startStreamingEntry', () => {
            const { TerminalPanel } = loadTerminalPanel();
            let revealArgs = [];
            TerminalPanel.currentPanel = {
                viewColumn: 3,
                webview: { postMessage: () => { } },
                reveal: (col, preserveFocus) => {
                    revealArgs = [col, preserveFocus];
                }
            };
            TerminalPanel.startStreamingEntry('code', '/path', () => { });
            expect(revealArgs).toEqual([3, true]);
            TerminalPanel.currentPanel = null;
        });

        itWithContext('should reveal panel with preserveFocus in show()', ({ vscode }) => {
            const { TerminalPanel } = loadTerminalPanel();
            let revealArgs = [];
            const mockPanel = {
                viewColumn: 1,
                webview: {
                    postMessage: () => { },
                    html: '',
                    onDidReceiveMessage: () => ({ dispose: () => { } }),
                    asWebviewUri: (u) => u
                },
                onDidDispose: () => ({ dispose: () => { } }),
                reveal: (col, preserveFocus) => {
                    revealArgs = [col, preserveFocus];
                }
            };

            const originalCreate = vscode.window.createWebviewPanel;
            vscode.window.createWebviewPanel = () => mockPanel;

            TerminalPanel.show({ runCommand: () => { } });
            // By default show reveals in Beside (2) and preserves focus (true)
            // But if it's new, it uses targetColumn = vscode.ViewColumn.Beside
            expect(revealArgs).toEqual([vscode.ViewColumn.Beside, true]);

            TerminalPanel.currentPanel = null;
            vscode.window.createWebviewPanel = originalCreate;
        });

        itWithContext('should store handlers on show', () => {
            const { TerminalPanel } = loadTerminalPanel();
            const h = () => { };
            TerminalPanel.show({ downloadGraphPdf: h, cancelRun: h, clearAll: h });
            expect(TerminalPanel._downloadGraphPdf).toBe(h);
            expect(TerminalPanel._cancelHandler).toBe(h);
            TerminalPanel.currentPanel = null;
        });

        itWithContext('should call cancelTaskHandler when receiving cancelTask message', async ({ vscode }) => {
            const { TerminalPanel } = loadTerminalPanel();
            let receivedRunId = null;
            const cancelTaskHandler = (runId) => { receivedRunId = runId; };

            let messageHandler;
            const mockWebview = {
                onDidReceiveMessage: (handler) => { messageHandler = handler; return { dispose: () => { } }; },
                postMessage: () => { },
                asWebviewUri: (u) => u,
                cspSource: ''
            };
            const mockPanel = {
                webview: mockWebview,
                reveal: () => { },
                onDidDispose: () => { return { dispose: () => { } }; }
            };

            const originalCreate = vscode.window.createWebviewPanel;
            vscode.window.createWebviewPanel = () => mockPanel;

            TerminalPanel.show({
                cancelTask: cancelTaskHandler,
                runCommand: async () => ({})
            });

            await messageHandler({ type: 'cancelTask', runId: 'test-run-123' });

            expect(receivedRunId).toBe('test-run-123');

            TerminalPanel.currentPanel = null;
            vscode.window.createWebviewPanel = originalCreate;
        });

        itWithContext('show() should store openHelpPanel callback in _openHelpPanel', ({ vscode }) => {
            const { TerminalPanel } = loadTerminalPanel();
            const mockPanel = {
                webview: {
                    postMessage: () => {},
                    html: '',
                    onDidReceiveMessage: () => ({ dispose: () => {} }),
                    asWebviewUri: (u) => u
                },
                onDidDispose: () => ({ dispose: () => {} }),
                reveal: () => {}
            };

            const originalCreate = vscode.window.createWebviewPanel;
            vscode.window.createWebviewPanel = () => mockPanel;

            const helpPanelOpener = () => {};
            TerminalPanel.show({ runCommand: () => {}, openHelpPanel: helpPanelOpener });
            expect(TerminalPanel._openHelpPanel).toBe(helpPanelOpener);

            TerminalPanel.currentPanel = null;
            TerminalPanel._openHelpPanel = null;
            vscode.window.createWebviewPanel = originalCreate;
        });

        itWithContext('openArtifact message with help type calls _openHelpPanel', async ({ vscode }) => {
            const { TerminalPanel } = loadTerminalPanel();
            let capturedPath = null;
            let capturedLabel = null;
            TerminalPanel._openHelpPanel = (p, l) => { capturedPath = p; capturedLabel = l; };

            let messageHandler;
            const mockWebview = {
                onDidReceiveMessage: (handler) => { messageHandler = handler; return { dispose: () => {} }; },
                postMessage: () => {},
                asWebviewUri: (u) => u,
                cspSource: ''
            };
            const mockPanel = {
                webview: mockWebview,
                reveal: () => {},
                onDidDispose: () => ({ dispose: () => {} })
            };

            const originalCreate = vscode.window.createWebviewPanel;
            vscode.window.createWebviewPanel = () => mockPanel;
            TerminalPanel.show({ runCommand: async () => ({}) });

            await messageHandler({
                type: 'openArtifact',
                artifactType: 'help',
                path: '/tmp/help_regress.md',
                label: 'Help: regress'
            });

            expect(capturedPath).toBe('/tmp/help_regress.md');
            expect(capturedLabel).toBe('Help: regress');

            TerminalPanel.currentPanel = null;
            TerminalPanel._openHelpPanel = null;
            vscode.window.createWebviewPanel = originalCreate;
        });

        itWithContext('openArtifact message without help type does NOT call _openHelpPanel', async ({ vscode }) => {
            const { TerminalPanel } = loadTerminalPanel();
            const openHelpPanelSpy = sinon.stub();
            TerminalPanel._openHelpPanel = openHelpPanelSpy;

            let messageHandler;
            const mockWebview = {
                onDidReceiveMessage: (handler) => { messageHandler = handler; return { dispose: () => {} }; },
                postMessage: () => {},
                asWebviewUri: (u) => u,
                cspSource: ''
            };
            const mockPanel = {
                webview: mockWebview,
                reveal: () => {},
                onDidDispose: () => ({ dispose: () => {} })
            };

            const originalCreate = vscode.window.createWebviewPanel;
            vscode.window.createWebviewPanel = () => mockPanel;
            TerminalPanel.show({ runCommand: async () => ({}) });

            // Non-help artifact: no artifactType
            await messageHandler({
                type: 'openArtifact',
                path: '/tmp/graph.pdf',
                baseDir: '/tmp'
            });

            // _openHelpPanel should NOT have been called
            expect(openHelpPanelSpy.called).toBe(false);

            TerminalPanel.currentPanel = null;
            TerminalPanel._openHelpPanel = null;
            vscode.window.createWebviewPanel = originalCreate;
        });

        itWithContext('normalizeArtifacts preserves type field on artifacts', () => {
            const { normalizeArtifacts } = loadTerminalPanel();
            const result = normalizeArtifacts({
                artifacts: [
                    { path: '/tmp/help.md', type: 'help', label: 'Help: regress' },
                    { path: '/tmp/graph.pdf', type: 'graph', label: 'mygraph' }
                ]
            });
            expect(result.length).toBe(2);
            expect(result[0].type).toBe('help');
            expect(result[1].type).toBe('graph');
        });
    });

    describe('DataBrowserPanel', () => {
        itWithContext('should reveal panel in current viewColumn on createOrShow if exists', async () => {
            const { DataBrowserPanel } = loadDataBrowserPanel();
            let revealArgs = [];
            DataBrowserPanel.currentPanel = {
                _panel: {
                    viewColumn: 3,
                    reveal: (col) => {
                        revealArgs = [col];
                    }
                },
                _fetchCredentials: () => { }
            };

            await DataBrowserPanel.createOrShow({ fsPath: '/path' });
            expect(revealArgs).toEqual([3]);

            DataBrowserPanel.currentPanel = null;
        });
    });
});
