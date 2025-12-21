const { assert } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const path = require('path');

describe('extension refreshMcpPackage', () => {
    let spawnSync;
    let extension;
    let vscodeMock;

    beforeEach(() => {
        spawnSync = sinon.stub();
        vscodeMock = buildVscodeMock();

        extension = proxyquire.noCallThru().load('../../src/extension', {
            vscode: vscodeMock,
            './mcp-client': { client: { setLogger: () => { }, onStatusChanged: () => ({ dispose() { } }) } },
            './terminal-panel': { TerminalPanel: { setExtensionUri: () => { }, addEntry: () => { }, show: () => { } } },
            './artifact-utils': { openArtifact: () => { } },
            fs: {
                mkdirSync: sinon.stub(),
                writeFileSync: sinon.stub(),
                existsSync: sinon.stub().returns(false),
                readFileSync: sinon.stub().returns('{}')
            },
            child_process: { spawnSync }
        });
    });

    it('refreshes to latest version when uvx succeeds', () => {
        spawnSync.returns({ status: 0, stdout: '2.0.0\n', stderr: '' });

        const version = extension.refreshMcpPackage();

        assert.equal(version, '2.0.0');
        assert.isTrue(spawnSync.calledOnce, 'spawnSync should be invoked');
        const [cmd, args] = spawnSync.firstCall.args;
        assert.equal(cmd, 'uvx');
        assert.includeMembers(args, ['--refresh', '--from', 'mcp-stata@latest', 'mcp-stata', '--version']);
    });

    it('returns null when uvx fails', () => {
        spawnSync.returns({ status: 1, stdout: '', stderr: 'boom' });

        const version = extension.refreshMcpPackage();

        assert.isNull(version);
        assert.isTrue(spawnSync.calledOnce, 'spawnSync should be invoked');
    });

    it('writeMcpConfig (VS Code host) writes only servers entry, merges env, and removes cursor mcp_stata', () => {
        const writeFileSync = sinon.stub();
        const readFileSync = sinon.stub();
        const existsSync = sinon.stub().returns(true);

        readFileSync.onCall(0).returns(JSON.stringify({
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

        const extensionWithFs = proxyquire.noCallThru().load('../../src/extension', {
            vscode: buildVscodeMock(),
            './mcp-client': { client: { setLogger: () => { }, onStatusChanged: () => ({ dispose() { } }) } },
            './terminal-panel': { TerminalPanel: { setExtensionUri: () => { }, addEntry: () => { }, show: () => { } } },
            './artifact-utils': { openArtifact: () => { } },
            fs: {
                mkdirSync: sinon.stub(),
                writeFileSync,
                existsSync,
                readFileSync
            },
            child_process: { spawnSync: sinon.stub() }
        });

        const { writeMcpConfig } = extensionWithFs;

        writeMcpConfig({
            configPath: '/tmp/user/globalStorage/mcp.json',
            writeVscode: true,
            writeCursor: false
        });

        assert.isTrue(writeFileSync.calledOnce, 'writes once to shared user config');
        const updated = JSON.parse(writeFileSync.firstCall.args[1]);
        const serverEntry = updated.servers.mcp_stata;
        assert.deepEqual(serverEntry.args.slice(0, 3), ['--refresh', '--from', 'mcp-stata@latest']);
        // env merged from both containers
        assert.deepEqual(serverEntry.env, { STATA_LICENSE: 'abc', STATA_HOME: '/opt/stata' });
        assert.equal(serverEntry.note, 'keep-me');
        // other entries untouched
        assert.deepEqual(updated.servers.other_server, {
            type: 'stdio',
            command: 'foo',
            args: ['bar'],
            env: { KEEP: 'me' }
        });
        // cursor mcp_stata removed but other cursor entries kept
        assert.property(updated, 'mcpServers');
        assert.notProperty(updated.mcpServers, 'mcp_stata');
        assert.deepEqual(updated.mcpServers.other_cursor, {
            command: 'baz',
            args: ['qux'],
            env: { ALSO: 'keep' }
        });
    });

    it('writeMcpConfig (Cursor host) writes only mcpServers entry, merges env, and removes VS Code mcp_stata', () => {
        const writeFileSync = sinon.stub();
        const readFileSync = sinon.stub();
        const existsSync = sinon.stub().returns(true);

        readFileSync.onCall(0).returns(JSON.stringify({
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

        const extensionWithFs = proxyquire.noCallThru().load('../../src/extension', {
            vscode: buildVscodeMock(),
            './mcp-client': { client: { setLogger: () => { }, onStatusChanged: () => ({ dispose() { } }) } },
            './terminal-panel': { TerminalPanel: { setExtensionUri: () => { }, addEntry: () => { }, show: () => { } } },
            './artifact-utils': { openArtifact: () => { } },
            fs: {
                mkdirSync: sinon.stub(),
                writeFileSync,
                existsSync,
                readFileSync
            },
            child_process: { spawnSync: sinon.stub() }
        });

        const { writeMcpConfig } = extensionWithFs;

        writeMcpConfig({
            configPath: '/tmp/user/globalStorage/mcp.json',
            writeVscode: false,
            writeCursor: true
        });

        assert.isTrue(writeFileSync.calledOnce, 'writes once to shared user config');
        const updated = JSON.parse(writeFileSync.firstCall.args[1]);
        const cursorEntry = updated.mcpServers.mcp_stata;
        assert.deepEqual(cursorEntry.args.slice(0, 3), ['--refresh', '--from', 'mcp-stata@latest']);
        assert.deepEqual(cursorEntry.env, { STATA_HOME: '/opt/stata', STATA_LICENSE: 'abc' });
        assert.equal(cursorEntry.retry, 3);
        // other cursor entries untouched
        assert.deepEqual(updated.mcpServers.other_cursor, {
            command: 'baz',
            args: ['qux'],
            env: { ALSO: 'keep' }
        });
        // VS Code mcp_stata removed but other servers retained
        assert.property(updated, 'servers');
        assert.notProperty(updated.servers, 'mcp_stata');
        assert.deepEqual(updated.servers.other_server, {
            type: 'stdio',
            command: 'foo',
            args: ['bar'],
            env: { KEEP: 'me' }
        });
    });

    describe('getUvInstallCommand', () => {
        it('returns curl/sh installer on macOS', () => {
            const { getUvInstallCommand } = extension;
            const result = getUvInstallCommand('darwin');
            assert.equal(result.command, 'sh');
            assert.deepEqual(result.args, ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh']);
            assert.include(result.display, 'curl -LsSf https://astral.sh/uv/install.sh | sh');
        });

        it('returns curl/sh installer on Linux', () => {
            const { getUvInstallCommand } = extension;
            const result = getUvInstallCommand('linux');
            assert.equal(result.command, 'sh');
            assert.deepEqual(result.args, ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh']);
            assert.include(result.display, 'curl -LsSf https://astral.sh/uv/install.sh | sh');
        });

        it('returns powershell installer on Windows', () => {
            const { getUvInstallCommand } = extension;
            const result = getUvInstallCommand('win32');
            assert.equal(result.command, 'powershell');
            assert.deepEqual(result.args, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'iwr https://astral.sh/uv/install.ps1 -useb | iex']);
            assert.include(result.display, 'install.ps1');
            assert.include(result.display, 'powershell');
        });
    });

    describe('promptInstallMcpCli', () => {
        it('shows missing CLI prompt only on first invocation', async () => {
            const { promptInstallMcpCli } = extension;
            const globalState = { get: sinon.stub().returns(false), update: sinon.stub().resolves() };
            const context = { globalState };

            await promptInstallMcpCli(context);
            assert.isTrue(vscodeMock.window.showErrorMessage.calledOnce);
            assert.isTrue(globalState.update.calledWithMatch(sinon.match.string, true));

            await promptInstallMcpCli(context);
            assert.isTrue(vscodeMock.window.showErrorMessage.calledOnce, 'should not prompt a second time');
        });

        it('skips prompt when already recorded', async () => {
            const { promptInstallMcpCli } = extension;
            const globalState = { get: sinon.stub().returns(true), update: sinon.stub().resolves() };
            const context = { globalState };

            await promptInstallMcpCli(context);
            assert.isTrue(vscodeMock.window.showErrorMessage.notCalled);
            assert.isTrue(globalState.update.notCalled);
        });
    });

    describe('existing mcp config', () => {
        it('detects existing servers in config files', () => {
            const { hasExistingMcpConfig } = extension;
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().returns(JSON.stringify({
                    servers: { mcp_stata: { command: 'uvx', args: [] } }
                }))
            };

            const extWithFs = proxyquire.noCallThru().load('../../src/extension', {
                vscode: vscodeMock,
                './mcp-client': { client: { setLogger: () => { }, onStatusChanged: () => ({ dispose() { } }) } },
                './terminal-panel': { TerminalPanel: { setExtensionUri: () => { }, addEntry: () => { }, show: () => { } } },
                './artifact-utils': { openArtifact: () => { } },
                fs: fsStub,
                child_process: { spawnSync: sinon.stub() }
            });

            const ctx = { mcpConfigPath: '/tmp/user/mcp.json' };
            assert.isTrue(extWithFs.hasExistingMcpConfig(ctx));
        });

        it('suppresses missing CLI prompt when config already present', async () => {
            const fsStub = {
                mkdirSync: sinon.stub(),
                writeFileSync: sinon.stub(),
                existsSync: sinon.stub().callsFake((p) => p.includes('mcp.json')),
                readFileSync: sinon.stub().returns(JSON.stringify({
                    servers: {
                        mcp_stata: {
                            type: 'stdio',
                            command: 'uvx',
                            args: ['--from', 'mcp-stata@latest', 'mcp-stata']
                        }
                    }
                }))
            };

            const spawnSyncStub = sinon.stub().returns({ status: 1, error: new Error('missing') });

            const extWithFs = proxyquire.noCallThru().load('../../src/extension', {
                vscode: vscodeMock,
                './mcp-client': { client: { setLogger: () => { }, onStatusChanged: () => ({ dispose() { } }) } },
                './terminal-panel': { TerminalPanel: { setExtensionUri: () => { }, addEntry: () => { }, show: () => { } } },
                './artifact-utils': { openArtifact: () => { } },
                fs: fsStub,
                child_process: { spawnSync: spawnSyncStub }
            });

            vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
            const globalState = { get: sinon.stub().returns(false), update: sinon.stub().resolves() };
            const context = {
                subscriptions: [],
                globalState,
                mcpConfigPath: '/tmp/global/mcp.json',
                globalStoragePath: '/tmp/globalStorage',
                extensionUri: {},
                extensionPath: '/workspace'
            };

            await extWithFs.activate(context);

            assert.isTrue(vscodeMock.window.showErrorMessage.notCalled, 'should not prompt when config already present');
            assert.isTrue(globalState.update.calledWithMatch(sinon.match.string, true));
        });

        it('detects cursor-format configs in user storage', () => {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().returns(JSON.stringify({
                    mcpServers: {
                        mcp_stata: {
                            command: 'uvx',
                            args: ['--from', 'mcp-stata@latest', 'mcp-stata']
                        }
                    }
                }))
            };

            const extWithFs = proxyquire.noCallThru().load('../../src/extension', {
                vscode: vscodeMock,
                './mcp-client': { client: { setLogger: () => { }, onStatusChanged: () => ({ dispose() { } }) } },
                './terminal-panel': { TerminalPanel: { setExtensionUri: () => { }, addEntry: () => { }, show: () => { } } },
                './artifact-utils': { openArtifact: () => { } },
                fs: fsStub,
                child_process: { spawnSync: sinon.stub() }
            });

            const ctx = { mcpConfigPath: '/tmp/user/cursor-mcp.json' };
            assert.isTrue(extWithFs.hasExistingMcpConfig(ctx));
        });

        it('resolves VS Code path on windows', () => {
            const originalAppData = process.env.APPDATA;
            delete process.env.APPDATA;
            const extWithFs = proxyquire.noCallThru().load('../../src/extension', {
                vscode: buildVscodeMock(),
                './mcp-client': { client: { setLogger: () => { }, onStatusChanged: () => ({ dispose() { } }) } },
                './terminal-panel': { TerminalPanel: { setExtensionUri: () => { }, addEntry: () => { }, show: () => { } } },
                './artifact-utils': { openArtifact: () => { } },
                fs: {
                    mkdirSync: sinon.stub(),
                    writeFileSync: sinon.stub(),
                    existsSync: sinon.stub().returns(false),
                    readFileSync: sinon.stub().returns('{}')
                },
                child_process: { spawnSync: sinon.stub() }
            });

            const ctx = {
                mcpPlatformOverride: 'win32',
                mcpHomeOverride: 'C:\\Users\\Bob'
            };

            const target = extWithFs.getMcpConfigTarget(ctx);
            const expected = path.join('C:\\Users\\Bob', 'AppData', 'Roaming', 'Code', 'User', 'mcp.json');
            assert.equal(target.configPath, expected);
            assert.isFalse(target.writeCursor);
            if (originalAppData === undefined) {
                delete process.env.APPDATA;
            } else {
                process.env.APPDATA = originalAppData;
            }
        });

        it('resolves Cursor path on windows', () => {
            const cursorMock = buildVscodeMock();
            cursorMock.env.appName = 'Cursor';

            const extWithFs = proxyquire.noCallThru().load('../../src/extension', {
                vscode: cursorMock,
                './mcp-client': { client: { setLogger: () => { }, onStatusChanged: () => ({ dispose() { } }) } },
                './terminal-panel': { TerminalPanel: { setExtensionUri: () => { }, addEntry: () => { }, show: () => { } } },
                './artifact-utils': { openArtifact: () => { } },
                fs: {
                    mkdirSync: sinon.stub(),
                    writeFileSync: sinon.stub(),
                    existsSync: sinon.stub().returns(false),
                    readFileSync: sinon.stub().returns('{}')
                },
                child_process: { spawnSync: sinon.stub() }
            });

            const ctx = {
                mcpPlatformOverride: 'win32',
                mcpHomeOverride: 'C:\\Users\\Bob'
            };

            const target = extWithFs.getMcpConfigTarget(ctx);
            const expected = path.join('C:\\Users\\Bob', '.cursor', 'mcp.json');
            assert.equal(target.configPath, expected);
            assert.isTrue(target.writeCursor);
        });

        it('resolves Windsurf path on linux', () => {
            const extWithFs = proxyquire.noCallThru().load('../../src/extension', {
                vscode: buildVscodeMock(),
                './mcp-client': { client: { setLogger: () => { }, onStatusChanged: () => ({ dispose() { } }) } },
                './terminal-panel': { TerminalPanel: { setExtensionUri: () => { }, addEntry: () => { }, show: () => { } } },
                './artifact-utils': { openArtifact: () => { } },
                fs: {
                    mkdirSync: sinon.stub(),
                    writeFileSync: sinon.stub(),
                    existsSync: sinon.stub().returns(false),
                    readFileSync: sinon.stub().returns('{}')
                },
                child_process: { spawnSync: sinon.stub() }
            });

            const ctx = {
                mcpPlatformOverride: 'linux',
                mcpHomeOverride: '/home/alex',
                mcpAppNameOverride: 'Windsurf'
            };

            const target = extWithFs.getMcpConfigTarget(ctx);
            const expected = path.join('/home/alex', '.codeium', 'mcp_config.json');
            assert.equal(target.configPath, expected);
            assert.isTrue(target.writeCursor);
        });

        it('resolves Antigravity path on windows', () => {
            const extWithFs = proxyquire.noCallThru().load('../../src/extension', {
                vscode: buildVscodeMock(),
                './mcp-client': { client: { setLogger: () => { }, onStatusChanged: () => ({ dispose() { } }) } },
                './terminal-panel': { TerminalPanel: { setExtensionUri: () => { }, addEntry: () => { }, show: () => { } } },
                './artifact-utils': { openArtifact: () => { } },
                fs: {
                    mkdirSync: sinon.stub(),
                    writeFileSync: sinon.stub(),
                    existsSync: sinon.stub().returns(false),
                    readFileSync: sinon.stub().returns('{}')
                },
                child_process: { spawnSync: sinon.stub() }
            });

            const originalAppData = process.env.APPDATA;
            process.env.APPDATA = path.join('C\\Users\\Bob', 'AppData', 'Roaming');

            const ctx = {
                mcpPlatformOverride: 'win32',
                mcpHomeOverride: 'C\\Users\\Bob',
                mcpAppNameOverride: 'Antigravity'
            };

            const target = extWithFs.getMcpConfigTarget(ctx);
            const expected = path.join('C\\Users\\Bob', 'AppData', 'Roaming', 'Antigravity', 'User', 'mcp.json');
            assert.equal(target.configPath, expected);
            assert.isTrue(target.writeCursor);

            process.env.APPDATA = originalAppData;
        });

        it('resolves VS Code Insiders path on linux', () => {
            const extWithFs = proxyquire.noCallThru().load('../../src/extension', {
                vscode: buildVscodeMock(),
                './mcp-client': { client: { setLogger: () => { }, onStatusChanged: () => ({ dispose() { } }) } },
                './terminal-panel': { TerminalPanel: { setExtensionUri: () => { }, addEntry: () => { }, show: () => { } } },
                './artifact-utils': { openArtifact: () => { } },
                fs: {
                    mkdirSync: sinon.stub(),
                    writeFileSync: sinon.stub(),
                    existsSync: sinon.stub().returns(false),
                    readFileSync: sinon.stub().returns('{}')
                },
                child_process: { spawnSync: sinon.stub() }
            });

            const ctx = {
                mcpPlatformOverride: 'linux',
                mcpHomeOverride: '/home/dev',
                mcpAppNameOverride: 'Visual Studio Code - Insiders'
            };

            const target = extWithFs.getMcpConfigTarget(ctx);
            const expected = path.join('/home/dev', '.config', 'Code - Insiders', 'User', 'mcp.json');
            assert.equal(target.configPath, expected);
            assert.isFalse(target.writeCursor);
        });

        it('honors explicit override path and writes both formats', () => {
            const extWithFs = proxyquire.noCallThru().load('../../src/extension', {
                vscode: buildVscodeMock(),
                './mcp-client': { client: { setLogger: () => { }, onStatusChanged: () => ({ dispose() { } }) } },
                './terminal-panel': { TerminalPanel: { setExtensionUri: () => { }, addEntry: () => { }, show: () => { } } },
                './artifact-utils': { openArtifact: () => { } },
                fs: {
                    mkdirSync: sinon.stub(),
                    writeFileSync: sinon.stub(),
                    existsSync: sinon.stub().returns(false),
                    readFileSync: sinon.stub().returns('{}')
                },
                child_process: { spawnSync: sinon.stub() }
            });

            const ctx = { mcpConfigPath: '/tmp/override/mcp.json' };
            const target = extWithFs.getMcpConfigTarget(ctx);
            assert.equal(target.configPath, '/tmp/override/mcp.json');
            assert.isTrue(target.writeCursor);
            assert.isFalse(target.writeVscode);
        });

        it('falls back to home/AppData/Roaming when APPDATA unset', () => {
            const extWithFs = proxyquire.noCallThru().load('../../src/extension', {
                vscode: buildVscodeMock(),
                './mcp-client': { client: { setLogger: () => { }, onStatusChanged: () => ({ dispose() { } }) } },
                './terminal-panel': { TerminalPanel: { setExtensionUri: () => { }, addEntry: () => { }, show: () => { } } },
                './artifact-utils': { openArtifact: () => { } },
                fs: {
                    mkdirSync: sinon.stub(),
                    writeFileSync: sinon.stub(),
                    existsSync: sinon.stub().returns(false),
                    readFileSync: sinon.stub().returns('{}')
                },
                child_process: { spawnSync: sinon.stub() }
            });

            const originalAppData = process.env.APPDATA;
            delete process.env.APPDATA;

            const ctx = {
                mcpPlatformOverride: 'win32',
                mcpHomeOverride: 'C\\Users\\Dana',
                mcpAppNameOverride: 'Visual Studio Code'
            };

            const target = extWithFs.getMcpConfigTarget(ctx);
            const expected = path.join('C\\Users\\Dana', 'AppData', 'Roaming', 'Code', 'User', 'mcp.json');
            assert.equal(target.configPath, expected);
            assert.isFalse(target.writeCursor);

            process.env.APPDATA = originalAppData;
        });

        it('returns null and logs when home cannot be resolved', () => {
            const extWithFs = proxyquire.noCallThru().load('../../src/extension', {
                vscode: buildVscodeMock(),
                './mcp-client': { client: { setLogger: () => { }, onStatusChanged: () => ({ dispose() { } }) } },
                './terminal-panel': { TerminalPanel: { setExtensionUri: () => { }, addEntry: () => { }, show: () => { } } },
                './artifact-utils': { openArtifact: () => { } },
                fs: {
                    mkdirSync: sinon.stub(),
                    writeFileSync: sinon.stub(),
                    existsSync: sinon.stub().returns(false),
                    readFileSync: sinon.stub().returns('{}')
                },
                child_process: { spawnSync: sinon.stub() }
            });

            const target = extWithFs.getMcpConfigTarget({ mcpHomeOverride: null, mcpPlatformOverride: 'linux' });
            assert.isNull(target);
        });

        it('skips write when no targets selected', () => {
            const writeFileSync = sinon.stub();
            const extWithFs = proxyquire.noCallThru().load('../../src/extension', {
                vscode: buildVscodeMock(),
                './mcp-client': { client: { setLogger: () => { }, onStatusChanged: () => ({ dispose() { } }) } },
                './terminal-panel': { TerminalPanel: { setExtensionUri: () => { }, addEntry: () => { }, show: () => { } } },
                './artifact-utils': { openArtifact: () => { } },
                fs: {
                    mkdirSync: sinon.stub(),
                    writeFileSync,
                    existsSync: sinon.stub().returns(false),
                    readFileSync: sinon.stub().returns('{}')
                },
                child_process: { spawnSync: sinon.stub() }
            });

            extWithFs.writeMcpConfig({ configPath: '/tmp/none.json', writeVscode: false, writeCursor: false });
            assert.isTrue(writeFileSync.notCalled);
        });
    });
});

function buildVscodeMock() {
    const noop = () => { };
    const stubbedOutput = { appendLine: sinon.stub(), show: sinon.stub(), clear: sinon.stub() };
    const stubbedStatus = { show: sinon.stub(), hide: sinon.stub(), dispose: sinon.stub() };

    return {
        window: {
            createOutputChannel: () => stubbedOutput,
            createStatusBarItem: () => stubbedStatus,
            showErrorMessage: sinon.stub().resolves(),
            showInformationMessage: sinon.stub().resolves()
        },
        StatusBarAlignment: { Right: 1 },
        ProgressLocation: { Notification: 1 },
        ThemeColor: function () { },
        ExtensionMode: { Test: 2 },
        commands: {
            registerCommand: sinon.stub(),
            getCommands: sinon.stub().resolves([]),
            executeCommand: sinon.stub().resolves()
        },
        workspace: {
            workspaceFolders: [],
            getConfiguration: sinon.stub().returns({ get: sinon.stub().returns('') })
        },
        env: {
            clipboard: { writeText: sinon.stub().resolves() },
            openExternal: sinon.stub(),
            appName: 'Visual Studio Code'
        },
        Uri: {
            parse: sinon.stub().returns({}),
            joinPath: sinon.stub().returns({ fsPath: '' })
        }
    };
}
