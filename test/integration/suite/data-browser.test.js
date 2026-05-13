const vscode = require('vscode');

describe('Data Browser Integration', () => {
    jest.setTimeout(60000);

    afterEach(async () => {
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

    test('DataBrowserPanel should work with LIVE server if configured', async () => {
        if (process.env.STATA_AGENT_LIVE !== '1') {
            console.log('Skipping live server test (STATA_AGENT_LIVE !== 1)');
            return;
        }

        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        if (!extension.isActive) await extension.activate();
        const api = extension.exports;
        console.log('[Live Test] Extension API keys:', Object.keys(api || {}));
        const stataClient = api.stataClient;

        if (!stataClient) {
            throw new Error(`stataClient is undefined in extension.exports! Keys: ${Object.keys(api || {}).join(', ')}`);
        }

        // Load some data first
        console.log('[Live Test] Loading auto.dta...');
        await stataClient.runCode('sysuse auto, clear');

        // Verify dataset state
        console.log('[Live Test] Fetching dataset state...');
        const state = await stataClient.getDatasetState();
        expect(state.obs_count).toBeGreaterThan(0);
        expect(state.var_count).toBeGreaterThan(0);
        console.log(`[Live Test] Dataset: ${state.obs_count} obs, ${state.var_count} vars`);

        // List variables
        const variables = await stataClient.listVariables();
        expect(variables.length).toBeGreaterThan(0);
        const varNames = variables.map(v => v.name);
        console.log(`[Live Test] Variables: ${varNames.slice(0, 10).join(', ')}...`);

        // Fetch data via StataClient
        const varlist = varNames.slice(0, 5);
        const result = await stataClient.getDataPage(0, 10, varlist);
        expect(result instanceof Uint8Array || Buffer.isBuffer(result)).toBe(true);
        expect(result.byteLength).toBeGreaterThan(0);
        console.log(`[Live Test] Successfully fetched ${result.byteLength} bytes of Arrow data from StataClient.`);
    });

});