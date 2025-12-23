const vscode = require('vscode');

jest.mock('fs');
// path is fine as is

jest.mock('../../src/artifact-utils', () => ({
    openArtifact: () => { }
}));

describe('Panels', () => {
    let terminalPanelModule;

    beforeAll(() => {
        terminalPanelModule = require('../../src/terminal-panel');
    });

    describe('TerminalPanel helpers', () => {
        it('toEntry should structure data correctly', () => {
            const { toEntry } = terminalPanelModule;
            const result = {
                stdout: 'out',
                command: 'test cmd',
                rc: 0,
                success: true,
                artifacts: [{ path: '/tmp/g.pdf' }]
            };

            const entry = toEntry('sysuse auto', result);

            expect(entry.code).toEqual('sysuse auto');
            expect(entry.stdout).toEqual('out');
            expect(entry.success).toBe(true);
            expect(entry.artifacts.length).toBe(1);
            expect(entry.artifacts[0].path).toEqual('/tmp/g.pdf');
        });

        it('toEntry should not fall back to contentText on failure', () => {
            const { toEntry } = terminalPanelModule;
            const result = {
                contentText: '{"command":"reg y x"}',
                stderr: '. reg y x\nvariable y not found\nr(111);',
                rc: 111,
                success: false
            };

            const entry = toEntry('reg y x', result);

            expect(entry.code).toEqual('reg y x');
            expect(entry.stdout).toEqual('');
            expect(entry.stderr).toEqual('. reg y x\nvariable y not found\nr(111);');
            expect(entry.success).toBe(false);
        });

        it('normalizeArtifacts should filter nulls and handle formatting', () => {
            const { normalizeArtifacts } = terminalPanelModule;
            const input = {
                artifacts: [
                    null,
                    { path: '/a.pdf', previewDataUri: 'data:...' }
                ]
            };

            const normalized = normalizeArtifacts(input);
            expect(normalized.length).toBe(1);
            expect(normalized[0].path).toEqual('/a.pdf');
            expect(normalized[0].previewDataUri).toEqual('data:...');
        });

        describe('TerminalPanel.addEntry', () => {
            it('should append to existing panel', () => {
                const { TerminalPanel } = terminalPanelModule;
                let postedMessage = null;
                let revealedColumn = null;

                TerminalPanel.currentPanel = {
                    webview: {
                        postMessage: (msg) => { postedMessage = msg; }
                    },
                    reveal: (col) => { revealedColumn = col; }
                };

                TerminalPanel.addEntry('code', { stdout: 'result' }, '/path/to/file');

                expect(postedMessage.type).toEqual('append');
                expect(postedMessage.entry.code).toEqual('code');
                expect(postedMessage.entry.stdout).toEqual('result');
                expect(revealedColumn).not.toBeNull();

                TerminalPanel.currentPanel = null;
            });

            it('should open new panel if none exists', () => {
                const { TerminalPanel } = terminalPanelModule;
                let showCalled = false;
                let capturedOptions = null;

                const originalShow = TerminalPanel.show;
                TerminalPanel.show = (opts) => {
                    showCalled = true;
                    capturedOptions = opts;
                };

                TerminalPanel.currentPanel = null;

                const runCmd = async () => { };
                const varProvider = () => [];
                TerminalPanel.addEntry('code', { stdout: 'res' }, '/path', runCmd, varProvider);

                expect(showCalled).toBe(true);
                expect(capturedOptions.initialCode).toEqual('code');
                expect(capturedOptions.filePath).toEqual('/path');
                expect(capturedOptions.runCommand).toEqual(runCmd);
                expect(capturedOptions.variableProvider).toEqual(varProvider);

                TerminalPanel.show = originalShow;
            });
        });

        describe('new controls + download wiring', () => {
            it('stores download/cancel handlers on show', () => {
                const { TerminalPanel } = terminalPanelModule;
                TerminalPanel.currentPanel = null;
                const downloadStub = () => { };
                const cancelStub = () => { };
                const clearStub = () => { };

                TerminalPanel.show({
                    filePath: '/tmp/foo',
                    initialCode: null,
                    initialResult: null,
                    runCommand: async () => ({}),
                    variableProvider: () => [],
                    downloadGraphPdf: downloadStub,
                    cancelRun: cancelStub,
                    clearAll: clearStub
                });

                expect(TerminalPanel._downloadGraphPdf).toBe(downloadStub);
                expect(TerminalPanel._cancelHandler).toBe(cancelStub);
                expect(TerminalPanel._clearHandler).toBe(clearStub);

                TerminalPanel.currentPanel = null;
            });

            it('_handleDownloadGraphPdf delegates when set', async () => {
                const { TerminalPanel } = terminalPanelModule;
                const stub = jest.fn().mockResolvedValue();
                TerminalPanel._downloadGraphPdf = stub;

                await TerminalPanel._handleDownloadGraphPdf('g1');

                expect(stub).toHaveBeenCalledWith('g1');
            });

            it('_handleClearAll delegates when set', async () => {
                const { TerminalPanel } = terminalPanelModule;
                const stub = jest.fn().mockResolvedValue();
                TerminalPanel._clearHandler = stub;

                await TerminalPanel._handleClearAll();

                expect(stub).toHaveBeenCalledTimes(1);
            });

            it(
                'startStreamingEntry wires cancel handler and passes through show',
                () => {
                    const { TerminalPanel } = terminalPanelModule;
                    const cancelStub = () => { };
                    const runStub = () => { };
                    const varStub = () => [];
                    let capturedOptions = null;

                    const originalShow = TerminalPanel.show;
                    TerminalPanel.show = (opts) => {
                        capturedOptions = opts;
                    };

                    TerminalPanel.currentPanel = null;
                    TerminalPanel.startStreamingEntry('code', '/tmp/x', runStub, varStub, cancelStub);

                    expect(TerminalPanel._cancelHandler).toBe(cancelStub);
                    expect(capturedOptions.cancelRun).toBe(cancelStub);

                    TerminalPanel.show = originalShow;
                    TerminalPanel.currentPanel = null;
                }
            );
        });
    });
});
