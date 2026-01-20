const { describe, it, beforeEach, afterEach, expect, jest } = require('bun:test');
const sinon = require('sinon');
const path = require('path');
const proxyquire = require('proxyquire');
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

afterEach(() => {
        const config = vscodeMock.workspace.getConfiguration();
        if (config.get.restore) config.get.restore();
});

describe('mcp-client normalizeResponse', () => {
    it('keeps longest stdout including logText tail', () => {
        const client = new McpClient();

        const meta = { logText: 'live stream tail', command: 'do foo' };
        const response = { stdout: 'short', rc: 1 };
        const normalized = client._normalizeResponse(response, meta);

        expect(normalized.stdout).toEqual('live stream tail');
    });

    it('falls back to log tail for stderr on non-zero rc', () => {
        const client = new McpClient();

        const meta = { logText: '... type mismatch\nr(109);\n', command: 'do foo' };
        const response = { rc: 109 };
        const normalized = client._normalizeResponse(response, meta);

        expect(normalized.stderr).toContain('type mismatch');
        expect(normalized.stderr).toContain('r(109)');
        expect(normalized.success).toEqual(false);
    });
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
        config.get.mockReset();
        config.get.mockImplementation((key, def) => {
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
                    { name: "existing_graph", path: "/tmp/graph.pdf" }
                ]
            };

            const mockClient = {
                callTool: sinon.stub()
            };

            // Setup mock responses for exports
            client._exportGraphPreferred = sinon.stub().callsFake(async (c, name) => {
                return { content: [{ type: 'text', text: `/tmp/${name}.pdf` }] };
            });

            // Configure the stubbed _callTool to return artifacts
            // Note: _callTool takes (client, name, args)

            const artifacts = await client._resolveArtifactsFromList(mockResponse, '/tmp', mockClient);

            expect(artifacts.length).toBe(3);

            // Check simple_graph
            const simple = artifacts.find(a => a.label === 'simple_graph');
            expect(simple).toBeDefined();
            expect(simple.path).toEqual('/tmp/simple_graph.pdf');

            // Check named_graph
            const named = artifacts.find(a => a.label === 'named_graph');
            expect(named).toBeDefined();
            expect(named.path).toEqual('/tmp/named_graph.pdf');


            // Check existing_graph
            const existing = artifacts.find(a => a.label === 'existing_graph');
            expect(existing).toBeDefined();
            expect(existing.path).toEqual('/tmp/graph.pdf'); // Should preserve original
        });

        it('should handle export failures gracefully', async () => {
            const mockResponse = { graphs: ["bad_graph"] };
            const mockClient = { callTool: sinon.stub() };

            client._exportGraphPreferred = sinon.stub().rejects(new Error("Export failed"));

            const artifacts = await client._resolveArtifactsFromList(mockResponse, '/tmp', mockClient);

            // verifiable behavior: it falls back to direct artifact conversion or error placeholder
            expect(artifacts.length).toBe(1);
            expect(artifacts[0].label).toEqual('bad_graph');
            expect(artifacts[0].error).toContain('Export failed');
        });
    });

    describe('_normalizeResponse', () => {
        it('prefers scml stderr payloads for errors', () => {
            const response = {
                error: {
                    rc: 111,
                    stderr: { scml: '{err}variable {bf}compl_gloves{sf} not found' }
                }
            };

            const normalized = client._normalizeResponse(response, { command: 'reg price compl_gloves' });

            expect(normalized.success).toBe(false);
            expect(normalized.rc).toEqual(111);
            expect(normalized.stderr).toContain('{err}variable {bf}compl_gloves{sf} not found');
        });

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

            expect(normalized.success).toBe(false);
            expect(normalized.rc).toEqual(111);
            expect(normalized.stdout).toEqual('');
            expect(normalized.contentText).toEqual('');
            expect(normalized.stderr).toContain('variable y not found');
        });

        it('preserves graph artifact arrays in normalized responses', () => {
            const response = {
                success: true,
                graphArtifacts: [
                    { label: 'g1', path: '/tmp/g1.png' }
                ]
            };

            const normalized = client._normalizeResponse(response, { command: 'graph' });

            expect(Array.isArray(normalized.graphArtifacts)).toBe(true);
            expect(normalized.graphArtifacts.length).toBe(1);
            expect(normalized.graphArtifacts[0].label).toBe('g1');
            expect(Array.isArray(normalized.artifacts)).toBe(true);
            expect(normalized.artifacts[0].path).toBe('/tmp/g1.png');
        });
    });

    describe('Artifact Parsing', () => {
        it('_parseArtifactLikeJson should handle graph objects', () => {
            const input = JSON.stringify({ graph: { name: 'g1', path: 'p1.png' } });
            const art = client._parseArtifactLikeJson(input);
            expect(art.label).toEqual('g1');
            expect(art.path).toEqual('p1.png');
        });

        it('_parseArtifactLikeJson should handle flat objects', () => {
            const input = JSON.stringify({ name: 'g2', url: 'https://example.com/image.png' });
            const art = client._parseArtifactLikeJson(input);
            expect(art.label).toEqual('g2');
            expect(art.path).toEqual('https://example.com/image.png');
        });

        it('_parseArtifactLikeJson should return null for invalid json', () => {
            const art = client._parseArtifactLikeJson('invalid json');
            expect(art).toBeNull();
        });
    });

    describe('run', () => {
        it('should enable artifact collection', async () => {
            const enqueueSpy = sinon.spy(client, '_enqueue');

            await client.run('sysuse auto');

            expect(enqueueSpy.calledOnce).toBe(true);
            const args = enqueueSpy.firstCall.args;
            expect(args[0]).toEqual('run_command');
            expect(args[5]).toEqual(true); // collectArtifacts flag
        });
    });

    describe('fetchGraph', () => {
        it('enqueues export_graph with graph_name and format (no base64)', async () => {
            const enqueueSpy = sinon.spy(client, '_enqueue');
            const taskResult = { path: '/tmp/g1.pdf' };

            const callToolStub = client._callTool;
            callToolStub.callsFake(async (c, name, args) => {
                expect(name).toEqual('export_graph');
                expect(args.graph_name).toEqual('g1');
                expect(args.format).not.toBeDefined();
                return { content: [{ type: 'text', text: '/tmp/g1.pdf' }] };
            });
            client._graphResponseToArtifact = sinon.stub().returns(taskResult);

            const result = await client.fetchGraph('g1');

            expect(result).toBe(taskResult);
            expect(enqueueSpy.calledOnce).toBe(true);
            const [label, options] = enqueueSpy.firstCall.args;
            expect(label).toEqual('fetch_graph');
            expect(options).toEqual({});
        });
    });

    describe('getVariableList', () => {
        it('enqueues get_variable_list and returns normalized list', async () => {
            const enqueueStub = sinon.stub(client, '_enqueue').callsFake(async (label, options, task) => {
                expect(label).toEqual('get_variable_list');
                expect(options).toEqual({});
                const normalized = await task();
                return normalized;
            });

            client._callTool.callsFake(async () => ({ variables: [{ name: 'price', label: 'Price' }, { variable: 'mpg' }] }));

            const result = await client.getVariableList();

            expect(result).toEqual([
                { name: 'price', label: 'Price' },
                { name: 'mpg', label: '' }
            ]);
            enqueueStub.restore();
        });

        it('_normalizeVariableList handles strings, objects, and nested content', () => {
            const strings = client._normalizeVariableList(['price', 'mpg']);
            expect(strings).toEqual([
                { name: 'price', label: '' },
                { name: 'mpg', label: '' }
            ]);

            const objects = client._normalizeVariableList({ variables: [{ variable: 'weight', desc: 'Weight' }] });
            expect(objects).toEqual([{ name: 'weight', label: 'Weight' }]);

            const nested = client._normalizeVariableList({ content: [{ text: JSON.stringify({ vars: [{ var: 'turn' }] }) }] });
            expect(nested).toEqual([{ name: 'turn', label: '' }]);
        });
    });

    describe('getUiChannel', () => {
        it('enqueues get_ui_channel and returns parsed result', async () => {
            const enqueueStub = sinon.stub(client, '_enqueue').callsFake(async (label, options, task) => {
                expect(label).toEqual('get_ui_channel');
                expect(options).toEqual({});
                const result = await task();
                return result;
            });

            client._callTool.callsFake(async (c, name) => {
                expect(name).toEqual('get_ui_channel');
                return { baseUrl: 'http://localhost:1234', token: 'xyz' };
            });

            const result = await client.getUiChannel();
            expect(result).toEqual({ baseUrl: 'http://localhost:1234', token: 'xyz' });
            enqueueStub.restore();
        });
    });

    describe('runFile', () => {
        it('should honor resolved cwd when no workspace folders exist', async () => {
            const originalFolders = vscodeMock.workspace.workspaceFolders;
            vscodeMock.workspace.workspaceFolders = [];

            const config = vscodeMock.workspace.getConfiguration();
            config.get.mockImplementation((key, def) => {
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

            expect(enqueueStub.calledOnce).toBe(true);
            const [label, rest, , meta, normalizeFlag, collectFlag] = enqueueStub.firstCall.args;
            expect(label).toEqual('run_file');
            expect('cancellationToken' in rest).toBeTruthy();
            expect(normalizeFlag).toEqual(false);
            expect(collectFlag).toEqual(false);

            const expectedCwd = path.normalize(path.resolve('relative/run'));
            expect(meta.cwd).toEqual(expectedCwd);
            expect(meta.filePath).toEqual('/tmp/project/script.do');
            expect(meta.command).toEqual('do "/tmp/project/script.do"');

            expect(result.taskResult.name).toEqual('run_do_file_background');
            expect(result.taskResult.args.cwd).toEqual(expectedCwd);
            expect(result.taskResult.args.path).toEqual('/tmp/project/script.do');

            enqueueStub.restore();
            vscodeMock.workspace.workspaceFolders = originalFolders;
        });

        it('should respect explicitly provided cwd in options', async () => {
            const callToolStub = client._callTool;
            callToolStub.resetBehavior();
            callToolStub.callsFake(async (_client, name, args) => ({ name, args }));

            const enqueueStub = sinon.stub(client, '_enqueue').callsFake(async (label, rest, task, meta, normalize, collect) => {
                const taskResult = await task({});
                return { label, rest, meta, normalize, collect, taskResult };
            });

            const explicitCwd = '/explicit/cwd';
            const result = await client.runFile('/tmp/script.do', { cwd: explicitCwd });

            expect(result.meta.cwd).toEqual(explicitCwd);
            expect(result.taskResult.args.cwd).toEqual(explicitCwd);

            enqueueStub.restore();
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

            expect(enqueueStub.calledOnce).toBe(true);
            expect(result.label).toEqual('run_selection');
            expect(result.meta.cwd).toEqual('/tmp/project');
            expect(result.taskResult.name).toEqual('run_command_background');
            expect(result.taskResult.args.cwd).toEqual('/tmp/project');
            expect(result.taskResult.args.code).toEqual('display "hi"');

            enqueueStub.restore();
        });
    });

    describe('cancellation', () => {
        beforeEach(() => {
            // Use real _callTool implementation for cancellation behaviors.
            client._callTool = McpClient.prototype._callTool.bind(client);
        });

        it('passes progressToken and signal to client.request when provided', async () => {
            const abort = new AbortController();
            const requestStub = sinon.stub().resolves({ ok: true });
            const callToolStub = sinon.stub().resolves({});
            const clientMock = { request: requestStub, callTool: callToolStub };

            await client._callTool(clientMock, 'run_command', { code: 'sleep 10' }, { progressToken: 'p_tok', signal: abort.signal });

            expect(requestStub.calledOnce).toBe(true);
            const [reqPayload, , options] = requestStub.firstCall.args;
            expect(reqPayload.params._meta).toEqual({ progressToken: 'p_tok' });
            expect(options.signal).toBe(abort.signal);
            expect(callToolStub.notCalled).toBe(true);
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

            expect(thrown).not.toBeNull();
            expect(String(thrown?.message || thrown)).toMatch(/(cancel|abort)/i);
            emitSpy.restore();
        });

        it('cancelAll triggers active cancellation with a reason', async () => {
            const cancelSpy = sinon.spy();
            client._activeCancellation = { cancel: cancelSpy };
            client._pending = 1;
            const result = await client.cancelAll();
            expect(result).toBe(true);
            expect(cancelSpy.calledOnce).toBe(true);
            expect(String(cancelSpy.firstCall.args[0] || '')).toMatch(/user cancelled/);
            client._pending = 0;
        });

        it('cancelAll calls cancel_task when a background task is active', async () => {
            const cancelSpy = sinon.spy();
            client._activeCancellation = { cancel: cancelSpy };
            client._pending = 1;
            client._activeRun = { taskId: 'task-123' };
            client._ensureClient = sinon.stub().resolves({});
            client._cancelTask = sinon.stub().resolves();

            const result = await client.cancelAll();

            expect(result).toBe(true);
            expect(cancelSpy.calledOnce).toBe(true);
            expect(client._cancelTask.calledOnce).toBe(true);
            expect(client._cancelTask.firstCall.args[1]).toEqual('task-123');
            client._pending = 0;
            client._activeRun = null;
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
                _appendLog: (t) => { run._logBuffer += String(t || ''); },
                onRawLog: sinon.spy()
            };

            await client._drainActiveRunLog({}, run);

            expect(run._logBuffer).toEqual('abc');
            expect(run.onRawLog.called).toBe(true);
            expect(run.logOffset).toEqual(3);
            expect(client._readLogSlice.called).toBe(true);
        });

        it('_tailLogLoop should forward read_log data to onLog until cancelled', async () => {
            client._delay = sinon.stub().resolves();
            client._readLogSlice = sinon.stub().resolves({ path: '/tmp/x.log', offset: 0, next_offset: 3, data: 'hi\n' });

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
            run.onRawLog = sinon.spy((data) => {
                if (data) run._tailCancelled = true;
            });

            await client._tailLogLoop({}, run);

            expect(run.onLog.calledOnce).toBe(true);
            expect(run.onRawLog.calledOnce).toBe(true);
            expect(run._logBuffer).toEqual('hi\n');
            expect(run.logOffset).toEqual(3);
        });

        it('runSelection should drain read_log when log_path is only present in tool response', async () => {
            client._delay = sinon.stub().resolves();
            client._awaitTaskDone = sinon.stub().resolves();

            // Let the real _enqueue run (so normalization happens).
            // Ensure the MCP client exists.
            client._ensureClient = sinon.stub().resolves({});

            // Stub _callTool for background kickoff, result, and read_log.
            client._callTool = sinon.stub().callsFake(async (_client, name, args) => {
                if (name === 'run_command_background') {
                    return {
                        structuredContent: {
                            result: JSON.stringify({
                                command: args.code,
                                rc: 0,
                                stdout: '',
                                stderr: null,
                                log_path: '/tmp/mcp_stata_test.log',
                                task_id: 'task-abc',
                                success: true,
                                error: null
                            })
                        },
                        content: [{ type: 'text', text: '' }]
                    };
                }
                if (name === 'get_task_result') {
                    return {
                        structuredContent: {
                            result: JSON.stringify({
                                command: args.code || 'display "HI"',
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
                    const data = (args.offset || 0) === 0 ? 'abc\n' : '';
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
            expect(result.success).toBe(true);
            expect(result.rc).toEqual(0);
            expect(result.logPath).toEqual('/tmp/mcp_stata_test.log');
            expect(result.stdout).toEqual('abc\n');
        });
    });

    describe('background task helpers', () => {
        it('_awaitTaskDone resolves after task_done notification', async () => {
            const runState = {};
            const cancellationToken = { onCancellationRequested: sinon.stub().returns({ dispose: sinon.stub() }) };

            const promise = client._awaitTaskDone(runState, 'task-1', cancellationToken);
            runState._taskDoneResolve({ event: 'task_done', task_id: 'task-1' });

            const result = await promise;

            expect(result).toBeTruthy();
            expect(result.task_id).toEqual('task-1');
        });

        it('_awaitBackgroundResult wires task id and log path', async () => {
            const runState = { logPath: null };
            client._ensureLogTail = sinon.stub().callsFake(async (_client, run, logPath) => {
                run.logPath = logPath;
            });
            client._awaitTaskDone = sinon.stub().resolves({ event: 'task_done', task_id: 'task-xyz' });
            client._callTool = sinon.stub().callsFake(async (_client, name) => {
                if (name === 'get_task_result') {
                    return { ok: true };
                }
                return {};
            });

            const kickoff = {
                log_path: '/tmp/background.log',
                structuredContent: {
                    log_path: '/tmp/background.log',
                    task_id: 'task-xyz'
                },
                content: [{ type: 'text', text: '' }]
            };

            const result = await client._awaitBackgroundResult({}, runState, kickoff, { token: { onCancellationRequested: sinon.stub() } });

            expect(runState.logPath).toEqual('/tmp/background.log');
            expect(runState.taskId).toEqual('task-xyz');
            expect(result).toEqual({
                event: 'task_done',
                task_id: 'task-xyz',
                log_path: '/tmp/background.log'
            });
        });
    });

    describe('_resolveRunFileCwd', () => {
        it('should default to the file directory when unset', () => {
            const cwd = client._resolveRunFileCwd('/tmp/project/script.do');
            expect(cwd).toEqual(path.normalize('/tmp/project'));
        });

        it('should expand workspace and fileDir tokens', () => {
            const config = vscodeMock.workspace.getConfiguration();
            config.get.mockImplementation((key, def) => {
                if (key === 'runFileWorkingDirectory') return '${workspaceFolder}/sub/${fileDir}';
                if (key === 'requestTimeoutMs') return 1000;
                return def;
            });

            const cwd = client._resolveRunFileCwd('/tmp/project/script.do');
            expect(cwd).toEqual(path.normalize('/mock/workspace/sub//tmp/project'));
        });

        it('should honor absolute paths', () => {
            const config = vscodeMock.workspace.getConfiguration();
            config.get.mockImplementation((key, def) => {
                if (key === 'runFileWorkingDirectory') return '/abs/path';
                if (key === 'requestTimeoutMs') return 1000;
                return def;
            });

            const cwd = client._resolveRunFileCwd('/tmp/project/script.do');
            expect(cwd).toEqual(path.normalize('/abs/path'));
        });

        it('should expand tilde to home directory', () => {
            const config = vscodeMock.workspace.getConfiguration();
            const originalHome = process.env.HOME;
            process.env.HOME = '/home/tester';

            config.get.mockImplementation((key, def) => {
                if (key === 'runFileWorkingDirectory') return '~/stata/runs';
                if (key === 'requestTimeoutMs') return 1000;
                return def;
            });

            const cwd = client._resolveRunFileCwd('/tmp/project/script.do');
            expect(cwd).toEqual(path.normalize('/home/tester/stata/runs'));

            process.env.HOME = originalHome;
        });

        it('should fall back to file directory when tokens are unknown', () => {
            const config = vscodeMock.workspace.getConfiguration();
            config.get.mockImplementation((key, def) => {
                if (key === 'runFileWorkingDirectory') return '${unknownToken}';
                if (key === 'requestTimeoutMs') return 1000;
                return def;
            });

            const cwd = client._resolveRunFileCwd('/tmp/project/script.do');
            expect(cwd).toEqual(path.normalize('/tmp/project'));
        });

        it('should resolve relative paths against workspace root when available', () => {
            const config = vscodeMock.workspace.getConfiguration();
            config.get.mockImplementation((key, def) => {
                if (key === 'runFileWorkingDirectory') return 'relative/run';
                if (key === 'requestTimeoutMs') return 1000;
                return def;
            });

            const cwd = client._resolveRunFileCwd('/tmp/project/script.do');
            expect(cwd).toEqual(path.normalize('/mock/workspace/relative/run'));
        });

        it('should resolve relative paths against process cwd when workspace is missing', () => {
            const config = vscodeMock.workspace.getConfiguration();
            const originalFolders = vscodeMock.workspace.workspaceFolders;
            vscodeMock.workspace.workspaceFolders = [];

            config.get.mockImplementation((key, def) => {
                if (key === 'runFileWorkingDirectory') return 'relative/run';
                if (key === 'requestTimeoutMs') return 1000;
                return def;
            });

            const cwd = client._resolveRunFileCwd('/tmp/project/script.do');
            expect(cwd).toEqual(path.normalize(path.resolve('relative/run')));

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


            const result = await client.listGraphs({ baseDir: '/tmp' });

            expect(Array.isArray(result.graphs)).toBe(true);
            expect(result.graphs.length).toBe(1);
            expect(result.graphs[0].label).toEqual('g1');
            expect(result.graphs[0].path).toEqual('/tmp/g1.pdf');
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

            expect(Array.isArray(result.graphs)).toBe(true);
            expect(result.graphs.length).toBe(2);

            const labels = result.graphs.map((g) => g.label);
            expect(labels).toEqual(expect.arrayContaining(['g1', 'g2']));
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

            expect(result.graphs.length).toBe(1);
            expect(result.graphs[0].label).toEqual('g_wrapped');
        });
    });

    describe('_formatRecentStderr', () => {
        it('should prioritize critical error lines', () => {
            const client = new McpClient();
            client._recentStderr = [
                '[mcp_stata] INFO: starting',
                '[mcp_stata] FATAL: STATA INITIALIZATION FAILED',
                'Error: RuntimeError("failed to initialize Stata")',
                '[mcp_stata] DEBUG: cleanup'
            ];

            const formatted = client._formatRecentStderr();
            expect(formatted).toContain('FATAL: STATA INITIALIZATION FAILED');
            expect(formatted).toContain('RuntimeError');
            expect(formatted).not.toContain('starting');
            expect(formatted).not.toContain('cleanup');
        });

        it('should fall back to last 5 lines if no critical lines found', () => {
            const client = new McpClient();
            client._recentStderr = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'];

            const formatted = client._formatRecentStderr();
            expect(formatted).toContain('L2');
            expect(formatted).toContain('L6');
            expect(formatted).not.toContain('L1');
        });

        it('should clear buffer on createClient', async () => {
            const client = new McpClient();
            client._recentStderr = ['OLD ERROR'];

            // We need to bypass the bridge check and SDK check to let it reach the stderr init
            // but the simplest is just to test that the line is there in the source.
            // Or we call it and let it fail, then check if it's cleared.
            try { await client._createClient(); } catch (e) { /* expected to fail in test env */ }

            expect(client._recentStderr).not.toContain('OLD ERROR');
            expect(client._recentStderr.length).toBe(0);
        });

        it('should clear buffer when various success signals are seen', () => {
            const client = new McpClient();

            const scenarios = [
                { msg: '[mcp_stata] INFO: StataClient initialized successfully', clearExpected: true },
                { msg: '[mcp_stata] INFO: Auto-discovered Stata at /path', clearExpected: true },
                { msg: '[mcp_stata] INFO: Discovery found Stata at: /path', clearExpected: true },
                { msg: '[mcp_stata] Pre-flight succeeded for /path', clearExpected: true },
                { msg: '[mcp_stata] INFO: starting up', clearExpected: false }
            ];

            for (const s of scenarios) {
                client._recentStderr = ['OLD ERROR'];
                client._handleStderrData(s.msg);
                if (s.clearExpected) {
                    expect(client._recentStderr).not.toContain('OLD ERROR');
                    expect(client._recentStderr[0]).toBe(s.msg);
                } else {
                    expect(client._recentStderr).toContain('OLD ERROR');
                    expect(client._recentStderr).toContain(s.msg);
                }
            }
        });
    });
});
