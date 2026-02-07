const { describe, it, beforeEach, afterEach, expect, jest } = require('bun:test');
const path = require('path');

const resetModules = () => {
    for (const key of Object.keys(require.cache)) {
        delete require.cache[key];
    }
};

const mockCjsModule = (modulePath, factory) => {
    const resolved = require.resolve(modulePath);
    const existing = require.cache[resolved];
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: factory()
    };
    return () => {
        if (existing) {
            require.cache[resolved] = existing;
        } else {
            delete require.cache[resolved];
        }
    };
};

describe('extension unit tests', () => {
    let extension;
    let vscode;
    let fs;
    let spawnSync;
    let fsOriginals;
    let cpOriginalSpawnSync;
    let restoreModuleMocks = [];
    let mcpClientMock;
    let originalUvCmdEnv;

    const setupMocks = () => {
        resetModules();
        originalUvCmdEnv = process.env.MCP_STATA_UVX_CMD;
        delete process.env.MCP_STATA_UVX_CMD;

        // Stub builtin modules in-place
        fs = require('fs');
        fsOriginals = {
            existsSync: fs.existsSync,
            readFileSync: fs.readFileSync,
            writeFileSync: fs.writeFileSync,
            mkdirSync: fs.mkdirSync
        };
        fs.existsSync = jest.fn();
        fs.readFileSync = jest.fn();
        fs.writeFileSync = jest.fn();
        fs.mkdirSync = jest.fn();

        const cp = require('child_process');
        cpOriginalSpawnSync = cp.spawnSync;
        cp.spawnSync = jest.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
        spawnSync = cp.spawnSync;

        // Mock internal modules to avoid side effects
        mcpClientMock = {
            setLogger: jest.fn(),
            onStatusChanged: jest.fn().mockReturnValue({ dispose: jest.fn() }),
            dispose: jest.fn(),
            connect: jest.fn().mockResolvedValue({}),
            runSelection: jest.fn().mockResolvedValue({}),
            getUiChannel: jest.fn().mockResolvedValue(null),
            hasConfig: jest.fn().mockReturnValue(false),
            getServerConfig: jest.fn().mockReturnValue({ command: null, args: null, env: {}, configPath: null })
        };
        restoreModuleMocks = [];
        restoreModuleMocks.push(mockCjsModule('../../src/mcp-client', () => ({
            StataMcpClient: jest.fn().mockImplementation(() => mcpClientMock),
            client: mcpClientMock
        })));
        restoreModuleMocks.push(mockCjsModule('../../src/terminal-panel', () => ({
            TerminalPanel: {
                setExtensionUri: jest.fn(),
                addEntry: jest.fn(),
                show: jest.fn(),
                setLogProvider: jest.fn(),
                startStreamingEntry: jest.fn().mockReturnValue(null),
                appendStreamingLog: jest.fn(),
                updateStreamingProgress: jest.fn(),
                finishStreamingEntry: jest.fn(),
                failStreamingEntry: jest.fn()
            }
        })));
        restoreModuleMocks.push(mockCjsModule('../../src/data-browser-panel', () => ({
            DataBrowserPanel: { createOrShow: jest.fn(), setLogger: jest.fn(), refresh: jest.fn() }
        })));
        restoreModuleMocks.push(mockCjsModule('../../src/artifact-utils', () => ({
            openArtifact: jest.fn()
        })));
        vscode = require('vscode');

        // Reset the shared configuration mock implementation to defaults for each test
        const config = vscode.workspace.getConfiguration();
        config.get.mockImplementation((key, defaultValue) => {
            if (key === 'requestTimeoutMs') return 1000;
            if (key === 'runFileWorkingDirectory') return '';
            if (key === 'autoRevealOutput') return true;
            if (key === 'autoConfigureMcp') return true;
            return defaultValue;
        });

        extension = require('../../src/extension');
    };

    beforeEach(() => {
        setupMocks();
    });

    afterEach(() => {
        restoreModuleMocks.forEach((restore) => restore());
        restoreModuleMocks = [];
        process.env.MCP_STATA_UVX_CMD = originalUvCmdEnv;
        if (fs && fsOriginals) {
            fs.existsSync = fsOriginals.existsSync;
            fs.readFileSync = fsOriginals.readFileSync;
            fs.writeFileSync = fsOriginals.writeFileSync;
            fs.mkdirSync = fsOriginals.mkdirSync;
        }
        if (cpOriginalSpawnSync) {
            const cp = require('child_process');
            cp.spawnSync = cpOriginalSpawnSync;
        }
        jest.clearAllMocks();
        resetModules();
    });

    describe('output log streaming', () => {
        it('streams raw logs to Output channel when enabled', async () => {
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
        it('refreshes to latest version when uvx succeeds', () => {
            spawnSync.mockReturnValue({ status: 0, stdout: '2.0.0\n', stderr: '' });
            const version = extension.refreshMcpPackage();
            expect(version).toEqual('2.0.0');
            expect(spawnSync).toHaveBeenCalled();
            const [cmd, args] = spawnSync.mock.calls[0];
            expect(cmd).toEqual('uvx');
            expect(args).toContain('--refresh');
            expect(args).toContain('--refresh-package');
            expect(args).toContain('--from');
            expect(args).toContain('mcp-stata@latest');
        });

        it('returns null when uvx fails', () => {
            spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'boom' });
            const version = extension.refreshMcpPackage();
            expect(version).toBeNull();
            expect(spawnSync).toHaveBeenCalled();
        });
    });

    describe('writeMcpConfig', () => {
        it('writeMcpConfig (VS Code host) writes only servers entry, merges env, and removes cursor mcp_stata', () => {
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

        it('writeMcpConfig (Cursor host) writes only mcpServers entry, merges env, and removes VS Code mcp_stata', () => {
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

        it('writeMcpConfig auto-updates old mcp.json formatting to the new uvx command', () => {
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
        it('returns curl/sh installer on macOS', () => {
            const result = extension.getUvInstallCommand('darwin');
            expect(result.command).toEqual('sh');
            expect(result.args).toEqual(['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh']);
            expect(result.display).toContain('curl -LsSf https://astral.sh/uv/install.sh | sh');
        });

        it('returns curl/sh installer on Linux', () => {
            const result = extension.getUvInstallCommand('linux');
            expect(result.command).toEqual('sh');
            expect(result.args).toEqual(['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh']);
            expect(result.display).toContain('curl -LsSf https://astral.sh/uv/install.sh | sh');
        });

        it('returns powershell installer on Windows', () => {
            const result = extension.getUvInstallCommand('win32');
            expect(result.command).toEqual('powershell');
            expect(result.args).toEqual(['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'iwr https://astral.sh/uv/install.ps1 -useb | iex']);
            expect(result.display).toContain('install.ps1');
            expect(result.display).toContain('powershell');
        });
    });

    describe('promptInstallMcpCli', () => {
        it('shows missing CLI prompt only on first invocation', async () => {
            const globalState = { get: jest.fn().mockReturnValue(false), update: jest.fn().mockResolvedValue() };
            const context = { globalState };

            await extension.promptInstallMcpCli(context);
            expect(vscode.window.showErrorMessage).toHaveBeenCalled();
            expect(globalState.update).toHaveBeenCalledWith(expect.any(String), true);

            vscode.window.showErrorMessage.mockClear();
            await extension.promptInstallMcpCli(context);
            expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
        });

        it('skips prompt when already recorded', async () => {
            const globalState = { get: jest.fn().mockReturnValue(true), update: jest.fn().mockResolvedValue() };
            const context = { globalState };

            await extension.promptInstallMcpCli(context);
            expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
            expect(globalState.update).not.toHaveBeenCalled();
        });
    });

    describe('existing mcp config', () => {
        it('respects opt-out setting and skips auto config', async () => {
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

        it('detects existing servers in config files', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                servers: { mcp_stata: { command: 'uvx', args: [] } }
            }));

            const ctx = { mcpConfigPath: '/tmp/user/mcp.json' };
            expect(extension.hasExistingMcpConfig(ctx)).toBe(true);
        });

        it('suppresses missing CLI prompt when config already present', async () => {
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

        it('detects cursor-format configs in user storage', () => {
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

        it('resolves VS Code path on windows', () => {
            const originalAppData = process.env.APPDATA;
            delete process.env.APPDATA;

            const ctx = {
                mcpPlatformOverride: 'win32',
                mcpHomeOverride: 'C:\\Users\\Bob',
                mcpAppNameOverride: 'Visual Studio Code'
            };

            const target = extension.getMcpConfigTarget(ctx);
            const expected = path.join('C:\\Users\\Bob', 'AppData', 'Roaming', 'Code', 'User', 'mcp.json');
            expect(target.configPath).toEqual(expected);
            expect(target.writeCursor).toBe(false);

            process.env.APPDATA = originalAppData;
        });

        it('resolves Cursor path on windows', () => {
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

        it('resolves Windsurf path on linux', () => {
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

        it('resolves Windsurf Next path on mac', () => {
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

        it('resolves Antigravity path on windows', () => {
            const originalAppData = process.env.APPDATA;
            process.env.APPDATA = path.join('C:\\Users\\Bob', 'AppData', 'Roaming');

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

            process.env.APPDATA = originalAppData;
        });

        it('resolves VS Code Insiders path on linux', () => {
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

        it('honors explicit override path and writes both formats', () => {
            const ctx = { mcpConfigPath: '/tmp/override/mcp.json' };
            const target = extension.getMcpConfigTarget(ctx);
            expect(target.configPath).toEqual('/tmp/override/mcp.json');
            expect(target.writeCursor).toBe(true);
            expect(target.writeVscode).toBe(false);
        });

        it('falls back to home/AppData/Roaming when APPDATA unset', () => {
            const originalAppData = process.env.APPDATA;
            delete process.env.APPDATA;

            const ctx = {
                mcpPlatformOverride: 'win32',
                mcpHomeOverride: 'C:\\Users\\Dana',
                mcpAppNameOverride: 'Visual Studio Code'
            };

            const target = extension.getMcpConfigTarget(ctx);
            const expected = path.join('C:\\Users\\Dana', 'AppData', 'Roaming', 'Code', 'User', 'mcp.json');
            expect(target.configPath).toEqual(expected);
            expect(target.writeCursor).toBe(false);

            process.env.APPDATA = originalAppData;
        });

        it('returns null and logs when home cannot be resolved', () => {
            const target = extension.getMcpConfigTarget({ mcpHomeOverride: null, mcpPlatformOverride: 'linux' });
            expect(target).toBeNull();
        });

        it('skips write when no targets selected', () => {
            fs.writeFileSync.mockClear();
            extension.writeMcpConfig({ configPath: '/tmp/none.json', writeVscode: false, writeCursor: false });
            expect(fs.writeFileSync).not.toHaveBeenCalled();
        });
    });

    describe('getClaudeMcpConfigTarget', () => {
        it('resolves user scope Claude config path', () => {
            const ctx = {
                mcpHomeOverride: '/home/alex',
                extensionMode: vscode.ExtensionMode.Test
            };

            const target = extension.getClaudeMcpConfigTarget(ctx, 'user');
            expect(target.configPath).toEqual(path.join('/home/alex', '.claude.json'));
            expect(target.writeCursor).toBe(true);
            expect(target.writeVscode).toBe(false);
        });

        it('resolves project scope Claude config path', () => {
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
        beforeEach(() => {
            // Note: setupMocks is already called in the top-level beforeEach
            // But we want to ensure spawnSync fails by default for these tests
            spawnSync.mockReturnValue({ status: 1, error: new Error('not found') });
        });

        it('findUvBinary prioritizes system PATH over bundled binary', () => {
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

        it('findUvBinary falls back to bundled binary if system PATH fails', () => {
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

        it('isMcpConfigWorking returns true for functional commands', () => {
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

        it('isMcpConfigWorking returns false for broken commands', () => {
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

        it('isMcpConfigCurrent returns false if command does not match and is not uv-like', () => {
            const api = extension.activate({ 
                extensionUri: { fsPath: '/mock/extension' },
                globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue(true) },
                subscriptions: [],
                extensionMode: 3,
                globalStoragePath: '/tmp/gs'
            });
            expect(api.isMcpConfigCurrent({ command: 'python' }, 'uvx')).toBe(false);
        });

        it('isMcpConfigCurrent returns true if command is uv-like and args match package', () => {
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

        it('isMcpConfigCurrent returns false if version mismatch', () => {
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

        it('activate flow: uses existing config if working and current', () => {
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

        it('activate flow: updates config if working but not current (outdated version)', () => {
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
        it('calls connect() on activation when loadStataOnStartup is true', async () => {
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

        it('does NOT call connect() on activation when loadStataOnStartup is false', async () => {
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
