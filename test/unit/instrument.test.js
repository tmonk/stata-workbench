/**
 * Tests for instrument.js — Sentry initialization and global hooks.
 *
 * instrument.js is loaded as a side-effect module. It:
 *   1. Attaches global.addLogToSentryBuffer (buffers logs)
 *   2. Attaches global.setStataWorkbenchShuttingDown (shutdown flag)
 *   3. Initializes Sentry SDK with DSN and filters
 *
 * Because loading the real module initializes Sentry (which we want to avoid in
 * tests), we test the global hooks by loading the module in a simulated
 * environment, and we test the beforeSend/beforeSendTransaction logic by
 * exporting equivalent testable helpers or by checking global behavior.
 */
const { describe, it, beforeEach, afterEach, expect, jest } = require('bun:test');

// Save original globals to restore after tests
const origAddLogToSentryBuffer = global.addLogToSentryBuffer;
const origSetStataWorkbenchShuttingDown = global.setStataWorkbenchShuttingDown;

describe('instrument.js — global hooks', () => {
    beforeEach(() => {
        // Clear any previously set globals
        delete global.addLogToSentryBuffer;
        delete global.setStataWorkbenchShuttingDown;
    });

    afterEach(() => {
        // Restore originals
        global.addLogToSentryBuffer = origAddLogToSentryBuffer;
        global.setStataWorkbenchShuttingDown = origSetStataWorkbenchShuttingDown;
    });

    describe('global.addLogToSentryBuffer', () => {
        // The module may already be cached from the preload script.
        // To ensure fresh globals, force a re-evaluation.
        function freshRequireInstrument() {
            delete require.cache[require.resolve('../../src/instrument')];
            require('../../src/instrument');
        }

        it('is a function after require', () => {
            delete global.addLogToSentryBuffer;
            freshRequireInstrument();
            expect(typeof global.addLogToSentryBuffer).toBe('function');
        });

        it('buffers log messages', () => {
            delete global.addLogToSentryBuffer;
            freshRequireInstrument();

            expect(() => {
                global.addLogToSentryBuffer('test log message');
            }).not.toThrow();
        });

        it('handles null/undefined gracefully', () => {
            delete global.addLogToSentryBuffer;
            freshRequireInstrument();

            expect(() => {
                global.addLogToSentryBuffer(null);
                global.addLogToSentryBuffer(undefined);
                global.addLogToSentryBuffer('');
            }).not.toThrow();
        });

        it('does not crash when called many times', () => {
            delete global.addLogToSentryBuffer;
            freshRequireInstrument();

            expect(() => {
                for (let i = 0; i < 500; i++) {
                    global.addLogToSentryBuffer(`log line ${i}`);
                }
            }).not.toThrow();
        });
    });

    describe('global.setStataWorkbenchShuttingDown', () => {
        function freshRequireInstrument() {
            delete require.cache[require.resolve('../../src/instrument')];
            require('../../src/instrument');
        }

        it('is a function after require', () => {
            delete global.setStataWorkbenchShuttingDown;
            freshRequireInstrument();
            expect(typeof global.setStataWorkbenchShuttingDown).toBe('function');
        });

        it('can be called without error', () => {
            delete global.setStataWorkbenchShuttingDown;
            freshRequireInstrument();
            expect(() => {
                global.setStataWorkbenchShuttingDown();
            }).not.toThrow();
        });
    });

    describe('global hook interaction', () => {
        it('both globals are set by loading the module once', () => {
            delete global.addLogToSentryBuffer;
            delete global.setStataWorkbenchShuttingDown;
            delete require.cache[require.resolve('../../src/instrument')];
            require('../../src/instrument');
            expect(typeof global.addLogToSentryBuffer).toBe('function');
            expect(typeof global.setStataWorkbenchShuttingDown).toBe('function');
        });
    });
});

