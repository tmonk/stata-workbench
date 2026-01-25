const { describe, it, expect, beforeEach, afterEach } = require('bun:test');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const vscodeMock = require('../mocks/vscode');
const cp = require('child_process');
const path = require('path');

describe('MCP Discovery and Fallback Logic', () => {
    let originalSpawnSync;
    let stubs = {
        spawnSync: sinon.stub(),
        existsSync: sinon.stub().returns(false)
    };

    beforeEach(() => {
        delete process.env.MCP_STATA_UVX_CMD;
        originalSpawnSync = cp.spawnSync;
        cp.spawnSync = stubs.spawnSync;
        stubs.spawnSync.reset();
        // ENSURE default is a failure/error
        stubs.spawnSync.returns({
            status: -1,
            error: { code: 'ENOENT' },
            stderr: Buffer.from(''),
            stdout: Buffer.from('')
        });
        stubs.existsSync.reset();
        stubs.existsSync.returns(false);
    });

    afterEach(() => {
        cp.spawnSync = originalSpawnSync;
        delete process.env.MCP_STATA_UVX_CMD;
    });

    describe('findUvBinary', () => {
        it('identifies broken shims in system PATH and skips them', () => {
            // Force clear env var and any global state
            delete process.env.MCP_STATA_UVX_CMD;

            const api = proxyquire.noCallThru().load('../../src/extension', {
                'vscode': vscodeMock,
                'child_process': {
                    spawnSync: stubs.spawnSync
                },
                'fs': { existsSync: stubs.existsSync, statSync: () => ({ isFile: () => true }) },
                './mcp-client': { client: { getServerConfig: () => ({}), connect: () => Promise.resolve({}) } },
                './terminal-panel': { TerminalPanel: { setExtensionUri: () => {} } }
            });

            const findUvBinary = api.findUvBinary;

            // Ensure the stub is clean and set a default rejection for everything
            stubs.spawnSync.reset();
            stubs.spawnSync.returns({
                status: -1,
                error: { code: 'ENOENT' },
                stderr: Buffer.from(''),
                stdout: Buffer.from('')
            });

            // uvx is found but reports broken realpath (macOS issue)
            stubs.spawnSync.withArgs('uvx', sinon.match.any, sinon.match.any).returns({
                status: 127,
                stderr: Buffer.from('realpath: command not found\n'),
                error: null
            });

            const result = findUvBinary();
            if (result !== null) {
                // If it failed, let's see why
                console.error(`FAILURE in test identifies broken shims: result was "${result}" but expected null.`);
                const lastCall = stubs.spawnSync.lastCall;
                if (lastCall) {
                    console.error(`Last spawnSync call was: cmd=${lastCall.args[0]}, args=${JSON.stringify(lastCall.args[1])}`);
                }
            }
            expect(result).toBeNull();
        });
    });

    describe('isMcpConfigWorking', () => {
        it('identifies non-functional configs based on stderr', () => {
             const api = proxyquire.noCallThru().load('../../src/extension', {
                'vscode': vscodeMock,
                'child_process': { spawnSync: stubs.spawnSync },
                './mcp-client': { client: { getServerConfig: () => ({}), connect: () => Promise.resolve({}) } },
                './terminal-panel': { TerminalPanel: { setExtensionUri: () => {} } }
            });

            const { isMcpConfigWorking } = api;

            // Ensure clean stub
            stubs.spawnSync.reset();

            // Success case
            stubs.spawnSync.withArgs('good-uv', sinon.match.any, sinon.match.any).returns({
                status: 0,
                stderr: Buffer.from(''),
                error: null
            });
            expect(isMcpConfigWorking({ command: 'good-uv' })).toBe(true);

            // Stderr error case (missing realpath)
            stubs.spawnSync.withArgs('bad-uv', sinon.match.any, sinon.match.any).returns({
                status: 0,
                stderr: Buffer.from('realpath: command not found\n'),
                error: null
            });
            expect(isMcpConfigWorking({ command: 'bad-uv' })).toBe(false);
        });
    });
});
