const vscode = require('vscode');

jest.mock('fs');

jest.mock('../../src/artifact-utils', () => ({
    openArtifact: () => { },
    revealArtifact: () => { },
    copyToClipboard: () => { },
    resolveArtifactUri: () => { }
}));

describe('Panels', () => {
    let terminalPanelModule;

    let toEntry, smclToHtml, normalizeArtifacts, parseSMCL;

    beforeAll(() => {
        terminalPanelModule = require('../../src/terminal-panel');
        ({ toEntry, smclToHtml, normalizeArtifacts, parseSMCL } = terminalPanelModule);
    });

    describe('TerminalPanel helpers', () => {

        it('toEntry should structure data correctly on success', () => {
            const result = {
                stdout: '{com}. display "hello"',
                rc: 0,
                success: true
            };

            const entry = toEntry('display "hello"', result);

            expect(entry.code).toEqual('display "hello"');
            expect(entry.success).toBe(true);
            expect(entry.hasError).toBe(false);
            expect(entry.rc).toBe(0);
            expect(entry.stdout).toContain('hello');
            expect(entry.fullStdout).toContain('hello');
        });

        it('toEntry should hide stdout but keep fullStdout on failure', () => {
            const result = {
                stdout: '{com}. nosuchcommand\n{err}command nosuchcommand not found',
                rc: 199,
                success: false
            };

            const entry = toEntry('nosuchcommand', result);

            expect(entry.success).toBe(false);
            expect(entry.hasError).toBe(true);
            expect(entry.rc).toBe(199);
            expect(entry.stdout).toEqual(''); // Result view cleared
            expect(entry.fullStdout).toContain('nosuchcommand'); // Log kept
            expect(entry.stderr).toContain('not found');
        });

        it('toEntry should detect hasError from {err} even if success=true (legacy/edge cases)', () => {
            const result = {
                stdout: '{err}warning: something is off',
                rc: 0,
                success: true
            };

            const entry = toEntry('cmd', result);
            expect(entry.hasError).toBe(true);
            expect(entry.success).toBe(true); // as per determineSuccess logic for RC 0
            expect(entry.stdout).toContain('warning');
        });

        it('smclToHtml should handle global smcl tags and state switches', () => {
            const input = '{smcl}{com}{sf}{ul off}{txt}Text';
            const html = smclToHtml(input);
            expect(html).not.toContain('{smcl}');
            expect(html).toContain('class="smcl-com syntax-highlight"');
            expect(html).toContain('class="smcl-txt"');
            expect(html).toContain('Text');
        });

        it('normalizeArtifacts should filter nulls', () => {
            const input = {
                artifacts: [null, { path: '/a.pdf' }]
            };
            const normalized = normalizeArtifacts(input);
            expect(normalized.length).toBe(1);
            expect(normalized[0].path).toEqual('/a.pdf');
        });

        describe('parseSMCL', () => {
            describe('Return Code Detection (Strict)', () => {
                it('should detect RC from standard search tag', () => {
                    expect(parseSMCL('{search r(111), local:r(111);}').rc).toBe(111);
                });

                it('should detect RC from standalone line', () => {
                    expect(parseSMCL('r(199);').rc).toBe(199);
                });

                it('should ignore false positive RCs in table data', () => {
                    const input = 'Adj R-squared = 0.0515\nWithin R-sq. = 0.0195\n1.98 0.051';
                    expect(parseSMCL(input).rc).toBeNull();
                });
            });

            describe('Error Message Capture (Strict)', () => {
                it('should capture error only from {err} tag', () => {
                    const output = parseSMCL('{err}variable x not found');
                    expect(output.formattedText).toContain('Error: variable x not found');
                });

                it('should ignore errors in plain text', () => {
                    expect(parseSMCL('if rc error 198').formattedText).toBe('');
                });
            });

            describe('Command History & Filtering', () => {
                it('should capture command with multiple prefixes', () => {
                    const input = '{com}. cap noi Estimate x\n{err}err';
                    expect(parseSMCL(input).formattedText).toContain('Command:\n  Estimate x');
                });

                it('should ignore loop keywords', () => {
                    const input = '{com}. while 1 {\n{com}. foreach x of varlist * {\n{err}err';
                    const out = parseSMCL(input).formattedText;
                    expect(out).not.toContain('Command:\n  while');
                    expect(out).not.toContain('Command:\n  foreach');
                });
            });

            describe('Call Stack Management', () => {
                it('should track and freeze stack on error', () => {
                    const input = 'begin main\nbegin sub\n{err}err\nend sub';
                    expect(parseSMCL(input).formattedText).toContain('In: main → sub');
                });

                it('should strictly pop only matching tags', () => {
                    const input = 'begin main\nbegin sub\nend main\n{err}err';
                    expect(parseSMCL(input).formattedText).toContain('In: main → sub');
                });
            });

            describe('Complex Scenarios', () => {
                it('should handle reghdfe output correctly', () => {
                    const input = `
      {hline 50} begin main {hline}
    = cap noi Estimate x
      {hline 46} begin Estimate {hline}
{err}variable x not found
{search r(111), local:r(111);}
`;
                    const parsed = parseSMCL(input);
                    expect(parsed.rc).toBe(111);
                    expect(parsed.formattedText).toContain('In: main → Estimate');
                    expect(parsed.formattedText).toContain('Command:\n  Estimate x');
                    expect(parsed.formattedText).toContain('Error: variable x not found');
                });
            });
        });
    });

    describe('TerminalPanel Class', () => {
        let TerminalPanel;
        beforeAll(() => { TerminalPanel = terminalPanelModule.TerminalPanel; });

        it('should reveal panel if exists on addEntry', () => {
            let revealed = false;
            TerminalPanel.currentPanel = {
                webview: { postMessage: () => { } },
                reveal: () => { revealed = true; }
            };
            TerminalPanel.addEntry('code', { stdout: '' }, '/path');
            expect(revealed).toBe(true);
            TerminalPanel.currentPanel = null;
        });

        it('should store handlers on show', () => {
            const h = () => { };
            TerminalPanel.show({ downloadGraphPdf: h, cancelRun: h, clearAll: h });
            expect(TerminalPanel._downloadGraphPdf).toBe(h);
            expect(TerminalPanel._cancelHandler).toBe(h);
            TerminalPanel.currentPanel = null;
        });
    });
});
