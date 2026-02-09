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

    describe('writeMcpConfig', () => {
        itWithHarness('writeMcpConfig (VS Code host) writes only servers entry, merges env, and removes cursor mcp_stata', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                servers: {
                    mcp_stata: {
                        type: 'stdio',
                        command: 'uvx',
                        args: ['--from', 'mcp-stata@latest', 'mcp-stata'],
                        env: { STATA_HOME: '/opt/stata' },
                        note: 'keep-me'
                    },
                    other_server: {
                        type: 'stdio',
                        command: 'foo',
                        args: ['bar'],
                        env: { KEEP: 'me' }
                    }
                },
                mcpServers: {
                    mcp_stata: {
                        command: 'uvx',
                        args: ['--from', 'mcp-stata@latest', 'mcp-stata'],
                        env: { STATA_LICENSE: 'abc' },
                        retry: 3
                    },
                    other_cursor: {
                        command: 'baz',
                        args: ['qux'],
                        env: { ALSO: 'keep' }
                    }
                }
            }));

            extension.writeMcpConfig({
                configPath: '/tmp/test.json',
                writeVscode: true,
                writeCursor: false
            });

            expect(fs.writeFileSync).toHaveBeenCalled();
            const updated = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
            const serverEntry = updated.servers.mcp_stata;
            expect(serverEntry.args).toEqual(['--refresh', '--refresh-package', 'mcp-stata', '--from', 'mcp-stata@latest', 'mcp-stata']);
            expect(serverEntry.env).toEqual({ STATA_LICENSE: 'abc', STATA_HOME: '/opt/stata' });
            expect(serverEntry.note).toEqual('keep-me');
            expect(updated.servers.other_server).toEqual({
                type: 'stdio',
                command: 'foo',
                args: ['bar'],
                env: { KEEP: 'me' }
            });
            expect(updated.mcpServers).toBeDefined();
            expect(updated.mcpServers.mcp_stata).toBeUndefined();
            expect(updated.mcpServers.other_cursor).toEqual({
                command: 'baz',
                args: ['qux'],
                env: { ALSO: 'keep' }
            });
        });

        itWithHarness('writeMcpConfig sets MCP_STATA_NO_RELOAD_ON_CLEAR when enabled', () => {
            const config = vscode.workspace.getConfiguration();
            config.get.mockImplementation((key, def) => {
                if (key === 'noReloadOnClear') return true;
                return def;
            });

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                servers: {
                    mcp_stata: {
                        type: 'stdio',
                        command: 'uvx',
                        args: ['--from', 'mcp-stata@latest', 'mcp-stata'],
                        env: { STATA_HOME: '/opt/stata' }
                    }
                }
            }));

            extension.writeMcpConfig({
                configPath: '/tmp/test.json',
                writeVscode: true,
                writeCursor: false
            });

            const updated = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
            expect(updated.servers.mcp_stata.env).toEqual({
                STATA_HOME: '/opt/stata',
                MCP_STATA_NO_RELOAD_ON_CLEAR: '1'
            });
        });

        itWithHarness('writeMcpConfig removes MCP_STATA_NO_RELOAD_ON_CLEAR when disabled', () => {
            const config = vscode.workspace.getConfiguration();
            config.get.mockImplementation((key, def) => {
                if (key === 'noReloadOnClear') return false;
                return def;
            });

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                servers: {
                    mcp_stata: {
                        type: 'stdio',
                        command: 'uvx',
                        args: ['--from', 'mcp-stata@latest', 'mcp-stata'],
                        env: { MCP_STATA_NO_RELOAD_ON_CLEAR: '1', STATA_HOME: '/opt/stata' }
                    }
                }
            }));

            extension.writeMcpConfig({
                configPath: '/tmp/test.json',
                writeVscode: true,
                writeCursor: false
            });

            const updated = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
            expect(updated.servers.mcp_stata.env).toEqual({ STATA_HOME: '/opt/stata' });
        });

        itWithHarness('writeMcpConfig (Cursor host) writes only mcpServers entry, merges env, and removes VS Code mcp_stata', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                servers: {
                    mcp_stata: {
                        type: 'stdio',
                        command: 'uvx',
                        args: ['--from', 'mcp-stata@latest', 'mcp-stata'],
                        env: { STATA_HOME: '/opt/stata' },
                        note: 'keep-me'
                    },
                    other_server: {
                        type: 'stdio',
                        command: 'foo',
                        args: ['bar'],
                        env: { KEEP: 'me' }
                    }
                },
                mcpServers: {
                    mcp_stata: {
                        command: 'uvx',
                        args: ['--from', 'mcp-stata@latest', 'mcp-stata'],
                        env: { STATA_LICENSE: 'abc' },
                        retry: 3
                    },
                    other_cursor: {
                        command: 'baz',
                        args: ['qux'],
                        env: { ALSO: 'keep' }
                    }
                }
            }));

            extension.writeMcpConfig({
                configPath: '/tmp/test.json',
                writeVscode: false,
                writeCursor: true
            });

            expect(fs.writeFileSync).toHaveBeenCalled();
            const updated = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
            const cursorEntry = updated.mcpServers.mcp_stata;
            expect(cursorEntry.args).toEqual(['--refresh', '--refresh-package', 'mcp-stata', '--from', 'mcp-stata@latest', 'mcp-stata']);
            expect(cursorEntry.env).toEqual({ STATA_HOME: '/opt/stata', STATA_LICENSE: 'abc' });
            expect(cursorEntry.retry).toEqual(3);
            expect(updated.mcpServers.other_cursor).toEqual({
                command: 'baz',
                args: ['qux'],
                env: { ALSO: 'keep' }
            });
            expect(updated.servers).toBeDefined();
            expect(updated.servers.mcp_stata).toBeUndefined();
            expect(updated.servers.other_server).toEqual({
                type: 'stdio',
                command: 'foo',
                args: ['bar'],
                env: { KEEP: 'me' }
            });
        });

        itWithHarness('writeMcpConfig auto-updates old mcp.json formatting to the new uvx command', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                servers: {
                    mcp_stata: {
                        type: 'stdio',
                        command: 'uvx',
                        args: ['--from', 'mcp-stata', 'mcp-stata', '--refresh'],
                        env: { STATA_HOME: '/opt/stata' }
                    }
                }
            }));

            extension.writeMcpConfig({
                configPath: '/tmp/test.json',
                writeVscode: true,
                writeCursor: false
            });

            expect(fs.writeFileSync).toHaveBeenCalled();
            const updated = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
            const serverEntry = updated.servers.mcp_stata;
            
            // Should now have the full expanded argument list including --refresh-package
            expect(serverEntry.args).toEqual([
                '--refresh', 
                '--refresh-package', 
                'mcp-stata', 
                '--from', 
                'mcp-stata@latest', 
                'mcp-stata'
            ]);
            
            // Environment variables should be preserved
            expect(serverEntry.env).toEqual({ STATA_HOME: '/opt/stata' });
        });
    });

    describe('getUvInstallCommand', () => {
        itWithHarness('returns curl/sh installer on macOS', () => {
            const result = extension.getUvInstallCommand('darwin');
            expect(result.command).toEqual('sh');
            expect(result.args).toEqual(['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh']);
            expect(result.display).toContain('curl -LsSf https://astral.sh/uv/install.sh | sh');
        });

        itWithHarness('returns curl/sh installer on Linux', () => {
            const result = extension.getUvInstallCommand('linux');
            expect(result.command).toEqual('sh');
            expect(result.args).toEqual(['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh']);
            expect(result.display).toContain('curl -LsSf https://astral.sh/uv/install.sh | sh');
        });

        itWithHarness('returns powershell installer on Windows', () => {
            const result = extension.getUvInstallCommand('win32');
            expect(result.command).toEqual('powershell');
            expect(result.args).toEqual(['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'iwr https://astral.sh/uv/install.ps1 -useb | iex']);
            expect(result.display).toContain('install.ps1');
            expect(result.display).toContain('powershell');
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

        itWithHarness('detects existing servers in config files', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                servers: { mcp_stata: { command: 'uvx', args: [] } }
            }));

            const ctx = { mcpConfigPath: '/tmp/user/mcp.json' };
            expect(extension.hasExistingMcpConfig(ctx)).toBe(true);
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

        itWithHarness('detects cursor-format configs in user storage', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                mcpServers: {
                    mcp_stata: {
                        command: 'uvx',
                        args: ['--from', 'mcp-stata@latest', 'mcp-stata']
                    }
                }
            }));

            const ctx = { mcpConfigPath: '/tmp/user/cursor-mcp.json' };
            expect(extension.hasExistingMcpConfig(ctx)).toBe(true);
        });

        itWithHarness('resolves VS Code path on windows', ({ env }) => {
            const originalAppData = env.APPDATA;
            delete env.APPDATA;

            const ctx = {
                mcpPlatformOverride: 'win32',
                mcpHomeOverride: 'C:\\Users\\Bob',
                mcpAppNameOverride: 'Visual Studio Code'
            };

            const target = extension.getMcpConfigTarget(ctx);
            const expected = path.join('C:\\Users\\Bob', 'AppData', 'Roaming', 'Code', 'User', 'mcp.json');
            expect(target.configPath).toEqual(expected);
            expect(target.writeCursor).toBe(false);

            env.APPDATA = originalAppData;
        });

        itWithHarness('resolves Cursor path on windows', () => {
            const ctx = {
                mcpPlatformOverride: 'win32',
                mcpHomeOverride: 'C:\\Users\\Bob',
                mcpAppNameOverride: 'Cursor'
            };

            const target = extension.getMcpConfigTarget(ctx);
            const expected = path.join('C:\\Users\\Bob', '.cursor', 'mcp.json');
            expect(target.configPath).toEqual(expected);
            expect(target.writeCursor).toBe(true);
        });

        itWithHarness('resolves Windsurf path on linux', () => {
            const ctx = {
                mcpPlatformOverride: 'linux',
                mcpHomeOverride: '/home/alex',
                mcpAppNameOverride: 'Windsurf'
            };

            const target = extension.getMcpConfigTarget(ctx);
            const expected = path.join('/home/alex', '.codeium', 'windsurf', 'mcp_config.json');
            expect(target.configPath).toEqual(expected);
            expect(target.writeCursor).toBe(true);
        });

        itWithHarness('resolves Windsurf Next path on mac', () => {
            const ctx = {
                mcpPlatformOverride: 'darwin',
                mcpHomeOverride: '/Users/tom',
                mcpAppNameOverride: 'Windsurf Next'
            };

            const target = extension.getMcpConfigTarget(ctx);
            const expected = path.join('/Users/tom', '.codeium', 'windsurf-next', 'mcp_config.json');
            expect(target.configPath).toEqual(expected);
            expect(target.writeCursor).toBe(true);
        });

        itWithHarness('resolves Antigravity path on windows', ({ env }) => {
            const originalAppData = env.APPDATA;
            env.APPDATA = path.join('C:\\Users\\Bob', 'AppData', 'Roaming');

            const ctx = {
                mcpPlatformOverride: 'win32',
                mcpHomeOverride: 'C:\\Users\\Bob',
                mcpAppNameOverride: 'Antigravity'
            };

            const target = extension.getMcpConfigTarget(ctx);
            // In the original test line 503: path.join('C\\Users\\Bob', 'AppData', 'Roaming', 'Antigravity', 'User', 'mcp.json')
            // Wait, Antigravity in getMcpConfigTarget uses resolveHostMcpPath which might be different.
            // Let's check what the code actually does.
            const expected = path.join('C:\\Users\\Bob', 'AppData', 'Roaming', 'Antigravity', 'User', 'mcp.json');
            expect(target.configPath).toEqual(expected);
            expect(target.writeCursor).toBe(true);

            env.APPDATA = originalAppData;
        });

        itWithHarness('resolves VS Code Insiders path on linux', () => {
            const ctx = {
                mcpPlatformOverride: 'linux',
                mcpHomeOverride: '/home/dev',
                mcpAppNameOverride: 'Visual Studio Code - Insiders'
            };

            const target = extension.getMcpConfigTarget(ctx);
            const expected = path.join('/home/dev', '.config', 'Code - Insiders', 'User', 'mcp.json');
            expect(target.configPath).toEqual(expected);
            expect(target.writeCursor).toBe(false);
        });

        itWithHarness('honors explicit override path and writes both formats', () => {
            const ctx = { mcpConfigPath: '/tmp/override/mcp.json' };
            const target = extension.getMcpConfigTarget(ctx);
            expect(target.configPath).toEqual('/tmp/override/mcp.json');
            expect(target.writeCursor).toBe(true);
            expect(target.writeVscode).toBe(false);
        });

        itWithHarness('falls back to home/AppData/Roaming when APPDATA unset', ({ env }) => {
            const originalAppData = env.APPDATA;
            delete env.APPDATA;

            const ctx = {
                mcpPlatformOverride: 'win32',
                mcpHomeOverride: 'C:\\Users\\Dana',
                mcpAppNameOverride: 'Visual Studio Code'
            };

            const target = extension.getMcpConfigTarget(ctx);
            const expected = path.join('C:\\Users\\Dana', 'AppData', 'Roaming', 'Code', 'User', 'mcp.json');
            expect(target.configPath).toEqual(expected);
            expect(target.writeCursor).toBe(false);

            env.APPDATA = originalAppData;
        });

        itWithHarness('returns null and logs when home cannot be resolved', () => {
            const target = extension.getMcpConfigTarget({ mcpHomeOverride: null, mcpPlatformOverride: 'linux' });
            expect(target).toBeNull();
        });

        itWithHarness('skips write when no targets selected', () => {
            fs.writeFileSync.mockClear();
            extension.writeMcpConfig({ configPath: '/tmp/none.json', writeVscode: false, writeCursor: false });
            expect(fs.writeFileSync).not.toHaveBeenCalled();
        });
    });

    describe('getClaudeMcpConfigTarget', () => {
        itWithHarness('resolves user scope Claude config path', () => {
            const ctx = {
                mcpHomeOverride: '/home/alex',
                extensionMode: vscode.ExtensionMode.Test
            };

            const target = extension.getClaudeMcpConfigTarget(ctx, 'user');
            expect(target.configPath).toEqual(path.join('/home/alex', '.claude.json'));
            expect(target.writeCursor).toBe(true);
            expect(target.writeVscode).toBe(false);
        });

        itWithHarness('resolves project scope Claude config path', () => {
            const ctx = {
                mcpWorkspaceOverride: '/workspace',
                extensionMode: vscode.ExtensionMode.Test
            };

            const target = extension.getClaudeMcpConfigTarget(ctx, 'project');
            expect(target.configPath).toEqual(path.join('/workspace', '.mcp.json'));
            expect(target.writeCursor).toBe(true);
            expect(target.writeVscode).toBe(false);
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

        itWithHarness('findUvBinary falls back to bundled binary if system PATH fails', ({ env }) => {
            delete env.MCP_STATA_UVX_CMD;
            spawnSync.mockReturnValue({ status: 1, error: new Error('not found') });
            const bundledPath = path.join('/mock/extension', 'bin', `${process.platform}-${process.arch}`, 'uvx');

            // 1. Mock ALL system path checks fail, but bundled check succeeds
            spawnSync.mockImplementation((cmd) => {
                if (cmd === bundledPath) {
                    return { status: 0, stdout: 'uv 0.5.0', stderr: '' };
                }
                return { status: 1, error: new Error('not found'), stderr: '' };
            });

            // 2. Mock bundled binary is PRESENT
            fs.existsSync.mockImplementation((p) => p === bundledPath);
            
            const api = extension.activate({ 
                extensionUri: { fsPath: '/mock/extension' },
                globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue(true) },
                subscriptions: [],
                extensionMode: 3, // Test
                globalStoragePath: '/tmp/gs'
            });

            const found = api.reDiscoverUv();
            expect(found).toBe(bundledPath);
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

        itWithHarness('isMcpConfigCurrent returns false if command does not match and is not uv-like', () => {
            spawnSync.mockReturnValue({ status: 1, error: new Error('not found') });
            const api = extension.activate({ 
                extensionUri: { fsPath: '/mock/extension' },
                globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue(true) },
                subscriptions: [],
                extensionMode: 3,
                globalStoragePath: '/tmp/gs'
            });
            expect(api.isMcpConfigCurrent({ command: 'python' }, 'uvx')).toBe(false);
        });

        itWithHarness('isMcpConfigCurrent returns true if command is uv-like and args match package', () => {
            spawnSync.mockReturnValue({ status: 1, error: new Error('not found') });
            const api = extension.activate({ 
                extensionUri: { fsPath: '/mock/extension' },
                globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue(true) },
                subscriptions: [],
                extensionMode: 3,
                globalStoragePath: '/tmp/gs'
            });
            const config = { command: 'uvx', args: ['--from', 'mcp-stata@latest', 'mcp-stata'] };
            expect(api.isMcpConfigCurrent(config, 'uvx')).toBe(true);
        });

        itWithHarness('isMcpConfigCurrent returns false if version mismatch', () => {
            spawnSync.mockReturnValue({ status: 1, error: new Error('not found') });
            const api = extension.activate({ 
                extensionUri: { fsPath: '/mock/extension' },
                globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue(true) },
                subscriptions: [],
                extensionMode: 3,
                globalStoragePath: '/tmp/gs'
            });
            const config = { command: 'uvx', args: ['--from', 'mcp-stata==1.0.0', 'mcp-stata'] };
            expect(api.isMcpConfigCurrent(config, 'uvx', '1.1.0')).toBe(false);
        });

        itWithHarness('activate flow: uses existing config if working and current', () => {
            spawnSync.mockReturnValue({ status: 1, error: new Error('not found') });
            mcpClientMock.getServerConfig.mockReturnValue({
                command: 'uvx',
                args: ['--from', 'mcp-stata@latest', 'mcp-stata'],
                configPath: '/mock/mcp.json'
            });
            spawnSync.mockReturnValue({ status: 0, stdout: 'uv 0.5.0' });

            extension.activate({ 
                extensionUri: { fsPath: '/mock/extension' },
                globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue(true) },
                subscriptions: [],
                extensionMode: 3,
                mcpHomeOverride: '/mock/home',
                globalStoragePath: '/tmp/gs'
            });

            // We expect at least one call to check if uvx is functional
            // but we don't expect calls to update config
            expect(fs.writeFileSync).not.toHaveBeenCalled();
        });

        itWithHarness('activate flow: updates config if working but not current (outdated version)', () => {
            spawnSync.mockReturnValue({ status: 1, error: new Error('not found') });
            // Existing config has old version
            const existingConfig = {
                command: 'uvx',
                args: ['--from', 'mcp-stata==1.0.0', 'mcp-stata'],
                configPath: '/mock/mcp.json'
            };
            mcpClientMock.getServerConfig.mockReturnValue(existingConfig);
            
            // Mock spawnSync for ALL calls
            spawnSync.mockImplementation((cmd, args) => {
                // Return '1.2.0' for version checks
                if (args && args.includes('--version')) return { status: 0, stdout: '1.2.0\n' };
                // Return '1.2.0' for python version check too
                if (args && args.includes('importlib.metadata')) return { status: 0, stdout: '1.2.0\n' };
                return { status: 0, stdout: '' };
            });

            // Mock fs calls for writeMcpConfig
            fs.existsSync.mockImplementation((p) => {
                if (p.includes('mcp.json')) return true;
                return false;
            });
            fs.readFileSync.mockImplementation((p) => {
                if (p.includes('mcp.json')) {
                    return JSON.stringify({
                        servers: {
                            mcp_stata: {
                                type: 'stdio',
                                command: 'uvx',
                                args: ['--from', 'mcp-stata==1.0.0', 'mcp-stata']
                            }
                        }
                    });
                }
                return '';
            });

            const context = { 
                extensionUri: { fsPath: '/mock/extension' },
                globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue(true) },
                subscriptions: [],
                extensionMode: 3,
                mcpConfigPath: '/mock/mcp.json',
                globalStoragePath: '/tmp/gs'
            };
            
            extension.activate(context);

            expect(fs.writeFileSync).toHaveBeenCalled();
            const writeCalls = fs.writeFileSync.mock.calls;
            const mcpWrite = writeCalls.find(call => call[0].includes('mcp.json'));
            expect(mcpWrite).toBeDefined();
            expect(mcpWrite[1]).toContain('mcp-stata==1.2.0');
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
});
