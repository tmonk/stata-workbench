const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { TerminalPanel } = require('../../../src/terminal-panel');

describe('Log Buffering Integration', () => {

    test('Backend calculates and sends logSize correctly', async () => {
        // Setup: Create a temp log file
        const logPath = path.join(__dirname, 'test.log');
        const logContent = 'Line 1\nLine 2\nLine 3\n';
        fs.writeFileSync(logPath, logContent);
        const expectedSize = Buffer.byteLength(logContent, 'utf8');

        // Spy on TerminalPanel._postMessage
        // Since _postMessage is static, we can replace it for the test
        const originalPostMessage = TerminalPanel._postMessage;
        let capturedMessage = null;
        TerminalPanel._postMessage = (msg) => {
            if (msg.type === 'runFinished') {
                capturedMessage = msg;
            }
        };

        // Mock TerminalPanel.currentPanel to ensure guards pass
        TerminalPanel.currentPanel = {
            webview: { postMessage: () => { } }
        };

        try {
            // Trigger finishStreamingEntry
            const result = {
                rc: 0,
                logPath: logPath,
                stdout: 'done',
                stderr: '',
                contentType: 'text'
            };

            TerminalPanel.finishStreamingEntry('test-run-1', result);

            // Verify
            assert.ok(capturedMessage, 'Should have sent runFinished message');
            assert.strictEqual(capturedMessage.logPath, logPath, 'Log path should match');
            assert.strictEqual(capturedMessage.logSize, expectedSize, `Log size should be ${expectedSize}, got ${capturedMessage.logSize}`);

        } finally {
            // Cleanup
            TerminalPanel._postMessage = originalPostMessage;
            if (fs.existsSync(logPath)) {
                fs.unlinkSync(logPath);
            }
            TerminalPanel.currentPanel = undefined;
        }
    });

    test('Backend handles missing log file gracefully', async () => {
        const logPath = path.join(__dirname, 'nonexistent.log');

        const originalPostMessage = TerminalPanel._postMessage;
        let capturedMessage = null;
        TerminalPanel._postMessage = (msg) => {
            if (msg.type === 'runFinished') {
                capturedMessage = msg;
            }
        };
        TerminalPanel.currentPanel = { webview: { postMessage: () => { } } };

        try {
            const result = {
                rc: 0,
                logPath: logPath // Points to non-existent file
            };

            TerminalPanel.finishStreamingEntry('test-run-2', result);

            assert.ok(capturedMessage);
            assert.strictEqual(capturedMessage.logSize, 0, 'Log size should be 0 for missing file');

        } finally {
            TerminalPanel._postMessage = originalPostMessage;
            TerminalPanel.currentPanel = undefined;
        }
    });
});
