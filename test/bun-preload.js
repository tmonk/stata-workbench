const path = require('path');
const { jest, mock } = require('bun:test');

globalThis.jest = jest;
globalThis.mock = mock;

mock.module('vscode', () => require(path.join(__dirname, 'mocks', 'vscode')));

if (!jest.doMock) {
  jest.doMock = (specifier, factory) => mock.module(specifier, factory);
}

if (!jest.resetModules) {
  jest.resetModules = () => {
    for (const key of Object.keys(require.cache)) {
      delete require.cache[key];
    }
  };
}
