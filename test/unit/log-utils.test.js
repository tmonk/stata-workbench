/**
 * Tests for log-utils — SMCL parsing and internal log line filtering.
 *
 * Covers:
 *   - filterMcpLogs: removes internal management commands and SMCL headers
 *   - parseSMCL: extracts return codes and error context from SMCL text
 *   - INTERNAL_PATTERNS: regex accuracy against known Stata output patterns
 */
const { describe, it, expect } = require('bun:test');
const { filterMcpLogs, parseSMCL, INTERNAL_PATTERNS } = require('../../src/log-utils');

describe('filterMcpLogs', () => {
    it('returns empty string for null/undefined input', () => {
        expect(filterMcpLogs(null)).toBe('');
        expect(filterMcpLogs(undefined)).toBe('');
    });

    it('returns empty string for empty input', () => {
        expect(filterMcpLogs('')).toBe('');
    });

    it('passes through normal output lines', () => {
        const input = 'display "hello"\n. hello\n';
        expect(filterMcpLogs(input)).toBe(input);
    });

    it('removes "capture log close _mcp_smcl_" lines', () => {
        const input = 'capture log close _mcp_smcl_\nsome output\n';
        const expected = 'some output\n';
        expect(filterMcpLogs(input)).toBe(expected);
    });

    it('removes "capture _return hold mcp_hold_" lines', () => {
        const input = 'capture _return hold mcp_hold_\nsome output\n';
        const expected = 'some output\n';
        expect(filterMcpLogs(input)).toBe(expected);
    });

    it('removes SMCL log header metadata lines', () => {
        const input = '{smcl}\n{com}{sf}{ul off}log type: smcl\n{com}{sf}{ul off}opened on: 12 May 2025\nsome output\n';
        // Header lines (including the {smcl} line) are removed; only the user output remains.
        // The trailing newline from the blank ({smcl}) line is consumed during filter.
        expect(filterMcpLogs(input)).toBe('some output\n');
    });

    it('removes log file path lines with _mcp_smcl_', () => {
        const input = '      log:  /tmp/_mcp_smcl_abc123.smcl\nsome output\n';
        const expected = 'some output\n';
        expect(filterMcpLogs(input)).toBe(expected);
    });

    it('removes name lines with _mcp_smcl_', () => {
        const input = '       name:  _mcp_smcl_abc123\nsome output\n';
        const expected = 'some output\n';
        expect(filterMcpLogs(input)).toBe(expected);
    });

    it('removes unnamed log entries', () => {
        const input = '       name:  <unnamed>\nsome output\n';
        const expected = 'some output\n';
        expect(filterMcpLogs(input)).toBe(expected);
    });

    it('removes the SMCL bottom border pattern', () => {
        const input = '{txt}{sf}{ul off}{.-}\nsome output\n';
        const expected = 'some output\n';
        expect(filterMcpLogs(input)).toBe(expected);
    });

    it('preserves lines that partially match but are not actual management commands', () => {
        // A user typing "capture log close mylog" should NOT be removed
        const input = 'capture log close mylog\n';
        expect(filterMcpLogs(input)).toBe(input);
    });

    it('removes management commands with various whitespace prefixes', () => {
        const input = '  capture log close _mcp_smcl_\n\tcapture _return hold mcp_hold_\n';
        expect(filterMcpLogs(input)).toBe('');
    });

    it('preserves normal Stata output mixed with management lines', () => {
        const input = [
            '{smcl}',
            '{com}{sf}{ul off}log type: smcl',
            '{com}{sf}{ul off}opened on: 12 May 2025, 10:00:00',
            '       name:  _mcp_smcl_abc123',
            '. di "hello world"',
            'hello world',
            'capture log close _mcp_smcl_',
        ].join('\n');

        const filtered = filterMcpLogs(input);
        expect(filtered).toContain('di "hello world"');
        expect(filtered).toContain('hello world');
        expect(filtered).not.toContain('_mcp_smcl_');
        expect(filtered).not.toContain('{smcl}');
        expect(filtered).not.toContain('log type:');
    });

    it('handles Windows-style \\r\\n line endings', () => {
        const input = 'capture log close _mcp_smcl_\r\noutput line\r\n';
        // \r is consumed by the split; join re-adds only \n.
        expect(filterMcpLogs(input)).toBe('output line\n');
    });

    it('does not alter lines that just happen to contain "mcp"', () => {
        const input = 'this is not an mcp command\nmcp is not a command here\n';
        expect(filterMcpLogs(input)).toBe(input);
    });
});

