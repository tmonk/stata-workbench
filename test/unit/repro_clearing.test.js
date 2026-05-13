const { describe, it } = require('bun:test');
const assert = require('assert');

describe('Terminal Clearing Reproduction', () => {

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
        let innerHTML = '';
        const stdoutEl = {
            get innerHTML() { return innerHTML; },
            set innerHTML(v) { innerHTML = v; },
            insertAdjacentHTML: (pos, chunk) => {
                innerHTML += chunk;
            }
        };

        for (let i = 0; i < 50; i++) {
            const chunk = `Chunk ${i} ` + "x".repeat(990) + "\n";
            stdoutEl.insertAdjacentHTML('beforeend', chunk);

            if (stdoutEl.innerHTML.length > MAX_LIMIT) {
                stdoutEl.innerHTML = safeSliceTail(stdoutEl.innerHTML, MAX_LIMIT);
            }
        }

        const streamedResult = stdoutEl.innerHTML;
        assert.ok(streamedResult.length <= MAX_LIMIT + 1000, `Streamed length ${streamedResult.length} too big`);
        assert.ok(streamedResult.length > 0, 'Streamed output should not be empty');

        let finalStdout = '';
        for (let i = 0; i < 50; i++) {
            finalStdout += `Chunk ${i} ` + "x".repeat(990) + "\n";
        }

        const normalizedFinal = safeSliceTail(finalStdout, MAX_LIMIT);
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

        assert.ok(stdoutEl.innerHTML.length > 0, 'Output cleared on completion!');
        assert.strictEqual(stdoutEl.innerHTML, normalizedFinal, 'Content should match normalized final');
    });

    it('should handle exactly standard inputs without clearing', () => {
        const content = "<span>content</span>".repeat(2000);
        const truncated = safeSliceTail(content, 20000);
        assert.ok(truncated.length > 0);
        assert.ok(truncated.length <= 20000);
    });
});
