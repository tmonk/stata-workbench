const assert = require('chai').assert;
const proxyquire = require('proxyquire');
const vscodeMock = require('../mocks/vscode');
const sinon = require('sinon');

describe('Panels', () => {
    let terminalPanelModule;

    before(() => {
        // Load modules with mocked vscode
        // Use .noCallThru() to ensure we don't try to load real vscode
        terminalPanelModule = proxyquire.noCallThru().load('../../src/terminal-panel', {
            'vscode': vscodeMock,
            'fs': {},
            'path': require('path'),
            './artifact-utils': { openArtifact: () => { } }
        });
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

            assert.equal(entry.code, 'sysuse auto');
            assert.equal(entry.stdout, 'out');
            assert.isTrue(entry.success);
            assert.lengthOf(entry.artifacts, 1);
            assert.equal(entry.artifacts[0].path, '/tmp/g.pdf');
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

            assert.equal(entry.code, 'reg y x');
            assert.equal(entry.stdout, '');
            assert.equal(entry.stderr, '. reg y x\nvariable y not found\nr(111);');
            assert.isFalse(entry.success);
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
            assert.lengthOf(normalized, 1);
            assert.equal(normalized[0].path, '/a.pdf');
            assert.equal(normalized[0].previewDataUri, 'data:...');
        });

        describe('TerminalPanel.addEntry', () => {
            it('should append to existing panel', () => {
                const { TerminalPanel } = terminalPanelModule;
                let postedMessage = null;
                let revealedColumn = null;

                // Mock current panel
                TerminalPanel.currentPanel = {
                    webview: {
                        postMessage: (msg) => { postedMessage = msg; }
                    },
                    reveal: (col) => { revealedColumn = col; }
                };

                TerminalPanel.addEntry('code', { stdout: 'result' }, '/path/to/file');

                assert.deepEqual(postedMessage.type, 'append');
                assert.equal(postedMessage.entry.code, 'code');
                assert.equal(postedMessage.entry.stdout, 'result');
                assert.isNotNull(revealedColumn);

                // Cleanup
                TerminalPanel.currentPanel = null;
            });

            it('should open new panel if none exists', () => {
                const { TerminalPanel } = terminalPanelModule;
                let showCalled = false;
                let capturedOptions = null;

                // Stub static show method manually for this test
                const originalShow = TerminalPanel.show;
                TerminalPanel.show = (opts) => {
                    showCalled = true;
                    capturedOptions = opts;
                };

                // Ensure no current panel
                TerminalPanel.currentPanel = null;

                const runCmd = async () => { };
                const varProvider = () => [];
                TerminalPanel.addEntry('code', { stdout: 'res' }, '/path', runCmd, varProvider);

                assert.isTrue(showCalled);
                assert.equal(capturedOptions.initialCode, 'code');
                assert.equal(capturedOptions.filePath, '/path');
                assert.equal(capturedOptions.runCommand, runCmd);
                assert.equal(capturedOptions.variableProvider, varProvider);

                // Restore
                TerminalPanel.show = originalShow;
            });
        });

        describe('new controls + download wiring', () => {
            it('stores download/cancel handlers on show', () => {
                const { TerminalPanel } = terminalPanelModule;
                TerminalPanel.currentPanel = null;
                const downloadStub = () => {};
                const cancelStub = () => {};
                const clearStub = () => {};

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

                assert.strictEqual(TerminalPanel._downloadGraphPdf, downloadStub);
                assert.strictEqual(TerminalPanel._cancelHandler, cancelStub);
                assert.strictEqual(TerminalPanel._clearHandler, clearStub);

                TerminalPanel.currentPanel = null;
            });

            it('_handleDownloadGraphPdf delegates when set', async () => {
                const { TerminalPanel } = terminalPanelModule;
                const stub = sinon.stub().resolves();
                TerminalPanel._downloadGraphPdf = stub;

                await TerminalPanel._handleDownloadGraphPdf('g1');

                assert.isTrue(stub.calledOnceWith('g1'));
            });

            it('_handleClearAll delegates when set', async () => {
                const { TerminalPanel } = terminalPanelModule;
                const stub = sinon.stub().resolves();
                TerminalPanel._clearHandler = stub;

                await TerminalPanel._handleClearAll();

                assert.isTrue(stub.calledOnce);
            });

            it('startStreamingEntry wires cancel handler and passes through show', () => {
                const { TerminalPanel } = terminalPanelModule;
                const cancelStub = () => {};
                const runStub = () => {};
                const varStub = () => [];
                let capturedOptions = null;

                const originalShow = TerminalPanel.show;
                TerminalPanel.show = (opts) => {
                    capturedOptions = opts;
                };

                TerminalPanel.currentPanel = null;
                TerminalPanel.startStreamingEntry('code', '/tmp/x', runStub, varStub, cancelStub);

                assert.strictEqual(TerminalPanel._cancelHandler, cancelStub);
                assert.strictEqual(capturedOptions.cancelRun, cancelStub);

                TerminalPanel.show = originalShow;
                TerminalPanel.currentPanel = null;
            });
        });
    });
});
