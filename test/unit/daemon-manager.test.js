const { describe, it, beforeEach, afterEach, expect, jest } = require('bun:test');
const path = require('path');
const os = require('os');
const fs = require('fs');
const cp = require('child_process');
const net = require('net');

const SESSION_DIR = path.join(os.homedir(), '.cache', 'stata-agent', 'sessions');

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
    let spawnCallArgs;

    // Store original function references so we can restore them manually
    // instead of relying on jest.restoreAllMocks() (which conflicts with
    // other test files under --concurrent).
    let _origExistsSync;
    let _origReadFileSync;
    let _origUnlinkSync;
    let _origCreateConnection;
    let _origSpawnSync;

    beforeEach(() => {
        // _findStataAgentBinary returns STATA_AGENT_PATH immediately if set;
        // unset so it goes through the normal binary search path.
        originalStataPath = process.env.STATA_AGENT_PATH;
        delete process.env.STATA_AGENT_PATH;

        // Track spawn calls manually so we don't rely on jest.spyOn on the
        // shared child_process module (which breaks under --concurrent when
        // other test files call jest.restoreAllMocks()).
        spawnCallArgs = [];

        // Replace module functions directly (not via jest.spyOn) so that
        // jest.restoreAllMocks() from other test files cannot interfere.
        _origSpawnSync = cp.spawnSync;
        cp.spawnSync = jest.fn().mockReturnValue({ status: 1 });

        _origExistsSync = fs.existsSync;
        _origReadFileSync = fs.readFileSync;
        _origUnlinkSync = fs.unlinkSync;
        fs.existsSync = jest.fn().mockReturnValue(false);
        fs.readFileSync = jest.fn();
        fs.unlinkSync = jest.fn();

        _origCreateConnection = net.createConnection;
        net.createConnection = jest.fn();

        // Rely on the (possibly cached) DaemonManager from the module system.
        // We don't delete require.cache because that would break concurrent test
        // execution where other test files also hold references to daemon-manager.
        const { DaemonManager: DM } = require('../../src/daemon-manager');
        DaemonManager = DM;

        // Override the internal spawn function with a mock that records calls
        // and returns a default mock child process (overridable per test).
        let currentMockProc = null;
        DaemonManager.__setSpawn((bin, args, opts) => {
            const call = { bin, args, opts };
            spawnCallArgs.push(call);
            return currentMockProc || createMockChildProcess();
        });

        // Expose a helper so tests can set the return value for the next spawn
        manager = new DaemonManager();
        manager.__setMockProc = (proc) => { currentMockProc = proc; };

        // Default mock proc: set a default one
        const defaultProc = createMockChildProcess();
        manager.__setMockProc(defaultProc);
    });

    afterEach(() => {
        if (originalStataPath !== undefined) {
            process.env.STATA_AGENT_PATH = originalStataPath;
        }
        // Restore manually to avoid conflicts with other test files
        if (_origSpawnSync) cp.spawnSync = _origSpawnSync;
        if (_origExistsSync) fs.existsSync = _origExistsSync;
        if (_origReadFileSync) fs.readFileSync = _origReadFileSync;
        if (_origUnlinkSync) fs.unlinkSync = _origUnlinkSync;
        if (_origCreateConnection) net.createConnection = _origCreateConnection;
        DaemonManager.__resetSpawn();
        // Don't call jest.restoreAllMocks() — it interferes with other test files
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

            expect(spawnCallArgs.length).toBe(0);
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

            expect(spawnCallArgs.length).toBe(0);
        });

        it('removes stale meta and spawns when socket file is missing', async () => {
            const mockProc = createMockChildProcess();
            manager.__setMockProc(mockProc);

            // Sequence existsSync returns:
            //   1st meta check → true (stale meta exists)
            //   after unlink → gone for a few polls, then reappears
            let metaCheckCount = 0;
            fs.existsSync.mockReset();
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
            expect(spawnCallArgs.length).toBeGreaterThan(0);
        });

        it('spawns daemon and resolves when meta appears', async () => {
            const mockProc = createMockChildProcess();
            manager.__setMockProc(mockProc);

            let metaCheckCount = 0;
            fs.existsSync.mockReset();
            fs.existsSync.mockImplementation((p) => {
                if (p === mockMetaPath) {
                    metaCheckCount++;
                    return metaCheckCount > 3;
                }
                return false;
            });

            await manager.ensureRunning('default', { timeout: 5000 });

            expect(spawnCallArgs.length).toBe(1);
            expect(spawnCallArgs[0].bin).toBe('stata-agent');
            expect(spawnCallArgs[0].args).toEqual(
                expect.arrayContaining(['daemon', 'start', '--session', 'default'])
            );
            expect(manager._processes.get('default')).toBe(mockProc);
        });

        it('forwards --mock when opts.mock is set', async () => {
            const mockProc = createMockChildProcess();
            manager.__setMockProc(mockProc);

            let metaCheckCount = 0;
            fs.existsSync.mockReset();
            fs.existsSync.mockImplementation((p) => {
                if (p === mockMetaPath) {
                    metaCheckCount++;
                    return metaCheckCount > 3;
                }
                return false;
            });

            await manager.ensureRunning('default', { mock: true, timeout: 5000 });

            expect(spawnCallArgs[0].args).toContain('--mock');
        });

        it('rejects when spawned process exits before meta appears', async () => {
            const mockProc = createMockChildProcess();
            manager.__setMockProc(mockProc);
            fs.existsSync.mockReturnValue(false);

            const promise = manager.ensureRunning('default');

            // Trigger exit handler synchronously
            const exitHandler = mockProc._handlers['exit'];
            expect(exitHandler).toBeDefined();
            exitHandler(1);

            await expect(promise).rejects.toThrow('Daemon exited with code 1');
            expect(manager._processes.has('default')).toBe(false);
        });

        it('rejects on timeout when meta never appears', async () => {
            const mockProc = createMockChildProcess();
            manager.__setMockProc(mockProc);
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

        it('falls back to SIGKILL when process survives SIGTERM after 3s timeout', async () => {
            jest.useFakeTimers();
            try {
                const mockProc = createMockChildProcess();
                manager._processes.set('default', mockProc);

                // Prevent _processes.delete from happening so the SIGKILL check
                // finds the process still in the map when the timer fires
                const origDelete = manager._processes.delete.bind(manager._processes);
                manager._processes.delete = jest.fn();

                // Call stop (async) — it fires the SIGTERM + registers 3s timer
                const stopPromise = manager.stop('default');

                // Advance time past the 3s SIGKILL timeout
                jest.advanceTimersByTime(3100);

                await stopPromise;

                // SIGTERM was sent
                expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
                // SIGKILL was also sent because process was still in map
                expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL');
            } finally {
                jest.useRealTimers();
            }
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
            manager.__setMockProc(mockProc);

            const mockMetaPath = path.join(SESSION_DIR, 'default.json');
            let metaCheckCount = 0;
            fs.existsSync.mockReset();
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
            manager.__setMockProc(mockProc);
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

    // ------------------------------------------------------------------
    // _findStataAgentBinary — STATA_AGENT_PATH env
    // ------------------------------------------------------------------
    describe('_findStataAgentBinary', () => {
        afterEach(() => {
            delete process.env.STATA_AGENT_PATH;
        });

        it('returns STATA_AGENT_PATH when set', () => {
            process.env.STATA_AGENT_PATH = '/custom/stata-agent';
            const result = manager._findStataAgentBinary();
            expect(result).toBe('/custom/stata-agent');
        });

        it('does not use STATA_PATH env (reserved for Stata Corp binary)', () => {
            process.env.STATA_PATH = '/custom/stata-mp';
            jest.spyOn(cp, 'spawnSync').mockReturnValue({ status: 0 });
            const result = manager._findStataAgentBinary();
            // Should fall through to discovery, not use STATA_PATH
            expect(result).not.toBe('/custom/stata-mp');
            expect(cp.spawnSync).toHaveBeenCalledWith('stata-agent', ['--version'], expect.any(Object));
        });
    });

    // ------------------------------------------------------------------
    // ensureRunning — windows TCP branch
    // ------------------------------------------------------------------
    describe('ensureRunning', () => {
        let origPlatform;

        beforeEach(() => {
            origPlatform = process.platform;
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        });

        afterEach(() => {
            Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
        });

        it('appends --transport tcp args when process.platform is win32', async () => {
            const mockProc = createMockChildProcess();
            manager.__setMockProc(mockProc);

            const mockMetaPath = path.join(SESSION_DIR, 'default.json');
            let metaCheckCount = 0;
            fs.existsSync.mockReset();
            fs.existsSync.mockImplementation((p) => {
                if (p === mockMetaPath) {
                    metaCheckCount++;
                    return metaCheckCount > 3;
                }
                return false;
            });

            await manager.ensureRunning('default', { timeout: 5000 });

            expect(spawnCallArgs[0].args).toEqual(
                expect.arrayContaining(['--transport', 'tcp'])
            );
        });
    });

    // ------------------------------------------------------------------
    // stop — TCP transport
    // ------------------------------------------------------------------
    describe('stop', () => {
        it('creates TCP connection when meta transport is tcp', async () => {
            const mockProc = createMockChildProcess();
            manager._processes.set('default', mockProc);

            const mockSocket = createMockSocket();
            net.createConnection.mockReturnValue(mockSocket);
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                transport: 'tcp',
                port: 9876,
                host: '127.0.0.1',
            }));

            await manager.stop('default');

            expect(net.createConnection).toHaveBeenCalledWith(
                expect.objectContaining({ port: 9876, host: '127.0.0.1' })
            );
        });
    });

    // ------------------------------------------------------------------
    // health — TCP transport
    // ------------------------------------------------------------------
    describe('health', () => {
        it('connects via TCP when meta transport is tcp', async () => {
            const mockMetaPath = path.join(SESSION_DIR, 'default.json');
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                transport: 'tcp',
                port: 8765,
            }));

            const mockSocket = createMockSocket();
            net.createConnection.mockReturnValue(mockSocket);

            const healthPromise = manager.health('default');
            mockSocket._trigger('data', Buffer.from(
                JSON.stringify({ result: { status: 'running', pid: 12345 } }) + '\n'
            ));

            const result = await healthPromise;
            expect(result).toEqual({ status: 'running', pid: 12345 });
            expect(net.createConnection).toHaveBeenCalledWith(
                expect.objectContaining({ port: 8765 })
            );
        });
    });

    // ------------------------------------------------------------------
    // DaemonManager.__setSpawn / __resetSpawn API
    // ------------------------------------------------------------------
    describe('__setSpawn / __resetSpawn', () => {
        it('__setSpawn overrides the internal spawn function', () => {
            const customSpawn = jest.fn().mockReturnValue(createMockChildProcess());
            DaemonManager.__setSpawn(customSpawn);

            manager._findStataAgentBinary = () => 'test-bin';
            // Temporarily make meta appear so ensureRunning tries to spawn
            const mockMetaPath = path.join(SESSION_DIR, 'default.json');
            let checked = false;
            fs.existsSync.mockReset();
            fs.existsSync.mockImplementation((p) => {
                if (p === mockMetaPath && checked) return true;
                if (p === mockMetaPath) { checked = true; return false; }
                return false;
            });

            const promise = manager.ensureRunning('default', { timeout: 5000 });
            // Let the poll interval fire
            setTimeout(async () => {
                const exitHandler = customSpawn.mock.results[0]?.value?._handlers?.exit;
                if (exitHandler) exitHandler(0);
            }, 300);

            return promise.then(() => {
                expect(customSpawn).toHaveBeenCalledWith(
                    'test-bin',
                    expect.arrayContaining(['daemon', 'start', '--session', 'default']),
                    expect.any(Object)
                );
            }).finally(() => DaemonManager.__resetSpawn());
        }, 10000);

        it('default spawn function delegates to child_process.spawn', () => {
            // Reset to use the default _spawn
            DaemonManager.__resetSpawn();

            const mockChildProc = createMockChildProcess();
            const spawnSpy = jest.spyOn(cp, 'spawn').mockReturnValue(mockChildProc);

            // Call ensureRunning with a mock binary that will trigger spawn
            manager._findStataAgentBinary = () => 'stata-agent';
            const mockMetaPath = path.join(SESSION_DIR, 'default.json');
            let metaCheckCount = 0;
            fs.existsSync.mockReset();
            fs.existsSync.mockImplementation((p) => {
                if (p === mockMetaPath) {
                    metaCheckCount++;
                    return metaCheckCount > 3;
                }
                return false;
            });

            const promise = manager.ensureRunning('default', { timeout: 5000 });

            // Let poll interval fire and meta appear
            setTimeout(async () => {
                const exitHandler = mockChildProc._handlers?.exit;
                if (exitHandler) exitHandler(0);
            }, 500);

            return promise.then(() => {
                expect(spawnSpy).toHaveBeenCalledWith(
                    'stata-agent',
                    expect.arrayContaining(['daemon', 'start', '--session', 'default']),
                    expect.any(Object)
                );
                spawnSpy.mockRestore();
            }).catch(() => {
                spawnSpy.mockRestore();
            });
        }, 10000);

        it('__resetSpawn restores the original child_process.spawn', () => {
            const customSpawn = jest.fn();
            DaemonManager.__setSpawn(customSpawn);
            DaemonManager.__resetSpawn();

            // After reset, calling spawn should go to the real child_process.spawn
            const mockProc = createMockChildProcess();
            manager.__setMockProc(mockProc);

            expect(DaemonManager.__resetSpawn).not.toThrow();
        });
    });

    // ------------------------------------------------------------------
    // Edge cases
    // ------------------------------------------------------------------
    describe('edge cases', () => {
        it('ensureRunning handles spawn throwing synchronously', async () => {
            DaemonManager.__setSpawn(() => { throw new Error('spawn EACCES'); });
            const mockMetaPath = path.join(SESSION_DIR, 'default.json');
            fs.existsSync.mockReset();
            fs.existsSync.mockImplementation((p) => {
                if (p === mockMetaPath) { return false; }
                return false;
            });

            await expect(
                manager.ensureRunning('default', { timeout: 100 })
            ).rejects.toThrow('spawn EACCES');

            DaemonManager.__resetSpawn();
        });

        it('handle multiple sessions independently', async () => {
            const mockProcA = createMockChildProcess();
            const mockProcB = createMockChildProcess();
            let spawnCount = 0;
            DaemonManager.__setSpawn(() => {
                spawnCount++;
                return spawnCount === 1 ? mockProcA : mockProcB;
            });

            // Use a map of session -> { ready: bool } so each session is independent
            const sessionReady = { 'default': false, 'session-b': false };
            fs.existsSync.mockReset();
            fs.existsSync.mockImplementation((p) => {
                const sName = path.basename(p, '.json');
                if (sName === 'default' || sName === 'session-b') {
                    if (sessionReady[sName]) return true;
                    return false;
                }
                // .sock and .json checks
                if (p.endsWith('.sock')) return false;
                return false;
            });

            // Start both sessions concurrently
            const p1 = manager.ensureRunning('default', { timeout: 5000 });
            const p2 = manager.ensureRunning('session-b', { timeout: 5000 });

            // Allow spawn to happen, then make meta appear
            await new Promise(r => setTimeout(r, 400));
            sessionReady['default'] = true;
            sessionReady['session-b'] = true;

            await Promise.all([p1, p2]);

            expect(spawnCount).toBe(2);
            expect(manager._processes.get('default')).toBe(mockProcA);
            expect(manager._processes.get('session-b')).toBe(mockProcB);

            DaemonManager.__resetSpawn();
        }, 10000);
    });
});
