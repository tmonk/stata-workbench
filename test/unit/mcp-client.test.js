const assert = require('chai').assert;
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const path = require('path');
const vscodeMock = require('../mocks/vscode');

// Mock MCP SDK
const ClientMock = class {
    constructor() {
        this.connect = sinon.stub().resolves();
        this.callTool = sinon.stub().resolves({ content: [] });
    }
};

const StdioClientTransportMock = class {
    constructor() { }
};

// Load McpClient with mocks
const { StataMcpClient: McpClient } = proxyquire.noCallThru().load('../../src/mcp-client', {
    'vscode': vscodeMock,
    'fs': {
        existsSync: sinon.stub().returns(true),
        readFileSync: sinon.stub().returns(Buffer.from('fake_image_data'))
    },
    '@modelcontextprotocol/sdk/client/stdio.js': { StdioClientTransport: StdioClientTransportMock },
    '@modelcontextprotocol/sdk/client/index.js': { Client: ClientMock },
    'child_process': {
        spawn: sinon.stub().returns({
            stdout: { on: sinon.stub() },
            stderr: { on: sinon.stub() },
            on: sinon.stub(),
            kill: sinon.stub()
        })
    }
});

describe('McpClient', () => {
    let client;
    let mockClientInstance;

    beforeEach(() => {
        client = new McpClient({
            subscriptions: [],
            extensionUri: { fsPath: '/test/path' }
        });

        vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: '/mock/workspace' } }];

        const config = vscodeMock.workspace.getConfiguration();
        config.get.resetBehavior();
        config.get.callsFake((key, def) => {
            if (key === 'requestTimeoutMs') return 1000;
            if (key === 'runFileWorkingDirectory') return '';
            if (key === 'autoRevealOutput') return true;
            return def;
        });

        // Mock internal methods to avoid actual process spawning
        client._ensureClient = sinon.stub().resolves(new ClientMock());
        client._callTool = sinon.stub().resolves({});
    });

    describe('_resolveArtifactsFromList', () => {
        it('should correctly resolve graph artifacts with export fallback', async () => {
            const mockResponse = {
                graphs: [
                    // Case 1: Simple string name (needs export)
                    "simple_graph",
                    // Case 2: Object with just name (needs export)
                    { name: "named_graph" },
                    // Case 3: Fully formed artifact (no export needed)
                    { name: "existing_graph", path: "/tmp/graph.pdf", dataUri: "data:application/pdf;base64,..." }
                ]
            };

            const mockClient = {
                callTool: sinon.stub()
            };

            // Setup mock responses for exports
            const expectedDataUri = `data:image/png;base64,${Buffer.from('fake_image_data').toString('base64')}`;
            client._fileToDataUri = sinon.stub().returns(expectedDataUri);
            client._exportGraphPreferred = sinon.stub().callsFake(async (c, name) => {
                return { content: [{ type: 'text', text: `/tmp/${name}.pdf` }] };
            });

            // Configure the stubbed _callTool to return artifacts
            // Note: _callTool takes (client, name, args)
            client._callTool.withArgs(mockClient, 'export_graph', { graph_name: 'simple_graph', format: 'png' })
                .resolves({ content: [{ type: 'text', text: '/tmp/simple_graph.png' }] });

            client._callTool.withArgs(mockClient, 'export_graph', { graph_name: 'named_graph', format: 'png' })
                .resolves({ content: [{ type: 'text', text: '/tmp/named_graph.png' }] });

            const artifacts = await client._resolveArtifactsFromList(mockResponse, '/tmp', mockClient);

            assert.lengthOf(artifacts, 3);

            // Check simple_graph
            const simple = artifacts.find(a => a.label === 'simple_graph');
            assert.exists(simple);
            assert.equal(simple.path, '/tmp/simple_graph.pdf');

            // Check named_graph
            const named = artifacts.find(a => a.label === 'named_graph');
            assert.exists(named);
            assert.equal(named.path, '/tmp/named_graph.pdf');


            // Check existing_graph
            const existing = artifacts.find(a => a.label === 'existing_graph');
            assert.exists(existing);
            assert.equal(existing.path, '/tmp/graph.pdf'); // Should preserve original
        });

        it('should handle export failures gracefully', async () => {
            const mockResponse = { graphs: ["bad_graph"] };
            const mockClient = { callTool: sinon.stub() };

            client._exportGraphPreferred = sinon.stub().rejects(new Error("Export failed"));

            const artifacts = await client._resolveArtifactsFromList(mockResponse, '/tmp', mockClient);

            // verifiable behavior: it falls back to direct artifact conversion or error placeholder
            assert.lengthOf(artifacts, 1);
            assert.equal(artifacts[0].label, 'bad_graph');
            assert.include(artifacts[0].error, 'Export failed');
        });
    });

    describe('_normalizeResponse', () => {
        it('should not treat structured JSON content as stdout/contentText and should prefer error fields', () => {
            const response = {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        command: 'reg y x',
                        success: false,
                        error: {
                            message: '. reg y x\nvariable y not found\nr(111);',
                            rc: 111,
                            snippet: '. reg y x\nvariable y not found\nr(111);'
                        }
                    })
                }]
            };

            const normalized = client._normalizeResponse(response, { command: 'reg y x' });

            assert.isFalse(normalized.success);
            assert.equal(normalized.rc, 111);
            assert.equal(normalized.stdout, '');
            assert.equal(normalized.contentText, '');
            assert.include(normalized.stderr, 'variable y not found');
        });
    });

    describe('Artifact Parsing', () => {
        it('_parseArtifactLikeJson should handle graph objects', () => {
            const input = JSON.stringify({ graph: { name: 'g1', path: 'p1.png' } });
            const art = client._parseArtifactLikeJson(input);
            assert.equal(art.label, 'g1');
            assert.equal(art.path, 'p1.png');
        });

        it('_parseArtifactLikeJson should handle flat objects', () => {
            const input = JSON.stringify({ name: 'g2', url: 'https://example.com/image.png' });
            const art = client._parseArtifactLikeJson(input);
            assert.equal(art.label, 'g2');
            assert.equal(art.path, 'https://example.com/image.png');
            assert.isNull(art.dataUri);
        });

        it('_parseArtifactLikeJson should return null for invalid json', () => {
            const art = client._parseArtifactLikeJson('invalid json');
            assert.isNull(art);
        });
    });

    describe('run', () => {
        it('should enable artifact collection', async () => {
            const enqueueSpy = sinon.spy(client, '_enqueue');

            await client.run('sysuse auto');

            assert.isTrue(enqueueSpy.calledOnce);
            const args = enqueueSpy.firstCall.args;
            assert.equal(args[0], 'run_command');
            assert.equal(args[5], true); // collectArtifacts flag
        });
    });

    describe('fetchGraph', () => {
        it('enqueues export_graph with graph_name and format (no base64)', async () => {
            const enqueueSpy = sinon.spy(client, '_enqueue');
            const taskResult = { path: '/tmp/g1.pdf' };

            const callToolStub = client._callTool;
            callToolStub.callsFake(async (c, name, args) => {
                assert.equal(name, 'export_graph');
                assert.deepEqual(args, { graph_name: 'g1', format: 'pdf' });
                return { content: [{ type: 'text', text: '/tmp/g1.pdf' }] };
            });
            client._graphResponseToArtifact = sinon.stub().returns(taskResult);

            const result = await client.fetchGraph('g1');

            assert.strictEqual(result, taskResult);
            assert.isTrue(enqueueSpy.calledOnce);
            const [label, options] = enqueueSpy.firstCall.args;
            assert.equal(label, 'fetch_graph');
            assert.deepEqual(options, {});
        });
    });

    describe('getVariableList', () => {
        it('enqueues get_variable_list and returns normalized list', async () => {
            const enqueueStub = sinon.stub(client, '_enqueue').callsFake(async (label, options, task) => {
                assert.equal(label, 'get_variable_list');
                assert.deepEqual(options, {});
                const normalized = await task();
                return normalized;
            });

            client._callTool.callsFake(async () => ({ variables: [{ name: 'price', label: 'Price' }, { variable: 'mpg' }] }));

            const result = await client.getVariableList();

            assert.deepEqual(result, [
                { name: 'price', label: 'Price' },
                { name: 'mpg', label: '' }
            ]);
            enqueueStub.restore();
        });

        it('_normalizeVariableList handles strings, objects, and nested content', () => {
            const strings = client._normalizeVariableList(['price', 'mpg']);
            assert.deepEqual(strings, [
                { name: 'price', label: '' },
                { name: 'mpg', label: '' }
            ]);

            const objects = client._normalizeVariableList({ variables: [{ variable: 'weight', desc: 'Weight' }] });
            assert.deepEqual(objects, [{ name: 'weight', label: 'Weight' }]);

            const nested = client._normalizeVariableList({ content: [{ text: JSON.stringify({ vars: [{ var: 'turn' }] }) }] });
            assert.deepEqual(nested, [{ name: 'turn', label: '' }]);
        });
    });

    describe('runFile', () => {
        it('should honor resolved cwd when no workspace folders exist', async () => {
            const originalFolders = vscodeMock.workspace.workspaceFolders;
            vscodeMock.workspace.workspaceFolders = [];

            const config = vscodeMock.workspace.getConfiguration();
            config.get.callsFake((key, def) => {
                if (key === 'runFileWorkingDirectory') return 'relative/run';
                if (key === 'requestTimeoutMs') return 1000;
                return def;
            });

            const callToolStub = client._callTool;
            callToolStub.resetBehavior();
            callToolStub.callsFake(async (_client, name, args) => ({ name, args }));

            const enqueueStub = sinon.stub(client, '_enqueue').callsFake(async (label, rest, task, meta, normalize, collect) => {
                const taskResult = await task({});
                return { label, rest, meta, normalize, collect, taskResult };
            });

            const result = await client.runFile('/tmp/project/script.do');

            assert.isTrue(enqueueStub.calledOnce);
            const [label, rest, , meta, normalizeFlag, collectFlag] = enqueueStub.firstCall.args;
            assert.equal(label, 'run_file');
            assert.deepEqual(rest, {});
            assert.equal(normalizeFlag, false);
            assert.equal(collectFlag, false);

            const expectedCwd = path.normalize(path.resolve('relative/run'));
            assert.equal(meta.cwd, expectedCwd);
            assert.equal(meta.filePath, '/tmp/project/script.do');
            assert.equal(meta.command, 'do "/tmp/project/script.do"');

            assert.equal(result.taskResult.name, 'run_do_file');
            assert.equal(result.taskResult.args.cwd, expectedCwd);
            assert.equal(result.taskResult.args.path, '/tmp/project/script.do');

            enqueueStub.restore();
            vscodeMock.workspace.workspaceFolders = originalFolders;
        });
    });

    describe('cwd propagation', () => {
        it('runSelection should pass cwd through to run_command when provided', async () => {
            const callToolStub = client._callTool;
            callToolStub.resetBehavior();
            callToolStub.callsFake(async (_client, name, args) => ({ name, args }));

            const enqueueStub = sinon.stub(client, '_enqueue').callsFake(async (label, rest, task, meta, normalize, collect) => {
                const taskResult = await task({});
                return { label, rest, meta, normalize, collect, taskResult };
            });

            const result = await client.runSelection('display "hi"', { cwd: '/tmp/project', normalizeResult: false, includeGraphs: false });

            assert.isTrue(enqueueStub.calledOnce);
            assert.equal(result.label, 'run_selection');
            assert.equal(result.meta.cwd, '/tmp/project');
            assert.equal(result.taskResult.name, 'run_command');
            assert.equal(result.taskResult.args.cwd, '/tmp/project');
            assert.equal(result.taskResult.args.code, 'display "hi"');

            enqueueStub.restore();
        });
    });

    describe('cancellation', () => {
        it('passes progressToken and signal to client.request when provided', async () => {
            const abort = new AbortController();
            const requestStub = sinon.stub().resolves({ ok: true });
            const callToolStub = sinon.stub().resolves({});
            const clientMock = { request: requestStub, callTool: callToolStub };

            await client._callTool(clientMock, 'run_command', { code: 'sleep 10' }, { progressToken: 'p_tok', signal: abort.signal });

            assert.isTrue(requestStub.calledOnce, 'client.request should be used when progressToken exists');
            const [reqPayload, , options] = requestStub.firstCall.args;
            assert.deepEqual(reqPayload.params._meta, { progressToken: 'p_tok' });
            assert.strictEqual(options.signal, abort.signal);
            assert.isTrue(callToolStub.notCalled, 'callTool should not be used when request path is taken');
        });

        it('treats AbortError as cancellation and surfaces a friendly message', async () => {
            const abortErr = new Error('Aborted');
            abortErr.name = 'AbortError';
            const callToolStub = sinon.stub().rejects(abortErr);
            const emitSpy = sinon.spy(client._statusEmitter, 'emit');
            const clientMock = { callTool: callToolStub };

            let thrown = null;
            try {
                await client._callTool(clientMock, 'run_command', { code: 'sleep 10' });
            } catch (err) {
                thrown = err;
            }

            assert.isNotNull(thrown, 'error should be thrown');
            assert.match(String(thrown?.message || thrown), /cancel/i);
            assert.isTrue(emitSpy.calledWith('connected'), 'status should reset to connected on cancel');
            emitSpy.restore();
        });

        it('cancelAll triggers active cancellation with a reason', async () => {
            const cancelSpy = sinon.spy();
            client._activeCancellation = { cancel: cancelSpy };
            const result = await client.cancelAll();
            assert.isTrue(result, 'cancelAll should report true');
            assert.isTrue(cancelSpy.calledOnce);
            assert.match(String(cancelSpy.firstCall.args[0] || ''), /user cancelled/);
        });
    });

    describe('log tailing', () => {
        it('_drainActiveRunLog should append remaining log data to buffer', async () => {
            client._delay = sinon.stub().resolves();
            client._readLogSlice = sinon.stub();
            client._readLogSlice.onCall(0).resolves({ path: '/tmp/x.log', offset: 0, next_offset: 3, data: 'abc' });
            client._readLogSlice.onCall(1).resolves({ path: '/tmp/x.log', offset: 3, next_offset: 3, data: '' });
            client._readLogSlice.onCall(2).resolves({ path: '/tmp/x.log', offset: 3, next_offset: 3, data: '' });

            const run = {
                logPath: '/tmp/x.log',
                logOffset: 0,
                _tailCancelled: false,
                _tailPromise: null,
                _logBuffer: '',
                _appendLog: (t) => { run._logBuffer += String(t || ''); }
            };

            await client._drainActiveRunLog({}, run);

            assert.equal(run._logBuffer, 'abc');
            assert.equal(run.logOffset, 3);
            assert.isTrue(client._readLogSlice.called);
        });

        it('_tailLogLoop should forward read_log data to onLog until cancelled', async () => {
            client._delay = sinon.stub().resolves();
            client._readLogSlice = sinon.stub().resolves({ path: '/tmp/x.log', offset: 0, next_offset: 2, data: 'hi' });

            const run = {
                logPath: '/tmp/x.log',
                logOffset: 0,
                _tailCancelled: false,
                _logBuffer: '',
                _appendLog: (t) => { run._logBuffer += String(t || ''); }
            };
            run.onLog = sinon.spy((data) => {
                // Stop after first chunk
                run._tailCancelled = true;
            });

            await client._tailLogLoop({}, run);

            assert.isTrue(run.onLog.calledOnce);
            assert.equal(run._logBuffer, 'hi');
            assert.equal(run.logOffset, 2);
        });

        it('runSelection should drain read_log when log_path is only present in tool response', async () => {
            client._delay = sinon.stub().resolves();

            // Let the real _enqueue run (so normalization happens).
            // Ensure the MCP client exists.
            client._ensureClient = sinon.stub().resolves({});

            // Stub _callTool for both run_command and read_log.
            client._callTool = sinon.stub().callsFake(async (_client, name, args) => {
                if (name === 'run_command') {
                    return {
                        structuredContent: {
                            result: JSON.stringify({
                                command: args.code,
                                rc: 0,
                                stdout: '',
                                stderr: null,
                                log_path: '/tmp/mcp_stata_test.log',
                                success: true,
                                error: null
                            })
                        },
                        content: [{ type: 'text', text: '' }]
                    };
                }
                if (name === 'read_log') {
                    // Return one chunk then empty.
                    const nextOffset = (args.offset || 0) === 0 ? 3 : 3;
                    const data = (args.offset || 0) === 0 ? 'abc' : '';
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                path: args.path,
                                offset: args.offset || 0,
                                next_offset: nextOffset,
                                data
                            })
                        }]
                    };
                }
                return {};
            });

            const result = await client.runSelection('display "HI"', {
                normalizeResult: true,
                includeGraphs: false
            });

            // Critical behavior: stdout comes from drained log, not the empty stdout from structured content.
            assert.isTrue(result.success);
            assert.equal(result.rc, 0);
            assert.equal(result.logPath, '/tmp/mcp_stata_test.log');
            assert.equal(result.stdout, 'abc');
        });
    });

    describe('_resolveRunFileCwd', () => {
        it('should default to the file directory when unset', () => {
            const cwd = client._resolveRunFileCwd('/tmp/project/script.do');
            assert.equal(cwd, path.normalize('/tmp/project'));
        });

        it('should expand workspace and fileDir tokens', () => {
            const config = vscodeMock.workspace.getConfiguration();
            config.get.callsFake((key, def) => {
                if (key === 'runFileWorkingDirectory') return '${workspaceFolder}/sub/${fileDir}';
                if (key === 'requestTimeoutMs') return 1000;
                return def;
            });

            const cwd = client._resolveRunFileCwd('/tmp/project/script.do');
            assert.equal(cwd, path.normalize('/mock/workspace/sub//tmp/project'));
        });

        it('should honor absolute paths', () => {
            const config = vscodeMock.workspace.getConfiguration();
            config.get.callsFake((key, def) => {
                if (key === 'runFileWorkingDirectory') return '/abs/path';
                if (key === 'requestTimeoutMs') return 1000;
                return def;
            });

            const cwd = client._resolveRunFileCwd('/tmp/project/script.do');
            assert.equal(cwd, path.normalize('/abs/path'));
        });

        it('should expand tilde to home directory', () => {
            const config = vscodeMock.workspace.getConfiguration();
            const originalHome = process.env.HOME;
            process.env.HOME = '/home/tester';

            config.get.callsFake((key, def) => {
                if (key === 'runFileWorkingDirectory') return '~/stata/runs';
                if (key === 'requestTimeoutMs') return 1000;
                return def;
            });

            const cwd = client._resolveRunFileCwd('/tmp/project/script.do');
            assert.equal(cwd, path.normalize('/home/tester/stata/runs'));

            process.env.HOME = originalHome;
        });

        it('should fall back to file directory when tokens are unknown', () => {
            const config = vscodeMock.workspace.getConfiguration();
            config.get.callsFake((key, def) => {
                if (key === 'runFileWorkingDirectory') return '${unknownToken}';
                if (key === 'requestTimeoutMs') return 1000;
                return def;
            });

            const cwd = client._resolveRunFileCwd('/tmp/project/script.do');
            assert.equal(cwd, path.normalize('/tmp/project'));
        });

        it('should resolve relative paths against workspace root when available', () => {
            const config = vscodeMock.workspace.getConfiguration();
            config.get.callsFake((key, def) => {
                if (key === 'runFileWorkingDirectory') return 'relative/run';
                if (key === 'requestTimeoutMs') return 1000;
                return def;
            });

            const cwd = client._resolveRunFileCwd('/tmp/project/script.do');
            assert.equal(cwd, path.normalize('/mock/workspace/relative/run'));
        });

        it('should resolve relative paths against process cwd when workspace is missing', () => {
            const config = vscodeMock.workspace.getConfiguration();
            const originalFolders = vscodeMock.workspace.workspaceFolders;
            vscodeMock.workspace.workspaceFolders = [];

            config.get.callsFake((key, def) => {
                if (key === 'runFileWorkingDirectory') return 'relative/run';
                if (key === 'requestTimeoutMs') return 1000;
                return def;
            });

            const cwd = client._resolveRunFileCwd('/tmp/project/script.do');
            assert.equal(cwd, path.normalize(path.resolve('relative/run')));

            vscodeMock.workspace.workspaceFolders = originalFolders;
        });
    });

    describe('listGraphs', () => {
        it('should resolve artifacts with client access', async () => {
            // Mock list_graphs to return simple list of names
            client._callTool.withArgs(sinon.match.any, 'list_graphs', sinon.match.any)
                .resolves({ graphs: ['g1'] });

            // Mock export behavior for "g1"
            client._exportGraphPreferred = sinon.stub().resolves({ content: [{ type: 'text', text: '/tmp/g1.pdf' }] });
            client._callTool.withArgs(sinon.match.any, 'export_graph', sinon.match.has('format', 'png'))
                .resolves({ content: [{ type: 'text', text: '/tmp/g1.png' }] });
            const expectedDataUri = `data:image/png;base64,${Buffer.from('fake_image_data').toString('base64')}`;
            client._fileToDataUri = sinon.stub().returns(expectedDataUri);


            const result = await client.listGraphs({ baseDir: '/tmp' });

            assert.isArray(result.graphs);
            assert.lengthOf(result.graphs, 1);
            assert.equal(result.graphs[0].label, 'g1');
            assert.equal(result.graphs[0].path, '/tmp/g1.pdf');
        });

        it('should aggregate graph lists across multiple content chunks', async () => {
            const wrappedResponse = {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ graphs: ['g1'] })
                    },
                    {
                        type: 'text',
                        text: JSON.stringify({ graphs: ['g2'] })
                    }
                ]
            };

            client._callTool.withArgs(sinon.match.any, 'list_graphs', sinon.match.any)
                .resolves(wrappedResponse);

            // Mock export for both graphs
            client._exportGraphPreferred = sinon.stub().callsFake(async (_c, name) => ({ content: [{ type: 'text', text: `/tmp/${name}.pdf` }] }));
            client._callTool.withArgs(sinon.match.any, 'export_graph', sinon.match.has('format', 'png'))
                .callsFake(async (_c, _name, args) => ({ content: [{ type: 'text', text: `/tmp/${args.graph_name}.png` }] }));

            const result = await client.listGraphs({ baseDir: '/tmp' });

            assert.isArray(result.graphs);
            assert.lengthOf(result.graphs, 2);

            const labels = result.graphs.map((g) => g.label);
            assert.includeMembers(labels, ['g1', 'g2']);
        });

        it('should handle text-wrapped graph lists', async () => {
            // Mock list_graphs to return text-wrapped JSON (common MCP pattern)
            const wrappedResponse = {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ graphs: ['g_wrapped'] })
                }]
            };

            client._callTool.withArgs(sinon.match.any, 'list_graphs', sinon.match.any)
                .resolves(wrappedResponse);

            // Mock export
            client._exportGraphPreferred = sinon.stub().resolves({ content: [{ type: 'text', text: '/tmp/g_wrapped.pdf' }] });
            client._callTool.withArgs(sinon.match.any, 'export_graph', sinon.match.has('format', 'png'))
                .resolves({ content: [{ type: 'text', text: '/tmp/g_wrapped.png' }] });


            const result = await client.listGraphs({ baseDir: '/tmp' });

            assert.lengthOf(result.graphs, 1);
            assert.equal(result.graphs[0].label, 'g_wrapped');
        });
    });
});
