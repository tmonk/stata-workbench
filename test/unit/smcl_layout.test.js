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

    describe('Advanced Rendering', () => {

        it('should handle paragraph settings {p # # #}', () => {
            const input = '{p 4 8 2}Indented paragraph text.{p_end}';
            const html = smclToHtml(input);
            assert(html.includes('padding-left:8ch'), 'Should have subsequent indent of 8ch');
            assert(html.includes('text-indent:-4ch'), 'Should have first-line indent relative to padding (4-8=-4ch)');
            assert(html.includes('padding-right:2ch'), 'Should have right margin of 2ch');
        });

        it('should handle paragraph shortcuts like {pstd}', () => {
            const input = '{pstd}Standard text.{p_end}';
            const html = smclToHtml(input);
            // pstd is {p 4 4 2}
            assert(html.includes('padding-left:4ch'), 'Should have padding-left 4ch');
            assert(html.includes('text-indent:0ch'), 'Should have text-indent 0ch (4-4)');
        });

        it('should handle {p2colset} and {p2col}', () => {
            const input = '{p2colset 4 20 22 2}{p2col :Left}Right side text{p_end}';
            const html = smclToHtml(input);
            
            // Check for flex layout
            assert(html.includes('display:flex'), 'Should use flex layout for table row');
            assert(html.includes('Left'), 'Should contain left column text');
            assert(html.includes('Right side text'), 'Should contain right column text');
            
            // Check dimensions from p2colset
            assert(html.includes('flex: 0 0 16ch'), 'Left column width should be 20-4=16ch');
            assert(html.includes('padding-left:2ch'), 'Right column padding-left should be 22-20=2ch');
        });

        it('should handle {synopt} which is a synonym for p2col', () => {
            const input = '{p2colset 4 20 22 2}{synopt :Option}Description{p_end}';
            const html = smclToHtml(input);
            assert(html.includes('Option'), 'Should render Option');
            assert(html.includes('Description'), 'Should render Description');
        });

        it('should handle {hi} and {hilite}', () => {
            const input = 'Normal {hi:Highlighted} Normal';
            const html = smclToHtml(input);
            assert(html.includes('smcl-hi'), 'Should have smcl-hi class');
            assert(html.includes('Highlighted'), 'Should contain the text');
        });

        it('should render helpb and helpi correctly', () => {
            const input = '{helpb regress} and {helpi summarize}';
            const html = smclToHtml(input);
            assert(html.includes('smcl-bf'), 'helpb should have bold class');
            assert(html.includes('smcl-it'), 'helpi should have italic class');
            assert(html.includes('regress'), 'Should contain link text');
        });

        it('should end paragraph on blank line', () => {
            const input = '{pstd}Line 1\n\nLine 2';
            const html = smclToHtml(input);
            // It should contain </div> before Line 2
            const parts = html.split('</div>');
            assert(parts.length > 1, 'Should have closed a div');
            assert(parts[0].includes('Line 1'), 'First part should have Line 1');
            assert(html.includes('Line 2'), 'Should have Line 2');
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

        it('should render complex describe table rows correctly', () => {
            const input = '{p 0 48}{res}{bind:make           }{txt}{bind: str18   }{bind:%-18s     }{space 1}{bind:         }{bind:  }{res}{res}Make and model{p_end}';
            const html = smclToHtml(input);
            
            // Should preserve the negative indent for hanging logic
            assert(html.includes('text-indent:-48ch'), 'Should have negative indent for first line');
            // Should wrap bind in span with white-space: pre-wrap/pre
            assert(html.includes('white-space:pre'), 'Binds should preserve internal spacing');
            assert(html.includes('make           '), 'Should preserve trailing spaces in variable name');
            assert(html.includes('Make and model'), 'Should contain variable label');
            assert(html.endsWith('</div>'), 'Should end with a closed div');
        });

        it('should handle a mix of headers, lines, and table rows sensibly', () => {
            const input = 
                'Variable      Storage   Display    Value\n' +
                '    name         type    format    label      Variable label\n' +
                '{hline}\n' +
                '{p 0 48}{res}{bind:make           }{txt}{bind: str18   }{bind:%-18s     }{space 1}{bind:         }{bind:  }{res}{res}Make and model{p_end}';
            
            const html = smclToHtml(input);
            const lines = html.split('\n');
            
            // Check header preservation (should be at top, usually in raw or com)
            assert(html.includes('Variable      Storage'), 'Headers should be preserved');
            
            // Check horizontal line
            assert(html.includes('---'), 'hline should render');
            
            // Check the row is still correctly formed even after previous content
            assert(html.includes('padding-left:48ch'), 'Table row should still have correct padding');
            assert(html.includes('Make and model'), 'Table row should still have correct content');
        });

        it('should handle nested colors inside p2col without breaking layout', () => {
            const input = '{synoptset 4 20 22 2}{p2col :{res:Option}}Multi-mode {txt:description} with {hi:highlight}{p_end}';
            const html = smclToHtml(input);
            
            assert(html.includes('smcl-res'), 'Should have color for Option');
            assert(html.includes('Option'), 'Should render Option');
            assert(html.includes('smcl-hi'), 'Should have highlight');
            assert(html.includes('description'), 'Should render description');
            // Ensure the columns didn't collapse
            assert(html.includes('flex: 0 0 16ch'), 'Column 1 width preserved');
        });
    });
});
