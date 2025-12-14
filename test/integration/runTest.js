const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');
        const workspacePath = path.resolve(__dirname, './fixture');

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [workspacePath]
        });
    } catch (err) {
        console.error('Failed to run integration tests', err);
        process.exit(1);
    }
}

main();
