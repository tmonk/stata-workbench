const path = require('path');
const fs = require('fs');
const { runCLI } = require('jest');

async function run() {
    const projectRootPath = path.resolve(__dirname, '../../../');
    const configPath = path.resolve(projectRootPath, 'jest.config.js');

    // Set environment variable to indicate integration test mode
    process.env.MCP_STATA_INTEGRATION = '1';
    global.realVscode = require('vscode');
    console.log('[INTEGRATION] MCP_STATA_INTEGRATION:', process.env.MCP_STATA_INTEGRATION);

    try {
        const result = await runCLI(
            {
                config: configPath,
                runInBand: true, // Required for VS Code integration tests
            },
            [projectRootPath]
        );

        if (result.results && result.results.numFailedTests > 0) {
            throw new Error(`${result.results.numFailedTests} integration tests failed.`);
        }
    } catch (error) {
        console.error('Jest integration test run failed:', error);
        throw error;
    }
}

module.exports = { run };