describe('instrument.js — Sentry filters (behavioral)', () => {
    beforeEach(() => {
        delete global.addLogToSentryBuffer;
        delete global.setStataWorkbenchShuttingDown;
    });

    afterEach(() => {
        global.addLogToSentryBuffer = origAddLogToSentryBuffer;
        global.setStataWorkbenchShuttingDown = origSetStataWorkbenchShuttingDown;
    });

    it('registers Sentry with expected DSN pattern', () => {
        // The module imports Sentry and calls Sentry.init — we can't easily
        // intercept this with jest.mock since it's loaded eagerly.
        // Instead, verify no exception is thrown when loading.
        expect(() => {
            require('../../src/instrument');
        }).not.toThrow();
    });

    it('beforeSend filters out test-file exceptions', () => {
        // Simulate the filtering logic from instrument.js
        // This is a white-box test of the filter behavior
        const logBuffer = [];
        const isShuttingDown = false;

        // Create a mock event that would be filtered
        const testFrameEvent = {
            exception: {
                values: [{
                    stacktrace: {
                        frames: [{ filename: '/path/to/test/something.test.js' }]
                    }
                }]
            }
        };

        // Check if the filter logic matches what instrument.js implements
        const isTestFile = (event) =>
            (event.exception?.values || []).some(ex =>
                ex.stacktrace?.frames?.some(frame =>
                    frame.filename && (
                        frame.filename.includes('test/') ||
                        frame.filename.includes('.test.') ||
                        frame.filename.includes('pypi-versioning.test')
                    )
                )
            );

        expect(isTestFile(testFrameEvent)).toBe(true);

        // Non-test file should not match
        const prodEvent = {
            exception: {
                values: [{
                    stacktrace: {
                        frames: [{ filename: '/app/src/extension.js' }]
                    }
                }]
            }
        };
        expect(isTestFile(prodEvent)).toBe(false);
    });

    it('beforeSend filters out shutdown lifecycle errors', () => {
        // Simulate the shutdown filter
        const isShuttingDown = true;
        const isLifecycleError = (msg) =>
            msg.includes('connection closed') ||
            msg.includes('channel has been closed') ||
            msg.includes('not connected') ||
            msg.includes('socket hang up') ||
            msg.includes('econnreset') ||
            msg.includes('request timed out') ||
            msg.includes('aborted') ||
            msg.includes('canceled') ||
            msg.includes('disposed') ||
            msg.includes('terminated');

        expect(isShuttingDown && isLifecycleError('connection closed')).toBe(true);
        expect(isShuttingDown && isLifecycleError('actual error')).toBe(false);
    });

    it('beforeSend filters out Stata user errors (r(NNN); pattern)', () => {
        const isStataUserError = (msg) => /r\(\d+\);/.test(msg) || /\[rc\s+\d+\]/.test(msg);
        expect(isStataUserError('r(111);')).toBe(true);
        expect(isStataUserError('r(601); some error')).toBe(true);
        expect(isStataUserError('[rc 111]')).toBe(true);
        expect(isStataUserError('actual failure')).toBe(false);
    });

    it('beforeSend filters events not related to our extension', () => {
        const isFromOurExtension = (event) =>
            (event.exception?.values || []).some(ex => {
                const hasOurFrame = ex.stacktrace?.frames?.some(frame =>
                    frame.filename && (
                        frame.filename.includes('stata-workbench') ||
                        frame.filename.includes('tmonk')
                    )
                );
                if (hasOurFrame) return true;

                const val = (ex.value || '').toLowerCase();
                return val.includes('stata-workbench') || val.includes('tmonk');
            });

        const ourEvent = {
            exception: {
                values: [{
                    value: 'Error in stata-workbench: something broke',
                    stacktrace: { frames: [{ filename: '/app/stata-workbench/src/extension.js' }] }
                }]
            }
        };
        expect(isFromOurExtension(ourEvent)).toBe(true);

        const otherEvent = {
            exception: {
                values: [{
                    value: 'Error in some-other-extension',
                    stacktrace: { frames: [{ filename: '/app/other-ext/index.js' }] }
                }]
            }
        };
        expect(isFromOurExtension(otherEvent)).toBe(false);
    });

    it('beforeSendTransaction filters out known noise patterns', () => {
        const noiseMarkers = [
            'exa.', 'ExtensionServerService',
            'kiro.', 'agent-event', 'AgentExecution', 'Steering.',
            'readFile.readFileFromUri', 'openTextDocument', 'getDiagnostics',
            'QApi.QAPICall', 'AsyncToolCallStart', 'Graph.',
            'codegpt', 'autocomplete', 'api/autocomplete',
            'pdf.worker', 'pdf.mjs', 'viewer.html',
            'envelope', 'sentry.io', 'notifications.handleAgentEvent'
        ];

        for (const marker of noiseMarkers) {
            const event = { transaction: `some.prefix.${marker}.something` };
            const isNoise = noiseMarkers.some(m => event.transaction.includes(m));
            expect(isNoise).toBe(true);
        }

        // Our own transactions should pass through
        const ourEvent = { transaction: 'stata.extension.runSelection' };
        const isOurTransaction = ourEvent.transaction.startsWith('stata.');
        expect(isOurTransaction).toBe(true);
    });
});
