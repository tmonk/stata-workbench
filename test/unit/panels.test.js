const assert = require('chai').assert;
const proxyquire = require('proxyquire');
const vscodeMock = require('../mocks/vscode');

describe('Panels', () => {
    let runPanelModule, interactivePanelModule;

    before(() => {
        // Load modules with mocked vscode
        // Use .noCallThru() to ensure we don't try to load real vscode
        runPanelModule = proxyquire.noCallThru().load('../../src/run-panel', {
            'vscode': vscodeMock,
            'fs': {},
            'path': require('path')
        });
        interactivePanelModule = proxyquire.noCallThru().load('../../src/interactive-panel', {
            'vscode': vscodeMock,
            'fs': {},
            'path': require('path')
        });
    });

    describe('RunPanel.renderHtml', () => {
        it('should generate valid HTML with artifacts', () => {
            const { renderHtml } = runPanelModule;
            const webviewMock = {
                asWebviewUri: (u) => u.toString(),
                cspSource: 'mock-csp'
            };
            const extUri = { toString: () => 'ext' };
            const result = {
                command: 'assert_me_command',
                stdout: 'test output',
                cwd: '/tmp',
                artifacts: [
                    { label: 'graph1', path: '/tmp/graph1.pdf', previewDataUri: 'data:image/png;base64,123' },
                    { label: 'graph2', path: '/tmp/graph2.pdf' } // No preview
                ]
            };

            const html = renderHtml(result, 'Test Title', webviewMock, extUri, {}, 'nonce123');

            // Assertions
            // Title is not in HTML body, but command is
            assert.include(html, 'assert_me_command');
            assert.include(html, 'Run Result');
            assert.include(html, 'graph1');
            assert.include(html, 'data:image/png;base64,123'); // Preview image
            assert.include(html, 'graph2');
            assert.include(html, 'nonce-nonce123'); // CSP Nonce
            assert.include(html, 'test output'); // stdout content

            // Check for checkmark/placeholder difference logic
            // graph1 should have img tag
            assert.match(html, /<img src="data:image\/png;base64,123"/);
            // graph2 should have placeholder div
            assert.include(html, '📄');
        });

        it('should handle no artifacts gracefully', () => {
            const { renderHtml } = runPanelModule;
            const webviewMock = {
                asWebviewUri: (u) => u.toString(),
                cspSource: 'mock-csp'
            };
            const html = renderHtml({}, 'Title', webviewMock, {}, {}, 'nonce');
            assert.include(html, 'No artifacts generated');
        });
    });

    describe('InteractivePanel helpers', () => {
        it('toEntry should structure data correctly', () => {
            const { toEntry } = interactivePanelModule;
            const result = {
                stdout: 'out',
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
    });
});
