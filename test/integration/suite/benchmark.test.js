const vscode = require('vscode');
const { tableFromArrays, tableToIPC } = require('apache-arrow');

/**
 * Data Browser Benchmark — migrated from MCP HTTP API to StataClient.
 *
 * In the new architecture, DataBrowserPanel uses StataClient methods
 * (listVariables, getDatasetState, getDataPage) directly instead of
 * making HTTP requests to an MCP API server.
 */
describe('Data Browser Benchmark', () => {
    jest.setTimeout(180000); // 3 minutes total
    let DataBrowserPanel; // Will be hydrated from extension exports
    let currentVars = [];
    let currentArrowBuffer = null;

    const N_ROWS = 1000;

    beforeEach(async () => {
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        if (!extension.isActive) await extension.activate();

        // Get API from exports
        const api = extension.exports;

        // Use the DataBrowserPanel that the extension is actually using
        DataBrowserPanel = api.DataBrowserPanel;

        // Mock StataClient methods directly (DataBrowserPanel no longer uses HTTP).
        // The mock methods read from shared variables updated per scenario.
        DataBrowserPanel._stataClient = {
            listVariables: async () => currentVars,
            getDatasetState: async () => ({
                obs_count: N_ROWS,
                var_count: currentVars.length,
                dataset_name: 'benchmark',
            }),
            getDataPage: async (_start, _count, _varlist) => currentArrowBuffer,
            validateFilterExpr: async () => ({ valid: true, error: null }),
            computeViewIndices: async () => [],
        };
    });

    afterEach(async () => {
        if (DataBrowserPanel && DataBrowserPanel.currentPanel) {
            DataBrowserPanel.currentPanel.dispose();
        }
    });

    test('Benchmark Scenarios: 50, 500, 5000 Vars', async () => {
        const scenarios = [
            { cols: 50, name: 'Small (50)' },
            { cols: 500, name: 'Medium (500)' },
            { cols: 5000, name: 'Large (5000)' }
        ];

        // Function to update shared data (read by mock StataClient methods)
        const updateServerData = (cols) => {
            console.log(`Generating data for ${cols} columns...`);
            const data = {};
            const vars = [];
            for (let j = 0; j < cols; j++) {
                const colName = `var_${j}`;
                data[colName] = new Float64Array(N_ROWS).fill(Math.random());
                vars.push({ name: colName, type: 'float', label: `Label for ${colName}` });
            }
            const table = tableFromArrays(data);
            const arrowBuffer = tableToIPC(table);
            currentVars = vars;
            currentArrowBuffer = arrowBuffer;
        };

        const allResults = [];

        for (const scenario of scenarios) {
            console.log(`\n--- STARTING BENCHMARK: ${scenario.name} ---`);
            updateServerData(scenario.cols);

            let perfLogs = [];

            // Create a promise that resolves when THIS scenario's logs are done
            const logCapturePromise = new Promise((resolve) => {
                const timer = setTimeout(() => {
                    console.log(`Test [${scenario.name}]: Timeout waiting for logs.`);
                    resolve();
                }, 15000);

                const logger = (msg) => {
                    // console.log(`[${scenario.name}] ${msg}`); // Uncomment for debug
                    if (msg.includes('[Perf]')) {
                        const match = msg.match(/\[Perf\] (.+): ([\d\.]+)ms/);
                        if (match) {
                            perfLogs.push({ metric: match[1], duration: parseFloat(match[2]) });
                        }
                    }
                    if (msg.includes('Render Grid') && msg.includes('[Perf]')) {
                        console.log(`MARKER [${scenario.name}]: Render Grid log received.`);
                        clearTimeout(timer);
                        // Short delay to ensure any subsequent async logs (like pagination) finish if needed
                        // but strictly we have the render time.
                        setTimeout(resolve, 100);
                    }
                };

                DataBrowserPanel.setLogger(logger);
            });

            // Trigger reload/load
            if (DataBrowserPanel.currentPanel) {
                console.log(`Test [${scenario.name}]: Refreshing existing panel...`);
                // Dispose and recreate is the cleanest way to force a full reload with new data
                DataBrowserPanel.currentPanel.dispose();
                // Wait a bit for cleanup
                await new Promise(r => setTimeout(r, 500));
                await vscode.commands.executeCommand('stata-workbench.viewData');
            } else {
                console.log(`Test [${scenario.name}]: Opening new panel...`);
                await vscode.commands.executeCommand('stata-workbench.viewData');
            }

            await logCapturePromise;

            // Format results
            const result = {
                scenario: scenario.name,
                metrics: perfLogs
            };
            allResults.push(result);
            console.log(`--- FINISHED BENCHMARK: ${scenario.name} ---`);
        }

        console.log('\n=========================================');
        console.log('       FINAL BENCHMARK REPORT            ');
        console.log('=========================================');
        console.log(JSON.stringify(allResults, null, 2));

        // Format a markdown table for easy reading
        console.log('\n| Scenario | Parse (ms) | Fetch (ms) | Render (ms) | Variables (ms) | Total (ms) |');
        console.log('| :--- | :--- | :--- | :--- | :--- | :--- |');

        allResults.forEach(r => {
            const parse = r.metrics.find(m => m.metric === 'Arrow Parse & Convert')?.duration || 0;
            const fetch = r.metrics.find(m => m.metric === 'Data Fetch')?.duration || 0;
            const render = r.metrics.find(m => m.metric === 'Render Grid')?.duration || 0;
            const vars = r.metrics.find(m => m.metric === 'Variables Population')?.duration || 0;

            // Total is roughly fetch (which includes parse) + render
            // But let's sum up everything excluding Parse if it's already in Fetch?
            // Actually, best "User Perceived" is probably just Fetch + Render + Variables population overhead?

            const total = fetch + render + vars;
            console.log(`| ${r.scenario} | ${parse.toFixed(1)} | ${fetch.toFixed(1)} | ${render.toFixed(1)} | ${vars.toFixed(1)} | ${total.toFixed(1)} |`);
        });

        console.log('=========================================\n');

        if (DataBrowserPanel && DataBrowserPanel.currentPanel) {
            DataBrowserPanel.currentPanel.dispose();
        }
        console.log('Test: Force exiting process.');
        process.exit(0);
    });
});
