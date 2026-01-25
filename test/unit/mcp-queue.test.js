const { describe, it, beforeEach, expect, jest } = require('bun:test');
const sinon = require('sinon');
const { StataMcpClient } = require('../../src/mcp-client');
const vscodeMock = require('../mocks/vscode');

// We need to mock the entire MCP environment similar to mcp-client.test.js
// but we'll focus on the queueing logic.

describe('StataMcpClient Queueing', () => {
    let client;

    beforeEach(() => {
        client = new StataMcpClient();
        // Mock _ensureClient to return a fake client immediately
        client._ensureClient = sinon.stub().resolves({
            callTool: sinon.stub().resolves({ content: [] }),
            request: sinon.stub().resolves({ content: [] })
        });
        
        // Mock vscode configuration
        vscodeMock.workspace.getConfiguration = sinon.stub().returns({
            get: (key, def) => def
        });
    });

    it('should serialize multiple calls', async () => {
        const executionOrder = [];
        
        const task1 = async () => {
            executionOrder.push('start1');
            await new Promise(resolve => setTimeout(resolve, 50));
            executionOrder.push('end1');
            return { success: true };
        };

        const task2 = async () => {
            executionOrder.push('start2');
            await new Promise(resolve => setTimeout(resolve, 10));
            executionOrder.push('end2');
            return { success: true };
        };

        // Fire both without awaiting
        const p1 = client._enqueue('task1', {}, task1);
        const p2 = client._enqueue('task2', {}, task2);

        await Promise.all([p1, p2]);

        expect(executionOrder).toEqual(['start1', 'end1', 'start2', 'end2']);
    });

    it('should emit correct status transitions during queuing', async () => {
        const statuses = [];
        client.onStatusChanged(s => statuses.push(s));

        const task1 = async () => {
            await new Promise(resolve => setTimeout(resolve, 50));
            return { success: true };
        };

        const task2 = async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            return { success: true };
        };

        // Initially no status emitted yet (or idle)
        const p1 = client._enqueue('task1', {}, task1);
        // p1 starts immediately in the promise chain
        // statuses should have 'running' (from first work starting) or 'idle'/'queued' from enqueue
        
        const p2 = client._enqueue('task2', {}, task2);
        
        await Promise.all([p1, p2]);

        // Expected transitions:
        // 1. Enqueue task1 -> _pending: 1 -> status: 'idle' (since _active is false)
        // 2. task1 starts work -> _active: true -> status: 'running'
        // 3. Enqueue task2 -> _pending: 2 -> status: 'queued'
        // 4. task1 ends -> _pending: 1 -> _active: false -> status: 'queued'
        // 5. task2 starts work -> _active: true -> status: 'running'
        // 6. task2 ends -> _pending: 0 -> _active: false -> status: 'connected'

        expect(statuses).toContain('running');
        expect(statuses).toContain('queued');
        expect(statuses[statuses.length - 1]).toEqual('connected');
    });

    it('should call onStarted when task actually begins', async () => {
        let started1 = false;
        let started2 = false;

        const task1 = async () => {
            await new Promise(resolve => setTimeout(resolve, 50));
            return { content: [] };
        };

        const task2 = async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            return { content: [] };
        };

        // We use the public RAPs that call _enqueue
        // We need to stub _callTool to avoid actual MCP calls if we use runSelection/runFile
        client._callTool = sinon.stub().callsFake(async () => {
            await new Promise(resolve => setTimeout(resolve, 50));
            return { content: [] };
        });
        client._awaitBackgroundResult = sinon.stub().resolves({ success: true });
        client._drainActiveRunLog = sinon.stub().resolves();

        const p1 = client.run('code1', { onStarted: () => { started1 = true; } });
        const p2 = client.run('code2', { onStarted: () => { started2 = true; } });

        // Wait a tiny bit for p1 work to start but p1 shouldn't be finished yet because _callTool takes 50ms
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(started1).toBe(true);
        // started2 should be false because task1 is still running in _callTool
        expect(started2).toBe(false);

        await p1;
        // After p1 finished, p2 should have started
        expect(started2).toBe(true);

        await p2;
    });

    it('should handle cancellation of queued tasks', async () => {
        const task1 = async () => {
            await new Promise(resolve => setTimeout(resolve, 50));
            return { content: [] };
        };

        const task2 = sinon.spy(async () => {
            return { content: [] };
        });

        const cts1 = client._createCancellationSource();
        const cts2 = client._createCancellationSource();

        const p1 = client._enqueue('task1', { cancellationSource: cts1, cancellationToken: cts1.token }, task1);
        const p2 = client._enqueue('task2', { cancellationSource: cts2, cancellationToken: cts2.token }, task2);
        // Prevent unhandled rejection in test
        p2.catch(() => {});

        // Cancel task 2 immediately while it's in the queue
        cts2.cancel();

        await p1;
        
        let errorThrown = false;
        try {
            await p2;
        } catch (e) {
            errorThrown = true;
            expect(e.message).toContain('cancelled');
        }

        expect(errorThrown).toBe(true);
        expect(task2.called).toBe(false);
    });
});
