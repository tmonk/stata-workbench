const path = require('path');
const { jest, mock } = require('bun:test');
const { setDefaultVscode, setDefaultEnv } = require('../src/runtime-context');
const { createVscodeMock } = require('./mocks/vscode');

globalThis.jest = jest;
globalThis.mock = mock;

setDefaultEnv(process.env);
setDefaultVscode(createVscodeMock());

mock.module('vscode', () => require(path.join(__dirname, 'mocks', 'vscode-proxy')));

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
  })
}));

mock.module('@sentry/browser', () => ({
  init: jest.fn(),
  replayIntegration: jest.fn(() => ({ name: 'Replay' }))
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
