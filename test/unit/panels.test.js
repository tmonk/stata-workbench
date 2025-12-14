const assert = require('chai').assert;
const proxyquire = require('proxyquire');
const vscodeMock = require('../mocks/vscode');

describe('Panels', () => {
    let interactivePanelModule;

    before(() => {
        // Load modules with mocked vscode
        // Use .noCallThru() to ensure we don't try to load real vscode
        interactivePanelModule = proxyquire.noCallThru().load('../../src/interactive-panel', {
            'vscode': vscodeMock,
            'fs': {},
            'path': require('path'),
            './artifact-utils': { openArtifact: () => { } }
        });
    });

    describe('InteractivePanel helpers', () => {
        it('toEntry should structure data correctly', () => {
            const { toEntry } = interactivePanelModule;
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

        it('normalizeArtifacts should filter nulls and handle formatting', () => {
            const { normalizeArtifacts } = interactivePanelModule;
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

        describe('InteractivePanel.addEntry', () => {
            it('should append to existing panel', () => {
                const { InteractivePanel } = interactivePanelModule;
                let postedMessage = null;
                let revealedColumn = null;

                // Mock current panel
                InteractivePanel.currentPanel = {
                    webview: {
                        postMessage: (msg) => { postedMessage = msg; }
                    },
                    reveal: (col) => { revealedColumn = col; }
                };

                InteractivePanel.addEntry('code', { stdout: 'result' }, '/path/to/file');

                assert.deepEqual(postedMessage.type, 'append');
                assert.equal(postedMessage.entry.code, 'code');
                assert.equal(postedMessage.entry.stdout, 'result');
                assert.isNotNull(revealedColumn);

                // Cleanup
                InteractivePanel.currentPanel = null;
            });

            it('should open new panel if none exists', () => {
                const { InteractivePanel } = interactivePanelModule;
                let showCalled = false;
                let capturedOptions = null;

                // Stub static show method manually for this test
                const originalShow = InteractivePanel.show;
                InteractivePanel.show = (opts) => {
                    showCalled = true;
                    capturedOptions = opts;
                };

                // Ensure no current panel
                InteractivePanel.currentPanel = null;

                const runCmd = async () => { };
                const varProvider = () => [];
                InteractivePanel.addEntry('code', { stdout: 'res' }, '/path', runCmd, varProvider);

                assert.isTrue(showCalled);
                assert.equal(capturedOptions.initialCode, 'code');
                assert.equal(capturedOptions.filePath, '/path');
                assert.equal(capturedOptions.runCommand, runCmd);
                assert.equal(capturedOptions.variableProvider, varProvider);

                // Restore
                InteractivePanel.show = originalShow;
            });
        });
    });
});
