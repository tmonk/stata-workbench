const { describe, it, beforeAll, beforeEach, expect, jest } = require('bun:test');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

describe('Syntax Highlighting Logic (main.js)', () => {
    let dom;
    let window;
    let document;
    let mainJsContent;

    beforeAll(() => {
        const mainJsPath = path.resolve(__dirname, '../../src/ui-shared/main.js');
        mainJsContent = fs.readFileSync(mainJsPath, 'utf8');
    });

    beforeEach(() => {
        dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
            runScripts: 'dangerously',
            resources: 'usable'
        });
        window = dom.window;
        document = window.document;

        // Mock highlight.js
        window.hljs = {
            highlight: jest.fn((code, options) => {
                return { value: 'HIGHLIGHTED_' + code };
            }),
            getLanguage: jest.fn().mockReturnValue(null),
            registerLanguage: jest.fn(),
            HASH_COMMENT_MODE: {},
            C_BLOCK_COMMENT_MODE: {},
            BACKSLASH_ESCAPE: {}
        };

        // Load main.js logic
        // We can just eval it since it writes to window.stataUI
        window.eval(mainJsContent);
    });

    it('should be defined', () => {
        expect(window.stataUI).toBeDefined();
        expect(window.stataUI.processSyntaxHighlighting).toBeDefined();
    });

    it('should highlight code blocks', () => {
        document.body.innerHTML = '<span class="smcl-com syntax-highlight">. display "hello"</span>';

        window.stataUI.processSyntaxHighlighting(document);

        const el = document.querySelector('.smcl-com');
        expect(el.classList.contains('highlighted')).toBe(true);
        expect(el.classList.contains('hljs')).toBe(true);
        expect(el.innerHTML).toContain('class="prompt"');
        expect(el.innerHTML).toContain('HIGHLIGHTED_display "hello"');
    });

    it('should NOT add hljs class to empty prompts', () => {
        // This reproduces the issue: lines with just ". "
        document.body.innerHTML = '<span class="smcl-com syntax-highlight">. </span>';

        window.stataUI.processSyntaxHighlighting(document);

        const el = document.querySelector('.smcl-com');
        expect(el.classList.contains('highlighted')).toBe(true);
        // CRITICAL CHECK: Should NOT look like a code block
        expect(el.classList.contains('hljs')).toBe(false);

        // Should still preserve the prompt structure
        expect(el.innerHTML).toContain('<span class="prompt">. </span>');
    });

    it('should handle raw strings without prompt', () => {
        document.body.innerHTML = '<span class="smcl-com syntax-highlight">code without prompt</span>';
        window.stataUI.processSyntaxHighlighting(document);

        const el = document.querySelector('.smcl-com');
        expect(el.classList.contains('hljs')).toBe(true);
        expect(el.innerHTML).toContain('HIGHLIGHTED_code without prompt');
    });

    it('should NOT destroy child elements (like smcl-hline) when highlighting', () => {
        // Issue: if we use textContent, we lose inner spans
        // In the new logic, we replace hlines with dashes, so this specific preservation check
        // is less critical for hline itself, but STILL valid for other HTML.
        // Let's test with a generic span instead of smcl-hline which we nuked.
        const originalInner = '. <span class="custom-span">content</span>';
        document.body.innerHTML = `<span class="smcl-com syntax-highlight">${originalInner}</span>`;

        window.stataUI.processSyntaxHighlighting(document);

        const el = document.querySelector('.smcl-com');
        expect(el.innerHTML).toContain('custom-span');
    });
});
