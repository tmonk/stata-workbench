const path = require('path');

module.exports = {
    testMatch: ['<rootDir>/test/integration/suite/*.test.js', '!**/benchmark.test.js'],
    testEnvironment: 'node',
    moduleNameMapper: {
        '^vscode$': '<rootDir>/test/integration/vscode-redirect.js'
    }
};
