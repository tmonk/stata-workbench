const vscode = require('vscode');

jest.mock('fs');
// path is fine as is

jest.mock('../../src/artifact-utils', () => ({
    openArtifact: () => { }
}));

describe('Panels', () => {
    let terminalPanelModule;

    beforeAll(() => {
        terminalPanelModule = require('../../src/terminal-panel');
    });

    describe('TerminalPanel helpers', () => {
        it('toEntry should structure data correctly', () => {
            const { toEntry } = terminalPanelModule;
            const result = {
                stdout: 'out',
                command: 'test cmd',
                rc: 0,
                success: true,
                artifacts: [{ path: '/tmp/g.pdf' }]
            };

            const entry = toEntry('sysuse auto', result);

            expect(entry.code).toEqual('sysuse auto');
            expect(entry.stdout).toEqual('out');
            expect(entry.success).toBe(true);
            expect(entry.artifacts.length).toBe(1);
            expect(entry.artifacts[0].path).toEqual('/tmp/g.pdf');
        });

        it('toEntry should not fall back to contentText on failure', () => {
            const { toEntry } = terminalPanelModule;
            const result = {
                contentText: '{"command":"reg y x"}',
                stderr: '. reg y x\n{err}variable y not found\nr(111);',
                rc: 111,
                success: false
            };

            const entry = toEntry('reg y x', result);

            expect(entry.code).toEqual('reg y x');
            expect(entry.stdout).toEqual('');
            expect(entry.stderr).toContain('Error: variable y not found');
            expect(entry.stderr).toContain('smcl-err');
            expect(entry.stderr).toContain('r(111)');
            expect(entry.success).toBe(false);
        });

        it('toEntry should find context in stdout when error is in stderr', () => {
            const { toEntry } = terminalPanelModule;
            const result = {
                stdout: '{com}. cljn',
                stderr: '{err}command cljn is unrecognized\n{txt}r(199);',
                rc: 199,
                success: false
            };

            const entry = toEntry('do "test.do"', result);

            expect(entry.stderr).toContain('Command:');
            expect(entry.stderr).toContain('cljn');
            expect(entry.stderr).toContain('Error: command cljn is unrecognized');
            expect(entry.stderr).toContain('smcl-hline');
        });

        it('smclToHtml should handle global smcl tags and state switches', () => {
            const { smclToHtml } = terminalPanelModule;
            const input = '{smcl}{com}{sf}{ul off}{txt}Text';
            const html = smclToHtml(input);
            expect(html).not.toContain('{smcl}');
            expect(html).not.toContain('{sf}');
            expect(html).not.toContain('{ul off}');
            expect(html).toContain('class="smcl-com syntax-highlight"');
            expect(html).toContain('class="smcl-txt"');
            expect(html).toContain('Text');
        });

        it('smclToHtml should handle nested tags', () => {
            const { smclToHtml } = terminalPanelModule;
            const input = '{com}Command {bf:Bold}{/com}';
            const html = smclToHtml(input);
            expect(html).toContain('class="smcl-com');
            expect(html).toContain('class="smcl-bf');
        });

        it('smclToHtml should handle hline', () => {
            const { smclToHtml } = terminalPanelModule;
            const input = '{hline 20}';
            const html = smclToHtml(input);
            expect(html).toContain('class="smcl-hline"');
        });

        it('smclToHtml should handle character escapes', () => {
            const { smclToHtml } = terminalPanelModule;
            const input = '{c -(}brackets{c )-}';
            const html = smclToHtml(input);
            expect(html).toBe('{brackets}');
        });

        it('smclToHtml should handle complex multi-line output (Decent Test)', () => {
            const { smclToHtml } = terminalPanelModule;
            const input = `{smcl}
{com}{sf}{ul off}{txt}{.-}
      name:  {res}_mcp_smcl_cc333d3e
       {txt}log:  {res}/tmp/mcp_smcl_test.smcl
  {txt}log type:  {res}smcl
 {txt}opened on:  {res}27 Dec 2025, 00:54:58
{txt}
{com}. clear all`;
            const html = smclToHtml(input);

            // Check major tags are gone or converted
            expect(html).not.toContain('{smcl}');
            expect(html).not.toContain('{sf}');
            expect(html).not.toContain('{ul off}');

            // Check conversion to spans
            expect(html).toContain('<span class="smcl-com syntax-highlight">');
            expect(html).toContain('<span class="smcl-txt">');
            // 'res' was only in metadata, so it's gone
            expect(html).not.toContain('<span class="smcl-res">');
            expect(html).toContain('<span class="smcl-hline"></span>'); // from {.-}

            // Check text content
            expect(html).not.toContain('_mcp_smcl_cc333d3e');
            expect(html).not.toContain('/tmp/mcp_smcl_test.smcl');
            expect(html).toContain('clear all');

            // Verify structure: spans should be closed
            const openSpans = (html.match(/<span/g) || []).length;
            const closeSpans = (html.match(/<\/span>/g) || []).length;
            expect(openSpans).toBe(closeSpans);
        });

        it('normalizeArtifacts should filter nulls and handle formatting', () => {
            const { normalizeArtifacts, parseSMCL } = terminalPanelModule;
            const input = {
                artifacts: [
                    null,
                    { path: '/a.pdf', previewDataUri: 'data:...' }
                ]
            };

            const normalized = normalizeArtifacts(input);
            expect(normalized.length).toBe(1);
            expect(parseSMCL('r(199);').rc).toBe(199);
            expect(parseSMCL('{search r(199), local:r(199);}').rc).toBe(199);
            expect(normalized[0].path).toEqual('/a.pdf');
            expect(normalized[0].previewDataUri).toEqual('data:...');
        });

        it('parseSMCL should handle complex multi-step errors and ignore comments/prompts in errors', () => {
            const { parseSMCL } = terminalPanelModule;
            const input = `
{com}. * Extract path up to and including the project folder
{txt}
{com}. Estimate compl_gloves pc_03_17 female age graduate
{err}variable compl_gloves not found
{txt}{search r(111), local:r(111);}
`;
            const parsed = parseSMCL(input);

            // Check order and content
            expect(parsed.formattedText).toContain('Command:\n  Estimate compl_gloves');
            expect(parsed.formattedText).toContain('variable compl_gloves not found');

            // Verify skips
            expect(parsed.formattedText).not.toContain('* Extract path');
            expect(parsed.formattedText).not.toContain('display as error');
        });

        it('parseSMCL should filter out noisy traces and internal commands from error output', () => {
            const { parseSMCL } = terminalPanelModule;
            const input = `
{com}. Estimate compl_gloves pc_03_17 female age graduate
{err}error 190
error 198
if \`"\`lhs'"'!="" error 198
di as err \`"palette \`palette' not found"\`
 16.         display as error "liner: RHS variable not specified and could not be inferred"
{err}variable compl_gloves not found
{txt}{search r(111), local:r(111);}
{com}. capture log close _mcp_smcl_d9e4a9bf
{txt}
`;
            const parsed = parseSMCL(input);

            // Command should be Estimate, NOT log close
            expect(parsed.formattedText).toContain('Command:\n  Estimate compl_gloves');
            expect(parsed.formattedText).not.toContain('log close');

            // Error should be concise
            expect(parsed.formattedText).toContain('Error: variable compl_gloves not found');
            expect(parsed.formattedText).not.toContain('error 190');
            expect(parsed.formattedText).not.toContain('error 198');
            expect(parsed.formattedText).not.toContain('display as error');
            expect(parsed.formattedText).not.toContain('liner: RHS variable');
        });

        it('parseSMCL should ignore false positive "error" words in source code loops (Regression Test)', () => {
            const { parseSMCL } = terminalPanelModule;
            const input = `
{com}. while \`""' != ":" & \`""' != "" {
{txt}  
  if \`"\`lhs'"'!="" error 198
  ...
{err}variable compl_gloves not found
{txt}{search r(111), local:r(111);}
`;
            const parsed = parseSMCL(input);

            // Should capture the real error, ignoring the fake one in source code
            expect(parsed.formattedText).toContain('variable compl_gloves not found');
            expect(parsed.formattedText).not.toContain('error 198');

            // Should not capture 'while' as the main command
            expect(parsed.formattedText).not.toContain('Command:\n  while');
        });

        describe('TerminalPanel.addEntry', () => {
            it('should append to existing panel', () => {
                const { TerminalPanel } = terminalPanelModule;
                let postedMessage = null;
                let revealedColumn = null;

                TerminalPanel.currentPanel = {
                    webview: {
                        postMessage: (msg) => { postedMessage = msg; }
                    },
                    reveal: (col) => { revealedColumn = col; }
                };

                TerminalPanel.addEntry('code', { stdout: 'result' }, '/path/to/file');

                expect(postedMessage.type).toEqual('append');
                expect(postedMessage.entry.code).toEqual('code');
                expect(postedMessage.entry.stdout).toEqual('result');
                expect(revealedColumn).not.toBeNull();

                TerminalPanel.currentPanel = null;
            });

            it('should open new panel if none exists', () => {
                const { TerminalPanel } = terminalPanelModule;
                let showCalled = false;
                let capturedOptions = null;

                const originalShow = TerminalPanel.show;
                TerminalPanel.show = (opts) => {
                    showCalled = true;
                    capturedOptions = opts;
                };

                TerminalPanel.currentPanel = null;

                const runCmd = async () => { };
                const varProvider = () => [];
                TerminalPanel.addEntry('code', { stdout: 'res' }, '/path', runCmd, varProvider);

                expect(showCalled).toBe(true);
                expect(capturedOptions.initialCode).toEqual('code');
                expect(capturedOptions.filePath).toEqual('/path');
                expect(capturedOptions.runCommand).toEqual(runCmd);
                expect(capturedOptions.variableProvider).toEqual(varProvider);

                TerminalPanel.show = originalShow;
            });
        });

        describe('new controls + download wiring', () => {
            it('stores download/cancel handlers on show', () => {
                const { TerminalPanel } = terminalPanelModule;
                TerminalPanel.currentPanel = null;
                const downloadStub = () => { };
                const cancelStub = () => { };
                const clearStub = () => { };

                TerminalPanel.show({
                    filePath: '/tmp/foo',
                    initialCode: null,
                    initialResult: null,
                    runCommand: async () => ({}),
                    variableProvider: () => [],
                    downloadGraphPdf: downloadStub,
                    cancelRun: cancelStub,
                    clearAll: clearStub
                });

                expect(TerminalPanel._downloadGraphPdf).toBe(downloadStub);
                expect(TerminalPanel._cancelHandler).toBe(cancelStub);
                expect(TerminalPanel._clearHandler).toBe(clearStub);

                TerminalPanel.currentPanel = null;
            });

            it('_handleDownloadGraphPdf delegates when set', async () => {
                const { TerminalPanel } = terminalPanelModule;
                const stub = jest.fn().mockResolvedValue();
                TerminalPanel._downloadGraphPdf = stub;

                await TerminalPanel._handleDownloadGraphPdf('g1');

                expect(stub).toHaveBeenCalledWith('g1');
            });

            it('_handleClearAll delegates when set', async () => {
                const { TerminalPanel } = terminalPanelModule;
                const stub = jest.fn().mockResolvedValue();
                TerminalPanel._clearHandler = stub;

                await TerminalPanel._handleClearAll();

                expect(stub).toHaveBeenCalledTimes(1);
            });

            it(
                'startStreamingEntry wires cancel handler and passes through show',
                () => {
                    const { TerminalPanel } = terminalPanelModule;
                    const cancelStub = () => { };
                    const runStub = () => { };
                    const varStub = () => [];
                    let capturedOptions = null;

                    const originalShow = TerminalPanel.show;
                    TerminalPanel.show = (opts) => {
                        capturedOptions = opts;
                    };

                    TerminalPanel.currentPanel = null;
                    TerminalPanel.startStreamingEntry('code', '/tmp/x', runStub, varStub, cancelStub);

                    expect(TerminalPanel._cancelHandler).toBe(cancelStub);
                    expect(capturedOptions.cancelRun).toBe(cancelStub);

                    TerminalPanel.show = originalShow;
                    TerminalPanel.currentPanel = null;
                }
            );
        });

        it('parseSMCL should correctly extract call stack and errors from complex Stata log (Regression Test)', () => {
            const { parseSMCL } = terminalPanelModule;
            const input = `
      {hline 50} end ms_get_version {hline}
    - cap noi Estimate 0'
    = cap noi Estimate compl_gloves pc_03_17 female age graduate, cluster(homecountry) absorb( date continent field university)
      {hline 46} begin reghdfe.Estimate {hline}
      - syntax varlist(fv ts numeric) [if] [in] [fw aw pw/] [ , Absorb(string) Group_id(varname numeric) Individual_id(varname numeric) AGgregation(string) VCE(string) CLuster(string) RESiduals(name) RESiduals2 DOFadjustments(string) GROUPVar(name) TEChnique(string) TOLerance(real 1e-8) ITERATE(real 16000) TRAnsform(string) ACCELeration(string) PREConditioner(string) PRUNE NOSAMPle COMPACT POOLsize(integer 10) PARallel(string asis) noHEader noTABle noFOOTnote Verbose(integer 0) noWARN TIMEit KEEPSINgletons noPARTIALout varlist_is_touse noREGress KEEPMATA FASTREGress noCONstant noAbsorb2 ] [*]
{err}variable {bf}compl_gloves{sf} not found
{txt}      {hline 48} end reghdfe.Estimate {hline}
    - Cleanup c(rc)' keep_mata'
    = Cleanup 111 0
      {hline 47} begin reghdfe.Cleanup {hline}
      - args rc keep_mata
      - loc cleanup_folder = !keep_mata' & ("$LAST_PARALLEL_DIR"!="")
      = loc cleanup_folder = !0 & (""!="")
      - if (cleanup_folder') cap mata: unlink_folder(HDFE.parallel_dir, 0)
      = if (0) cap mata: unlink_folder(HDFE.parallel_dir, 0)
      - global LAST_PARALLEL_DIR
      - global pids
      - if (!keep_mata') cap mata: mata drop HDFE
      = if (!0) cap mata: mata drop HDFE
      - cap mata: mata drop hdfe_*
      - cap drop __temp_reghdfe_resid__
      - if rc') exit rc'
      = if (111) exit 111
      {hline 49} end reghdfe.Cleanup {hline}
    {hline 59} end reghdfe {hline}
    {c )-}
    matrix resultsi', 1] = _b[var']
    matrix resultsi', 2] = _se[var']
    local i = \`i' + 1
    {c )-}
  {hline 52} end make_decay_graph {hline}
{search r(111), local:r(111);}
`;
            // Simulate full stack by prepending checking begins
            const fullInput = `
      {hline 50} begin make_decay_graph {hline}
      {hline 40} begin reghdfe {hline}
` + input;

            const parsed = parseSMCL(fullInput);

            expect(parsed.rc).toBe(111);

            // Check formatted text content
            expect(parsed.formattedText).toContain('In: make_decay_graph → reghdfe → reghdfe.Estimate');
            expect(parsed.formattedText).toContain('Command:\n  Estimate compl_gloves');
            // The error message should be clean
            expect(parsed.formattedText).toMatch(/Error:\s+variable compl_gloves not found/);
        });
    });
});
