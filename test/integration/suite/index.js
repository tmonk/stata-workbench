const path = require('path');
const fs = require('fs');
const { runCLI } = require('jest');

async function run() {
    const projectRootPath = path.resolve(__dirname, '../../../');
    const configPath = path.resolve(projectRootPath, 'jest.config.js');
    const suiteDir = __dirname;

    // Set environment variable to indicate integration test mode
    process.env.STATA_AGENT_INTEGRATION = '1';
    global.realVscode = require('vscode');
    console.log('[INTEGRATION] STATA_AGENT_INTEGRATION:', process.env.STATA_AGENT_INTEGRATION);

    try {
        const testPattern = process.env.TEST_PATTERN;
        const testFile = process.env.TEST_FILE;
        const shardTotal = Math.max(1, parseInt(process.env.TEST_SHARD_TOTAL || '1', 10));
        const shardIndex = Math.max(0, parseInt(process.env.TEST_SHARD_INDEX || '0', 10));
        const options = {
            config: configPath,
            runInBand: true
        };

        if (testFile) {
            options.testMatch = [path.join(suiteDir, testFile)];
            // Clear shard-based filtering if a specific file is requested
            delete options.runTestsByPath;
            delete options.nonFlagArgs;
            delete options._;
        } else if (shardTotal > 1) {
            const allTests = fs.readdirSync(suiteDir)
                .filter((file) => file.endsWith('.test.js') && file !== 'benchmark.test.js' && file !== 'integration.test.js')
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

        console.log('[INTEGRATION] Jest options:', JSON.stringify(options, null, 2));
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
