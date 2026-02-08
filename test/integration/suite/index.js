const path = require('path');
const fs = require('fs');
const { runCLI } = require('jest');

async function run() {
    const projectRootPath = path.resolve(__dirname, '../../../');
    const configPath = path.resolve(projectRootPath, 'jest.config.js');
    const suiteDir = __dirname;

    // Set environment variable to indicate integration test mode
    process.env.MCP_STATA_INTEGRATION = '1';
    global.realVscode = require('vscode');
    console.log('[INTEGRATION] MCP_STATA_INTEGRATION:', process.env.MCP_STATA_INTEGRATION);

    try {
        const testPattern = process.env.TEST_PATTERN;
        const shardTotal = Math.max(1, parseInt(process.env.TEST_SHARD_TOTAL || '1', 10));
        const shardIndex = Math.max(0, parseInt(process.env.TEST_SHARD_INDEX || '0', 10));
        const options = {
            config: configPath,
            runInBand: true
        };

        if (shardTotal > 1) {
            const allTests = fs.readdirSync(suiteDir)
                .filter((file) => file.endsWith('.test.js') && file !== 'benchmark.test.js')
                .sort()
                .map((file) => path.join(suiteDir, file));

            const selected = allTests.filter((_, idx) => idx % shardTotal === shardIndex);
            options.runTestsByPath = true;
            options.testPathPattern = selected;
            options.nonFlagArgs = selected;
            options._ = selected;
        }
        if (testPattern) {
            options.testNamePattern = testPattern;
        }

        const result = await runCLI(options, [projectRootPath]);

        if (result.results && result.results.numFailedTests > 0) {
            throw new Error(`${result.results.numFailedTests} integration tests failed.`);
        }
    } catch (error) {
        console.error('Jest integration test run failed:', error);
        throw error;
    }
}

module.exports = { run };
