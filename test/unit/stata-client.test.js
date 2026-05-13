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
    
    describe('validateFilterExpr', () => {
        it('returns { valid: true } on success response', async () => {
            await client.ensureConnected('default');
            const promise = client.validateFilterExpr('price > 5000');
            await Promise.resolve();
            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.method).toBe('validate_filter');
            expect(request.args.filter_expr).toBe('price > 5000');
            mockSocket.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: true, result: {} }) + '\n'));
            const result = await promise;
            expect(result.valid).toBe(true);
            expect(result.error).toBe(null);
        });
    
        it('returns { valid: false, error } when stataClient throws', async () => {
            client._call = jest.fn().mockRejectedValue(new Error('syntax error'));
            const result = await client.validateFilterExpr('price > 5000');
            expect(result.valid).toBe(false);
            expect(result.error).toBe('syntax error');
        });
    });
    
    describe('computeViewIndices', () => {
        it('sends compute_view_indices and returns indices array', async () => {
            await client.ensureConnected('default');
            const promise = client.computeViewIndices('price > 5000');
            await Promise.resolve();
            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.method).toBe('compute_view_indices');
            mockSocket.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: true, result: { indices: [1, 3, 7] } }) + '\n'));
            const result = await promise;
            expect(result).toEqual([1, 3, 7]);
        });
    
        it('returns empty array when result has no indices key', async () => {
            await client.ensureConnected('default');
            const promise = client.computeViewIndices('price > 5000');
            await Promise.resolve();
            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            mockSocket.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: true, result: {} }) + '\n'));
            const result = await promise;
            expect(result).toEqual([]);
        });
    });
    
    describe('listGraphs', () => {
        it('calls graph_list and returns result', async () => {
            await client.ensureConnected('default');
            const promise = client.listGraphs();
            await Promise.resolve();
            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.method).toBe('graph_list');
            mockSocket.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: true, result: { graph_names: ['mygraph'] } }) + '\n'));
            const result = await promise;
            expect(result.graph_names[0]).toBe('mygraph');
        });
    });
    
    describe('exportGraph', () => {
        it('calls graph_export with name, format, out_path', async () => {
            await client.ensureConnected('default');
            const promise = client.exportGraph('mygraph', 'pdf', '/tmp/out.pdf');
            await Promise.resolve();
            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.method).toBe('graph_export');
            expect(request.args.name).toBe('mygraph');
            expect(request.args.format).toBe('pdf');
            expect(request.args.out_path).toBe('/tmp/out.pdf');
            mockSocket.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: true, result: {} }) + '\n'));
            await expect(promise).resolves.toBeDefined();
        });
    });
    
    describe('getResults', () => {
        it('calls results with class=r by default', async () => {
            await client.ensureConnected('default');
            const promise = client.getResults();
            await Promise.resolve();
            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.method).toBe('results');
            expect(request.args.class).toBe('r');
            mockSocket.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: true, result: {} }) + '\n'));
            await promise;
        });
    
        it('passes supplied resultClass to args.class', async () => {
            await client.ensureConnected('default');
            const promise = client.getResults('e');
            await Promise.resolve();
            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.args.class).toBe('e');
            mockSocket.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: true, result: {} }) + '\n'));
            await promise;
        });
    });
    
    describe('getLogTail', () => {
        it('calls log_tail with lines=50 by default', async () => {
            await client.ensureConnected('default');
            const promise = client.getLogTail();
            await Promise.resolve();
            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.method).toBe('log_tail');
            expect(request.args.lines).toBe(50);
            mockSocket.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: true, result: {} }) + '\n'));
            await promise;
        });
    
        it('passes custom line count', async () => {
            await client.ensureConnected('default');
            const promise = client.getLogTail(100);
            await Promise.resolve();
            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.args.lines).toBe(100);
            mockSocket.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: true, result: {} }) + '\n'));
            await promise;
        });
    });
    
    describe('searchLog', () => {
        it('calls log_search with pattern', async () => {
            await client.ensureConnected('default');
            const promise = client.searchLog('r(111)');
            await Promise.resolve();
            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.method).toBe('log_search');
            expect(request.args.pattern).toBe('r(111)');
            mockSocket.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: true, result: {} }) + '\n'));
            await promise;
        });
    });
    
    describe('getTaskStatus', () => {
        it('calls task_status with wait=false by default', async () => {
            await client.ensureConnected('default');
            const promise = client.getTaskStatus('tid');
            await Promise.resolve();
            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.method).toBe('task_status');
            expect(request.args.wait).toBe(false);
            mockSocket.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: true, result: {} }) + '\n'));
            await promise;
        });
    
        it('passes wait=true and timeout when opts supplied', async () => {
            await client.ensureConnected('default');
            const promise = client.getTaskStatus('tid', { wait: true, timeout: 60 });
            await Promise.resolve();
            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.args.wait).toBe(true);
            expect(request.args.timeout).toBe(60);
            mockSocket.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: true, result: {} }) + '\n'));
            await promise;
        });
    });
    
    describe('cancelTask', () => {
        it('sends task_cancel with task_id', async () => {
            await client.ensureConnected('default');
            const promise = client.cancelTask('tid-123');
            await Promise.resolve();
            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            expect(request.method).toBe('task_cancel');
            expect(request.args.task_id).toBe('tid-123');
            mockSocket.emit('data', Buffer.from(JSON.stringify({ id: request.id, ok: true, result: {} }) + '\n'));
            await promise;
        });
    });
    
    describe('setRequestTimeout', () => {
        it('updates _requestTimeoutMs', () => {
            expect(client._requestTimeoutMs).toBe(100000);
            client.setRequestTimeout(5000);
            expect(client._requestTimeoutMs).toBe(5000);
        });
    });
    
    describe('_onData fragmentation', () => {
        it('handles response split across two data events', async () => {
            await client.ensureConnected('default');
            const promise = client.runCode('display 1', { sessionName: 'default' });
            await Promise.resolve();
            const writtenData = mockSocket.write.mock.calls[0][0];
            const request = JSON.parse(writtenData.trim());
            const responseJson = JSON.stringify({ id: request.id, ok: true, result: { ok: true, rc: 0, stdout: '1' } });
            const halfIdx = Math.floor(responseJson.length / 2);
            mockSocket.emit('data', Buffer.from(responseJson.slice(0, halfIdx)));
            mockSocket.emit('data', Buffer.from(responseJson.slice(halfIdx) + '\n'));
            const result = await promise;
            expect(result.ok).toBe(true);
            expect(result.rc).toBe(0);
        });
    
        it('processes multiple responses in a single data event', async () => {
            await client.ensureConnected('default');
            const promiseA = client.runCode('display 1', { sessionName: 'default' });
            await Promise.resolve();
            const reqA = JSON.parse(mockSocket.write.mock.calls[0][0].trim());
            const promiseB = client.runCode('display 2', { sessionName: 'default' });
            await Promise.resolve();
            const reqB = JSON.parse(mockSocket.write.mock.calls[1][0].trim());
            const respA = JSON.stringify({ id: reqA.id, ok: true, result: { ok: true, rc: 0, stdout: '1' } }) + '\n';
            const respB = JSON.stringify({ id: reqB.id, ok: true, result: { ok: true, rc: 0, stdout: '2' } }) + '\n';
            mockSocket.emit('data', Buffer.from(respA + respB));
            const r1 = await promiseA;
            const r2 = await promiseB;
            expect(r1.stdout).toBe('1');
            expect(r2.stdout).toBe('2');
        });
    });
    
    describe('request timeout', () => {
        it('rejects with timeout error when no response arrives within _requestTimeoutMs', async () => {
            jest.useFakeTimers();
            try {
                client.setRequestTimeout(100);
                await client.ensureConnected('default');
                const promise = client.runCode('display 1', { sessionName: 'default' });
                await Promise.resolve();
                jest.advanceTimersByTime(101);
                await expect(promise).rejects.toThrow(/timed out/i);
            } finally {
                jest.useRealTimers();
            }
        });
    });
    
    describe('socket write error', () => {
        it('rejects the pending promise when socket.write callback receives an error', async () => {
            mockSocket.write = jest.fn((data, encoding, cb) => {
                if (cb) cb(new Error('EPIPE'));
                return false;
            });
            await client.ensureConnected('default');
            const promise = client.runCode('display 1', { sessionName: 'default' });
            await expect(promise).rejects.toThrow('EPIPE');
            expect(client._pending.size).toBe(0);
        });
    });
    
    describe('_scheduleReconnect', () => {
        it('emits error after _maxReconnectAttempts consecutive failures', async () => {
            client._maxReconnectAttempts = 1;
            // Register a no-op error handler so emit('error') doesn't throw
            client.on('error', () => {});
            const emitSpy = jest.spyOn(client, 'emit');
            
            // Make ensureRunning fail so reconnect attempts accumulate
            daemonMgr.ensureRunning = jest.fn().mockRejectedValue(new Error('cannot start'));
            
            // First call: count = 0 < maxAttempts, sets count to 1, schedules reconnect
            client._scheduleReconnect('default');
            
            // After 2s, the timer fires, ensureRunning rejects, catch triggers recursive call
            // In the recursive call: count (1) >= maxAttempts (1) → emits 'error'
            await new Promise(r => setTimeout(r, 3000));
            
            expect(emitSpy).toHaveBeenCalledWith('error', expect.objectContaining({
                message: expect.stringContaining('failed to restart'),
            }));
        }, 8000);
    });
    
    describe('multi-session', () => {
        it('maintains independent sockets for two sessions', async () => {
            const net = require('net');
            const socketA = createMockSocket();
            const socketB = createMockSocket();
            net.createConnection.mockReturnValueOnce(socketA).mockReturnValueOnce(socketB);
            await client.ensureConnected('session-a');
            await client.ensureConnected('session-b');
            expect(client.isConnected('session-a')).toBe(true);
            expect(client.isConnected('session-b')).toBe(true);
            await client.disconnect('session-a');
            expect(client.isConnected('session-a')).toBe(false);
            expect(client.isConnected('session-b')).toBe(true);
        });
    });
});
