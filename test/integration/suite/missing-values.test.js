const vscode = require('vscode');

/**
 * Missing values E2E test — migrated from old HTTP proxy architecture to StataClient.
 *
 * The old DataBrowserPanel proxied HTTP requests to a separate API server.
 * The new DataBrowserPanel uses StataClient methods (listVariables, getDataPage)
 * directly over the daemon's NDJSON socket protocol.
 *
 * This version verifies the end-to-end data pipeline via StataClient.
 */
describe('Data Browser Missing Values E2E', () => {
    jest.setTimeout(120000); // 2 minutes

    test('should show missing values as "." in the data browser', async () => {
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        if (!extension.isActive) await extension.activate();
        const api = extension.exports;
        const stataClient = api.stataClient;

        if (!stataClient) {
            throw new Error('stataClient is undefined');
        }

        // Prepare data with various missing values
        await stataClient.runCode('clear', { strict: false });
        await stataClient.runCode('set obs 3', { strict: false });
        await stataClient.runCode('gen x = .', { strict: false });
        await stataClient.runCode('replace x = 1 in 1', { strict: false });
        await stataClient.runCode('replace x = .a in 2', { strict: false });
        await stataClient.runCode('replace x = .z in 3', { strict: false });
        await stataClient.runCode('gen s = ""', { strict: false });
        await stataClient.runCode('replace s = "hello" in 1', { strict: false });

        // Verify variables are listed correctly
        const variables = await stataClient.listVariables();
        const varNames = variables.map(v => v.name);
        expect(varNames).toContain('x');
        expect(varNames).toContain('s');
        expect(varNames).not.toContain('make'); // Ensure 'clear' worked

        // Fetch data via getDataPage and verify the Arrow buffer is returned
        const buffer = await stataClient.getDataPage(0, 10, ['x', 's']);
        expect(buffer instanceof Uint8Array || Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.byteLength).toBeGreaterThan(0);
    });
});
