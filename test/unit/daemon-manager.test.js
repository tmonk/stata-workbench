const { describe, it, beforeEach, afterEach, expect, jest } = require('bun:test');
const path = require('path');
const os = require('os');
const fs = require('fs');
const cp = require('child_process');
const net = require('net');

const SESSION_DIR = path.join(os.homedir(), '.cache', 'mcp-stata', 'sessions');

/**
 * Create a mock net.Socket that stores event handlers for manual triggering.
 */
function createMockSocket() {
    const handlers = {};
    return {
        on: jest.fn((event, handler) => {
            handlers[event] = handler;
            return this;
        }),
        write: jest.fn(),
        end: jest.fn(),
        destroy: jest.fn(),
        _trigger(event, ...args) {
            if (handlers[event]) handlers[event](...args);
        },
    };
}

/**
 * Create a mock ChildProcess that stores event handlers for manual triggering.
 */
function createMockChildProcess() {
    const handlers = {};
    const proc = {
        on: jest.fn((event, handler) => {
            handlers[event] = handler;
            return proc;
        }),
        kill: jest.fn(),
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        pid: 12345,
        _handlers: handlers,
    };
    return proc;
}

describe('DaemonManager', () => {
    let DaemonManager;
    let manager;
    let originalStataPath;

    beforeEach(() => {
        // _findStataBinary returns STATA_PATH immediately if set;
        // unset so it goes through the normal binary search path.
        originalStataPath = process.env.STATA_PATH;
        delete process.env.STATA_PATH;

        // Spy on module exports before requiring daemon-manager.
        // The daemon-manager wrapper delegates to require('child_process').spawn()
        // dynamically (see the wrapper at module top), so spying on
        // cp.spawn intercepts those calls.
        jest.spyOn(cp, 'spawn').mockReturnValue(undefined);
        jest.spyOn(cp, 'spawnSync').mockReturnValue({ status: 1 });

        // fs.* calls in daemon-manager use fs.existsSync(...) (not destructured),
        // so spying on the fs module exports works.
        jest.spyOn(fs, 'existsSync').mockReturnValue(false);
        jest.spyOn(fs, 'readFileSync');
        jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

        // net is require-d dynamically inside health() and stop().
        jest.spyOn(net, 'createConnection');

        const { DaemonManager: DM } = require('../../src/daemon-manager');
        DaemonManager = DM;
        manager = new DaemonManager();
    });

    afterEach(() => {
        if (originalStataPath !== undefined) {
            process.env.STATA_PATH = originalStataPath;
        }
        jest.restoreAllMocks();
    });

    // ------------------------------------------------------------------
    // constructor
    // ------------------------------------------------------------------
    describe('constructor', () => {
        it('initialises empty process and callback maps', () => {
            expect(manager._processes).toBeInstanceOf(Map);
            expect(manager._processes.size).toBe(0);
            expect(manager._crashCallbacks).toBeInstanceOf(Map);
            expect(manager._crashCallbacks.size).toBe(0);
        });
    });

    // ------------------------------------------------------------------
    // ensureRunning
    // ------------------------------------------------------------------
    describe('ensureRunning', () => {
        const mockMetaPath = path.join(SESSION_DIR, 'default.json');
        const mockSockPath = path.join(SESSION_DIR, 'default.sock');

        it('returns immediately when meta and socket exist', async () => {
            fs.existsSync.mockImplementation((p) => {
                if (p === mockMetaPath) return true;
                if (p === mockSockPath) return true;
                return false;
            });
            fs.readFileSync.mockReturnValue(JSON.stringify({
                transport: 'unix',
                path: mockSockPath,
            }));

            await manager.ensureRunning('default');

            expect(cp.spawn).not.toHaveBeenCalled();
            expect(fs.unlinkSync).not.toHaveBeenCalled();
        });

        it('returns immediately for tcp transport when meta exists', async () => {
            fs.existsSync.mockImplementation((p) => {
                if (p === mockMetaPath) return true;
                return false;
            });
            fs.readFileSync.mockReturnValue(JSON.stringify({
                transport: 'tcp',
                port: 9876,
                host: '127.0.0.1',
            }));

            await manager.ensureRunning('default');

            expect(cp.spawn).not.toHaveBeenCalled();
        });

    it('removes stale meta and spawns when socket file is missing', async () => {
            const mockProc = createMockChildProcess();
            cp.spawn.mockReturnValue(mockProc);

            // Sequence existsSync returns:
            //   1st meta check → true (stale meta exists)
            //   after unlink → gone for a few polls, then reappears
            let metaCheckCount = 0;
            fs.existsSync.mockImplementation((p) => {
                if (p === mockMetaPath) {
                    metaCheckCount++;
                    return metaCheckCount === 1 || metaCheckCount > 4;
                }
                if (p === mockSockPath) return false;
                return false;
            });
            fs.readFileSync.mockReturnValue(JSON.stringify({
                transport: 'unix',
                path: mockSockPath,
            }));

            await manager.ensureRunning('default', { timeout: 5000 });

            expect(fs.unlinkSync).toHaveBeenCalledWith(mockMetaPath);
            expect(cp.spawn).toHaveBeenCalled();
        });

        it('spawns daemon and resolves when meta appears', async () => {
            const mockProc = createMockChildProcess();
            cp.spawn.mockReturnValue(mockProc);

            let metaCheckCount = 0;
            fs.existsSync.mockImplementation((p) => {
                if (p === mockMetaPath) {
                    metaCheckCount++;
                    return metaCheckCount > 3;
                }
                return false;
            });

            await manager.ensureRunning('default', { timeout: 5000 });

            expect(cp.spawn).toHaveBeenCalledTimes(1);
            // _findStataBinary falls through to 'stata'
            expect(cp.spawn.mock.calls[0][0]).toBe('stata');
            expect(cp.spawn.mock.calls[0][1]).toEqual(
                expect.arrayContaining(['daemon', 'start', '--session', 'default'])
            );
            expect(manager._processes.get('default')).toBe(mockProc);
        });

        it('forwards --mock when opts.mock is set', async () => {
            const mockProc = createMockChildProcess();
            cp.spawn.mockReturnValue(mockProc);

            let metaCheckCount = 0;
            fs.existsSync.mockImplementation((p) => {
                if (p === mockMetaPath) {
                    metaCheckCount++;
                    return metaCheckCount > 3;
                }
                return false;
            });

            await manager.ensureRunning('default', { mock: true, timeout: 5000 });

            expect(cp.spawn.mock.calls[0][1]).toContain('--mock');
        });

        it('rejects when spawned process exits before meta appears', async () => {
            const mockProc = createMockChildProcess();
            cp.spawn.mockReturnValue(mockProc);
            fs.existsSync.mockReturnValue(false);

            const promise = manager.ensureRunning('default');

            // Trigger exit handler synchronously — the mock stores it via
            // the proc.on spy + _handlers container.
            const exitHandler = mockProc._handlers['exit'];
            expect(exitHandler).toBeDefined();
            exitHandler(1);

            await expect(promise).rejects.toThrow('Daemon exited with code 1');
            expect(manager._processes.has('default')).toBe(false);
        });

        it('rejects on timeout when meta never appears', async () => {
            const mockProc = createMockChildProcess();
            cp.spawn.mockReturnValue(mockProc);
            fs.existsSync.mockReturnValue(false);

            await expect(
                manager.ensureRunning('default', { timeout: 100 })
            ).rejects.toThrow('Daemon start timed out');
        }, 5000);
    });

    // ------------------------------------------------------------------
    // stop
    // ------------------------------------------------------------------
    describe('stop', () => {
        it('kills tracked process with SIGTERM', async () => {
            const mockProc = createMockChildProcess();
            manager._processes.set('default', mockProc);

            await manager.stop('default');

            expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
            expect(manager._processes.has('default')).toBe(false);
        });

        it('sends NDJSON stop request when meta exists', async () => {
            const mockProc = createMockChildProcess();
            manager._processes.set('default', mockProc);

            const mockSocket = createMockSocket();
            net.createConnection.mockReturnValue(mockSocket);
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                transport: 'unix',
                path: '/tmp/stata-test.sock',
            }));

            await manager.stop('default');

            expect(net.createConnection).toHaveBeenCalledWith(
                expect.objectContaining({ path: '/tmp/stata-test.sock' })
            );
            expect(mockSocket.write).toHaveBeenCalledWith(
                expect.stringContaining('"method":"stop"')
            );
            expect(mockSocket.end).toHaveBeenCalled();
        });

        it('handles stop when no process is tracked', async () => {
            await manager.stop('nonexistent');
            // No error means pass.
        });

        it('removes process from tracking after stop', async () => {
            const mockProc = createMockChildProcess();
            manager._processes.set('default', mockProc);

            await manager.stop('default');

            expect(manager._processes.has('default')).toBe(false);
        });
    });

    // ------------------------------------------------------------------
    // health
    // ------------------------------------------------------------------
    describe('health', () => {
        const mockMetaPath = path.join(SESSION_DIR, 'default.json');

        it('returns null when meta file is missing', async () => {
            fs.existsSync.mockReturnValue(false);

            const result = await manager.health('default');

            expect(result).toBeNull();
            expect(net.createConnection).not.toHaveBeenCalled();
        });

        it('returns null when connection fails', async () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                transport: 'unix',
                path: '/tmp/stata-health.sock',
            }));

            const mockSocket = createMockSocket();
            net.createConnection.mockReturnValue(mockSocket);

            const healthPromise = manager.health('default');
            mockSocket._trigger('error', new Error('connect ECONNREFUSED'));

            const result = await healthPromise;
            expect(result).toBeNull();
            expect(net.createConnection).toHaveBeenCalled();
        });

        it('returns health result when daemon responds', async () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                transport: 'unix',
                path: '/tmp/stata-health.sock',
            }));

            const mockSocket = createMockSocket();
            net.createConnection.mockReturnValue(mockSocket);

            const healthPromise = manager.health('default');
            mockSocket._trigger('data', Buffer.from(
                JSON.stringify({ result: { status: 'running', pid: 12345 } }) + '\n'
            ));

            const result = await healthPromise;
            expect(result).toEqual({ status: 'running', pid: 12345 });
        });

        it('returns null on invalid JSON response', async () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                transport: 'unix',
                path: '/tmp/stata-health.sock',
            }));

            const mockSocket = createMockSocket();
            net.createConnection.mockReturnValue(mockSocket);

            const healthPromise = manager.health('default');
            mockSocket._trigger('data', 'not valid json');

            const result = await healthPromise;
            expect(result).toBeNull();
        });

        it('returns null when response lacks result field', async () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                transport: 'unix',
                path: '/tmp/stata-health.sock',
            }));

            const mockSocket = createMockSocket();
            net.createConnection.mockReturnValue(mockSocket);

            const healthPromise = manager.health('default');
            mockSocket._trigger('data', Buffer.from(
                JSON.stringify({ id: 'health-1', error: { message: 'not ready' } }) + '\n'
            ));

            const result = await healthPromise;
            expect(result).toBeNull();
        });

        it('returns null when meta file read throws', async () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockImplementation(() => { throw new Error('read error'); });

            const result = await manager.health('default');
            expect(result).toBeNull();
            expect(net.createConnection).not.toHaveBeenCalled();
        });
    });

    // ------------------------------------------------------------------
    // onCrash
    // ------------------------------------------------------------------
    describe('onCrash', () => {
        it('registers a single crash callback', () => {
            const cb = jest.fn();
            manager.onCrash('default', cb);

            const callbacks = manager._crashCallbacks.get('default');
            expect(callbacks).toContain(cb);
            expect(callbacks.length).toBe(1);
        });

        it('supports multiple crash callbacks per session', () => {
            const cb1 = jest.fn();
            const cb2 = jest.fn();
            manager.onCrash('default', cb1);
            manager.onCrash('default', cb2);

            const callbacks = manager._crashCallbacks.get('default');
            expect(callbacks).toEqual([cb1, cb2]);
        });

        it('supports independent callbacks per session', () => {
            const cbA = jest.fn();
            const cbB = jest.fn();
            manager.onCrash('session-a', cbA);
            manager.onCrash('session-b', cbB);

            expect(manager._crashCallbacks.get('session-a')).toContain(cbA);
            expect(manager._crashCallbacks.get('session-b')).toContain(cbB);
        });

        it('fires crash callback on process exit after ensureRunning resolves', async () => {
            const mockProc = createMockChildProcess();
            cp.spawn.mockReturnValue(mockProc);

            const mockMetaPath = path.join(SESSION_DIR, 'default.json');
            let metaCheckCount = 0;
            fs.existsSync.mockImplementation((p) => {
                if (p === mockMetaPath) {
                    metaCheckCount++;
                    return metaCheckCount > 3;
                }
                return false;
            });

            const cb = jest.fn();
            manager.onCrash('default', cb);

            await manager.ensureRunning('default', { timeout: 5000 });

            // Simulate process crash after successful start
            const exitHandler = mockProc._handlers['exit'];
            expect(exitHandler).toBeDefined();
            exitHandler(42);

            expect(cb).toHaveBeenCalledWith(42);
            expect(manager._processes.has('default')).toBe(false);
        });

        it('does not fire crash callback when process exits before start', async () => {
            const mockProc = createMockChildProcess();
            cp.spawn.mockReturnValue(mockProc);
            fs.existsSync.mockReturnValue(false);

            const cb = jest.fn();
            manager.onCrash('default', cb);

            const promise = manager.ensureRunning('default');
            const exitHandler = mockProc._handlers['exit'];
            expect(exitHandler).toBeDefined();
            exitHandler(1);

            await expect(promise).rejects.toThrow();
            expect(cb).not.toHaveBeenCalled();
        });
    });
});
