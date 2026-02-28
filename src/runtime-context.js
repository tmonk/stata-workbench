const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

let defaultVscode = null;
let defaultEnv = process.env;
let defaultFs = require('fs');
let defaultChildProcess = require('child_process');
let defaultMcpClient = null;

const setDefaultVscode = (api) => {
    defaultVscode = api || null;
};

const setDefaultEnv = (env) => {
    defaultEnv = env || process.env;
};

const setDefaultFs = (fs) => {
    defaultFs = fs || require('fs');
};

const setDefaultChildProcess = (childProcess) => {
    defaultChildProcess = childProcess || require('child_process');
};

const setDefaultMcpClient = (mcpClient) => {
    defaultMcpClient = mcpClient || null;
};

const getVscode = () => {
    const store = storage.getStore();
    if (store?.vscode) return store.vscode;
    if (defaultVscode) return defaultVscode;
    return require('vscode');
};

const getEnv = () => {
    const store = storage.getStore();
    return store?.env || defaultEnv || process.env;
};

const getFs = () => {
    const store = storage.getStore();
    return store?.fs || defaultFs;
};

const getChildProcess = () => {
    const store = storage.getStore();
    return store?.childProcess || defaultChildProcess;
};

const getMcpClient = () => {
    const store = storage.getStore();
    return store?.mcpClient || defaultMcpClient;
};

const runWithContext = (context, fn) => {
    const next = {
        vscode: context?.vscode ?? defaultVscode,
        env: context?.env ?? defaultEnv,
        fs: context?.fs ?? defaultFs,
        childProcess: context?.childProcess ?? defaultChildProcess,
        mcpClient: context?.mcpClient ?? defaultMcpClient
    };
    return storage.run(next, fn);
};

/**
 * Creates a Proxy that lazily resolves to the object returned by `getter()`.
 * Property access, method calls, and assignments are forwarded to the current
 * value, so the underlying implementation can be swapped via runtime-context
 * (e.g. in tests via `withTestContext`).
 */
const createDepProxy = (getter) => new Proxy({}, {
    get(_target, prop) {
        const target = getter();
        const value = target?.[prop];
        const isMockFunction = typeof value === 'function' && (value._isMockFunction || value.mock);
        if (typeof value === 'function' && !isMockFunction) {
            return value.bind(target);
        }
        return value;
    },
    set(_target, prop, value) {
        const target = getter();
        if (!target) return false;
        target[prop] = value;
        return true;
    }
});

module.exports = {
    createDepProxy,
    getVscode,
    getEnv,
    getFs,
    getChildProcess,
    getMcpClient,
    runWithContext,
    setDefaultVscode,
    setDefaultEnv,
    setDefaultFs,
    setDefaultChildProcess,
    setDefaultMcpClient
};
