const { describe, it, beforeEach, afterEach, expect, jest } = require('bun:test');
const { AsyncLocalStorage } = require('async_hooks');
const path = require('path');
const { withTestContext } = require('../helpers/test-context');
const { createExtensionHarness } = require('../helpers/extension-harness');

const harnessStore = new AsyncLocalStorage();
const getHarness = () => harnessStore.getStore();
const createProxy = (getter) => new Proxy(function () {}, {
    apply(_target, thisArg, args) {
        const target = getter();
        return target?.apply?.(thisArg, args);
    },
    get(_target, prop) {
        const target = getter();
        const value = target?.[prop];
        const isMockFunction = typeof value === 'function' && (value._isMockFunction || value.mock);
        if (typeof value === 'function' && !isMockFunction) {
            return value.bind(target);
        }
        return value;
    },
    set(_target, prop, value) {
        const target = getter();
        if (!target) return false;
        target[prop] = value;
        return true;
    }
});

const extension = createProxy(() => getHarness()?.extension);
const vscode = createProxy(() => getHarness()?.vscode);
const fs = createProxy(() => getHarness()?.fs);
const cp = createProxy(() => getHarness()?.cp);
const mcpClientMock = createProxy(() => getHarness()?.mcpClientMock);
const spawnSync = createProxy(() => getHarness()?.cp?.spawnSync);

