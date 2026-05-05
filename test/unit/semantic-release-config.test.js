const { describe, it, expect } = require('bun:test');
const { readFileSync } = require('fs');
const { join } = require('path');

const commitAnalyzerModule = require('@semantic-release/commit-analyzer');
const analyzeCommits = commitAnalyzerModule.analyzeCommits || commitAnalyzerModule.default || commitAnalyzerModule;

function getCommitAnalyzerConfig() {
    const configPath = join(__dirname, '..', '..', '.releaserc.json');
    const releaseConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    return releaseConfig.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/commit-analyzer')[1];
}

describe('semantic-release commit-analyzer configuration', () => {
    it('marks bang commits as major releases', async () => {
        const config = getCommitAnalyzerConfig();
        const logger = { log: () => {}, error: () => {} };

        const releaseType = await analyzeCommits(config, {
            cwd: process.cwd(),
            env: process.env,
            options: {},
            logger,
            commits: [{ message: 'feat!: remove deprecated api' }]
        });

        expect(releaseType).toBe('major');
    });

    it('keeps plain feature commits as minor releases', async () => {
        const config = getCommitAnalyzerConfig();
        const logger = { log: () => {}, error: () => {} };

        const releaseType = await analyzeCommits(config, {
            cwd: process.cwd(),
            env: process.env,
            options: {},
            logger,
            commits: [{ message: 'feat: add report explorer' }]
        });

        expect(releaseType).toBe('minor');
    });
});
