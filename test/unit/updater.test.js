const { describe, it, beforeEach, afterEach, expect, jest } = require('bun:test');

// Mock vscode globally (needed by installer, which updater requires).
jest.mock('vscode', () => ({
    window: {
        showInformationMessage: jest.fn().mockResolvedValue(),
        createTerminal: jest.fn().mockReturnValue({ show: jest.fn(), sendText: jest.fn() }),
        createOutputChannel: jest.fn().mockReturnValue({ appendLine: jest.fn() }),
    },
    ThemeColor: function (name) { this.name = name; },
}), { virtual: true });

const cp = require('child_process');
const installer = require('../../src/installer');
const updater = require('../../src/updater');

describe('updater module', () => {
    let mockOutputChannel;
    let mockContext;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
        mockOutputChannel = {
            appendLine: jest.fn(),
            append: jest.fn(),
            show: jest.fn(),
        };
        mockContext = {
            globalState: {
                get: jest.fn().mockReturnValue(null),
                update: jest.fn().mockResolvedValue(),
            },
        };
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // ==================================================================
    // checkAndUpgrade
    // ==================================================================
    describe('checkAndUpgrade', () => {
        it('returns { upgraded: false, reason: "not_installed" } when binary not found', async () => {
            jest.spyOn(installer, 'findStataAgentBinary').mockReturnValue(null);

            const result = await updater.checkAndUpgrade(mockContext, mockOutputChannel);
            expect(result).toEqual({ upgraded: false, reason: 'not_installed' });
        });

        it('calls stata-agent upgrade --quiet', async () => {
            jest.spyOn(installer, 'findStataAgentBinary').mockReturnValue('stata-agent');
            const spawnSpy = jest.spyOn(cp, 'spawnSync').mockReturnValue({ status: 0, stdout: '', stderr: '' });

            await updater.checkAndUpgrade(mockContext, mockOutputChannel);

            expect(mockOutputChannel.appendLine).toHaveBeenCalledWith('stata-agent is up to date.');
            expect(spawnSpy).toHaveBeenCalledWith('stata-agent', ['upgrade', '--quiet'], expect.objectContaining({
                env: expect.objectContaining({ STATA_AGENT_INSTALL_SOURCE: 'workbench' }),
                timeout: 35000,
            }));
        });

        it('returns { upgraded: true } on success', async () => {
            jest.spyOn(installer, 'findStataAgentBinary').mockReturnValue('stata-agent');
            jest.spyOn(cp, 'spawnSync').mockReturnValue({ status: 0, stdout: '', stderr: '' });

            const result = await updater.checkAndUpgrade(mockContext, mockOutputChannel);
            expect(result).toEqual({ upgraded: true });
        });

        it('returns { upgraded: false, reason } on failure', async () => {
            jest.spyOn(installer, 'findStataAgentBinary').mockReturnValue('stata-agent');
            jest.spyOn(cp, 'spawnSync').mockReturnValue({
                status: 1, stdout: '', stderr: 'upgrade failed: network error',
            });

            const result = await updater.checkAndUpgrade(mockContext, mockOutputChannel);
            expect(result.upgraded).toBe(false);
            expect(result.reason).toContain('network error');
            expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
                expect.stringContaining('upgrade failed')
            );
        });

        it('does not implement its own version comparison or PyPI fetch', async () => {
            jest.spyOn(installer, 'findStataAgentBinary').mockReturnValue('stata-agent');

            let callCount = 0;
            jest.spyOn(cp, 'spawnSync').mockImplementation(() => {
                callCount++;
                return { status: 0, stdout: '', stderr: '' };
            });

            await updater.checkAndUpgrade(mockContext, mockOutputChannel);

            expect(callCount).toBe(1);
            expect(cp.spawnSync).toHaveBeenCalledWith('stata-agent', ['upgrade', '--quiet'], expect.any(Object));
        });

        it('stores lastUpgradeFailedTs on failure', async () => {
            jest.spyOn(installer, 'findStataAgentBinary').mockReturnValue('stata-agent');
            jest.spyOn(cp, 'spawnSync').mockReturnValue({
                status: 1, stdout: '', stderr: 'upgrade failed',
            });

            await updater.checkAndUpgrade(mockContext, mockOutputChannel);

            expect(mockContext.globalState.update).toHaveBeenCalledWith(
                'lastUpgradeFailedTs', expect.any(Number)
            );
        });

        it('suppresses repeat failure notifications within 24h', async () => {
            const oneHourAgo = Date.now() - 3600 * 1000;
            mockContext.globalState.get.mockReturnValue(oneHourAgo);

            jest.spyOn(installer, 'findStataAgentBinary').mockReturnValue('stata-agent');
            jest.spyOn(cp, 'spawnSync').mockReturnValue({
                status: 1, stdout: '', stderr: 'upgrade failed',
            });

            const result = await updater.checkAndUpgrade(mockContext, mockOutputChannel);
            expect(result.upgraded).toBe(false);
            expect(mockContext.globalState.update).toHaveBeenCalledWith(
                'lastUpgradeFailedTs', expect.any(Number)
            );
        });

        it('re-prompts after 7 days', async () => {
            const eightDaysAgo = Date.now() - 8 * 24 * 3600 * 1000;
            mockContext.globalState.get.mockReturnValue(eightDaysAgo);

            jest.spyOn(installer, 'findStataAgentBinary').mockReturnValue('stata-agent');
            jest.spyOn(cp, 'spawnSync').mockReturnValue({
                status: 1, stdout: '', stderr: 'upgrade failed',
            });

            const result = await updater.checkAndUpgrade(mockContext, mockOutputChannel);
            expect(result.upgraded).toBe(false);
        });
    });
});
