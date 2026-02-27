const assert = require('assert');
const http = require('http');
const proxyquire = require('proxyquire');
const { describe, it, beforeAll, afterAll, beforeEach } = require('bun:test');

// Mock vscode module since DataBrowserPanel requires it
const vscodeMock = {
    window: {},
    workspace: {},
    Uri: {}
};

const mcpClientMock = {
    client: {}
};

const { DataBrowserPanel, _performRequest } = proxyquire('../../src/data-browser-panel', {
    'vscode': vscodeMock,
    './mcp-client': mcpClientMock
});

describe('DataBrowserPanel Concurrency', () => {
    let mockServer;
    let mockServerUrl;
    let requestCount = 0;

    beforeAll((done) => {
        // Create a mock server that simulates delay to test concurrency
        mockServer = http.createServer((req, res) => {
            requestCount++;
            // Simulate 500ms processing delay
            setTimeout(() => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, count: requestCount }));
            }, 500);
        });

        mockServer.listen(0, () => {
            const port = mockServer.address().port;
            mockServerUrl = `http://127.0.0.1:${port}`;
            done();
        });
    });

    afterAll((done) => {
        if (mockServer) {
            mockServer.close(done);
        } else {
            done();
        }
    });

    beforeEach(() => {
        requestCount = 0;
    });

    it('should handle concurrent API proxy requests efficiently', async () => {
        const start = Date.now();

        // Fire 5 requests simultaneously
        const promises = [];
        for (let i = 0; i < 5; i++) {
            promises.push(_performRequest(`${mockServerUrl}/v1/dataset`, {
                method: 'GET',
                headers: { 'Authorization': 'Bearer test-token' }
            }, false));
        }

        const results = await Promise.all(promises);
        const duration = Date.now() - start;

        // Verify all succeeded
        assert.equal(results.length, 5);
        results.forEach(res => {
            assert.equal(res.success, true);
        });

        // The mock server sleeps for 500ms. If requests are serial, 5 requests = 2500ms.
        // If concurrent, it should be just over 500ms.
        assert.ok(duration < 1500, `Requests took ${duration}ms, suggesting serial execution.`);
    });
});
