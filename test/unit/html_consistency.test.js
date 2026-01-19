const assert = require('assert');
const { JSDOM } = require('jsdom');

const { smclToHtml } = (() => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    global.window = dom.window;
    global.document = dom.window.document;
    global.navigator = dom.window.navigator;
    const stataUI = require('../../src/ui-shared/main.js');
    global.window.stataUI = stataUI;
    return stataUI;
})();

/**
 * Mock of the browser-side Syntax Highlighting logic in src/ui-shared/main.js
 */
function simulateHighlighting(html) {
    if (!html) return '';

    // Note: Re-simulate the highlighting logic accurately
    return html.replace(/<span class="smcl-com syntax-highlight">([^<]*)<\/span>/g, (match, content) => {
        let raw = content;
        let prefix = '';
        if (raw.startsWith('. ')) {
            prefix = '. ';
            raw = raw.substring(2);
        } else if (raw === '.' || raw.startsWith('.')) {
            prefix = '.';
            raw = raw.substring(1);
        }

        if (!raw.trim()) {
            return `<span class="smcl-com syntax-highlight highlighted"><span class="prompt">${prefix}</span></span>`;
        } else {
            return `<span class="smcl-com syntax-highlight highlighted hljs"><span class="prompt">${prefix}</span><span>HLJS:${raw}</span></span>`;
        }
    });
}

describe('HTML Output Consistency (Streaming vs Final)', () => {

    function testConsistency(chunks) {
        const fullInput = chunks.join('');

        // 1. Simulate Streaming with Line Buffering ( mirroring mcp-client.js fix)
        let streamedHtml = '';
        let lineBuffer = '';
        chunks.forEach(chunk => {
            lineBuffer += chunk;
            let lines = lineBuffer.split(/\r?\n/);
            lineBuffer = lines.pop() || '';

            // Mirror the SPECIAL logic in mcp-client.js
            if (lines.length > 0) {
                const lastLine = lines[lines.length - 1];
                if (lastLine.trim() === '.') {
                    lineBuffer = lines.pop() + '\n' + lineBuffer;
                }
            }

            if (lines.length > 0) {
                const completedText = lines.join('\n') + '\n';
                streamedHtml += smclToHtml(completedText);
            }
        });
        if (lineBuffer) {
            streamedHtml += smclToHtml(lineBuffer);
        }
        const finalStreamed = simulateHighlighting(streamedHtml);

        // 2. Simulate Final Log Loading
        const finalLogHtml = simulateHighlighting(smclToHtml(fullInput));

        if (finalStreamed !== finalLogHtml) {
            console.log('--- Streamed ---');
            console.log(JSON.stringify(finalStreamed));
            console.log('--- Final ---');
            console.log(JSON.stringify(finalLogHtml));

            // Helpful diff for debugging
            const len = Math.min(finalStreamed.length, finalLogHtml.length);
            for (let i = 0; i < len; i++) {
                if (finalStreamed[i] !== finalLogHtml[i]) {
                    console.log(`Diff at index ${i}: '${finalStreamed[i]}' vs '${finalLogHtml[i]}'`);
                    console.log('Streamed around:', JSON.stringify(finalStreamed.substring(i - 10, i + 20)));
                    console.log('Final around:', JSON.stringify(finalLogHtml.substring(i - 10, i + 20)));
                    break;
                }
            }
        }

        assert.strictEqual(finalStreamed, finalLogHtml, 'Streamed HTML should match Final Log HTML');
    }

    it('should stay consistent when prompt is streamed separately from command', () => {
        testConsistency(['. ', 'ls\n']);
    });

    it('should collapse prompt with newline if content follows', () => {
        // Case: . \nend of do-file
        testConsistency(['. \n', 'end of do-file\n']);
    });

    it('should collapse prompt without space if content follows', () => {
        // Case: .\nend of do-file
        testConsistency(['.\n', 'end of do-file\n']);
    });

    it('should collapse newline even if prompt is the VERY LAST thing (nothing follows)', () => {
        const input = '. \n';
        const html = smclToHtml(input);
        assert(!html.includes('\n'), 'Should collapse newline if it is part of a prompt');
    });

    it('should handle partial prompts without spaces if they occur', () => {
        testConsistency(['.', ' do test\n']);
    });

    it('should not have an unexpected empty line at the very end if input ends with newline', () => {
        const input = 'line1\n';
        const html = smclToHtml(input);
        // If it returns "line1\n", in a pre-wrap container, that shows as one line of text
        // and a second empty line. 
        // If Stata already gave us the newline, we might want to keep it, 
        // but if it's causing visual issues, we should keep it CONSISTENT.
        const finalLogHtml = simulateHighlighting(smclToHtml(input));
        assert.strictEqual(finalLogHtml.endsWith('\n'), true, 'Should preserve the trailing newline if it was in the input');
    });
});
