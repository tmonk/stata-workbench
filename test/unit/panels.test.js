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

        itWithContext('toEntry should hide stdout and keep fullStdout on failure', () => {
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
            expect(entry.stderr).toContain('not found');
        });

        itWithContext('toEntry should detect hasError from {err} even if success=true (legacy/edge cases)', () => {
            const { toEntry } = loadTerminalPanel();
            const result = {
                stdout: '{err}warning: something is off',
                rc: 0,
                success: true
            };

            const entry = toEntry('cmd', result);
            expect(entry.hasError).toBe(true);
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

        describe('parseSMCL', () => {
            itWithContext('should detect RC from standard search tag', () => {
                const { parseSMCL } = loadTerminalPanel();
                expect(parseSMCL('{search r(111), local:r(111);}').rc).toBe(111);
            });

            itWithContext('should detect RC from standalone line', () => {
                const { parseSMCL } = loadTerminalPanel();
                expect(parseSMCL('r(199);').rc).toBe(199);
            });

            itWithContext('should ignore false positive RCs in table data', () => {
                const { parseSMCL } = loadTerminalPanel();
                const input = 'Adj R-squared = 0.0515\nWithin R-sq. = 0.0195\n1.98 0.051';
                expect(parseSMCL(input).rc).toBeNull();
            });

            itWithContext('should capture error only from {err} tag', () => {
                const { parseSMCL } = loadTerminalPanel();
                const output = parseSMCL('{err}variable x not found');
                expect(output.formattedText).toContain('Error: variable x not found');
            });

            itWithContext('should ignore errors in plain text', () => {
                const { parseSMCL } = loadTerminalPanel();
                expect(parseSMCL('if rc error 198').formattedText).toBe('');
            });

            itWithContext('should capture command with multiple prefixes', () => {
                const { parseSMCL } = loadTerminalPanel();
                const input = '{com}. cap noi Estimate x\n{err}err';
                expect(parseSMCL(input).formattedText).toContain('Command:\n  Estimate x');
            });

            itWithContext('should ignore loop keywords', () => {
                const { parseSMCL } = loadTerminalPanel();
                const input = '{com}. while 1 {\n{com}. foreach x of varlist * {\n{err}err';
                const out = parseSMCL(input).formattedText;
                expect(out).not.toContain('Command:\n  while');
                expect(out).not.toContain('Command:\n  foreach');
            });

            itWithContext('should track and freeze stack on error', () => {
                const { parseSMCL } = loadTerminalPanel();
                const input = 'begin main\nbegin sub\n{err}err\nend sub';
                expect(parseSMCL(input).formattedText).toContain('In: main → sub');
            });

            itWithContext('should strictly pop only matching tags', () => {
                const { parseSMCL } = loadTerminalPanel();
                const input = 'begin main\nbegin sub\nend main\n{err}err';
                expect(parseSMCL(input).formattedText).toContain('In: main → sub');
            });

            itWithContext('should handle reghdfe output correctly', () => {
                const { parseSMCL } = loadTerminalPanel();
                const input = `
      {hline 50} begin main {hline}
    = cap noi Estimate x
      {hline 46} begin Estimate {hline}
{err}variable x not found
{search r(111), local:r(111);}
`;
                const parsed = parseSMCL(input);
                expect(parsed.rc).toBe(111);
                expect(parsed.formattedText).toContain('In: main → Estimate');
                expect(parsed.formattedText).toContain('Command:\n  Estimate x');
                expect(parsed.formattedText).toContain('Error: variable x not found');
            });
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
