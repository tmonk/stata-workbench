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

module.exports = {
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
