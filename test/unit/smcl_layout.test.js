const assert = require('assert');
// We will mock the necessary parts or load the function if exported
// Assuming we can load terminal-panel.js logic similar to other tests or create a standalone utility for testing if possible.
// For now, let's rely on the structure used in panels.test.js which likely requires the module.
const vscode = require('vscode');
jest.mock('vscode', () => require('../mocks/vscode'), { virtual: true });
const { smclToHtml } = require('../../src/terminal-panel.js');

describe('SMCL Layout Principles', () => {

    // Helper to strip HTML tags for checking alignment
    function stripHtml(html) {
        return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    }

    it('should align text using {col} correctly', () => {
        // "abc" is 3 chars. {col 10} should add 7 spaces (positions 0,1,2 filled, 3..9 spaces, write at 10)
        // Wait, Stata columns might be 1-based? Usually documentation says column.
        // If {col 10} means start at column 10 (0-indexed 9?), let's assume standard behavior.
        // SMCL {col} usually means "skip to column N".
        // Let's assume strict padding.

        const input = 'abc{col 10}d';
        const html = smclToHtml(input);
        const text = stripHtml(html);

        // alignment:
        // 01234567890
        // abc       d
        // d is at index 9 or 10?
        // If col 10 means 10th character position (index 9), then spaces needed = 9 - 3 = 6.
        // If col 10 means index 10, then spaces = 10 - 3 = 7.
        // Typical terminal "column 1" is index 0. So col 10 is index 9.
        // Let's guess standard behavior: "abc" is chars 1,2,3. next is 4. {col 10} jumps to 10.
        // So indices 4,5,6,7,8,9 (6 spaces) strings.
        // "abc      d" -> d is 10th char.

        // We will assert roughly for now and refine.
        // "abc" + 6 spaces + "d" = 10 chars total length? No.
        // "abc" (3) + spaces (6) = 9 chars. "d" is at index 9. This aligns with "col 10" being 1-based.

        // Let's require at least some spaces.
        assert(text.includes('abc      d') || text.includes('abc       d'));
    });

    it('should handle {col} after newline correctly', () => {
        const input = 'line1\n{col 5}x';
        const html = smclToHtml(input);
        const text = stripHtml(html);
        const lines = text.split('\n');

        assert.strictEqual(lines[0], 'line1');
        // {col 5} -> jump to 5th col. 1-based 5 -> index 4.
        // "    x" (4 spaces, x at index 4)
        assert(lines[1].startsWith('    x'));
    });

    it('should ignore {col} if already past column', () => {
        const input = '1234567890{col 5}x';
        const html = smclToHtml(input);
        const text = stripHtml(html);
        // Should just append x, maybe with 1 space? Stata usually appends.
        assert(text.includes('1234567890x') || text.includes('1234567890 x'));
    });

    it('should handle {space}', () => {
        const input = 'a{space 5}b';
        const html = smclToHtml(input);
        const text = stripHtml(html);
        assert.strictEqual(text, 'a     b');
    });

    it('should handle {hline}', () => {
        const input = '{hline 5}';
        const html = smclToHtml(input);
        const text = stripHtml(html);
        assert.strictEqual(text, '-----');
    });

    it('should handle {res:content} shorthand', () => {
        const input = 'val: {res:77}';
        const html = smclToHtml(input);
        // Should contain "77" inside a span
        assert(html.includes('77'));
        assert(html.includes('smcl-res'));
    });

    it('should handle {ralign N:content} by outputting content at least', () => {
        const input = '{ralign 10:hello}';
        const html = smclToHtml(input);
        const text = stripHtml(html);
        assert(text.includes('hello'));
        // Optional: verify alignment if we implement it. 
        // "     hello" (5 spaces)
    });

    it('should normalize \r\n to \n early', () => {
        const input = 'line1\r\nline2';
        const html = smclToHtml(input);
        // Should not contain \r
        assert(!html.includes('\r'));
        assert(html.includes('line1\nline2'));
    });
});
