const { runWithContext } = require('../../src/runtime-context');
const { createVscodeMock } = require('../mocks/vscode');

const withTestContext = (overrides, fn) => {
    const env = overrides?.env ? { ...overrides.env } : { ...process.env };
    const vscode = overrides?.vscode || createVscodeMock();
    const fs = overrides?.fs || undefined;
    const childProcess = overrides?.childProcess || undefined;
    const mcpClient = overrides?.mcpClient || undefined;
    return runWithContext({ env, vscode, fs, childProcess, mcpClient }, () => fn({ env, vscode, fs, childProcess, mcpClient }));
};

module.exports = { withTestContext };
