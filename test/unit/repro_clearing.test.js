const { describe, it } = require('bun:test');
const assert = require('assert');

describe('Terminal Clearing Reproduction', () => {

    // Updated limits as per user request (suspected cause of confusion or actual issue)
    const MAX_LIMIT = 20000;

    function safeSliceTail(html, limit) {
        if (!html || html.length <= limit) return html || '';
        let start = html.length - limit;

        const firstNewline = html.indexOf(String.fromCharCode(10), start);
        const firstTagStart = html.indexOf('<', start);

        let cutPoint = -1;
        let offset = 1;

        if (firstNewline !== -1 && firstTagStart !== -1) {
            if (firstNewline < firstTagStart) {
                cutPoint = firstNewline;
                offset = 1;
            } else {
                cutPoint = firstTagStart;
                offset = 0;
            }
        } else if (firstNewline !== -1) {
            cutPoint = firstNewline;
            offset = 1;
        } else if (firstTagStart !== -1) {
            cutPoint = firstTagStart;
            offset = 0;
        }

        if (cutPoint !== -1 && cutPoint < html.length - 1) {
            return html.substring(cutPoint + offset);
        }
        return html.slice(-limit);
    }

    it('should not clear output when processing large content sequence', () => {
        // Mock DOM element
        let innerHTML = '';
        const stdoutEl = {
            get innerHTML() { return innerHTML; },
            set innerHTML(v) { innerHTML = v; },
            insertAdjacentHTML: (pos, chunk) => {
                innerHTML += chunk;
            }
        };

        // Simulate Streaming
        // Append 50 chunks of 1000 chars. Total 50,000. Limit 20,000.
        for (let i = 0; i < 50; i++) {
            const chunk = `Chunk ${i} ` + "x".repeat(990) + "\n";
            stdoutEl.insertAdjacentHTML('beforeend', chunk);

            if (stdoutEl.innerHTML.length > MAX_LIMIT) {
                stdoutEl.innerHTML = safeSliceTail(stdoutEl.innerHTML, MAX_LIMIT);
            }
        }

        const streamedResult = stdoutEl.innerHTML;
        // Expect length close to 20000
        assert.ok(streamedResult.length <= MAX_LIMIT + 1000, `Streamed length ${streamedResult.length} too big`); // +1000 safety logic depending on slice
        assert.ok(streamedResult.length > 0, 'Streamed output should not be empty');

        // Simulate runFinished
        // Suppose finalStdout is the FULL content (50k chars)
        let finalStdout = '';
        for (let i = 0; i < 50; i++) {
            finalStdout += `Chunk ${i} ` + "x".repeat(990) + "\n";
        }

        const normalizedFinal = safeSliceTail(finalStdout, MAX_LIMIT);

        // Logic from terminal-panel.js runFinished
        const current = stdoutEl.innerHTML || '';
        const MAX_BACKFILL_DELTA = 5000;

        const needsInitial = !current && normalizedFinal;
        const needsSmallDelta = normalizedFinal.length > current.length &&
            (normalizedFinal.length - current.length) <= MAX_BACKFILL_DELTA;

        if (needsInitial || needsSmallDelta) {
            stdoutEl.innerHTML = normalizedFinal;
        } else if (!current && normalizedFinal) {
            stdoutEl.innerHTML = normalizedFinal;
        }

        // "Clears on completion" check
        assert.ok(stdoutEl.innerHTML.length > 0, 'Output cleared on completion!');

        // Verify content matches expected tail
        assert.strictEqual(stdoutEl.innerHTML, normalizedFinal, 'Content should match normalized final');
    });

    it('should handle exactly standard inputs without clearing', () => {
        // Test specifically with no newlines to stress delimiter logic
        const content = "<span>content</span>".repeat(2000); // 2000 * 21 = ~42000 chars
        const truncated = safeSliceTail(content, 20000);
        assert.ok(truncated.length > 0);
        assert.ok(truncated.length <= 20000);
    });
});
