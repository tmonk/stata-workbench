const { describe, it, beforeEach, afterEach, expect, jest } = require('bun:test');
const sinon = require('sinon');
const vscodeMock = require('../mocks/vscode');

// Mock MCP SDK
const ClientMock = class {
    constructor() {
        this.connect = sinon.stub().resolves();
        this.callTool = sinon.stub().resolves({ content: [] });
        this.listTools = sinon.stub().resolves({ tools: [] });
    }
    setNotificationHandler() {}
};

const StdioClientTransportMock = class {
    constructor() { }
};

const { mock: bunMock } = require('bun:test');
bunMock.module('vscode', () => vscodeMock);
bunMock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: StdioClientTransportMock }));
bunMock.module('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: ClientMock }));
bunMock.module('@modelcontextprotocol/sdk/types', () => ({
    LoggingMessageNotificationSchema: {},
    ProgressNotificationSchema: {},
    CallToolResultSchema: {}
}));

const { StataMcpClient: McpClient } = require('../../src/mcp-client');

const waitForCondition = async (predicate, { timeoutMs = 500, intervalMs = 10 } = {}) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (predicate()) return true;
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
};

describe('McpClient Queue and Cancellation', () => {
    const createClient = () => {
        const client = new McpClient();
        client._log = () => {};
        client._ensureClient = sinon.stub().resolves(new ClientMock());
        client._availableTools = new Set(['run_command_background', 'break_session']);
        
        // Default mock for run_command_background
        client._callTool = sinon.stub().callsFake(async (c, name, args) => {
            if (name === 'run_command_background') {
                return {
                    task_id: 'task-' + Math.random(),
                    log_path: '/tmp/test.log'
                };
            }
            return {};
        });

        // Mock awaitTaskDone to resolve immediately or when we want
        client._awaitTaskDone = sinon.stub().resolves({ status: 'done' });
        client._drainActiveRunLog = sinon.stub().resolves();
        return client;
    };

    describe('Queue Serialization', () => {
        it('should execute commands sequentially', async () => {
            const client = createClient();
            const executionOrder = [];
            
            client._callTool = sinon.stub().callsFake(async (c, name, args) => {
                const cmd = args.code;
                executionOrder.push('start:' + cmd);
                // Artificial delay to ensure overlap if not serialized
                await new Promise(r => setTimeout(r, 10));
                executionOrder.push('end:' + cmd);
                return { task_id: 't-' + cmd };
            });

            // Start multiple runs without awaiting
            const p1 = client.runSelection('cmd1');
            const p2 = client.runSelection('cmd2');
            const p3 = client.runSelection('cmd3');

            await Promise.all([p1, p2, p3]);

            expect(executionOrder).toEqual([
                'start:cmd1', 'end:cmd1',
                'start:cmd2', 'end:cmd2',
                'start:cmd3', 'end:cmd3'
            ]);
        });

        it('should emit "queued" status when multiple tasks are pending', async () => {
            const client = createClient();
            const statuses = [];
            client.onStatusChanged(s => statuses.push(s));

            // Setup a slow task
            let resolveSlow;
            const slowTaskPromise = new Promise(r => resolveSlow = r);
            client._callTool = sinon.stub().callsFake(async () => {
                await slowTaskPromise;
                return { task_id: 'slow' };
            });

            const p1 = client.runSelection('slow');
            const p2 = client.runSelection('waiting');

            // Give it a moment to process the first task and queue the second
            await new Promise(r => setTimeout(r, 10));

            expect(statuses).toContain('queued');
            
            resolveSlow();
            await Promise.all([p1, p2]);
            expect(statuses[statuses.length - 1]).toBe('connected');
        });
    });

    describe('Cancellation by runId', () => {
        it('should cancel a queued task by runId', async () => {
            const client = createClient();
            // Block the first task to keep the second in queue
            let resolveFirst;
            const firstPromise = new Promise(r => resolveFirst = r);
            client._callTool = sinon.stub().callsFake(async (c, name, args) => {
                if (args.code === 'first') {
                    await firstPromise;
                    return { task_id: 'first-id' };
                }
                return { task_id: 'cancelled-id' };
            });

            const p1 = client.runSelection('first', { runId: 'run-1' });
            const p2 = client.runSelection('second', { runId: 'run-2' });

            const queued = await waitForCondition(() => client._cancellationSourcesByRunId.has('run-2'), { timeoutMs: 1000 });
            expect(queued).toBe(true);

            // Cancel the second one while it's in queue
            const cancelled = await client.cancelRun('run-2');
            expect(cancelled).toBe(true);

            resolveFirst();
            await p1;

            // p2 should throw a cancellation error
            try {
                await p2;
                expect.fail('p2 should have been cancelled');
            } catch (err) {
                expect(err.message).toMatch(/cancelled/);
            }
        });

        it('should cancel an active task by runId and call break_session', async () => {
            const client = createClient();
            let resolveFirst;
            const firstPromise = new Promise(r => resolveFirst = r);
            
            client._callTool = sinon.stub().callsFake(async (c, name) => {
                if (name === 'run_command_background') {
                    return { task_id: 'active-task' };
                }
                return {};
            });

            // Mock _awaitTaskDone to wait for our signal
            client._awaitTaskDone = sinon.stub().callsFake(() => firstPromise);
            
            // Mock _breakSession to verify it's called
            client._breakSession = sinon.stub().resolves();

            const p1 = client.runSelection('active', { runId: 'run-1' });

            const started = await waitForCondition(() => client._activeRun?._runId === 'run-1', { timeoutMs: 1000 });
            expect(started).toBe(true);

            const cancelled = await client.cancelRun('run-1');
            expect(cancelled).toBe(true);

            try {
                await p1;
            } catch (err) {
                // Expected
            }

            expect(client._breakSession.calledOnce).toBe(true);
        });

        it('should suppress output after cancellation', async () => {
            const client = createClient();
            const onLog = sinon.stub();
            const runId = 'cancel-me';
            
            // Task that stays active
            client._awaitTaskDone = sinon.stub().returns(new Promise(() => {}));
            
            const p1 = client.runSelection('output', { runId, onLog });

            const started = await waitForCondition(() => client._activeRun?._runId === runId, { timeoutMs: 1000 });
            expect(started).toBe(true);
            const run = client._activeRun;
            expect(run).toBeTruthy();

            // Cancel it
            await client.cancelRun(runId);
            expect(run._cancelled).toBe(true);

            // Try to send a log message
            client._onLoggingMessage({}, {
                params: { data: { event: 'logMessage', data: 'should not see this' } }
            });

            expect(onLog.called).toBe(false);

            try { await p1; } catch (e) {}
        });
    });

    describe('Tool Name Mapping', () => {
        it('should resolve tool names based on discovered mapping', async () => {
            const client = createClient();
            // Mock listTools to return prefixed names
            const mockClient = new ClientMock();
            mockClient.listTools.resolves({
                tools: [
                    { name: 'mcp_stata_run_command_background' },
                    { name: 'mcp_stata_break_session' }
                ]
            });
            client._ensureClient = sinon.stub().resolves(mockClient);

            // Connect to trigger tool discovery
            await client._ensureClient(); // Usually called by _callTool but let's be explicit
            await client._refreshToolList(mockClient);

            expect(client._resolveToolName('run_command_background')).toBe('mcp_stata_run_command_background');
            expect(client._resolveToolName('break_session')).toBe('mcp_stata_break_session');
        });

        it('should use resolved name in _callTool', async () => {
            const client = createClient();
            // Restore real _callTool for this test
            client._callTool = McpClient.prototype._callTool.bind(client);
            client._ensureClient = sinon.stub().resolves({ type: 'standard' });
            
            client._toolMapping = new Map([['break_session', 'prefixed_break']]);
            client._availableTools = new Set(['prefixed_break']);
            
            const callToolStub = sinon.stub().resolves({});
            const mockClient = { callTool: callToolStub, type: 'standard' };

            await client._callTool(mockClient, 'break_session', { session_id: 'default' });

            expect(callToolStub.calledOnce).toBe(true);
            expect(callToolStub.firstCall.args[0].name).toBe('prefixed_break');
        });
    });

    describe('Stop Functionality', () => {
        it('cancelAll should cancel all queued and active tasks', async () => {
            const client = createClient();
            client._breakSession = sinon.stub().resolves();
            client._ensureClient = sinon.stub().resolves({});
            client._clientPromise = Promise.resolve({}); // Ensure it doesn't return false early
            
            // Mock _callTool to avoid real network/MCP calls
            client._callTool = sinon.stub().resolves({ content: [{ type: 'text', text: '{}' }] });

            const p1 = client.runSelection('cmd1', { runId: 'r1' });
            const p2 = client.runSelection('cmd2', { runId: 'r2' });

            // Small delay to ensure p1 has actually started its work loop
            await new Promise(r => setTimeout(r, 10));

            const cancelPromise = client.cancelAll();
            
            await cancelPromise;
            
            await Promise.allSettled([p1, p2]);

            expect(client._pending).toBe(0);
        });
    });
});
