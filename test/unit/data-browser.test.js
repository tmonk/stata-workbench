const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { tableToIPC, tableFromArrays } = require('apache-arrow');

describe('Data Browser Frontend (data-browser.js)', () => {
    let dom;
    let window;
    let document;
    let vscodeMock;
    let scriptContent;
    let activeTimers;

    beforeAll(() => {
        scriptContent = fs.readFileSync(path.join(__dirname, '../../src/ui-shared/data-browser.js'), 'utf8');
        // Strip ESM import for JSDOM eval
        scriptContent = scriptContent.replace(/import {.*} from 'apache-arrow';/g, '');
    });

    beforeEach(() => {
        activeTimers = new Set();

        // Setup JSDOM
        dom = new JSDOM(`
            <!DOCTYPE html>
            <html>
            <body>
                <div id="grid-header"></div>
                <div id="grid-body"></div>
                <input id="filter-input" />
                <button id="apply-filter"></button>
                <button id="btn-prev"></button>
                <button id="btn-next"></button>
                <button id="btn-refresh"></button>
                
                <!-- New Selector DOM -->
                <button id="btn-variables"></button>
                <div id="var-dropdown-menu" class="var-dropdown-menu">
                    <input id="var-search-input" />
                    <button id="btn-select-all"></button>
                    <button id="btn-select-none"></button>
                    <div id="var-list"></div>
                </div>

                <span id="page-info"></span>
                <span id="status-text"></span>
                <div id="loading-overlay" class="hidden"></div>
                <div id="error-banner" class="hidden"></div>
            </body>
            </html>
        `, {
            runScripts: "dangerously",
            resources: "usable"
        });

        window = dom.window;
        document = window.document;
        window.__DATA_BROWSER_TEST__ = true;

        // Track JSDOM's timers so we can clear them
        const originalSetTimeout = window.setTimeout;
        const originalSetInterval = window.setInterval;
        const originalClearTimeout = window.clearTimeout;
        const originalClearInterval = window.clearInterval;

        window.setTimeout = function (...args) {
            const id = originalSetTimeout.apply(this, args);
            activeTimers.add({ type: 'timeout', id });
            return id;
        };

        window.setInterval = function (...args) {
            const id = originalSetInterval.apply(this, args);
            activeTimers.add({ type: 'interval', id });
            return id;
        };

        window.clearTimeout = function (id) {
            activeTimers.forEach(timer => {
                if (timer.id === id) activeTimers.delete(timer);
            });
            return originalClearTimeout.call(this, id);
        };

        window.clearInterval = function (id) {
            activeTimers.forEach(timer => {
                if (timer.id === id) activeTimers.delete(timer);
            });
            return originalClearInterval.call(this, id);
        };

        // Mock VS Code API
        vscodeMock = {
            postMessage: jest.fn()
        };
        window.acquireVsCodeApi = () => vscodeMock;

        // Mock console to keep test output clean
        window.console = {
            log: jest.fn(),
            error: jest.fn(),
            warn: jest.fn()
        };

        // Inject dependencies
        window.tableFromIPC = require('apache-arrow').tableFromIPC;

        // Execute the script
        window.eval(scriptContent);
    });

    afterEach(() => {
        // Clear all tracked timers
        activeTimers.forEach(timer => {
            if (timer.type === 'timeout') {
                window.clearTimeout(timer.id);
            } else {
                window.clearInterval(timer.id);
            }
        });
        activeTimers.clear();

        // Cleanup JSDOM
        if (dom && dom.window) {
            dom.window.close();
        }

        dom = null;
        window = null;
        document = null;
        vscodeMock = null;
    });

    function triggerMessage(message) {
        window.dispatchEvent(new window.MessageEvent('message', { data: message }));
    }

    function getApiCall(urlPart) {
        return vscodeMock.postMessage.mock.calls.find(args =>
            args[0] &&
            args[0].type === 'apiCall' &&
            args[0].url &&
            args[0].url.includes(urlPart)
        )?.[0];
    }

    // Use real promises and microtask queue instead of fake timers
    async function flushPromises() {
        // Let microtasks run
        await Promise.resolve();
        // Give JSDOM timers a chance to fire
        await new Promise(resolve => setImmediate(resolve));
    }

    it('should initialize correctly and default to first 50 variables', async () => {
        // Generate 60 vars
        const bigVars = Array.from({ length: 60 }, (_, i) => ({ name: `v${i}` }));

        // Trigger init
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });

        const dsReqId = getApiCall('/v1/dataset').reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReqId, success: true, data: { dataset: { id: '123', n: 100 } } });
        await flushPromises();

        const varsReqId = getApiCall('/v1/vars').reqId;
        triggerMessage({ type: 'apiResponse', reqId: varsReqId, success: true, data: { vars: bigVars } });
        await flushPromises();

        // Check selected variables in state
        const state = window.__dataBrowserState;
        expect(state.vars.length).toBe(60);
        expect(state.selectedVars.length).toBe(50);
        expect(state.selectedVars[0]).toBe('v0');
        expect(state.selectedVars[49]).toBe('v49');
        expect(state.selectedVars).not.toContain('v50');

        // Check DOM list
        const items = document.querySelectorAll('#var-list .dropdown-item');
        expect(items.length).toBe(60);

        // Count checked boxes
        const checked = document.querySelectorAll('#var-list input[type="checkbox"]:checked');
        expect(checked.length).toBe(50);
    });

    it('should filter variables list via search', async () => {
        const vars = [{ name: 'apple' }, { name: 'banana' }, { name: 'cherry' }];

        // Init
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });
        const dsReq = getApiCall('/v1/dataset').reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReq, success: true, data: { dataset: { id: '1', n: 10 } } });
        await flushPromises();
        const varsReq = getApiCall('/v1/vars').reqId;
        triggerMessage({ type: 'apiResponse', reqId: varsReq, success: true, data: { vars } });
        await flushPromises();

        // Search 'pp' (apple)
        const searchInput = document.getElementById('var-search-input');
        searchInput.value = 'pp';
        searchInput.dispatchEvent(new window.Event('input'));

        const items = document.querySelectorAll('#var-list .dropdown-item');
        expect(items.length).toBe(1);
        expect(items[0].textContent).toContain('apple');
    });

    it('should select all/none respecting search filter', async () => {
        const vars = [{ name: 'apple' }, { name: 'apricot' }, { name: 'banana' }];

        // Init
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });
        const dsReq = getApiCall('/v1/dataset').reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReq, success: true, data: { dataset: { id: '1', n: 10 } } });
        await flushPromises();
        const varsReq = getApiCall('/v1/vars').reqId;
        triggerMessage({ type: 'apiResponse', reqId: varsReq, success: true, data: { vars } });
        await flushPromises();

        // Clear default selection to test filter logic cleanly
        window.__dataBrowserState.selectedVars = [];

        // Filter 'ap' (apple, apricot)
        const searchInput = document.getElementById('var-search-input');
        searchInput.value = 'ap';
        searchInput.dispatchEvent(new window.Event('input'));

        // Select All (should only select visible: apple, apricot)
        document.getElementById('btn-select-all').click();

        // Check state
        expect(window.__dataBrowserState.selectedVars).toContain('apple');
        expect(window.__dataBrowserState.selectedVars).toContain('apricot');
        expect(window.__dataBrowserState.selectedVars).not.toContain('banana'); // Not visible, not selected

        // Clear filter
        searchInput.value = '';
        searchInput.dispatchEvent(new window.Event('input'));

        // Now banana is visible but not selected. 
        // Select None -> Deselects all visible
        document.getElementById('btn-select-none').click();
        expect(window.__dataBrowserState.selectedVars.length).toBe(0);
    });

    it('should toggle variables and debounce page load', async () => {
        const vars = [{ name: 'v1' }];
        // Init
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });
        const dsReq = getApiCall('/v1/dataset').reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReq, success: true, data: { dataset: { id: '1', n: 10 } } });
        await flushPromises();
        const varsReq = getApiCall('/v1/vars').reqId;
        triggerMessage({ type: 'apiResponse', reqId: varsReq, success: true, data: { vars } });
        await flushPromises();

        // initial loadPage happened
        vscodeMock.postMessage.mockClear();

        // Click item (v1 is selected by default since < 50)
        // Check initial state
        expect(window.__dataBrowserState.selectedVars).toContain('v1');

        const item = document.querySelector('#var-list .dropdown-item');
        item.click(); // Toggle -> Deselect

        expect(window.__dataBrowserState.selectedVars).not.toContain('v1');

        // Expect NO immediate API call (debounce)
        expect(getApiCall('/v1/arrow')).toBeFalsy();

        // Wait for debounce
        await new Promise(r => setTimeout(r, 600));

        expect(getApiCall('/v1/arrow')).toBeTruthy();
    });
});