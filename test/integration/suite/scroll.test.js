const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { TerminalPanel } = require('../../../src/terminal-panel');

describe('Log Scrolling Integration', () => {
    const logPath = path.join(__dirname, 'scroll_test.log');
    // Create a log file larger than the default chunk size (assumed 100KB for the test, 
    // but in the backend it respects the requested maxBytes).
    // We will use 50 bytes chunks for testing to be granular.
    const runId = 'test-scroll-run';
    let cleanup = [];

    beforeAll(() => {
        // Generate a recognizable log file
        // Lines "Line 000" to "Line 999"
        let content = '';
        for (let i = 0; i < 1000; i++) {
            content += `Line ${String(i).padStart(3, '0')}\n`; // 9 bytes per line
        }
        // Total ~9000 bytes
        fs.writeFileSync(logPath, content);
    });

    afterAll(() => {
        if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
        cleanup.forEach(f => f());
    });

    test('Backend serves correct chunks for scrolling', async () => {
        // We will directly invoke _handleFetchLog on a TerminalPanel instance
        // But _handleFetchLog is an instance method. We need an instance.
        // We can't easily start the real panel, but we can prototype-call it if it doesn't use `this` heavily
        // OR we can rely on the fact that TerminalPanel is a class.

        // Actually, _handleFetchLog is likely an instance method that calls this._postMessage
        // We need to spy on `TerminalPanel._postMessage` (static) because that's how it replies.

        const originalPostMessage = TerminalPanel._postMessage;
        const messages = [];
        TerminalPanel._postMessage = (msg) => {
            messages.push(msg);
        };
        cleanup.push(() => TerminalPanel._postMessage = originalPostMessage);

        // Setup log provider
        TerminalPanel.setLogProvider(async (p, off, max) => {
            // Basic file read simulation
            if (!fs.existsSync(p)) return null;
            const buf = fs.readFileSync(p);
            const end = Math.min(buf.length, off + max);
            const chunk = buf.slice(off, end);
            return {
                data: chunk.toString('utf8'),
                next_offset: end
            };
        });
        // Cleanup log provider? It's static, so good practice to clear it or restore original if we knew it.
        // For now, just setting it is fine as we only run this test suite in isolation mostly, 
        // but to be safe:
        cleanup.push(() => TerminalPanel.setLogProvider(null));

        // _handleFetchLog is static.
        // It accepts (runId, path, offset, maxBytes)

        /* 
           src/terminal-panel.js:
           async _handleFetchLog(message) {
               ...
               const data = ...
               TerminalPanel._postMessage({ type: 'logChunk', ... });
           }
        */

        // Test 1: Fetch the tail (simulate initial load)
        // Total size ~9000 bytes. Request last 100 bytes.
        const stats = fs.statSync(logPath);
        const totalSize = stats.size;
        const tailSize = 100;
        const tailOffset = totalSize - tailSize;

        await TerminalPanel._handleFetchLog(runId, logPath, tailOffset, tailSize);

        const tailMsg = messages.find(m => m.offset === tailOffset);
        assert.ok(tailMsg, 'Should send logChunk for tail');
        assert.strictEqual(tailMsg.type, 'logChunk');
        // Check content: Should contain "Line 999"
        assert.ok(tailMsg.data.includes('Line 999'), 'Tail should contain last lines');

        // Test 2: Fetch "scrolling up" (previous chunk)
        messages.length = 0; // Clear
        const prevOffset = tailOffset - 100; // Previous 100 bytes
        await TerminalPanel._handleFetchLog(runId, logPath, prevOffset, 100);

        const scrollMsg = messages.find(m => m.offset === prevOffset);
        assert.ok(scrollMsg, 'Should send logChunk for scrolled section');
        // Check content: Should be earlier in the file
        // "Line 999" is at byte ~8991. 
        // We are at 8900-9000.
        // Previous is 8800-8900. Should contain something like "Line 98"
        assert.ok(scrollMsg.data.includes('Line'), 'Should contain lines');
        assert.ok(!scrollMsg.data.includes('Line 999'), 'Should NOT contain the very last line (it is previous chunk)');

        // Ensure data is what we expect
        const buffer = fs.readFileSync(logPath);
        const expectedChunk = buffer.slice(prevOffset, prevOffset + 100).toString('utf8');
        assert.strictEqual(scrollMsg.data, expectedChunk, 'Chunk content should match file content exactly');
    });
});
