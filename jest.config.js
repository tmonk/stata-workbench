module.exports = {
    testEnvironment: 'node',
    testPathIgnorePatterns: [
        '/node_modules/',
        '/.vscode-test/',
        '/dist/',
        '/build/'
    ],
    modulePathIgnorePatterns: [
        '/.vscode-test/',
        '/dist/',
        '/build/'
    ],
    moduleNameMapper: process.env.MCP_STATA_INTEGRATION === '1'
        ? { '^vscode$': '<rootDir>/test/integration/vscode-redirect.js' }
        : { '^vscode$': '<rootDir>/test/mocks/vscode.js' }
};
