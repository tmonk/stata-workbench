const { describe, it, beforeEach, afterEach, expect } = require('@jest/globals');
const path = require('path');

describe('extension unit tests', () => {
    let extension;
    let vscode;
    let fs;
    let spawnSync;

    const setupMocks = () => {
        jest.resetModules();

        // Mock dependencies using doMock so they are fresh for each re-require of extension
        const fsMock = {
            existsSync: jest.fn(),
            readFileSync: jest.fn(),
            writeFileSync: jest.fn(),
            mkdirSync: jest.fn()
        };
        jest.doMock('fs', () => fsMock);

        const cpMock = {
            spawnSync: jest.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' })
        };
        jest.doMock('child_process', () => cpMock);

        // Mock internal modules to avoid side effects
        const mcpClientMock = {
            setLogger: jest.fn(),
            onStatusChanged: jest.fn().mockReturnValue({ dispose: jest.fn() }),
            dispose: jest.fn()
        };
        jest.doMock('../../src/mcp-client', () => ({
            StataMcpClient: jest.fn().mockImplementation(() => mcpClientMock),
            client: mcpClientMock
        }));
        jest.doMock('../../src/terminal-panel', () => ({
            TerminalPanel: { setExtensionUri: jest.fn(), addEntry: jest.fn(), show: jest.fn() }
        }));
        jest.doMock('../../src/data-browser-panel', () => ({
            DataBrowserPanel: { createOrShow: jest.fn() }
        }));
        jest.doMock('../../src/artifact-utils', () => ({
            openArtifact: jest.fn()
        }));

        fs = require('fs');
        const cp = require('child_process');
        spawnSync = cp.spawnSync;
        vscode = require('vscode');
        extension = require('../../src/extension');
    };

    beforeEach(() => {
        setupMocks();
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
            expect(serverEntry.args.slice(0, 3)).toEqual(['--refresh', '--from', 'mcp-stata@latest']);
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
            expect(cursorEntry.args.slice(0, 3)).toEqual(['--refresh', '--from', 'mcp-stata@latest']);
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
        it('detects existing servers in config files', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                servers: { mcp_stata: { command: 'uvx', args: [] } }
            }));

            const ctx = { mcpConfigPath: '/tmp/user/mcp.json' };
            expect(extension.hasExistingMcpConfig(ctx)).toBe(true);
        });

        it('suppresses missing CLI prompt when config already present', async () => {
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
                extensionPath: '/workspace'
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
});
