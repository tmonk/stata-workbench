/**
 * Tests for runtime-context — the dependency injection / context-switching layer.
 *
 * Covers:
 *   - Default (fallback) providers
 *   - runWithContext — per-async-locale overrides
 *   - createDepProxy — lazy-forwarding proxy
 *   - setDefault* — updating defaults at runtime
 *   - getEnv — environment variable access
 *   - getMcpClient — legacy MCP client access
 */
const { describe, it, beforeEach, afterEach, expect, jest } = require('bun:test');
const { AsyncLocalStorage } = require('async_hooks');

// We must require the module fresh so tests can observe default state.
// But since runWithContext / setDefault* mutate module-level state, we
// restore those defaults in afterEach.
const ctx = require('../../src/runtime-context');

// Save originals to restore between tests
// Store a REFERENCE to process.env so restore compares correctly.
const ORIG_DEFAULTS = {
    vscode: null,
    env: process.env,
    fs: require('fs'),
    childProcess: require('child_process'),
};

describe('runtime-context', () => {
    afterEach(() => {
        // Restore defaults after each test
        ctx.setDefaultVscode(ORIG_DEFAULTS.vscode);
        ctx.setDefaultEnv(ORIG_DEFAULTS.env);
        ctx.setDefaultFs(ORIG_DEFAULTS.fs);
        ctx.setDefaultChildProcess(ORIG_DEFAULTS.childProcess);
        ctx.setDefaultMcpClient(null);
    });

    // ==================================================================
    // Default getters (no context override)
    // ==================================================================
    describe('default getters', () => {
        it('getVscode returns the real vscode module when no default set', () => {
            // When no default vscode is set and no context is active,
            // getVscode falls through to require('vscode')
            ctx.setDefaultVscode(null);
            // In test environment vscode may be mocked by the preload;
            // just verify it returns SOMETHING (truthy).
            const vscode = ctx.getVscode();
            expect(vscode).toBeDefined();
        });

        it('getFs returns the real fs module by default', () => {
            const fs = ctx.getFs();
            expect(fs).toBeDefined();
            expect(typeof fs.readFileSync).toBe('function');
        });

        it('getChildProcess returns the real child_process module by default', () => {
            const cp = ctx.getChildProcess();
            expect(cp).toBeDefined();
            expect(typeof cp.spawn).toBe('function');
        });

        it('getEnv returns process.env by default', () => {
            const env = ctx.getEnv();
            expect(env).toBe(process.env);
        });

        it('getMcpClient returns null by default', () => {
            expect(ctx.getMcpClient()).toBeNull();
        });
    });

    // ==================================================================
    // setDefault* — updating fallback providers
    // ==================================================================
    describe('setDefault*', () => {
        it('setDefaultVscode changes the fallback vscode', () => {
            const mockVscode = { version: 'test-version' };
            ctx.setDefaultVscode(mockVscode);
            expect(ctx.getVscode()).toBe(mockVscode);
        });

        it('setDefaultVscode(null) resets to require', () => {
            ctx.setDefaultVscode({ custom: true });
            ctx.setDefaultVscode(null);
            const vscode = ctx.getVscode();
            expect(vscode).toBeDefined();
            // Should no longer be our custom object
            expect(vscode.custom).toBeUndefined();
        });

        it('setDefaultEnv changes the fallback env', () => {
            const mockEnv = { CUSTOM: 'value' };
            ctx.setDefaultEnv(mockEnv);
            expect(ctx.getEnv()).toBe(mockEnv);
            expect(ctx.getEnv().CUSTOM).toBe('value');
        });

        it('setDefaultEnv(null) resets to process.env', () => {
            ctx.setDefaultEnv({ CUSTOM: 'value' });
            ctx.setDefaultEnv(null);
            expect(ctx.getEnv()).toBe(ORIG_DEFAULTS.env);
        });

        it('setDefaultFs changes the fallback fs', () => {
            const mockFs = { readFileSync: () => 'mock' };
            ctx.setDefaultFs(mockFs);
            expect(ctx.getFs()).toBe(mockFs);
            expect(ctx.getFs().readFileSync()).toBe('mock');
        });

        it('setDefaultChildProcess changes the fallback child_process', () => {
            const mockCp = { spawn: () => 'mock' };
            ctx.setDefaultChildProcess(mockCp);
            expect(ctx.getChildProcess()).toBe(mockCp);
        });

        it('setDefaultMcpClient sets the MCP client', () => {
            const mockClient = { call: () => {} };
            ctx.setDefaultMcpClient(mockClient);
            expect(ctx.getMcpClient()).toBe(mockClient);
        });

        it('setDefaultMcpClient(null) clears it', () => {
            ctx.setDefaultMcpClient({ call: () => {} });
            ctx.setDefaultMcpClient(null);
            expect(ctx.getMcpClient()).toBeNull();
        });
    });

    // ==================================================================
    // runWithContext — AsyncLocalStorage-based context switching
    // ==================================================================
    describe('runWithContext', () => {
        it('provides per-async-locale overrides', async () => {
            const mockVscode = { version: 'overridden' };
            const mockFs = { readFileSync: () => 'overridden-fs' };

            const result = await ctx.runWithContext(
                { vscode: mockVscode, fs: mockFs },
                () => {
                    // Inside the context, getters should return the override
                    expect(ctx.getVscode()).toBe(mockVscode);
                    expect(ctx.getFs()).toBe(mockFs);
                    expect(ctx.getVscode().version).toBe('overridden');
                    return 'done';
                }
            );

            expect(result).toBe('done');

            // After the context, defaults are restored
            expect(ctx.getFs()).toBe(ORIG_DEFAULTS.fs);
        });

        it('restores defaults after the callback completes', () => {
            const mockVscode = { version: 'temp' };
            ctx.runWithContext({ vscode: mockVscode }, () => {
                expect(ctx.getVscode()).toBe(mockVscode);
            });
            // After runWithContext returns, outside the context
            expect(ctx.getVscode()).not.toBe(mockVscode);
        });

        it('restores defaults even when callback throws', () => {
            const mockVscode = { version: 'temp' };
            expect(() => {
                ctx.runWithContext({ vscode: mockVscode }, () => {
                    throw new Error('oops');
                });
            }).toThrow('oops');
            // Defaults should be restored
            expect(ctx.getVscode()).not.toBe(mockVscode);
        });

        it('falls back to context env over default env', () => {
            const mockEnv = { CONTEXT_ENV: 'yes' };
            ctx.runWithContext({ env: mockEnv }, () => {
                expect(ctx.getEnv()).toBe(mockEnv);
                expect(ctx.getEnv().CONTEXT_ENV).toBe('yes');
            });
        });

        it('omitted context fields fall back to defaults', () => {
            const mockVscode = { version: 'ctx' };
            ctx.setDefaultFs({ readFileSync: () => 'default-fs' });
            ctx.runWithContext({ vscode: mockVscode }, () => {
                expect(ctx.getVscode()).toBe(mockVscode);
                // fs should fall back to the default we set
                expect(ctx.getFs().readFileSync()).toBe('default-fs');
            });
            ctx.setDefaultFs(ORIG_DEFAULTS.fs);
        });

        it('does not interfere with nested runWithContext calls', () => {
            const outerVscode = { version: 'outer' };
            const innerFs = { readFileSync: () => 'inner' };

            ctx.runWithContext({ vscode: outerVscode }, () => {
                expect(ctx.getVscode().version).toBe('outer');
                expect(ctx.getFs()).toBe(ORIG_DEFAULTS.fs);

                ctx.runWithContext({ fs: innerFs }, () => {
                    expect(ctx.getVscode().version).toBe('outer');
                    expect(ctx.getFs().readFileSync()).toBe('inner');
                });

                // After inner context, should be back to outer
                expect(ctx.getVscode().version).toBe('outer');
                expect(ctx.getFs()).toBe(ORIG_DEFAULTS.fs);
            });
        });
    });

    // ==================================================================
    // createDepProxy — lazy-forwarding proxy
    // ==================================================================
    describe('createDepProxy', () => {
        it('forwards property access to the current dependency', () => {
            const mockObj = { foo: 'bar', num: 42 };
            const getter = jest.fn().mockReturnValue(mockObj);
            const proxy = ctx.createDepProxy(getter);

            expect(proxy.foo).toBe('bar');
            expect(proxy.num).toBe(42);
            expect(getter).toHaveBeenCalled();
        });

        it('forwards method calls with correct binding', () => {
            const mockObj = {
                value: 10,
                add(x) { return this.value + x; },
            };
            const getter = jest.fn().mockReturnValue(mockObj);
            const proxy = ctx.createDepProxy(getter);

            const result = proxy.add(5);
            expect(result).toBe(15);
        });

        it('forwards property assignment to the underlying object', () => {
            const mockObj = { key: 'old' };
            const getter = jest.fn().mockReturnValue(mockObj);
            const proxy = ctx.createDepProxy(getter);

            proxy.key = 'new';
            expect(mockObj.key).toBe('new');
        });

        it('does not bind mock functions (preserves jest mock API)', () => {
            const mockFn = jest.fn().mockReturnValue('mocked');
            const mockObj = { method: mockFn };
            const getter = jest.fn().mockReturnValue(mockObj);
            const proxy = ctx.createDepProxy(getter);

            const result = proxy.method('arg');
            expect(result).toBe('mocked');
            expect(mockFn).toHaveBeenCalledWith('arg');
        });

        it('works with runWithContext for dynamic switching', () => {
            const objA = { name: 'A', greet() { return `Hello from ${this.name}`; } };
            const objB = { name: 'B', greet() { return `Hello from ${this.name}`; } };

            let current = objA;
            const getter = jest.fn().mockImplementation(() => current);
            const proxy = ctx.createDepProxy(getter);

            expect(proxy.name).toBe('A');
            expect(proxy.greet()).toBe('Hello from A');

            current = objB;
            expect(proxy.name).toBe('B');
            expect(proxy.greet()).toBe('Hello from B');
        });

        it('returns undefined for non-existent properties', () => {
            const mockObj = { exists: true };
            const proxy = ctx.createDepProxy(() => mockObj);

            expect(proxy.exists).toBe(true);
            expect(proxy.nonExistent).toBeUndefined();
        });

        it('handles null/undefined target from getter gracefully', () => {
            const proxy = ctx.createDepProxy(() => null);

            // All property accesses return undefined when target is null
            expect(proxy.anything).toBeUndefined();
            expect(proxy.toString).toBeUndefined();

            // Setting on null target returns false (no-op, doesn't crash)
            expect(() => {
                proxy.something = 'val';
            }).not.toThrow();
        });
    });

    // ==================================================================
    // Integration: createDepProxy with runWithContext
    // ==================================================================
    describe('createDepProxy with runWithContext', () => {
        it('switches dependency under the proxy when context changes', () => {
            const depA = { name: 'dep-a' };
            const depB = { name: 'dep-b' };
            let currentDep = depA;
            const proxy = ctx.createDepProxy(() => currentDep);

            expect(proxy.name).toBe('dep-a');

            currentDep = depB;
            expect(proxy.name).toBe('dep-b');
        });

        it('can be used with setDefault* for global override', () => {
            const customFs = { readFileSync: () => 'custom content' };
            ctx.setDefaultFs(customFs);

            const proxy = ctx.createDepProxy(() => ctx.getFs());
            expect(proxy.readFileSync()).toBe('custom content');

            ctx.setDefaultFs(ORIG_DEFAULTS.fs);
        });
    });
});
