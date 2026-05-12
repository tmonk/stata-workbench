const { describe, it, beforeEach, afterEach, expect, jest } = require('bun:test');
const { StataClient } = require('../../src/stata-client');
const { EventEmitter } = require('events');

function createMockDaemonManager() {
    return {
        ensureRunning: jest.fn().mockResolvedValue(),
        stop: jest.fn().mockResolvedValue(),
        health: jest.fn().mockResolvedValue({ status: 'ok', pid: 12345, sessions: ['default'] }),
        onCrash: jest.fn(),
    };
}

function createMockSocket() {
    const handlers = {};
    return {
        writable: true,
        destroyed: false,
        write: jest.fn((data, encoding, cb) => {
            if (cb) cb();
            return true;
        }),
        on: jest.fn((event, handler) => {
            handlers[event] = handler;
        }),
        end: jest.fn(),
        destroy: jest.fn(),
        _handlers: handlers,
        emit: function (event, ...args) {
            if (handlers[event]) handlers[event](...args);
        },
    };
}

describe('StataClient', () => {
    let client;
    let daemonMgr;
    let mockSocket;

    beforeEach(() => {
        daemonMgr = createMockDaemonManager();
        client = new StataClient(daemonMgr);
        mockSocket = createMockSocket();

        const net = require('net');
        jest.spyOn(net, 'createConnection').mockReturnValue(mockSocket);

        const fs = require('fs');
        jest.spyOn(fs, 'readFileSync').mockReturnValue(
            JSON.stringify({ transport: 'unix', path: '/tmp/mock.sock' })
        );
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('ensureConnected', () => {
        it('opens a socket when no connection exists', async () => {
            await client.ensureConnected('test-session');

            expect(client.isConnected('test-session')).toBe(true);
            expect(mockSocket.on).toHaveBeenCalledWith('data', expect.any(Function));
            expect(mockSocket.on).toHaveBeenCalledWith('error', expect.any(Function));
            expect(mockSocket.on).toHaveBeenCalledWith('close', expect.any(Function));
        });

        it('reads meta file for connection info', async () => {
            await client.ensureConnected('session-abc');

            const fs = require('fs');
            expect(fs.readFileSync).toHaveBeenCalled();
            // Should have been called with the meta path for the given session
            const calls = fs.readFileSync.mock.calls;
            const metaCall = calls.find(c => c[0] && c[0].includes('session-abc.json'));
            expect(metaCall).toBeTruthy();
        });

        it('reuses an existing writable connection', async () => {
            await client.ensureConnected('default');
            const net = require('net');
            expect(net.createConnection).toHaveBeenCalledTimes(1);

            // Second call should reuse without creating a new socket
            await client.ensureConnected('default');
            expect(net.createConnection).toHaveBeenCalledTimes(1);
        });
    });

    describe('disconnect', () => {
        it('closes the socket and cleans up', async () => {
            await client.ensureConnected('default');
            expect(client.isConnected('default')).toBe(true);

            await client.disconnect('default');

            expect(mockSocket.end).toHaveBeenCalled();
            expect(mockSocket.destroy).toHaveBeenCalled();
            expect(client.isConnected('default')).toBe(false);
        });
    });

    describe('runCode', () => {
        it('sends an NDJSON run request and resolves on success', async () => {
            await client.ensureConnected('default');

            const promise = client.runCode('display 1', { sessionName: 'default' });
            // Flush microtask so _call completes and writes to socket
            await Promise.resolve();

            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.method).toBe('run');
            expect(request.args.code).toBe('display 1');
            expect(request.args.echo).toBe(true);
            expect(request.args.max_output_tokens).toBe(1000);

            mockSocket.emit(
                'data',
                Buffer.from(
                    JSON.stringify({
                        id: request.id,
                        ok: true,
                        result: { ok: true, rc: 0, stdout: '1' },
                    }) + '\n',
                ),
            );

            const result = await promise;
            expect(result.ok).toBe(true);
            expect(result.rc).toBe(0);
            expect(result.stdout).toBe('1');
        });

        it('rejects on error response', async () => {
            await client.ensureConnected('default');

            const promise = client.runCode('bad command', { sessionName: 'default' });
            await Promise.resolve();

            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());

            mockSocket.emit(
                'data',
                Buffer.from(
                    JSON.stringify({
                        id: request.id,
                        ok: false,
                        error: 'Syntax error',
                        error_code: 'STATA_ERROR',
                    }) + '\n',
                ),
            );

            await expect(promise).rejects.toThrow('Syntax error');
        });
    });

    describe('runFile', () => {
        it('sends a run_file request', async () => {
            await client.ensureConnected('default');

            const promise = client.runFile('/path/test.do', { sessionName: 'default' });
            await Promise.resolve();

            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.method).toBe('run_file');
            expect(request.args.path).toBe('/path/test.do');

            mockSocket.emit(
                'data',
                Buffer.from(
                    JSON.stringify({
                        id: request.id,
                        ok: true,
                        result: { ok: true, rc: 0, stdout: 'done' },
                    }) + '\n',
                ),
            );

            const result = await promise;
            expect(result.ok).toBe(true);
        });
    });

    describe('cancel', () => {
        it('sends a break request', async () => {
            await client.ensureConnected('default');

            const promise = client.cancel('default');
            await Promise.resolve();

            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.method).toBe('break');

            mockSocket.emit(
                'data',
                Buffer.from(
                    JSON.stringify({
                        id: request.id,
                        ok: true,
                        result: { acknowledged: true },
                    }) + '\n',
                ),
            );

            const result = await promise;
            expect(result.acknowledged).toBe(true);
        });
    });

    describe('listVariables', () => {
        it('calls inspect_describe and maps result', async () => {
            await client.ensureConnected('default');

            const promise = client.listVariables('default');
            await Promise.resolve();

            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.method).toBe('inspect_describe');

            mockSocket.emit(
                'data',
                Buffer.from(
                    JSON.stringify({
                        id: request.id,
                        ok: true,
                        result: {
                            variables: [
                                { name: 'price', type: 'int', label: 'Price', format: '%8.0g' },
                                { name: 'mpg', type: 'int', label: 'MPG', format: '%8.0g' },
                            ],
                        },
                    }) + '\n',
                ),
            );

            const vars = await promise;
            expect(vars).toHaveLength(2);
            expect(vars[0].name).toBe('price');
            expect(vars[0].label).toBe('Price');
            expect(vars[0].type).toBe('int');
        });
    });

    describe('getDataPage', () => {
        it('calls inspect_get with arrow format and obs_range', async () => {
            await client.ensureConnected('default');

            const promise = client.getDataPage(0, 50, 'price mpg', 'default');
            await Promise.resolve();

            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.method).toBe('inspect_get');
            expect(request.args.format).toBe('arrow');
            expect(request.args.obs_range).toBe('1:50');
            expect(request.args.varlist).toBe('price mpg');

            mockSocket.emit(
                'data',
                Buffer.from(
                    JSON.stringify({
                        id: request.id,
                        ok: true,
                        result: { path: '/tmp/test.arrow', size_bytes: 100 },
                    }) + '\n',
                ),
            );

            // getDataPage reads the result file via fs.readFileSync (mocked) then unlinks it
            const result = await promise;
            expect(Buffer.isBuffer(result) || typeof result === 'string').toBe(true);
        });
    });

    describe('readLogAtOffset', () => {
        it('calls log_read_at_offset method', async () => {
            await client.ensureConnected('default');

            const promise = client.readLogAtOffset('/tmp/test.log', 0, 1024);
            await Promise.resolve();

            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.method).toBe('log_read_at_offset');
            expect(request.args.log_path).toBe('/tmp/test.log');
            expect(request.args.offset).toBe(0);
            expect(request.args.max_bytes).toBe(1024);

            mockSocket.emit(
                'data',
                Buffer.from(
                    JSON.stringify({
                        id: request.id,
                        ok: true,
                        result: { text: 'output line 1\noutput line 2', next_offset: 200 },
                    }) + '\n',
                ),
            );

            const result = await promise;
            expect(result.text).toContain('output line');
            expect(result.next_offset).toBe(200);
        });
    });

    describe('health', () => {
        it('sends health request', async () => {
            await client.ensureConnected('default');

            const promise = client.health('default');
            await Promise.resolve();

            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.method).toBe('health');

            mockSocket.emit(
                'data',
                Buffer.from(
                    JSON.stringify({
                        id: request.id,
                        ok: true,
                        result: { status: 'ok', pid: 12345, sessions: ['default'] },
                    }) + '\n',
                ),
            );

            const result = await promise;
            expect(result.status).toBe('ok');
            expect(result.pid).toBe(12345);
        });
    });

    describe('event emission', () => {
        it('emits status event on connect and disconnect', async () => {
            const statusEvents = [];
            client.on('status', (s) => statusEvents.push(s));

            await client.ensureConnected('default');
            expect(statusEvents).toContain('connected');

            // Simulate socket close
            mockSocket.emit('close');

            expect(statusEvents).toContain('disconnected');
        });

        it('emits error event on socket error', async () => {
            const errors = [];
            client.on('error', (e) => errors.push(e));

            await client.ensureConnected('default');
            mockSocket.emit('error', new Error('connection refused'));

            expect(errors.length).toBeGreaterThan(0);
            expect(errors[0].message).toBe('connection refused');
        });
    });
});
