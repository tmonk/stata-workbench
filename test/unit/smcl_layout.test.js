const { describe, it } = require('bun:test');
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

describe('SMCL Layout Principles', () => {

    function stripHtml(html) {
        return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    }

    it('should align text using {col} correctly', () => {
        const input = 'abc{col 10}d';
        const html = smclToHtml(input);
        const text = stripHtml(html);
        assert(text.includes('abc      d') || text.includes('abc       d'));
    });

    it('should handle {col} after newline correctly', () => {
        const input = 'line1\n{col 5}x';
        const html = smclToHtml(input);
        const text = stripHtml(html);
        const lines = text.split('\n');
        assert.strictEqual(lines[0], 'line1');
        assert(lines[1].startsWith('    x'));
    });

    it('should ignore {col} if already past column', () => {
        const input = '1234567890{col 5}x';
        const html = smclToHtml(input);
        const text = stripHtml(html);
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
        assert(html.includes('77'));
        assert(html.includes('smcl-res'));
    });

    it('should handle {ralign N:content} by outputting content at least', () => {
        const input = '{ralign 10:hello}';
        const html = smclToHtml(input);
        const text = stripHtml(html);
        assert(text.includes('hello'));
    });

    it('should normalize \\r\\n to \\n early', () => {
        const input = 'line1\r\nline2';
        const html = smclToHtml(input);
        assert(!html.includes('\r'));
        assert(html.includes('line1\nline2'));
    });

    describe('Advanced Rendering', () => {

        it('should handle paragraph settings {p # # #}', () => {
            const input = '{p 4 8 2}Indented paragraph text.{p_end}';
            const html = smclToHtml(input);
            assert(html.includes('padding-left:8ch'));
            assert(html.includes('text-indent:-4ch'));
            assert(html.includes('padding-right:2ch'));
        });

        it('should handle paragraph shortcuts like {pstd}', () => {
            const input = '{pstd}Standard text.{p_end}';
            const html = smclToHtml(input);
            assert(html.includes('padding-left:4ch'));
            assert(html.includes('text-indent:0ch'));
        });

        it('should handle {p2colset} and {p2col}', () => {
            const input = '{p2colset 4 20 22 2}{p2col :Left}Right side text{p_end}';
            const html = smclToHtml(input);
            assert(html.includes('display:flex'));
            assert(html.includes('Left'));
            assert(html.includes('Right side text'));
            assert(html.includes('flex: 0 0 16ch'));
            assert(html.includes('padding-left:2ch'));
        });

        it('should handle {synopt} which is a synonym for p2col', () => {
            const input = '{p2colset 4 20 22 2}{synopt :Option}Description{p_end}';
            const html = smclToHtml(input);
            assert(html.includes('Option'));
            assert(html.includes('Description'));
        });

        it('should handle {hi} and {hilite}', () => {
            const input = 'Normal {hi:Highlighted} Normal';
            const html = smclToHtml(input);
            assert(html.includes('smcl-hi'));
            assert(html.includes('Highlighted'));
        });

        it('should render helpb and helpi correctly', () => {
            const input = '{helpb regress} and {helpi summarize}';
            const html = smclToHtml(input);
            assert(html.includes('smcl-bf'));
            assert(html.includes('smcl-it'));
            assert(html.includes('regress'));
        });

        it('should end paragraph on blank line', () => {
            const input = '{pstd}Line 1\\n\\nLine 2';
            const html = smclToHtml(input);
            const parts = html.split('</div>');
            assert(parts.length > 1);
            assert(parts[0].includes('Line 1'));
            assert(html.includes('Line 2'));
        });

        it('should handle {dup}', () => {
            const input = '{dup 3:abc}';
            const html = smclToHtml(input);
            assert.strictEqual(html, 'abcabcabc');
        });

        it('should handle {c} with codes', () => {
            const input = '{c 0x6a}{c 107}';
            const html = smclToHtml(input);
            assert.strictEqual(html, 'jk');
        });
    });
});
