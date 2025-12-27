const { parseSMCL, determineSuccess } = require('../../src/terminal-panel');

describe('parseSMCL RC 10 and Amber Refinement', () => {
    it('should not detect RC 10 from char(10)', () => {
        const smcl = '{txt}241{com}.         local NL = char(10)';
        const parsed = parseSMCL(smcl);
        expect(parsed.rc).toBeNull();
        expect(parsed.hasError).toBe(false);
    });

    it('should detect RC 10 from standalone r(10);', () => {
        const smcl = 'r(10);';
        const parsed = parseSMCL(smcl);
        expect(parsed.rc).toBe(10);
    });

    it('should detect RC 10 from search tag', () => {
        const smcl = '{search r(10)}';
        const parsed = parseSMCL(smcl);
        expect(parsed.rc).toBe(10);
    });

    it('should correctly set hasError when {err} tag is present', () => {
        const smcl = '{err}variable not found\nr(111);';
        const parsed = parseSMCL(smcl);
        expect(parsed.rc).toBe(111);
        expect(parsed.hasError).toBe(true);
    });

    describe('determineSuccess Refinement', () => {
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
});