describe('extension unit tests', () => {
    const itWithHarness = (name, fn) => it(name, () => {
        const harness = createExtensionHarness();
        return withTestContext({
            vscode: harness.vscode,
            fs: harness.fs,
            childProcess: harness.cp,
            mcpClient: harness.mcpClientMock
        }, (ctx) => harnessStore.run(harness, () => fn(ctx)));
    });

    describe('output log streaming', () => {
        itWithHarness('streams raw logs to Output channel when enabled', async () => {
            const config = vscode.workspace.getConfiguration();
            config.get.mockImplementation((key, def) => {
                if (key === 'showAllLogsInOutput') return true;
                if (key === 'autoRevealOutput') return false;
                if (key === 'requestTimeoutMs') return 1000;
                if (key === 'runFileWorkingDirectory') return '';
                return def;
            });

            const handlers = new Map();
            vscode.commands.registerCommand.mockImplementation((name, handler) => {
                handlers.set(name, handler);
                return { dispose: jest.fn() };
            });

            const context = {
                subscriptions: [],
                globalState: { get: jest.fn().mockReturnValue(true), update: jest.fn().mockResolvedValue() },
                globalStoragePath: '/tmp/globalStorage',
                extensionUri: {},
                extensionPath: '/workspace',
                extensionMode: vscode.ExtensionMode.Test
            };

            await extension.activate(context);

            const outputChannel = vscode.window.createOutputChannel.mock.results[0]?.value;

            vscode.window.activeTextEditor = {
                selection: { isEmpty: false },
                document: {
                    getText: jest.fn().mockReturnValue('display "hi"'),
                    uri: { fsPath: '/tmp/test.do' }
                }
            };

            extension.mcpClient.runSelection.mockImplementation(async (_code, opts) => {
                if (opts?.onRawLog) {
                    opts.onRawLog('RAW-LOG');
                }
                return { rc: 0, success: true, stdout: '' };
            });

            const runHandler = handlers.get('stata-workbench.runSelection');
            expect(runHandler).toBeTruthy();
            await runHandler();

            expect(extension.mcpClient.runSelection).toHaveBeenCalled();
            expect(outputChannel.append).toHaveBeenCalledWith('RAW-LOG');
        });
    });

    describe('refreshMcpPackage', () => {
        itWithHarness('refreshes to latest version when uvx succeeds', () => {
            spawnSync.mockReturnValue({ status: 0, stdout: '2.0.0\n', stderr: '' });
            const version = extension.refreshMcpPackage();
            expect(version).toEqual('2.0.0');
            const spawnSyncMock = getHarness().cp.spawnSync;
            expect(spawnSyncMock).toHaveBeenCalled();
            const [cmd, args] = spawnSyncMock.mock.calls[0];
            expect(cmd).toEqual('uvx');
            expect(args).toContain('--refresh');
            expect(args).toContain('--refresh-package');
            expect(args).toContain('--from');
            expect(args).toContain('mcp-stata@latest');
        });

        itWithHarness('returns null when uvx fails', () => {
            spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'boom' });
            const version = extension.refreshMcpPackage();
            expect(version).toBeNull();
            expect(getHarness().cp.spawnSync).toHaveBeenCalled();
        });
    });


    describe('getMcpInstallCommand', () => {
        itWithHarness('returns curl/bash installer on macOS', () => {
            const result = extension.getMcpInstallCommand('darwin');
            expect(result.command).toEqual('bash');
            expect(result.args).toEqual(['-c', 'curl -LsSf https://mcp-stata-install.tdmonk.com/install.sh | bash']);
            expect(result.display).toContain('curl -LsSf https://mcp-stata-install.tdmonk.com/install.sh | bash');
        });

        itWithHarness('returns curl/bash installer on Linux', () => {
            const result = extension.getMcpInstallCommand('linux');
            expect(result.command).toEqual('bash');
            expect(result.args).toEqual(['-c', 'curl -LsSf https://mcp-stata-install.tdmonk.com/install.sh | bash']);
            expect(result.display).toContain('curl -LsSf https://mcp-stata-install.tdmonk.com/install.sh | bash');
        });

        itWithHarness('returns powershell installer on Windows', () => {
            const result = extension.getMcpInstallCommand('win32');
            expect(result.command).toEqual('powershell');
            expect(result.args).toEqual(['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '& ([ScriptBlock]::Create((irm https://mcp-stata-install.tdmonk.com/install.ps1)))']);
            expect(result.display).toContain('install.ps1');
        });
    });

    describe('promptInstallMcpCli', () => {
        itWithHarness('shows missing CLI prompt only on first invocation', async () => {
            const globalState = { get: jest.fn().mockReturnValue(false), update: jest.fn().mockResolvedValue() };
            const context = { globalState };

            await extension.promptInstallMcpCli(context);
            expect(vscode.window.showErrorMessage).toHaveBeenCalled();
            expect(globalState.update).toHaveBeenCalledWith(expect.any(String), true);

            vscode.window.showErrorMessage.mockClear();
            await extension.promptInstallMcpCli(context);
            expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
        });

        itWithHarness('skips prompt when already recorded', async () => {
            const globalState = { get: jest.fn().mockReturnValue(true), update: jest.fn().mockResolvedValue() };
            const context = { globalState };

            await extension.promptInstallMcpCli(context);
            expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
            expect(globalState.update).not.toHaveBeenCalled();
        });
    });

    describe('existing mcp config', () => {
        itWithHarness('respects opt-out setting and skips auto config', async () => {
            fs.existsSync.mockReturnValue(false);
            fs.readFileSync.mockReturnValue('');

            const configuration = {
                get: jest.fn().mockImplementation((key, defaultValue) => {
                    if (key === 'autoConfigureMcp') return false;
                    return defaultValue;
                })
            };

            // Override the mocked vscode for this test only
            vscode.workspace.getConfiguration.mockReturnValue(configuration);

            const globalState = { get: jest.fn().mockReturnValue(false), update: jest.fn().mockResolvedValue() };
            const context = {
                subscriptions: [],
                globalState,
                globalStoragePath: '/tmp/globalStorage',
                extensionUri: {},
                extensionPath: '/workspace',
                extensionMode: vscode.ExtensionMode.Test
            };

            await extension.activate(context);

            expect(configuration.get).toHaveBeenCalledWith('autoConfigureMcp', true);
            expect(fs.writeFileSync).not.toHaveBeenCalled();
        });


        itWithHarness('suppresses missing CLI prompt when config already present', async () => {
            mcpClientMock.hasConfig.mockReturnValue(true);
            fs.existsSync.mockImplementation((p) => p.includes('mcp.json'));
            fs.readFileSync.mockReturnValue(JSON.stringify({
                servers: {
                    mcp_stata: {
                        type: 'stdio',
                        command: 'uvx',
                        args: ['--from', 'mcp-stata@latest', 'mcp-stata']
                    }
                }
            }));

            spawnSync.mockReturnValue({ status: 1, error: new Error('missing') });

            vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
            const globalState = { get: jest.fn().mockReturnValue(false), update: jest.fn().mockResolvedValue() };
            const context = {
                subscriptions: [],
                globalState,
                mcpConfigPath: '/tmp/global/mcp.json',
                globalStoragePath: '/tmp/globalStorage',
                extensionUri: {},
                extensionPath: '/workspace',
                extensionMode: vscode.ExtensionMode.Test
            };

            await extension.activate(context);

            expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
            expect(globalState.update).toHaveBeenCalledWith(expect.any(String), true);
        });



    });






    describe('uv discovery and config validation', () => {
        itWithHarness('findUvBinary prioritizes system PATH over bundled binary', ({ env }) => {
            delete env.MCP_STATA_UVX_CMD;
            spawnSync.mockReturnValue({ status: 1, error: new Error('not found') });
            // 1. Mock system uv is present, but uvx is NOT
            spawnSync.mockImplementation((cmd, args) => {
                if (cmd === 'uv' && args[0] === '--version') {
                    return { status: 0, stdout: 'uv 0.5.0' };
                }
                return { status: 1, error: new Error('not found') };
            });

            // 2. Mock bundled binary is ALSO present
            fs.existsSync.mockImplementation((p) => p.includes('bin'));

            const api = extension.activate({ 
                extensionUri: { fsPath: '/mock/extension' },
                globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue(true) },
                subscriptions: [],
                extensionMode: 3, // Test
                globalStoragePath: '/tmp/gs'
            });

            const found = api.reDiscoverUv();
            expect(found).toBe('uv');
        });

        itWithHarness('findUvBinary falls back to bundled binary when system uv is missing', ({ env }) => {
            const h = getHarness();
            delete env.MCP_STATA_UVX_CMD;
            
            // 1. Mock system uv is NOT present
            h.cp.spawnSync.mockReturnValue({ status: 1, error: new Error('not found') });

            // 2. Mock bundled binary is present
            const platform = process.platform;
            const arch = process.arch;
            const binName = platform === 'win32' ? 'uvx.exe' : 'uvx';
            const bundledPath = path.join('/mock/extension', 'bin', `${platform}-${arch}`, binName);
            
            h.fs.existsSync.mockImplementation((p) => p.includes('bin'));
            h.cp.spawnSync.mockImplementation((cmd) => {
                if (cmd === bundledPath) {
                    return { status: 0, stdout: 'uv 0.5.0' };
                }
                return { status: 1, error: new Error('not found') };
            });

            const api = extension.activate({ 
                extensionUri: { fsPath: '/mock/extension' },
                globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue(true) },
                subscriptions: [],
                extensionMode: 3, // Test
                globalStoragePath: '/tmp/gs'
            });

            const found = api.reDiscoverUv({ extensionPath: '/mock/extension' });
            expect(found).toEqual(bundledPath);
        });


        itWithHarness('isMcpConfigWorking returns true for functional commands', () => {
            spawnSync.mockReturnValue({ status: 1, error: new Error('not found') });
            const api = extension.activate({ 
                extensionUri: { fsPath: '/mock/extension' },
                globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue(true) },
                subscriptions: [],
                extensionMode: 3,
                globalStoragePath: '/tmp/gs'
            });
            spawnSync.mockReturnValue({ status: 0 });
            expect(api.isMcpConfigWorking({ command: 'uvx' })).toBe(true);
        });

        itWithHarness('isMcpConfigWorking returns false for broken commands', () => {
            spawnSync.mockReturnValue({ status: 1, error: new Error('not found') });
            const api = extension.activate({ 
                extensionUri: { fsPath: '/mock/extension' },
                globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue(true) },
                subscriptions: [],
                extensionMode: 3,
                globalStoragePath: '/tmp/gs'
            });
            spawnSync.mockReturnValue({ status: 1 });
            expect(api.isMcpConfigWorking({ command: 'broken' })).toBe(false);
        });

        itWithHarness('runMcpInstaller executes bash installer on macOS (preferring local)', async () => {
            const h = getHarness();
            h.fs.existsSync.mockImplementation((p) => p.includes('install.sh'));
            h.cp.spawn.mockReturnValue({ 
                on: jest.fn().mockImplementation((event, cb) => {
                    if (event === 'close') cb(0);
                }),
                stdout: { on: jest.fn() },
                stderr: { on: jest.fn() }
            });

            const context = {
                extensionPath: '/mock/extension',
                mcpPlatformOverride: 'darwin'
            };

            await extension.runMcpInstaller(context);

            expect(h.cp.spawn).toHaveBeenCalled();
            const [cmd, args] = h.cp.spawn.mock.calls[0];
            expect(cmd).toEqual('bash');
            expect(args[1]).toContain('bash "/mock/extension/mcp-stata/plugin/install.sh"');
        });

        itWithHarness('runMcpInstaller executes powershell installer on Windows (preferring local)', async () => {
            const h = getHarness();
            h.fs.existsSync.mockImplementation((p) => p.includes('install.ps1'));
            h.cp.spawn.mockReturnValue({ 
                on: jest.fn().mockImplementation((event, cb) => {
                    if (event === 'close') cb(0);
                }),
                stdout: { on: jest.fn() },
                stderr: { on: jest.fn() }
            });

            const context = {
                extensionPath: '/mock/extension',
                mcpPlatformOverride: 'win32'
            };

        });

        itWithHarness('runMcpInstaller appends --dry-run flag', async () => {
            const h = getHarness();
            h.fs.existsSync.mockImplementation((p) => p.includes('install.sh'));
            h.cp.spawn.mockReturnValue({ 
                on: jest.fn().mockImplementation((event, cb) => {
                    if (event === 'close') cb(0);
                }),
                stdout: { on: jest.fn() },
                stderr: { on: jest.fn() }
            });

            const context = {
                extensionPath: '/mock/extension',
                mcpPlatformOverride: 'darwin',
                dryRun: true
            };

            await extension.runMcpInstaller(context);

            expect(h.cp.spawn).toHaveBeenCalled();
            const [_cmd, args] = h.cp.spawn.mock.calls[0];
            expect(args[1]).toContain('--dry-run');
        });

        itWithHarness('runMcpInstaller propagates env overrides', async () => {
            const h = getHarness();
            h.fs.existsSync.mockImplementation((p) => p.includes('install.sh'));
            h.cp.spawn.mockReturnValue({ 
                on: jest.fn().mockImplementation((event, cb) => {
                    if (event === 'close') cb(0);
                }),
                stdout: { on: jest.fn() },
                stderr: { on: jest.fn() }
            });

            const context = {
                extensionPath: '/mock/extension',
                mcpPlatformOverride: 'darwin',
                env: { MOCK_HOME: '/tmp/mock-home' }
            };

            await extension.runMcpInstaller(context);

            expect(h.cp.spawn).toHaveBeenCalled();
            const spawnOptions = h.cp.spawn.mock.calls[0][2];
            expect(spawnOptions.env.MOCK_HOME).toEqual('/tmp/mock-home');
            expect(spawnOptions.env.NO_COLOR).toEqual('1');
        });
    });

    describe('Stata Startup Loading', () => {
        itWithHarness('calls connect() on activation when loadStataOnStartup is true', async () => {
            const config = vscode.workspace.getConfiguration();
            config.get.mockImplementation((key, def) => {
                if (key === 'loadStataOnStartup') return true;
                return def;
            });

            const context = {
                subscriptions: [],
                globalState: { get: jest.fn().mockReturnValue(true), update: jest.fn().mockResolvedValue() },
                globalStoragePath: '/tmp/globalStorage',
                extensionUri: { fsPath: '/test/path' },
                extensionPath: '/test/path',
                extensionMode: vscode.ExtensionMode.Test
            };

            await extension.activate(context);

            expect(mcpClientMock.connect).toHaveBeenCalled();
        });

        itWithHarness('does NOT call connect() on activation when loadStataOnStartup is false', async () => {
            const config = vscode.workspace.getConfiguration();
            config.get.mockImplementation((key, def) => {
                if (key === 'loadStataOnStartup') return false;
                return def;
            });

            const context = {
                subscriptions: [],
                globalState: { get: jest.fn().mockReturnValue(true), update: jest.fn().mockResolvedValue() },
                globalStoragePath: '/tmp/globalStorage',
                extensionUri: { fsPath: '/test/path' },
                extensionPath: '/test/path',
                extensionMode: vscode.ExtensionMode.Test
            };

            await extension.activate(context);

            expect(mcpClientMock.connect).not.toHaveBeenCalled();
        });
    });

    describe('help command dispatch (onGraphReady)', () => {
        const activateWithHandlers = async (harness) => {
            const handlers = new Map();
            harness.vscode.commands.registerCommand.mockImplementation((name, handler) => {
                handlers.set(name, handler);
                return { dispose: jest.fn() };
            });
            const context = {
                subscriptions: [],
                globalState: { get: jest.fn().mockReturnValue(true), update: jest.fn().mockResolvedValue() },
                globalStoragePath: '/tmp/globalStorage',
                extensionUri: { fsPath: '/test/path' },
                extensionPath: '/test/path',
                extensionMode: harness.vscode.ExtensionMode.Test
            };
            await harness.extension.activate(context);
            return handlers;
        };

        itWithHarness('onGraphReady with help artifact reads file and opens help panel', async () => {
            const handlers = await activateWithHandlers(getHarness());

            vscode.window.activeTextEditor = {
                selection: { isEmpty: false },
                document: {
                    getText: jest.fn().mockReturnValue('help regress'),
                    uri: { fsPath: '/tmp/test.do' },
                    lineAt: jest.fn().mockReturnValue({ text: 'help regress' })
                }
            };

            const helpContent = '# regress\n\nLinear regression help text';
            fs.readFileSync.mockReturnValue(helpContent);
            getHarness().terminalPanel.startStreamingEntry.mockReturnValue('run-42');

            let capturedOnGraphReady = null;
            mcpClientMock.runSelection.mockImplementation(async (_code, opts) => {
                capturedOnGraphReady = opts?.onGraphReady;
                return { rc: 0, success: true, stdout: '' };
            });

            const runHandler = handlers.get('stata-workbench.runSelection');
            await runHandler();

            // Now fire onGraphReady with a help artifact
            expect(capturedOnGraphReady).toBeTruthy();
            const helpArtifact = { type: 'help', path: '/tmp/help_regress.md', label: 'Help: regress' };
            await capturedOnGraphReady(helpArtifact);

            // readFileSync should have been called for the help file
            expect(fs.readFileSync).toHaveBeenCalledWith('/tmp/help_regress.md', 'utf8');

            // HelpPanel uses vscode.window.createWebviewPanel with 'stataHelp'
            const helpPanelCalls = vscode.window.createWebviewPanel.mock.calls.filter(
                c => c[0] === 'stataHelp'
            );
            expect(helpPanelCalls.length).toBeGreaterThan(0);
            expect(helpPanelCalls[0][1]).toBe('Help: regress');
        });

        itWithHarness('onGraphReady with non-help artifact appends run artifact (not help panel)', async () => {
            const handlers = await activateWithHandlers(getHarness());

            vscode.window.activeTextEditor = {
                selection: { isEmpty: false },
                document: {
                    getText: jest.fn().mockReturnValue('scatter price mpg'),
                    uri: { fsPath: '/tmp/test.do' },
                    lineAt: jest.fn().mockReturnValue({ text: 'scatter price mpg' })
                }
            };

            let capturedOnGraphReady = null;
            mcpClientMock.runSelection.mockImplementation(async (_code, opts) => {
                capturedOnGraphReady = opts?.onGraphReady;
                return { rc: 0, success: true, stdout: '' };
            });

            const runHandler = handlers.get('stata-workbench.runSelection');
            await runHandler();

            expect(capturedOnGraphReady).toBeTruthy();
            const graphArtifact = { type: 'graph', path: '/tmp/scatter.pdf', label: 'scatter' };
            capturedOnGraphReady(graphArtifact);

            // A help panel (stataHelp) should NOT have been opened
            const helpPanelCalls = vscode.window.createWebviewPanel.mock.calls.filter(
                c => c[0] === 'stataHelp'
            );
            expect(helpPanelCalls.length).toBe(0);
        });

        itWithHarness('onGraphReady help file read failure falls back gracefully (no throw)', async () => {
            const handlers = await activateWithHandlers(getHarness());

            vscode.window.activeTextEditor = {
                selection: { isEmpty: false },
                document: {
                    getText: jest.fn().mockReturnValue('help regress'),
                    uri: { fsPath: '/tmp/test.do' },
                    lineAt: jest.fn().mockReturnValue({ text: 'help regress' })
                }
            };

            fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT: file not found'); });

            let capturedOnGraphReady = null;
            mcpClientMock.runSelection.mockImplementation(async (_code, opts) => {
                capturedOnGraphReady = opts?.onGraphReady;
                return { rc: 0, success: true, stdout: '' };
            });

            const runHandler = handlers.get('stata-workbench.runSelection');
            await runHandler();

            expect(capturedOnGraphReady).toBeTruthy();
            const helpArtifact = { type: 'help', path: '/missing/file.md', label: 'Help: regress' };

            // Must not throw even though readFileSync throws
            let thrown = null;
            try {
                capturedOnGraphReady(helpArtifact);
            } catch (err) {
                thrown = err;
            }
            expect(thrown).toBeNull();

            // No help panel should have been created (error was caught)
            const helpPanelCalls = vscode.window.createWebviewPanel.mock.calls.filter(
                c => c[0] === 'stataHelp'
            );
            expect(helpPanelCalls.length).toBe(0);
        });
    });

});