describe('parseSMCL', () => {
    it('returns { rc: null, errorContext: null } for empty input', () => {
        expect(parseSMCL('')).toEqual({ rc: null, errorContext: null });
        expect(parseSMCL(null)).toEqual({ rc: null, errorContext: null });
        expect(parseSMCL(undefined)).toEqual({ rc: null, errorContext: null });
    });

    it('returns rc: null and errorContext: null for clean output', () => {
        const output = '{res}. di "hello"\n{res}hello\n';
        expect(parseSMCL(output)).toEqual({ rc: null, errorContext: null });
    });

    it('extracts return code r(N)', () => {
        const output = 'r(111);\n some error text';
        expect(parseSMCL(output).rc).toBe(111);
    });

    it('extracts the LAST return code when multiple exist', () => {
        const output = 'r(100); then r(601); finally r(999);';
        expect(parseSMCL(output).rc).toBe(999);
    });

    it('extracts error context from {err} blocks', () => {
        const output = '{err}invalid syntax{r(198)}';
        const result = parseSMCL(output);
        expect(result.errorContext).toContain('invalid syntax');
    });

    it('prefixes "Error: " to error content that does not already start with Error', () => {
        const output = '{err}variable not found';
        const result = parseSMCL(output);
        expect(result.errorContext).toMatch(/^Error: .*variable not found/);
    });

    it('does not double-prefix "Error: "', () => {
        const output = '{err}Error: something went wrong';
        const result = parseSMCL(output);
        expect(result.errorContext).toContain('Error: something went wrong');
        // Count occurrences of "Error:" — should be exactly 1
        const matchCount = (result.errorContext.match(/Error:/g) || []).length;
        expect(matchCount).toBe(1);
    });

    it('filters out {err} content that contains "capture log close"', () => {
        const output = '{err}capture log close _mcp_smcl_ before{r(198)}{err}real error';
        const result = parseSMCL(output);
        expect(result.errorContext).not.toContain('capture log close');
        expect(result.errorContext).toContain('real error');
    });

    it('extracts both rc and errorContext from a realistic error', () => {
        const output = '{err}unknown function {com}r(133);';
        const result = parseSMCL(output);
        expect(result.rc).toBe(133);
        expect(result.errorContext).toContain('Error:');
    });

    it('handles multiple {err} blocks across multiple lines', () => {
        const output = [
            '{err}first error',
            '{res}some output',
            '{err}second error{r(198)};',
        ].join('\n');
        const result = parseSMCL(output);
        // Return code is extracted from r(198); in the output text
        expect(result.rc).toBe(198);
        expect(result.errorContext).toContain('first error');
        expect(result.errorContext).toContain('second error');
    });

    it('does not extract error context from {txt} or {res} blocks', () => {
        const output = '{txt}normal text{res}result text{err}actual error';
        const result = parseSMCL(output);
        expect(result.errorContext).toContain('actual error');
        expect(result.errorContext).not.toContain('normal text');
    });

    it('handles large blocks of text without crashing', () => {
        const largeText = '{err}error\n'.repeat(1000) + 'r(999);\n';
        const result = parseSMCL(largeText);
        expect(result.rc).toBe(999);
        expect(result.errorContext).toBeTruthy();
    });
});

describe('INTERNAL_PATTERNS', () => {
    it('contains patterns that match known internal management lines', () => {
        const testCases = [
            'capture log close _mcp_smcl_',
            'capture log close _mcp_smcl_abc123',
            '  capture log close _mcp_smcl_  ',
            'capture _return hold mcp_hold_',
            '{smcl}',
            '  {smcl}  ',
            'log type: smcl',
            '{com}{sf}{ul off}     log type: smcl',
            'opened on: 12 May 2025',
            '      log:  /tmp/_mcp_smcl_abc123.smcl',
            '       name:  _mcp_smcl_abc123',
            '       name:  <unnamed>',
            '{txt}{sf}{ul off}{.-}',
        ];

        for (const tc of testCases) {
            const matches = INTERNAL_PATTERNS.some(p => p.test(tc));
            expect(matches).toBe(true);
        }
    });

    it('does NOT match normal user content', () => {
        const shouldNotMatch = [
            '. di "hello"',
            'capture log close mylog',
            'capture _return list',
            'capture _return hold myown',
            'holds mcp stuff',
            'log: something',
            'name: mylog',
            '{txt}normal text{res}',
            'r(111);',
        ];

        for (const tc of shouldNotMatch) {
            const matches = INTERNAL_PATTERNS.some(p => p.test(tc));
            expect(matches).toBe(false);
        }
    });
});
