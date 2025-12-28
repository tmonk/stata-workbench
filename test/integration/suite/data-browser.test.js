const vscode = require('vscode');
const http = require('http');

describe('Data Browser Integration', () => {
    jest.setTimeout(60000);
    const enabled = process.env.MCP_STATA_INTEGRATION === '1';
    let dummyServer;
    let dummyUrl;

    beforeEach(async () => {
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
                } else if (req.url === '/v1/arrow') {
                    // Small Arrow IPC stream
                    const { tableToIPC, tableFromArrays } = require('apache-arrow');
                    const table = tableFromArrays({ a: [1, 2, 3] });
                    const buffer = tableToIPC(table);
                    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                    res.end(buffer);
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

    afterEach(async () => {
        // Close dummy server properly
        if (dummyServer) {
            await new Promise((resolve, reject) => {
                dummyServer.close((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            dummyServer = null;
        }

        // Close any open webview panels
        try {
            const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
            if (extension && extension.isActive) {
                const api = extension.exports;
                if (api && api.DataBrowserPanel && api.DataBrowserPanel.currentPanel) {
                    api.DataBrowserPanel.currentPanel.dispose();
                }
            }
        } catch (err) {
            // Ignore cleanup errors
        }

        // Clear any timers
        jest.clearAllTimers();
    });

    test('DataBrowserPanel should proxy API requests correctly', async () => {
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        if (!extension.isActive) await extension.activate();
        const api = extension.exports;

        // Open the panel
        await vscode.commands.executeCommand('stata-workbench.viewData');
        const panel = api.DataBrowserPanel.currentPanel;
        expect(panel).toBeTruthy();

        const result = await api.DataBrowserPanel._performRequest(`${dummyUrl}/v1/dataset`, { method: 'GET' });
        expect(result).toEqual({ dataset: { id: 'test-id', n: 50, frame: 'default' } });
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

        expect(result).toEqual(bodyObj);
    });

    test('DataBrowserPanel proxy should handle binary Arrow IPC responses', async () => {
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        const api = extension.exports;

        const result = await api.DataBrowserPanel._performRequest(`${dummyUrl}/v1/arrow`, { method: 'POST' }, true);

        expect(result instanceof Uint8Array).toBe(true);
        expect(result.byteLength).toBeGreaterThan(0);
    });

    test('DataBrowserPanel should work with LIVE server if configured', async () => {
        if (process.env.MCP_STATA_LIVE !== '1') {
            console.log('Skipping live server test (MCP_STATA_LIVE !== 1)');
            return;
        }

        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        if (!extension.isActive) await extension.activate();
        const api = extension.exports;
        console.log('[Live Test] Extension API keys:', Object.keys(api || {}));
        const mcpClient = api.mcpClient;

        if (!mcpClient) {
            throw new Error(`mcpClient is undefined in extension.exports! Keys: ${Object.keys(api || {}).join(', ')}`);
        }

        // Wait for client to be ready and get UI channel
        console.log('[Live Test] Fetching UI channel from real MCP server...');
        const channel = await mcpClient.getUiChannel();
        expect(channel.baseUrl).toBeTruthy();
        expect(channel.token).toBeTruthy();

        console.log(`[Live Test] Real Server BaseURL: ${channel.baseUrl}`);

        // Load some data first
        console.log('[Live Test] Loading auto.dta...');
        await mcpClient.runSelection('sysuse auto, clear');

        // Try /v1/dataset first
        const dsResult = await api.DataBrowserPanel._performRequest(`${channel.baseUrl}/v1/dataset`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${channel.token}` }
        });
        const ds = dsResult.dataset || dsResult;

        // Fetch data via arrow
        const endpoint = `${channel.baseUrl}/v1/arrow`;
        const body = {
            datasetId: ds.id,
            frame: ds.frame || 'default',
            limit: 10
        };

        const result = await api.DataBrowserPanel._performRequest(endpoint, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: {
                'Authorization': `Bearer ${channel.token}`,
                'Content-Type': 'application/json'
            }
        }, true);

        expect(result instanceof Uint8Array || Buffer.isBuffer(result)).toBe(true);
        expect(result.byteLength).toBeGreaterThan(0);
        console.log(`[Live Test] Successfully fetched ${result.byteLength} bytes of Arrow data from real server.`);
    });

    test('DataBrowserPanel proxy should handle errors', async () => {
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        const api = extension.exports;

        await expect(
            api.DataBrowserPanel._performRequest(`${dummyUrl}/v1/error`, { method: 'GET' })
        ).rejects.toThrow('API Request Failed (400)');
    });
});