const path = require('path');

module.exports = {
    testMatch: ['<rootDir>/test/integration/suite/*.vscode-test.js', '!**/benchmark.vscode-test.js'],
    testEnvironment: 'node',
    moduleNameMapper: {
        '^vscode$': '<rootDir>/test/integration/vscode-redirect.js'
    }
};
