const { describe, it, beforeEach, afterEach, expect, jest } = require('bun:test');
const path = require('path');

// Mock vscode BEFORE any require of installer.js
const mockTerminal = {
    show: jest.fn(),
    sendText: jest.fn(),
    dispose: jest.fn(),
};

const mockVscode = {
    window: {
        showInformationMessage: jest.fn().mockResolvedValue(),
        createTerminal: jest.fn().mockReturnValue(mockTerminal),
        createOutputChannel: jest.fn().mockReturnValue({
            appendLine: jest.fn(),
        }),
    },
    ThemeColor: function (name) { this.name = name; },
};

jest.mock('vscode', () => mockVscode, { virtual: true });

// Now safe to require. child_process is required by installer as `const cp = require('child_process')`
const cp = require('child_process');
const fs = require('fs');
const installer = require('../../src/installer');

describe('installer module', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
        delete process.env.STATA_AGENT_PATH;
        delete process.env.STATA_PATH;
    });

    // ==================================================================
    // findStataAgentBinary
    // ==================================================================
    describe('findStataAgentBinary', () => {
        it('returns STATA_AGENT_PATH if set', () => {
            process.env.STATA_AGENT_PATH = '/custom/stata-agent';
            expect(installer.findStataAgentBinary()).toBe('/custom/stata-agent');
        });

        it('discovers uv tool bin dir via uv tool dir --bin', () => {
            jest.spyOn(cp, 'spawnSync').mockImplementation((cmd, args) => {
                if (cmd === 'uv' && args[0] === 'tool' && args[1] === 'dir' && args[2] === '--bin') {
                    return { status: 0, stdout: '/home/user/.local/bin', stderr: '' };
                }
                return { status: 1, stdout: '', stderr: '' };
            });

            jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
                return p === path.join('/home/user/.local/bin', 'stata-agent');
            });

            const result = installer.findStataAgentBinary();
            expect(result).toBe(path.join('/home/user/.local/bin', 'stata-agent'));
        });

        it('discovers uv tool bin dir on Windows (stata-agent.exe)', () => {
            const origPlatform = process.platform;
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

            jest.spyOn(cp, 'spawnSync').mockImplementation((cmd, args) => {
                if (cmd === 'uv' && args[0] === 'tool' && args[1] === 'dir' && args[2] === '--bin') {
                    return { status: 0, stdout: 'C:\\Users\\test\\AppData\\Roaming\\uv\\bin', stderr: '' };
                }
                return { status: 1, stdout: '', stderr: '' };
            });

            jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
                return p === path.join('C:\\Users\\test\\AppData\\Roaming\\uv\\bin', 'stata-agent.exe');
            });

            const result = installer.findStataAgentBinary();
            expect(result).toBe(path.join('C:\\Users\\test\\AppData\\Roaming\\uv\\bin', 'stata-agent.exe'));

            Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
        });

        it('returns stata-agent on PATH if spawnSync succeeds', () => {
            jest.spyOn(cp, 'spawnSync').mockImplementation((cmd, args) => {
                if (cmd === 'stata-agent' && args[0] === '--version') {
                    return { status: 0, stdout: 'stata-agent 0.1.0', stderr: '' };
                }
                if (cmd === 'uv') {
                    return { status: 1, stdout: '', stderr: '' };
                }
                return { status: 1, stdout: '', stderr: '' };
            });

            expect(installer.findStataAgentBinary()).toBe('stata-agent');
        });

        it('does NOT return STATA_PATH env (reserved for Stata Corp)', () => {
            process.env.STATA_PATH = '/custom/stata-mp';
            jest.spyOn(cp, 'spawnSync').mockReturnValue({ status: 1, stdout: '', stderr: '' });
            const result = installer.findStataAgentBinary();
            expect(result).toBeNull();
        });

        it('returns null if nothing found', () => {
            jest.spyOn(cp, 'spawnSync').mockReturnValue({ status: 1, stdout: '', stderr: '' });
            const result = installer.findStataAgentBinary();
            expect(result).toBeNull();
        });
    });

    // ==================================================================
    // isStataAgentInstalled
    // ==================================================================
    describe('isStataAgentInstalled', () => {
        it('returns false when findStataAgentBinary returns null', () => {
            jest.spyOn(installer, 'findStataAgentBinary').mockReturnValue(null);
            expect(installer.isStataAgentInstalled()).toBe(false);
        });

        it('returns true when version output contains stata_agent', () => {
            jest.spyOn(installer, 'findStataAgentBinary').mockReturnValue('stata-agent');
            jest.spyOn(cp, 'spawnSync').mockReturnValue({ status: 0, stdout: 'stata_agent version 0.1.0', stderr: '' });
            expect(installer.isStataAgentInstalled()).toBe(true);
        });

        it('returns true when version output contains stata-agent (hyphenated)', () => {
            jest.spyOn(installer, 'findStataAgentBinary').mockReturnValue('stata-agent');
            jest.spyOn(cp, 'spawnSync').mockReturnValue({ status: 0, stdout: 'stata-agent 0.1.0', stderr: '' });
            expect(installer.isStataAgentInstalled()).toBe(true);
        });

        it('returns false when binary is Stata Corp (no stata_agent/stata-agent)', () => {
            jest.spyOn(installer, 'findStataAgentBinary').mockReturnValue('stata-mp');
            jest.spyOn(cp, 'spawnSync').mockReturnValue({ status: 0, stdout: 'Stata/MP 18.0', stderr: '' });
            expect(installer.isStataAgentInstalled()).toBe(false);
        });

        it('returns false when --version times out', () => {
            jest.spyOn(installer, 'findStataAgentBinary').mockReturnValue('stata-agent');
            jest.spyOn(cp, 'spawnSync').mockImplementation(() => { throw new Error('ETIMEDOUT'); });
            expect(installer.isStataAgentInstalled()).toBe(false);
        });

        it('returns false when spawnSync returns non-zero status', () => {
            jest.spyOn(installer, 'findStataAgentBinary').mockReturnValue('stata-agent');
            jest.spyOn(cp, 'spawnSync').mockReturnValue({ status: 1, stdout: '', stderr: 'command not found' });
            expect(installer.isStataAgentInstalled()).toBe(false);
        });
    });

    // ==================================================================
    // checkAndReport
    // ==================================================================
    describe('checkAndReport', () => {
        it('reports installed when binary is available', async () => {
            jest.spyOn(installer, 'isStataAgentInstalled').mockReturnValue(true);
            jest.spyOn(installer, 'findStataAgentBinary').mockReturnValue('stata-agent');

            const oc = { appendLine: jest.fn() };
            await installer.checkAndReport(oc);
            expect(oc.appendLine).toHaveBeenCalledWith(
                expect.stringContaining('stata-agent is installed')
            );
        });

        it('reports not installed when binary not found', async () => {
            jest.spyOn(installer, 'isStataAgentInstalled').mockReturnValue(false);
            jest.spyOn(installer, 'findStataAgentBinary').mockReturnValue(null);

            const oc = { appendLine: jest.fn() };
            await installer.checkAndReport(oc);
            expect(oc.appendLine).toHaveBeenCalledWith(
                expect.stringContaining('stata-agent is not installed')
            );
        });
    });

    // ==================================================================
    // runInstallInTerminal
    // ==================================================================
    describe('runInstallInTerminal', () => {
        it('creates terminal with name "Install Stata Agent"', () => {
            const oc = { appendLine: jest.fn() };
            installer.runInstallInTerminal(oc);

            expect(mockVscode.window.createTerminal).toHaveBeenCalledWith(
                expect.objectContaining({ name: 'Install Stata Agent' })
            );
        });

        it('sets STATA_AGENT_INSTALL_SOURCE=workbench in terminal env', () => {
            const oc = { appendLine: jest.fn() };
            installer.runInstallInTerminal(oc);

            expect(mockVscode.window.createTerminal).toHaveBeenCalledWith(
                expect.objectContaining({
                    env: { STATA_AGENT_INSTALL_SOURCE: 'workbench' }
                })
            );
        });

        it('sends curl command on Linux/Mac', () => {
            const origPlatform = process.platform;
            Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

            const oc = { appendLine: jest.fn() };
            installer.runInstallInTerminal(oc);

            expect(mockTerminal.sendText).toHaveBeenCalledWith(
                expect.stringContaining('curl -LsSf')
            );
            expect(mockTerminal.sendText).toHaveBeenCalledWith(
                expect.stringContaining('install.sh')
            );
            expect(mockTerminal.show).toHaveBeenCalled();

            Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
        });

        it('sends irm command on Windows', () => {
            const origPlatform = process.platform;
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

            const oc = { appendLine: jest.fn() };
            installer.runInstallInTerminal(oc);

            expect(mockTerminal.sendText).toHaveBeenCalledWith(
                expect.stringContaining('irm ')
            );
            expect(mockTerminal.sendText).toHaveBeenCalledWith(
                expect.stringContaining('install.ps1')
            );
            expect(mockTerminal.sendText).toHaveBeenCalledWith(
                expect.stringContaining('iex')
            );

            Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
        });

        it('logs install log path to output channel', () => {
            const oc = { appendLine: jest.fn() };
            installer.runInstallInTerminal(oc);

            expect(oc.appendLine).toHaveBeenCalledWith(
                expect.stringContaining('Install log:')
            );
        });
    });

    // ==================================================================
    // promptInstall
    // ==================================================================
    describe('promptInstall', () => {
        it('skips prompt if stataAgentInstallDeclined is true in globalState', async () => {
            const context = {
                globalState: {
                    get: jest.fn().mockReturnValue(true),
                    update: jest.fn().mockResolvedValue(),
                },
            };

            await installer.promptInstall(context);
            expect(mockVscode.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it('shows prompt when not declined', async () => {
            const context = {
                globalState: {
                    get: jest.fn().mockReturnValue(false),
                    update: jest.fn().mockResolvedValue(),
                },
            };

            mockVscode.window.showInformationMessage.mockResolvedValue('Install');

            await installer.promptInstall(context);
            expect(mockVscode.window.showInformationMessage).toHaveBeenCalledWith(
                'Stata Agent is not installed. Install now?',
                'Install',
                'Not now'
            );
        });

        it('sets declined flag when user selects "Not now"', async () => {
            const updateSpy = jest.fn().mockResolvedValue();
            const context = {
                globalState: {
                    get: jest.fn().mockReturnValue(false),
                    update: updateSpy,
                },
            };

            mockVscode.window.showInformationMessage.mockResolvedValue('Not now');

            await installer.promptInstall(context);
            expect(updateSpy).toHaveBeenCalledWith('stataAgentInstallDeclined', true);
        });

        it('clears declined flag on resetInstallPrompt command', () => {
            const updateSpy = jest.fn().mockResolvedValue();
            const context = {
                globalState: {
                    get: jest.fn(),
                    update: updateSpy,
                },
            };

            installer.resetInstallPrompt(context);
            expect(updateSpy).toHaveBeenCalledWith('stataAgentInstallDeclined', false);
        });
    });

    // ==================================================================
    // autoInstall
    // ==================================================================
    describe('autoInstall', () => {
        beforeEach(() => {
            jest.restoreAllMocks();
        });

        function mockSpawnProcess({ code = 0, stderr = '' } = {}) {
            const proc = {
                on: jest.fn(),
                kill: jest.fn(),
                stdout: { on: jest.fn() },
                stderr: { on: jest.fn() },
            };
            jest.spyOn(cp, 'spawn').mockReturnValue(proc);

            // Simulate events by wiring the 'data' and 'close' calls
            setTimeout(() => {
                // Trigger stdout data
                const stdoutDataHandler = proc.stdout.on.mock.calls.find(c => c[0] === 'data')?.[1];
                if (stdoutDataHandler) stdoutDataHandler(Buffer.from('install output'));

                // Trigger stderr data (if any)
                if (stderr) {
                    const stderrDataHandler = proc.stderr.on.mock.calls.find(c => c[0] === 'data')?.[1];
                    if (stderrDataHandler) stderrDataHandler(Buffer.from(stderr));
                }

                // Trigger close event
                const closeHandler = proc.on.mock.calls.find(c => c[0] === 'close')?.[1];
                if (closeHandler) closeHandler(code);
            }, 10);

            return proc;
        }

        it('runs curl|bash on Unix when stata-agent not installed', async () => {
            const origPlatform = process.platform;
            Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

            mockSpawnProcess({ code: 0 });

            const result = await installer.autoInstall();

            expect(cp.spawn).toHaveBeenCalledWith(
                '/bin/sh',
                ['-c', expect.stringContaining('curl -LsSf')],
                expect.objectContaining({
                    env: expect.objectContaining({ STATA_AGENT_INSTALL_SOURCE: 'workbench' }),
                })
            );
            expect(result.success).toBe(true);

            Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
        });

        it('runs irm|iex via powershell on Windows', async () => {
            const origPlatform = process.platform;
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

            mockSpawnProcess({ code: 0 });

            const result = await installer.autoInstall();

            expect(cp.spawn).toHaveBeenCalledWith(
                'powershell.exe',
                ['-Command', expect.stringContaining('irm ')],
                expect.any(Object)
            );
            expect(result.success).toBe(true);

            Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
        });

        it('sets STATA_AGENT_INSTALL_SOURCE=workbench in child process env', async () => {
            mockSpawnProcess({ code: 0 });

            await installer.autoInstall();

            expect(cp.spawn).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(Array),
                expect.objectContaining({
                    env: expect.objectContaining({ STATA_AGENT_INSTALL_SOURCE: 'workbench' }),
                })
            );
        });

        it('resolves with success when process exits with code 0', async () => {
            mockSpawnProcess({ code: 0 });

            const result = await installer.autoInstall();

            expect(result.success).toBe(true);
        });

        it('resolves with failure when process exits with non-zero code', async () => {
            mockSpawnProcess({ code: 1, stderr: 'some error occurred' });

            const result = await installer.autoInstall();

            expect(result.success).toBe(false);
            expect(result.reason).toBe('some error occurred');
        });

        it('resolves with failure when process errors', async () => {
            const proc = {
                on: jest.fn(),
                kill: jest.fn(),
                stdout: { on: jest.fn() },
                stderr: { on: jest.fn() },
            };
            jest.spyOn(cp, 'spawn').mockReturnValue(proc);

            setTimeout(() => {
                const errorHandler = proc.on.mock.calls.find(c => c[0] === 'error')?.[1];
                if (errorHandler) errorHandler(new Error('spawn failed'));
            }, 10);

            const result = await installer.autoInstall();

            expect(result.success).toBe(false);
            expect(result.reason).toBe('spawn failed');
        });

        it('kills process and resolves with failure on timeout', async () => {
            jest.useFakeTimers();

            const proc = {
                on: jest.fn(),
                kill: jest.fn(),
                stdout: { on: jest.fn() },
                stderr: { on: jest.fn() },
            };
            jest.spyOn(cp, 'spawn').mockReturnValue(proc);

            // Start autoInstall but don't resolve child events
            const promise = installer.autoInstall();

            // Advance past the 120s timeout
            jest.advanceTimersByTime(120001);
            await promise;

            expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

            const result = await promise;
            expect(result.success).toBe(false);
            expect(result.reason).toBe('Installation timed out');

            jest.useRealTimers();
        });

        it('does not kill process nor resolve timeout when process completes before timeout', async () => {
            const proc = {
                on: jest.fn(),
                kill: jest.fn(),
                stdout: { on: jest.fn() },
                stderr: { on: jest.fn() },
            };
            jest.spyOn(cp, 'spawn').mockReturnValue(proc);

            // Simulate immediate completion
            setTimeout(() => {
                const closeHandler = proc.on.mock.calls.find(c => c[0] === 'close')?.[1];
                if (closeHandler) closeHandler(0);
            }, 5);

            const result = await installer.autoInstall();

            expect(result.success).toBe(true);
            expect(proc.kill).not.toHaveBeenCalled();
        });
    });

});
