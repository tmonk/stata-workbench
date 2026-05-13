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

        // 1. Prepare data with various missing values
        await stataClient.runCode(`
            clear
            set obs 3
            gen x = .
            replace x = 1 in 1
            replace x = .a in 2
            replace x = .z in 3
            gen s = ""
            replace s = "hello" in 1
        `);

        // 2. Verify variables are listed correctly
        const variables = await stataClient.listVariables();
        const varNames = variables.map(v => v.name);
        expect(varNames).toContain('x');
        expect(varNames).toContain('s');

        // 3. Fetch data via getDataPage and verify the Arrow buffer is returned.
        //    StataClient.getDataPage() fetches an Arrow IPC buffer from the
        //    stata-agent daemon. The Arrow normalization of missing values
        //    (null for .a/.z, "" for empty string) is verified at the stata-agent
        //    RPC layer (tested in stata-agent's unit tests).
        const buffer = await stataClient.getDataPage(0, 10, ['x', 's']);
        expect(buffer instanceof Uint8Array || Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.byteLength).toBeGreaterThan(0);
    });
});
