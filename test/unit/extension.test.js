const { assert } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

describe('extension refreshMcpPackage', () => {
    let spawnSync;
    let extension;

    beforeEach(() => {
        spawnSync = sinon.stub();

        extension = proxyquire.noCallThru().load('../../src/extension', {
            vscode: buildVscodeMock(),
            './mcp-client': { client: { setLogger: () => { }, onStatusChanged: () => ({ dispose() { } }) } },
            './interactive-panel': { InteractivePanel: { setExtensionUri: () => { }, addEntry: () => { }, show: () => { } } },
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
            './interactive-panel': { InteractivePanel: { setExtensionUri: () => { }, addEntry: () => { }, show: () => { } } },
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
