const { describe, it, beforeEach, afterEach, expect } = require('bun:test');
const sinon = require('sinon');
const https = require('https');
const { EventEmitter } = require('events');

// Require mcp-client
const { StataMcpClient: McpClient } = require('../../src/mcp-client');

describe('McpClient PyPI Versioning (Sinon Stubbing)', () => {
    let client;
    let httpsGetStub;

    beforeEach(() => {
        client = new McpClient();
        client._log = sinon.stub();
        if (https.get.restore) https.get.restore();
        httpsGetStub = sinon.stub(https, 'get');
    });

    afterEach(() => {
        if (https.get.restore) https.get.restore();
    });

    describe('_sortVersions', () => {
        it('should correctly sort semantic versions', () => {
            const versions = ['1.2.3', '1.18.7', '1.18.6', '1.2.0', '1.2'];
            const sorted = client._sortVersions(versions);
            expect(sorted).toEqual(['1.18.7', '1.18.6', '1.2.3', '1.2.0', '1.2']);
        });
    });

    describe('_fetchLatestVersion', () => {
        it('should resolve with latest version and all versions on success', async () => {
            const mockResponse = new EventEmitter();
            mockResponse.statusCode = 200;

            httpsGetStub.callsFake((url, callback) => {
                process.nextTick(() => {
                    callback(mockResponse);
                    mockResponse.emit('data', JSON.stringify({
                        info: { version: '1.18.7' },
                        releases: { '1.18.7': [], '1.18.6': [] }
                    }));
                    mockResponse.emit('end');
                });
                return { on: sinon.stub(), setTimeout: sinon.stub(), destroy: sinon.stub() };
            });

            const result = await client._fetchLatestVersion();
            expect(result.latest).toBe('1.18.7');
            expect(result.all).toEqual(expect.arrayContaining(['1.18.7', '1.18.6']));
        });

        it('should reject on non-200 status code', async () => {
            const mockResponse = new EventEmitter();
            mockResponse.statusCode = 404;

            httpsGetStub.callsFake((url, callback) => {
                process.nextTick(() => {
                    callback(mockResponse);
                });
                return { on: sinon.stub(), setTimeout: sinon.stub(), destroy: sinon.stub() };
            });

            await expect(client._fetchLatestVersion()).rejects.toThrow('PyPI returned 404');
        });

        it('should reject on timeout', async () => {
            const mockRequest = new EventEmitter();
            mockRequest.setTimeout = (ms, cb) => {
                setTimeout(cb, 10);
            };
            mockRequest.destroy = sinon.stub();
            httpsGetStub.returns(mockRequest);

            await expect(client._fetchLatestVersion(5)).rejects.toThrow('PyPI request timed out');
        });
    });

    describe('_ensureClient implementation', () => {
        it('should fetch from PyPI if not already cached and no env var set', async () => {
            client._fetchLatestVersion = sinon.stub().resolves({
                latest: '1.18.7',
                all: ['1.18.7', '1.18.6']
            });
            client._createClient = sinon.stub().resolves({ 
                client: { connect: sinon.stub().resolves() }, 
                transport: {}, 
                setupTimeoutSeconds: '60' 
            });

            await client._ensureClient();

            expect(client._fetchLatestVersion.calledOnce).toBe(true);
            expect(client._pypiVersion).toBe('1.18.7');
        });

        it('should use fallback if PyPI fetch fails', async () => {
            client._fetchLatestVersion = sinon.stub().rejects(new Error('Network Error'));
            client._createClient = sinon.stub().resolves({ 
                client: { connect: sinon.stub().resolves() }, 
                transport: {}, 
                setupTimeoutSeconds: '60' 
            });

            await client._ensureClient();

            expect(client._fetchLatestVersion.calledOnce).toBe(true);
            expect(client._pypiVersion).toBeNull();
        });

        it('should only spawn one process when multiple callers invoke _ensureClient concurrently (race fix)', async () => {
            // Simulate slow PyPI fetch so concurrent callers can enter before _createClient runs
            let resolveFetch;
            client._fetchLatestVersion = sinon.stub().returns(new Promise(r => { resolveFetch = r; }));
            const mockClient = { connect: sinon.stub().resolves() };
            client._createClient = sinon.stub().resolves({ 
                client: mockClient, 
                transport: {}, 
                setupTimeoutSeconds: '60' 
            });
            client._refreshToolList = sinon.stub().resolves();

            // Fire two _ensureClient calls concurrently (before any await completes)
            const p1 = client._ensureClient();
            const p2 = client._ensureClient();

            // Both should resolve to the same client (shared _clientPromise)
            // Let the fetch resolve so _createClient runs
            resolveFetch({ latest: '1.0.0', all: ['1.0.0'] });

            const [c1, c2] = await Promise.all([p1, p2]);
            expect(c1).toBe(c2);

            // _createClient must be called only once (no duplicate mcp-stata spawns)
            expect(client._createClient.calledOnce).toBe(true);
        });
    });
});
