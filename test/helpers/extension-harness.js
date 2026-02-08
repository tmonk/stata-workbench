const { jest } = require('bun:test');
const proxyquire = require('proxyquire').noCallThru().noPreserveCache();
const { createVscodeMock } = require('../mocks/vscode');

const createExtensionHarness = (overrides = {}) => {
    const vscode = overrides.vscode || createVscodeMock();
    const fs = overrides.fs || {
        existsSync: jest.fn(),
        readFileSync: jest.fn(),
        writeFileSync: jest.fn(),
        mkdirSync: jest.fn()
    };
    const cp = overrides.cp || {
        spawnSync: jest.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' })
    };

    const mcpClientMock = overrides.mcpClientMock || {
        setLogger: jest.fn(),
        onStatusChanged: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        dispose: jest.fn(),
        connect: jest.fn().mockResolvedValue({}),
        runSelection: jest.fn().mockResolvedValue({}),
        getUiChannel: jest.fn().mockResolvedValue(null),
        hasConfig: jest.fn().mockReturnValue(false),
        getServerConfig: jest.fn().mockReturnValue({ command: null, args: null, env: {}, configPath: null })
    };

    const terminalPanel = overrides.terminalPanel || {
        setExtensionUri: jest.fn(),
        addEntry: jest.fn(),
        show: jest.fn(),
        setLogProvider: jest.fn(),
        startStreamingEntry: jest.fn().mockReturnValue(null),
        appendStreamingLog: jest.fn(),
        updateStreamingProgress: jest.fn(),
        finishStreamingEntry: jest.fn(),
        failStreamingEntry: jest.fn()
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
        './artifact-utils': artifactUtils
    });

    return {
        extension,
        vscode,
        fs,
        cp,
        mcpClientMock,
        terminalPanel,
        dataBrowserPanel,
        artifactUtils
    };
};

module.exports = { createExtensionHarness };
