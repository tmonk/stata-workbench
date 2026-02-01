const { expect, describe, it, beforeEach, afterEach } = require("bun:test");
const sinon = require("sinon");
const { StataMcpClient: McpClient } = require("../../src/mcp-client");
const vscode = require("../mocks/vscode");

describe("McpClient Break Session", () => {
    let client;

    beforeEach(() => {
        client = new McpClient();
        // Mock vscode workspace configuration
        sinon.stub(vscode.workspace, "getConfiguration").returns({
            get: (key, def) => def
        });
        client._availableTools = new Set(['run_command_background', 'break_session']);
    });

    afterEach(() => {
        sinon.restore();
    });

    it("should successfully break a long-running forvalues loop", async () => {
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

        // Wait a bit for it to "start" and set taskId
        await new Promise(r => setTimeout(r, 100));

        // Use the actual run state
        const activeRun = client._activeRun;
        expect(activeRun).toBeDefined();
        expect(activeRun.taskId).toBe('task-long-running');

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

    it("should allow sending a NEW command immediately after break_session", async () => {
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

        callToolStub.withArgs(sinon.match.any, 'break_session', sinon.match.any).resolves({});

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
        await new Promise(r => setTimeout(r, 50));

        // 2. Break it
        await client.cancelAll();
        expect(callToolStub.calledWith(sinon.match.any, 'break_session', sinon.match.any)).toBe(true);
        
        try { await p1; } catch (e) {}

        // 3. Run new command - should NOT be blocked by the previous one anymore
        const p2 = await client.runSelection('di "After Break"');
        
        expect(p2.stdout).toContain('After Break');
        expect(callToolStub.calledWith(sinon.match.any, 'run_command_background', sinon.match({ code: 'di "After Break"' }))).toBe(true);
    });
});
