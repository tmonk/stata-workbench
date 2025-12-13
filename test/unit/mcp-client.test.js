const assert = require('chai').assert;
const sinon = require('sinon');
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

describe('McpClient', () => {
    let client;
    let mockClientInstance;

    beforeEach(() => {
        client = new McpClient({
            subscriptions: [],
            extensionUri: { fsPath: '/test/path' }
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

            const expectedDataUri = `data:image/png;base64,${Buffer.from('fake_image_data').toString('base64')}`;

            // Check simple_graph
            const simple = artifacts.find(a => a.label === 'simple_graph');
            assert.exists(simple);
            assert.equal(simple.path, '/tmp/simple_graph.pdf');
            assert.equal(simple.previewDataUri, expectedDataUri);

            // Check named_graph
            const named = artifacts.find(a => a.label === 'named_graph');
            assert.exists(named);
            assert.equal(named.path, '/tmp/named_graph.pdf');
            assert.equal(named.previewDataUri, expectedDataUri);


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
            assert.equal(args[0], 'run');
            assert.equal(args[5], true); // collectArtifacts flag
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

            assert.isArray(result.graphs);
            assert.lengthOf(result.graphs, 1);
            assert.equal(result.graphs[0].label, 'g1');
            assert.equal(result.graphs[0].path, '/tmp/g1.pdf');
            assert.include(result.graphs[0].previewDataUri, 'data:image/png;base64,');
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
