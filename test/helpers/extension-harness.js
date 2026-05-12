const { jest } = require('bun:test');
const proxyquire = require('proxyquire').noCallThru().noPreserveCache();
const { createVscodeMock } = require('../mocks/vscode');

const createExtensionHarness = (overrides = {}) => {
    const vscode = overrides.vscode || createVscodeMock();
    const fs = overrides.fs || {
        existsSync: jest.fn(),
        readFileSync: jest.fn(),
        writeFileSync: jest.fn(),
        mkdirSync: jest.fn(),
        statSync: jest.fn().mockReturnValue({ size: 0 }),
        openSync: jest.fn(),
        readSync: jest.fn(),
        closeSync: jest.fn(),
        unlinkSync: jest.fn(),
    };
    const cp = overrides.cp || {
        spawnSync: jest.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' }),
        spawn: jest.fn().mockReturnValue({
            on: jest.fn(),
            unref: jest.fn(),
            kill: jest.fn(),
            stdout: { on: jest.fn() },
            stderr: { on: jest.fn() }
        })
    };

    const stataClientMock = overrides.stataClientMock || {
        on: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        ensureConnected: jest.fn().mockResolvedValue(),
        disconnect: jest.fn().mockResolvedValue(),
        isConnected: jest.fn().mockReturnValue(true),
        runCode: jest.fn().mockResolvedValue({ ok: true, rc: 0, stdout: '' }),
        runFile: jest.fn().mockResolvedValue({ ok: true, rc: 0, stdout: '' }),
        cancel: jest.fn().mockResolvedValue({ acknowledged: true }),
        cancelTask: jest.fn().mockResolvedValue({ cancelled: true }),
        listVariables: jest.fn().mockResolvedValue([]),
        getDatasetState: jest.fn().mockResolvedValue({ obs_count: 0, var_count: 0, dataset_name: '' }),
        getDataPage: jest.fn().mockResolvedValue(Buffer.from([])),
        health: jest.fn().mockResolvedValue({ status: 'ok', pid: 12345, sessions: ['default'] }),
    };

    const daemonMgrMock = overrides.daemonMgrMock || {
        ensureRunning: jest.fn().mockResolvedValue(),
        stop: jest.fn().mockResolvedValue(),
        health: jest.fn().mockResolvedValue({ status: 'ok', pid: 12345, sessions: ['default'] }),
        onCrash: jest.fn(),
    };

    const terminalPanel = overrides.terminalPanel || {
        setExtensionUri: jest.fn(),
        addEntry: jest.fn(),
        show: jest.fn(),
        setLogProvider: jest.fn(),
        setHandlersFactory: jest.fn(),
        restorePanel: jest.fn(),
        startStreamingEntry: jest.fn().mockReturnValue(null),
        appendStreamingLog: jest.fn(),
        updateStreamingProgress: jest.fn(),
        finishStreamingEntry: jest.fn(),
        failStreamingEntry: jest.fn(),
        appendRunArtifact: jest.fn(),
        updateStreamingStatus: jest.fn(),
        notifyTaskDone: jest.fn()
    };

    const dataBrowserPanel = overrides.dataBrowserPanel || {
        createOrShow: jest.fn(),
        setLogger: jest.fn(),
        refresh: jest.fn()
    };

    const artifactUtils = overrides.artifactUtils || {
        openArtifact: jest.fn()
    };

    const extension = proxyquire('../../src/extension', {
        './terminal-panel': { TerminalPanel: terminalPanel },
        './data-browser-panel': { DataBrowserPanel: dataBrowserPanel },
        './artifact-utils': artifactUtils,
        './daemon-manager': { DaemonManager: jest.fn().mockImplementation(() => daemonMgrMock) },
        './stata-client': { StataClient: jest.fn().mockImplementation(() => stataClientMock) },
    });

    return {
        extension,
        vscode,
        fs,
        cp,
        stataClientMock,
        daemonMgrMock,
        terminalPanel,
        dataBrowserPanel,
        artifactUtils
    };
};

module.exports = { createExtensionHarness };
