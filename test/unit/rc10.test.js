const { describe, it, expect } = require('bun:test');
const { determineSuccess } = require('../../src/terminal-panel');

describe('RC 10 handling', () => {
    it('should treat RC 0 as success', () => {
        expect(determineSuccess({ success: true }, 0)).toBe(true);
    });

    it('should treat RC 1 as failure', () => {
        expect(determineSuccess({ success: true }, 1)).toBe(false);
    });

    it('should treat RC 9 as failure', () => {
        expect(determineSuccess({ success: true }, 9)).toBe(false);
    });

    it('should treat RC 10 as failure', () => {
        expect(determineSuccess({ success: true }, 10)).toBe(false);
    });

    it('should treat other RCs as failure', () => {
        expect(determineSuccess({ success: true }, 198)).toBe(false);
    });
});
