const { jest } = require('bun:test');
const proxyquire = require('proxyquire').noCallThru().noPreserveCache();
const { createVscodeMock } = require('../mocks/vscode');
const { EventEmitter } = require('events');


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

    const stataClientMock = overrides.stataClientMock || Object.assign(new EventEmitter(), {
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
        exportGraph: jest.fn().mockResolvedValue({ file_path: '/tmp/graph.pdf' }),
    });

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

    // Mock Sentry so deactivate() with Sentry.flush() doesn't hang in tests
    const sentryMock = {
        init: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
        captureException: jest.fn(),
        captureMessage: jest.fn(),
        startSpan: jest.fn().mockImplementation((_opts, fn) => fn()),
        setTag: jest.fn(),
        setContext: jest.fn(),
        withScope: jest.fn(),
    };

    // Mock instrument.js (side-effect only — registers globals).
    // Note: extension.js requires './instrument.js' (with extension), so the
    // proxyquire key must match exactly.
    const instrumentMock = {
        // instrument.js exports nothing — it's loaded for side-effects
    };

    // Pre-set the global log buffer and shutdown flag that instrument.js normally sets.
    if (typeof global.addLogToSentryBuffer !== 'function') {
        const logBuffer = [];
        global.addLogToSentryBuffer = (msg) => {
            if (!msg) return;
            logBuffer.push(msg);
            if (logBuffer.length > 200) logBuffer.shift();
        };
    }
    if (typeof global.setStataWorkbenchShuttingDown !== 'function') {
        global.setStataWorkbenchShuttingDown = () => {};
    }

    const extension = proxyquire('../../src/extension', {
        './instrument.js': instrumentMock,
        '@sentry/node': sentryMock,
        './terminal-panel': { TerminalPanel: terminalPanel },
        './data-browser-panel': { DataBrowserPanel: dataBrowserPanel },
        './artifact-utils': artifactUtils,
        './daemon-manager': { DaemonManager: function() { return daemonMgrMock; } },
        './stata-client': { StataClient: jest.fn().mockImplementation(() => stataClientMock) },
        './installer': {
            isStataAgentInstalled: function() { return true; },
            findStataAgentBinary: function() { return 'stata-agent'; },
            promptInstall: function() {},
            resetInstallPrompt: function() {},
            runInstallInTerminal: function() {},
            checkAndReport: function() {},
        },
        './updater': {
            checkAndUpgrade: function() { return Promise.resolve({ upgraded: true }); },
        },
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
