const { describe, it, beforeEach, afterEach, expect, jest } = require('bun:test');
const sinon = require('sinon');
const path = require('path');
const fs = require('fs');
const os = require('os');
const proxyquire = require('proxyquire');
const vscodeMock = require('../mocks/vscode');

// Mock MCP SDK
const ClientMock = class {
    constructor() {
        this.connect = sinon.stub().resolves();
        this.listTools = sinon.stub().resolves({ tools: [] });
        this.callTool = sinon.stub().resolves({ content: [] });
        this.request = sinon.stub().resolves({ content: [] });
    }
};

const StdioClientTransportMock = class {
    constructor() { }
};

// Load McpClient with mocks
const { StataMcpClient: McpClient } = proxyquire.noCallThru().noPreserveCache().load('../../src/mcp-client', {
    'vscode': vscodeMock,
    'fs': {
        existsSync: sinon.stub().returns(true),
        readFileSync: sinon.stub().returns('{"servers": {"mcp_stata": {"command": "custom-cmd", "args": ["--custom"], "env": {"FOO": "BAR"}}}}')
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

describe('McpClient Auto-Refresh', () => {
    let client;

    beforeEach(() => {
        client = new McpClient();
        vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: '/mock/workspace' } }];
    });

    it('forces latest server when required tools are missing', async () => {
        const firstClient = new ClientMock();
        // First client returns old tools
        firstClient.listTools.resolves({
            tools: [
                { name: 'run_command' },
                { name: 'get_data' }
            ]
        });

        const secondClient = new ClientMock();
        // Second client returns new tools
        secondClient.listTools.resolves({
            tools: [
                { name: 'run_command_background' },
                { name: 'run_do_file_background' },
                { name: 'get_ui_channel' }
            ]
        });

        let clientCount = 0;
        const ensureClientStub = sinon.stub(client, '_ensureClient').callsFake(async () => {
            clientCount++;
            const c = clientCount === 1 ? firstClient : secondClient;
            // Simulate the refresh tool list that happens in _createClient
            await client._refreshToolList(c);
            return c;
        });

        const logSpy = sinon.spy(client, '_log');

        // We don't stub _enqueue, because we want it to call _ensureClient
        // But we DO need to mock _withActiveRun and _awaitBackgroundResult 
        // because we're not actually running a background process
        const withActiveRunStub = sinon.stub(client, '_withActiveRun').callsFake((_run, fn) => fn());
        const awaitBackgroundResultStub = sinon.stub(client, '_awaitBackgroundResult').resolves({ success: true });
        
        await client.run('sysuse auto');

        // Should have called _ensureClient twice:
        // 1. In _enqueue
        // 2. In _callTool (because run_command_background was missing)
        expect(clientCount).toBe(2);
        
        // Check logs for forcing latest server
        const forceLog = logSpy.getCalls().find(c => c.args[0].includes('Forcing refresh'));
        expect(forceLog).toBeDefined();
        expect(client._forceLatestServer).toBe(true);
    });

    it('preserves env while ignoring command/args during forced refresh', () => {
        client._forceLatestServer = true;
        
        // Use a real temporary file instead of relying on broken fs mock in Bun/proxyquire
        const tmpFile = path.join(os.tmpdir(), `mcp_test_${Date.now()}.json`);
        fs.writeFileSync(tmpFile, JSON.stringify({
            servers: {
                mcp_stata: {
                    command: "ignore-me",
                    args: ["--ignore"],
                    env: { "FOO": "BAR" }
                }
            }
        }));
        
        try {
            sinon.stub(client, '_candidateMcpConfigPaths').returns([tmpFile]);
            
            const config = client._loadServerConfig({ ignoreCommandArgs: true });
            
            expect(config.env).toEqual({ FOO: 'BAR' });
            expect(config.command).toBeNull();
            expect(config.args).toBeNull();
        } finally {
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        }
    });

    it('throws explicit error if tools still missing after refresh', async () => {
        const singletonClient = new ClientMock();
        singletonClient.listTools.resolves({
            tools: [{ name: 'run_command' }] // Missing background tools
        });

        sinon.stub(client, '_ensureClient').callsFake(async () => {
            await client._refreshToolList(singletonClient);
            return singletonClient;
        });
        
        // We don't stub _enqueue, so it uses our _ensureClient stub
        
        try {
            await client.run('sysuse auto');
            throw new Error('Should have failed');
        } catch (err) {
            expect(err.message.toLowerCase()).toContain('required tools: run_command_background');
            expect(err.message).toContain('Available tools: run_command');
        }
    });
});
