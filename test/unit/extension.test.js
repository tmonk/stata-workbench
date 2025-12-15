const { assert } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

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

    it('writeMcpConfig updates VS Code and Cursor configs with --refresh', () => {
        const writeFileSync = sinon.stub();
        const readFileSync = sinon.stub();
        const existsSync = sinon.stub().returns(true);

        // First call (VS Code format) returns servers shape without --refresh
        readFileSync.onCall(0).returns(JSON.stringify({
            servers: {
                mcp_stata: {
                    type: 'stdio',
                    command: 'uvx',
                    args: ['--from', 'mcp-stata@latest', 'mcp-stata']
                }
            }
        }));

        // Second call (Cursor format) returns mcpServers shape without --refresh
        readFileSync.onCall(1).returns(JSON.stringify({
            mcpServers: {
                mcp_stata: {
                    command: 'uvx',
                    args: ['--from', 'mcp-stata@latest', 'mcp-stata']
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

        // VS Code format
        writeMcpConfig('/tmp/.vscode/mcp.json', true);
        // Cursor format
        writeMcpConfig('/tmp/.cursor/mcp.json', false);

        // Validate writes
        const firstWrite = JSON.parse(writeFileSync.firstCall.args[1]);
        const serverArgs = firstWrite.servers.mcp_stata.args;
        assert.deepEqual(serverArgs.slice(0, 3), ['--refresh', '--from', 'mcp-stata@latest']);

        const secondWrite = JSON.parse(writeFileSync.secondCall.args[1]);
        const cursorArgs = secondWrite.mcpServers.mcp_stata.args;
        assert.deepEqual(cursorArgs.slice(0, 3), ['--refresh', '--from', 'mcp-stata@latest']);
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

            assert.isTrue(extWithFs.hasExistingMcpConfig('/workspace'));
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
                globalStoragePath: '/tmp/global',
                extensionUri: {},
                extensionPath: '/workspace'
            };

            await extWithFs.activate(context);

            assert.isTrue(vscodeMock.window.showErrorMessage.notCalled, 'should not prompt when config already present');
            assert.isTrue(globalState.update.calledWithMatch(sinon.match.string, true));
        });

        it('detects windsurf and antigravity configs', () => {
            const fsStub = {
                existsSync: sinon.stub().callsFake((p) => p.includes('.windsurf') || p.includes('.gemini') || p.includes('.antigravity')),
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

            assert.isTrue(extWithFs.hasExistingMcpConfig('/workspace'));
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
            openExternal: sinon.stub()
        },
        Uri: {
            parse: sinon.stub().returns({}),
            joinPath: sinon.stub().returns({ fsPath: '' })
        }
    };
}
