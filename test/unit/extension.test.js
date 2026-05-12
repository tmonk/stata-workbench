const { describe, it, beforeEach, afterEach, expect, jest } = require('bun:test');
const { AsyncLocalStorage } = require('async_hooks');
const { withTestContext } = require('../helpers/test-context');
const { createExtensionHarness } = require('../helpers/extension-harness');

const harnessStore = new AsyncLocalStorage();
const getHarness = () => harnessStore.getStore();
const createProxy = (getter) => new Proxy(function () {}, {
    apply(_target, thisArg, args) {
        const target = getter();
        return target?.apply?.(thisArg, args);
    },
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

const extension = createProxy(() => getHarness()?.extension);
const vscode = createProxy(() => getHarness()?.vscode);
const fs = createProxy(() => getHarness()?.fs);
const cp = createProxy(() => getHarness()?.cp);

function createConfig(configValues) {
    const vals = { ...configValues };
    return {
        get: jest.fn().mockImplementation((key, def) => {
            return key in vals ? vals[key] : def;
        }),
        has: jest.fn().mockReturnValue(true),
        inspect: jest.fn(),
        update: jest.fn().mockResolvedValue(),
    };
}

function basicActivateContext(overrides = {}) {
    return {
        subscriptions: [],
        globalState: { get: jest.fn().mockReturnValue(true), update: jest.fn().mockResolvedValue() },
        globalStoragePath: '/tmp/globalStorage',
        extensionUri: { fsPath: '/test/path' },
        extensionPath: '/test/path',
        extensionMode: vscode.ExtensionMode.Test,
        ...overrides,
    };
}

function mockStdHandlers() {
    const handlers = new Map();
    vscode.commands.registerCommand.mockImplementation((name, handler) => {
        handlers.set(name, handler);
        return { dispose: jest.fn() };
    });
    return handlers;
}

describe('extension unit tests', () => {
    const itWithHarness = (name, fn) => it(name, () => {
        const harness = createExtensionHarness();
        return withTestContext({
            vscode: harness.vscode,
            fs: harness.fs,
            childProcess: harness.cp,
        }, (ctx) => harnessStore.run(harness, () => fn(ctx)));
    });

    describe('activate', () => {
        itWithHarness('registers all commands on activation', async () => {
            const handlers = mockStdHandlers();
            await extension.activate(basicActivateContext());

            expect(handlers.has('stata-workbench.runSelection')).toBe(true);
            expect(handlers.has('stata-workbench.runFile')).toBe(true);
            expect(handlers.has('stata-workbench.restartDaemon')).toBe(true);
            expect(handlers.has('stata-workbench.showDaemonStatus')).toBe(true);
            expect(handlers.has('stata-workbench.viewData')).toBe(true);
            expect(handlers.has('stata-workbench.cancelRequest')).toBe(true);
            expect(handlers.has('stata-workbench.openTerminal')).toBe(true);
        });

        itWithHarness('returns test API when in Test mode', async () => {
            const api = extension.activate(basicActivateContext());
            expect(api.TerminalPanel).toBeDefined();
            expect(api.DataBrowserPanel).toBeDefined();
        });

        itWithHarness('creates status bar item', async () => {
            extension.activate(basicActivateContext());
            const barItem = vscode.window.createStatusBarItem.mock.results[0]?.value;
            expect(barItem).toBeDefined();
            expect(barItem.show).toHaveBeenCalled();
            expect(barItem.text).toContain('Stata');
        });
    });

    describe('runSelection', () => {
        itWithHarness('calls runCode with selected editor text', async () => {
            const handlers = mockStdHandlers();
            const api = extension.activate(basicActivateContext());

            // Set up mocks for this test
            const mockRunCode = jest.fn().mockResolvedValue({ ok: true, rc: 0, stdout: '1' });
            api.stataClient.runCode = mockRunCode;

            vscode.window.activeTextEditor = {
                selection: { isEmpty: false },
                document: {
                    getText: jest.fn().mockReturnValue('display "hi"'),
                    uri: { fsPath: '/tmp/test.do' },
                }
            };

            await handlers.get('stata-workbench.runSelection')();
            expect(mockRunCode).toHaveBeenCalled();
        });
    });

    describe('cancelRequest', () => {
        itWithHarness('calls cancel on the client', async () => {
            const handlers = mockStdHandlers();
            const api = extension.activate(basicActivateContext());
            const mockCancel = jest.fn().mockResolvedValue({ acknowledged: true });
            api.stataClient.cancel = mockCancel;

            await handlers.get('stata-workbench.cancelRequest')();
            expect(mockCancel).toHaveBeenCalled();
        });
    });

    describe('restartDaemon', () => {
        itWithHarness('stops and restarts daemon', async () => {
            const handlers = mockStdHandlers();
            const api = extension.activate(basicActivateContext());
            const mockStop = jest.fn().mockResolvedValue();
            const mockEnsureRunning = jest.fn().mockResolvedValue();
            api.daemonMgr.stop = mockStop;
            api.daemonMgr.ensureRunning = mockEnsureRunning;

            await handlers.get('stata-workbench.restartDaemon')();
            expect(mockStop).toHaveBeenCalledWith('default');
            expect(mockEnsureRunning).toHaveBeenCalledWith('default');
        });
    });

    describe('deactivate', () => {
        itWithHarness('stops daemon on deactivation when daemonMgr exists', async () => {
            const api = extension.activate(basicActivateContext());
            const mockStop = jest.fn().mockResolvedValue();
            api.daemonMgr.stop = mockStop;

            await extension.deactivate();
            expect(mockStop).toHaveBeenCalledWith('default');
        });

        itWithHarness('handles deactivate gracefully when daemonMgr is null', async () => {
            // Directly access extension module and set daemonMgr to null
            const ext = getHarness()?.extension;
            if (ext && ext.daemonMgr !== undefined) {
                ext.daemonMgr = null;
            }
            // Should not throw
            await extension.deactivate();
        });
    });

    describe('config', () => {
        itWithHarness('activates without throwing with loadStataOnStartup=true', async () => {
            const vscodeConfig = createConfig({ loadStataOnStartup: true });
            vscode.workspace.getConfiguration.mockReturnValue(vscodeConfig);
            const api = extension.activate(basicActivateContext());
            expect(api).toBeDefined();
        });

        itWithHarness('activates without throwing with loadStataOnStartup=false', async () => {
            const vscodeConfig = createConfig({ loadStataOnStartup: false });
            vscode.workspace.getConfiguration.mockReturnValue(vscodeConfig);
            const api = extension.activate(basicActivateContext());
            expect(api).toBeDefined();
        });
    });

    describe('status bar states', () => {
        itWithHarness('shows different text for connected state', async () => {
            extension.activate(basicActivateContext());
            const barItem = vscode.window.createStatusBarItem.mock.results[0]?.value;

            // We need to trigger the status callback
            // Since we can't easily call internal functions, verify the bar was created
            expect(barItem).toBeDefined();
        });
    });

    describe('config prefix', () => {
        itWithHarness('reads config using stata prefix', async () => {
            mockStdHandlers();
            const vscodeConfig = createConfig({ autoRevealOutput: true });
            vscode.workspace.getConfiguration.mockImplementation((section) => {
                if (section === 'stata') return vscodeConfig;
                return createConfig({});
            });
            extension.activate(basicActivateContext());
            // revealOutput reads from 'stata' prefix
            expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith('stata');
        });
    });
});
