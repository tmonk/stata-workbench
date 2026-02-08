const { describe, it, expect, jest } = require('bun:test');
const sinon = require('sinon');
const { withTestContext } = require('../helpers/test-context');
const { createExtensionHarness } = require('../helpers/extension-harness');

const itWithContext = (name, fn) => it(name, () => fn());

describe('MCP Discovery and Fallback Logic', () => {
    itWithContext('findUvBinary identifies broken shims and skips them', () => {
        const fs = {
            existsSync: jest.fn().mockReturnValue(false),
            statSync: jest.fn(() => ({ isFile: () => true }))
        };
        const cp = { spawnSync: sinon.stub() };
        cp.spawnSync.returns({
            status: -1,
            error: { code: 'ENOENT' },
            stderr: Buffer.from(''),
            stdout: Buffer.from('')
        });
        cp.spawnSync.withArgs('uvx', sinon.match.any, sinon.match.any).returns({
            status: 127,
            stderr: Buffer.from('realpath: command not found\n'),
            error: null
        });

        const mcpClientMock = {
            setLogger: jest.fn(),
            onStatusChanged: jest.fn().mockReturnValue({ dispose: jest.fn() }),
            dispose: jest.fn(),
            connect: jest.fn().mockResolvedValue({}),
            runSelection: jest.fn().mockResolvedValue({}),
            getUiChannel: jest.fn().mockResolvedValue(null),
            hasConfig: jest.fn().mockReturnValue(false),
            getServerConfig: jest.fn().mockReturnValue({ command: null, args: null, env: {}, configPath: null })
        };

        const { extension } = createExtensionHarness({ fs, cp });

        return withTestContext({ fs, childProcess: cp, mcpClient: mcpClientMock }, (ctx) => {
            delete ctx.env.MCP_STATA_UVX_CMD;
            const result = extension.findUvBinary();
            expect(result).toBeNull();
        });
    });

    itWithContext('isMcpConfigWorking checks stderr for failures', () => {
        const cp = { spawnSync: sinon.stub() };
        const mcpClientMock = {
            setLogger: jest.fn(),
            onStatusChanged: jest.fn().mockReturnValue({ dispose: jest.fn() }),
            dispose: jest.fn(),
            connect: jest.fn().mockResolvedValue({}),
            runSelection: jest.fn().mockResolvedValue({}),
            getUiChannel: jest.fn().mockResolvedValue(null),
            hasConfig: jest.fn().mockReturnValue(false),
            getServerConfig: jest.fn().mockReturnValue({ command: null, args: null, env: {}, configPath: null })
        };

        const { extension } = createExtensionHarness({ cp });

        return withTestContext({ childProcess: cp, mcpClient: mcpClientMock }, () => {
            cp.spawnSync.withArgs('good-uv', sinon.match.any, sinon.match.any).returns({
                status: 0,
                stderr: Buffer.from(''),
                error: null
            });
            expect(extension.isMcpConfigWorking({ command: 'good-uv' })).toBe(true);

            cp.spawnSync.withArgs('bad-uv', sinon.match.any, sinon.match.any).returns({
                status: 0,
                stderr: Buffer.from('realpath: command not found\n'),
                error: null
            });
            expect(extension.isMcpConfigWorking({ command: 'bad-uv' })).toBe(false);
        });
    });
});
