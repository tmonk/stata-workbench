const assert = require('chai').assert;
const vscode = require('vscode');
const http = require('http');

suite('Data Browser Integration', function () {
    this.timeout(60000);

    const enabled = process.env.MCP_STATA_INTEGRATION === '1';

    let dummyServer;
    let dummyUrl;

    setup(async () => {
        // Start a dummy HTTP server to act as the Stata API for proxy tests
        // This ensures the test is reliable even if Stata isn't running
        await new Promise(resolve => {
            dummyServer = http.createServer((req, res) => {
                if (req.url === '/v1/dataset') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ dataset: { id: 'test-id', n: 50, frame: 'default' } }));
                } else if (req.url === '/v1/error') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'bad request' }));
                } else if (req.url === '/v1/echo') {
                    let body = '';
                    req.on('data', chunk => body += chunk);
                    req.on('end', () => {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(body); // Echo back
                    });
                } else {
                    res.writeHead(404);
                    res.end();
                }
            });
            dummyServer.listen(0, '127.0.0.1', () => {
                const addr = dummyServer.address();
                dummyUrl = `http://127.0.0.1:${addr.port}`;
                resolve();
            });
        });
    });

    teardown(() => {
        if (dummyServer) dummyServer.close();
    });

    test('DataBrowserPanel should proxy API requests correctly', async () => {
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        if (!extension.isActive) await extension.activate();
        const api = extension.exports;

        // Open the panel
        await vscode.commands.executeCommand('stata-workbench.viewData');
        const panel = api.DataBrowserPanel.currentPanel;
        assert.ok(panel, 'Panel should be open');

        const result = await api.DataBrowserPanel._performRequest(`${dummyUrl}/v1/dataset`, { method: 'GET' });
        assert.deepEqual(result, { dataset: { id: 'test-id', n: 50, frame: 'default' } });
    });

    test('DataBrowserPanel proxy should handle POST requests with body', async () => {
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        const api = extension.exports;

        const bodyObj = { foo: 'bar', limit: 100 };
        const bodyStr = JSON.stringify(bodyObj);

        const result = await api.DataBrowserPanel._performRequest(`${dummyUrl}/v1/echo`, { 
            method: 'POST',
            body: bodyStr,
            headers: { 'Content-Type': 'application/json' }
        });
        
        assert.deepEqual(result, bodyObj);
    });

    test('DataBrowserPanel proxy should handle errors', async () => {
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        const api = extension.exports;

        try {
            await api.DataBrowserPanel._performRequest(`${dummyUrl}/v1/error`, { method: 'GET' });
            assert.fail('Should have thrown an error');
        } catch (err) {
            assert.include(err.message, 'API Request Failed (400)');
        }
    });
});
