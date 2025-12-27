
describe('Truncation Logic Regression Test', () => {

    /*
     * Mirrors logic in terminal-panel.js
     */
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

    it('should split cleanly at a newline', () => {
        // "x...x" + "\nNextLine"
        const input = "x".repeat(100) + "\nNextLine";
        const result = safeSliceTail(input, 35);
        expect(result).toBe('NextLine');
    });

    it('should align to tag start if closer than newline', () => {
        // limit 35. 
        // "x"*100 (len 100)
        // "<span>content</span>" (len 21) -> total 121
        // "\nNextLine" (len 9) -> total 130

        // start = 130 - 35 = 95.
        // We start searching at 95.
        // < of span is at 100.
        // \n is at 121.
        // 100 < 121.
        // So we cut at 100.
        // Result should be "<span>content</span>\nNextLine".

        const input = "x".repeat(100) + "<span>content</span>\nNextLine";

        const result = safeSliceTail(input, 35);
        expect(result).toBe('<span>content</span>\nNextLine');
    });

    it('should align to tag start if no newline is found', () => {
        const prefix = "x".repeat(100);
        const tag = "<span class='foo'>content</span>";
        const input = prefix + tag;
        // limit 50. start = 132-50=82. 
        // finds < at 100.
        const result = safeSliceTail(input, 50);
        expect(result).toBe(tag);
    });

    it('should handle large limits correctly (start < 0 is not possible, but small start)', () => {
        // If limit > length, safeSliceTail returns full string immediately.
        // If limit < length but covers almost everything.
        // "x...x" + "<span>...</span>"
        // limit huge. safeSliceTail logic: `html.length <= limit` -> returns html.
        // Test passes by default logic.

        const input = "abc";
        const result = safeSliceTail(input, 100);
        expect(result).toBe("abc");
    });
});
