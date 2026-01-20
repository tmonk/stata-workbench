const path = require('path');
const { jest, mock } = require('bun:test');

globalThis.jest = jest;
globalThis.mock = mock;

mock.module('vscode', () => require(path.join(__dirname, 'mocks', 'vscode')));

// Mock Sentry to avoid native module crashes and telemetry during tests
mock.module('@sentry/node', () => ({
  init: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
  setUser: jest.fn(),
  setTag: jest.fn(),
  setExtra: jest.fn(),
  withScope: jest.fn(),
  startTransaction: jest.fn().mockReturnValue({
    finish: jest.fn(),
    startChild: jest.fn().mockReturnValue({ finish: jest.fn() })
  }),
  nodeProfilingIntegration: jest.fn()
}));

mock.module('@sentry/profiling-node', () => ({
  nodeProfilingIntegration: jest.fn()
}));

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
