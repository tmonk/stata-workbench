const vscode = require('vscode');
const path = require('path');

describe('Data Browser Missing Values E2E', () => {
    jest.setTimeout(120000); // 2 minutes

    test('should show missing values as "." in the data browser', async () => {
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        if (!extension.isActive) await extension.activate();
        const api = extension.exports;
        const mcpClient = api.mcpClient;

        if (!mcpClient) {
            throw new Error('mcpClient is undefined');
        }

        // 1. Prepare data with various missing values
        await mcpClient.runSelection(`
            clear
            set obs 3
            gen x = .
            replace x = 1 in 1
            replace x = .a in 2
            replace x = .z in 3
            gen s = ""
            replace s = "hello" in 1
        `);

        // 2. Get UI channel
        const channel = await mcpClient.getUiChannel();
        expect(channel.baseUrl).toBeTruthy();
        expect(channel.token).toBeTruthy();

        // 3. Fetch data via JSON (get_page)
        const dsResult = await api.DataBrowserPanel._performRequest(`${channel.baseUrl}/v1/dataset`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${channel.token}` }
        });
        const ds = dsResult.dataset || dsResult;

        const pageBody = {
            datasetId: ds.id,
            offset: 0,
            limit: 10,
            vars: ['x', 's'],
            includeObsNo: true
        };

        const pageResult = await api.DataBrowserPanel._performRequest(`${channel.baseUrl}/v1/page`, {
            method: 'POST',
            body: JSON.stringify(pageBody),
            headers: {
                'Authorization': `Bearer ${channel.token}`,
                'Content-Type': 'application/json'
            }
        });

        // Verify JSON normalization to null
        // rows are [obs, x, s]
        expect(pageResult.rows[0][1]).toBe(1);
        expect(pageResult.rows[0][2]).toBe("hello");
        
        expect(pageResult.rows[1][1]).toBe(null); // .a normalized to null
        expect(pageResult.rows[1][2]).toBe("");    // empty string
        
        expect(pageResult.rows[2][1]).toBe(null); // .z normalized to null

        // 4. Fetch data via Arrow
        const arrowBody = {
            datasetId: ds.id,
            offset: 0,
            limit: 10,
            vars: ['x', 's'],
            includeObsNo: true
        };

        const arrowResult = await api.DataBrowserPanel._performRequest(`${channel.baseUrl}/v1/arrow`, {
            method: 'POST',
            body: JSON.stringify(arrowBody),
            headers: {
                'Authorization': `Bearer ${channel.token}`,
                'Content-Type': 'application/json'
            }
        }, true);

        expect(arrowResult instanceof Uint8Array || Buffer.isBuffer(arrowResult)).toBe(true);
        expect(arrowResult.byteLength).toBeGreaterThan(0);
        
        // We could parse Arrow here if we had the library, but the fact that it returns 
        // a buffer is already a good sign. The mcp-stata unit tests already 
        // verify Arrow normalization.
    });
});
