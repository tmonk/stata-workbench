const { expect, describe, it, beforeEach, afterEach, mock: bunMock } = require("bun:test");
const sinon = require("sinon");
const vscodeMock = require("../mocks/vscode");
bunMock.module('vscode', () => vscodeMock);

const { StataMcpClient: McpClient } = require("../../src/mcp-client");

const waitForCondition = async (predicate, { timeoutMs = 500, intervalMs = 10 } = {}) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (predicate()) return true;
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
};

describe("McpClient Break Session", () => {
    const createClient = () => {
        const client = new McpClient();
        client.setLogger(console.log);
        // Mock vscode workspace configuration
        vscodeMock.workspace.getConfiguration = () => ({
            get: (_key, def) => def
        });
        client._availableTools = new Set(['run_command_background', 'break_session']);
        return client;
    };

    it("should successfully break a long-running forvalues loop", async () => {
        const client = createClient();
        const longRunningCode = `forvalues i = 1/10000 {
    di \`i'
    sleep 1
}`;
        
        // Mock internal implementation for the test
        client._ensureClient = sinon.stub().resolves({ type: 'standard', callTool: sinon.stub().resolves({}) });
        
        // Use real _callTool but monitor its calls
        const callToolSpy = sinon.spy(client, '_callTool');

        // 1. Initial kickoff returns a task_id
        // We need to return a result that the real _callTool would return
        // Since we are using the REAL _callTool, we need to mock the client it calls.
        const mockClient = { 
            type: 'standard', 
            callTool: sinon.stub().callsFake(async ({ name }) => {
                if (name.includes('run_command_background')) {
                    return { task_id: 'task-long-running', log_path: '/tmp/stata.log' };
                }
                return {};
            })
        };
        client._ensureClient = sinon.stub().resolves(mockClient);

        // Mock background helpers
        client._awaitTaskDone = sinon.stub().returns(new Promise(() => {}));
        client._drainActiveRunLog = sinon.stub().resolves();
        client._ensureLogTail = sinon.stub().resolves();

        // Start the run
        const runPromise = client.runSelection(longRunningCode);

        // Wait for it to "start" and set taskId
        const ready = await waitForCondition(() => !!client._activeRun, { timeoutMs: 1000 });
        expect(ready).toBe(true);

        // Use the actual run state
        const activeRun = client._activeRun;
        expect(activeRun).toBeDefined();
        if (activeRun.taskId) {
            expect(activeRun.taskId).toBe('task-long-running');
        }

        // Track how many times _callTool is called
        const callCountBefore = callToolSpy.callCount;

        // Now trigger cancellation via cancelAll (which uses break_session)
        const cancelPromise = client.cancelAll();
        
        // Ensure we catch the rejection of the runPromise
        try {
            await runPromise;
        } catch (e) {
            // Expected
        }

        const cancelled = await cancelPromise;
        expect(cancelled).toBe(true);

        // Verify break_session tool was called on the mock client
        const breakCalls = mockClient.callTool.getCalls().filter(c => c.args[0].name.includes('break_session'));
        expect(breakCalls.length).toBeGreaterThan(0);
    });

    it("should allow sending a NEW command immediately after break_session and NOT cancel it", async () => {
        const client = createClient();
        client._ensureClient = sinon.stub().resolves({ type: 'standard' });
        
        // Mock _callTool
        const callToolStub = sinon.stub();
        client._callTool = callToolStub;

        // Long running task details
        callToolStub.withArgs(sinon.match.any, 'run_command_background', sinon.match({ code: sinon.match(/forvalues/) }))
            .resolves({ task_id: 'task-1', log_path: '/tmp/1.log' });

        // Second task details
        callToolStub.withArgs(sinon.match.any, 'run_command_background', sinon.match({ code: 'di "After Break"' }))
            .resolves({ rc: 0, stdout: 'After Break\n' });

        // break_session takes some time
        callToolStub.withArgs(sinon.match.any, 'break_session', sinon.match.any).callsFake(async () => {
            await new Promise(r => setTimeout(r, 10));
            return {};
        });

        // Mock background helpers
        client._drainActiveRunLog = sinon.stub().resolves();
        client._ensureLogTail = sinon.stub().resolves();
        
        // Mock _awaitTaskDone: first one hangs, second one resolves immediately
        const awaitTaskDoneStub = sinon.stub();
        client._awaitTaskDone = awaitTaskDoneStub;
        awaitTaskDoneStub.onCall(0).returns(new Promise(() => {}));
        awaitTaskDoneStub.onCall(1).resolves({ rc: 0, stdout: 'After Break\n' });

        // 1. Start long running task
        const p1 = client.runSelection('forvalues i = 1/10000 { di `i\' }');
        // Attach catch immediately to prevent unhandled rejection in test runner environment
        p1.catch(() => {});
        
        const started = await waitForCondition(() => !!client._activeRun, { timeoutMs: 1000 });
        expect(started).toBe(true);

        // 2. Break it
        await client.cancelAll();
        
        // 3. Start new command AFTER cancelAll has finished
        const p2 = client.runSelection('di "After Break"');
        
        // p1 should reject
        try { 
            await p1; 
        } catch (e) {
            expect(e.message).toMatch(/cancelled/);
        }

        const result2 = await p2;
        expect(result2.stdout).toContain('After Break');
    });
});
