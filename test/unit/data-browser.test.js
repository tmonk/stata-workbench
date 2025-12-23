const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

describe('Data Browser Frontend (data-browser.js)', () => {
    let dom;
    let window;
    let document;
    let vscodeMock;
    let scriptContent;

    beforeAll(() => {
        scriptContent = fs.readFileSync(path.join(__dirname, '../../src/ui-shared/data-browser.js'), 'utf8');
    });

    beforeEach(() => {
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
                <select id="variable-selector"></select>
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
        window.__DATA_BROWSER_TEST__ = true; // Enable testing hooks

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

        // Execute the script
        window.eval(scriptContent);
    });

    afterEach(() => {
        // Cleanup if needed
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

    it('should initialize correctly with nested dataset object', async () => {
        // Trigger init
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });

        // Check if API calls were made (via postMessage proxy)
        expect(vscodeMock.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'apiCall', url: 'http://test/v1/dataset' })
        );

        // Find the reqId for the dataset call
        const datasetCall = getApiCall('/v1/dataset');
        const datasetReqId = datasetCall.reqId;

        // Simulate response for dataset
        triggerMessage({
            type: 'apiResponse',
            reqId: datasetReqId,
            success: true,
            data: { dataset: { id: '123', n: 100, k: 5, frame: 'default' } }
        });

        // Wait for next tick/promise resolution
        await new Promise(resolve => setTimeout(resolve, 0));

        // Check vars call
        const varsCall = getApiCall('/v1/vars');
        expect(varsCall).toBeTruthy();
        const varsReqId = varsCall.reqId;

        // Simulate response for vars
        triggerMessage({
            type: 'apiResponse',
            reqId: varsReqId,
            success: true,
            data: { vars: [{ name: 'make', type: 'str18' }, { name: 'price', type: 'int' }] }
        });

        await new Promise(resolve => setTimeout(resolve, 0));

        // Verify status text updated correctly (nested object parsing)
        expect(document.getElementById('status-text').textContent).toContain('100 observations');
    });

    it('should handle /v1/vars response with "variables" property', async () => {
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });

        const dsReqId = getApiCall('/v1/dataset').reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReqId, success: true, data: { dataset: { id: '123', n: 100 } } });

        await new Promise(resolve => setTimeout(resolve, 0));

        const varsReqId = getApiCall('/v1/vars').reqId;
        // Respond with { variables: [...] } instead of { vars: [...] }
        triggerMessage({
            type: 'apiResponse',
            reqId: varsReqId,
            success: true,
            data: { variables: [{ name: 'mpg' }] }
        });

        await new Promise(resolve => setTimeout(resolve, 0));

        // Verify selector was populated (check dom)
        const selector = document.getElementById('variable-selector');
        expect(selector.innerHTML).toContain('mpg');
    });

    it('should send integer limit and offset in loadPage', async () => {
        // Setup state via init
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });

        // Respond to dataset
        const datasetReqId = getApiCall('/v1/dataset').reqId;
        triggerMessage({
            type: 'apiResponse',
            reqId: datasetReqId,
            success: true,
            data: { dataset: { id: '123', n: 100 } }
        });

        await new Promise(resolve => setTimeout(resolve, 0));

        // Respond to vars
        const varsReqId = getApiCall('/v1/vars').reqId;
        triggerMessage({
            type: 'apiResponse',
            reqId: varsReqId,
            success: true,
            data: { vars: [{ name: 'make' }] }
        });

        await new Promise(resolve => setTimeout(resolve, 0));

        // Check page call
        const pageCall = getApiCall('/v1/page');
        expect(pageCall).toBeTruthy();

        const body = JSON.parse(pageCall.options.body);
        expect(typeof body.limit).toBe('number');
        expect(typeof body.offset).toBe('number');
        expect(body.limit).toEqual(100);
        expect(body.offset).toEqual(0);
    });

    it('should render grid correctly using rows array', async () => {
        // Bypass full init sequence by mocking state if possible, or just running through it
        // Running through is safer given the closure scope.

        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });

        // Dataset
        const dsReqId = getApiCall('/v1/dataset').reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReqId, success: true, data: { dataset: { id: '123', n: 10 } } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Vars
        const varsReqId = getApiCall('/v1/vars').reqId;
        triggerMessage({ type: 'apiResponse', reqId: varsReqId, success: true, data: { vars: [{ name: 'v1' }, { name: 'v2' }] } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Page
        const pageReqId = getApiCall('/v1/page').reqId;

        // Send response with ROWS array
        triggerMessage({
            type: 'apiResponse',
            reqId: pageReqId,
            success: true,
            data: {
                datasetId: '123',
                vars: ['_n', 'v1', 'v2'], // API returns var mapping
                rows: [
                    [1, 'A', 10],
                    [2, 'B', 20]
                ]
            }
        });

        await new Promise(resolve => setTimeout(resolve, 0));

        // Verify Grid Render
        const rows = document.querySelectorAll('#grid-body tr');
        expect(rows.length).toEqual(2);

        const firstRowCells = rows[0].querySelectorAll('td');
        expect(firstRowCells.length).toEqual(3); // Obs + v1 + v2
        expect(firstRowCells[0].textContent).toEqual('1'); // _n
        expect(firstRowCells[1].textContent).toEqual('A'); // v1
        expect(firstRowCells[2].textContent).toEqual('10'); // v2
    });

    it('should handle dataset ID mismatch by re-initializing', async () => {
        // 1. Initial State
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });
        const dsReqId = getApiCall('/v1/dataset').reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReqId, success: true, data: { dataset: { id: 'OLD_ID', n: 10 } } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Respond to vars
        const varsReqId = getApiCall('/v1/vars').reqId;
        triggerMessage({ type: 'apiResponse', reqId: varsReqId, success: true, data: { vars: [] } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // 2. Load Page returns NEW_ID
        const pageReqId = getApiCall('/v1/page').reqId;

        // Clear previous calls to check for re-init
        vscodeMock.postMessage.mockReset();

        triggerMessage({
            type: 'apiResponse',
            reqId: pageReqId,
            success: true,
            data: {
                datasetId: 'NEW_ID', // Mismatch!
                rows: []
            }
        });

        await new Promise(resolve => setTimeout(resolve, 0));

        // Should trigger initBrowser -> /v1/dataset call
        expect(vscodeMock.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'apiCall', url: 'http://test/v1/dataset' })
        );
    });

    it(
        'should clamp invalid limit and offset before requesting a page',
        async () => {
            triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });

            const dsReqId = getApiCall('/v1/dataset').reqId;
            triggerMessage({ type: 'apiResponse', reqId: dsReqId, success: true, data: { dataset: { id: '123', n: 10 } } });
            await new Promise(resolve => setTimeout(resolve, 0));

            const varsReqId = getApiCall('/v1/vars').reqId;
            triggerMessage({ type: 'apiResponse', reqId: varsReqId, success: true, data: { vars: [{ name: 'v1' }] } });
            await new Promise(resolve => setTimeout(resolve, 0));

            vscodeMock.postMessage.mockReset();

            window.__dataBrowserState.limit = 0;
            window.__dataBrowserState.offset = "bad";
            window.__loadPage();
            await new Promise(resolve => setTimeout(resolve, 0));

            const pageCall = getApiCall('/v1/page');
            expect(pageCall).toBeTruthy();

            const body = JSON.parse(pageCall.options.body);
            expect(body.limit).toEqual(100);
            expect(body.offset).toEqual(0);
        }
    );

    it('should use "filterExpr" property when applying filter', async () => {
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });

        // init flow
        const dsReqId = getApiCall('/v1/dataset').reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReqId, success: true, data: { dataset: { id: '123', n: 10 } } });
        await new Promise(resolve => setTimeout(resolve, 0));
        const varsReqId = getApiCall('/v1/vars').reqId;
        triggerMessage({ type: 'apiResponse', reqId: varsReqId, success: true, data: { vars: [] } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Simulate filter input
        document.getElementById('filter-input').value = 'price > 5000';
        document.getElementById('apply-filter').click();

        await new Promise(resolve => setTimeout(resolve, 0));

        // Check validation call
        const validateCall = getApiCall('/v1/filters/validate');
        expect(validateCall).toBeTruthy();
        const valBody = JSON.parse(validateCall.options.body);
        expect('filterExpr' in valBody).toBeTruthy();
        expect('filter' in valBody).toBeFalsy();
        expect(valBody.filterExpr).toEqual('price > 5000');

        // Respond valid (using "ok" property as per latest finding)
        triggerMessage({ type: 'apiResponse', reqId: validateCall.reqId, success: true, data: { ok: true } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Check create view call
        const viewCall = getApiCall('/v1/views');
        expect(viewCall).toBeTruthy();
        const viewBody = JSON.parse(viewCall.options.body);
        expect('filterExpr' in viewBody).toBeTruthy();
        expect('filter' in viewBody).toBeFalsy();
    });

    it('should load page from view endpoint after applying filter', async () => {
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });

        // Init calls
        const dsReqId = getApiCall('/v1/dataset').reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReqId, success: true, data: { dataset: { id: 'DS1', n: 100 } } });
        await new Promise(resolve => setTimeout(resolve, 0));

        const varsReqId = getApiCall('/v1/vars').reqId;
        triggerMessage({ type: 'apiResponse', reqId: varsReqId, success: true, data: { vars: [{ name: 'v1' }] } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Initial loadPage call (clear it)
        vscodeMock.postMessage.mockReset();

        // Apply Filter
        document.getElementById('filter-input').value = 'v1 > 0';
        document.getElementById('apply-filter').click();
        await new Promise(resolve => setTimeout(resolve, 0));

        // Validation response
        const validateReqId = getApiCall('/v1/filters/validate').reqId;
        triggerMessage({ type: 'apiResponse', reqId: validateReqId, success: true, data: { ok: true } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // View creation response (nested view object)
        const viewReqId = getApiCall('/v1/views').reqId;
        triggerMessage({
            type: 'apiResponse',
            reqId: viewReqId,
            success: true,
            data: { view: { id: 'VIEW_1', filteredN: 50 } }
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Should trigger loadPage with view endpoint
        const pageCall = getApiCall('/v1/views/VIEW_1/page');
        expect(pageCall).toBeTruthy();

        const body = JSON.parse(pageCall.options.body);
        expect(body.datasetId).toEqual('DS1');
        expect(body.limit).toEqual(100);
    });

    it(
        'should render grid correctly when response uses "variables" instead of "vars"',
        async () => {
            // Init
            triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });
            const dsReqId = getApiCall('/v1/dataset').reqId;
            triggerMessage({ type: 'apiResponse', reqId: dsReqId, success: true, data: { dataset: { id: '123', n: 10 } } });
            await new Promise(resolve => setTimeout(resolve, 0));
            const varsReqId = getApiCall('/v1/vars').reqId;
            triggerMessage({ type: 'apiResponse', reqId: varsReqId, success: true, data: { vars: [{ name: 'v1' }] } });
            await new Promise(resolve => setTimeout(resolve, 0));

            // Page response with "variables"
            const pageReqId = getApiCall('/v1/page').reqId;
            triggerMessage({
                type: 'apiResponse',
                reqId: pageReqId,
                success: true,
                data: {
                    datasetId: '123',
                    variables: ['_n', 'v1'], // Using variables here
                    rows: [[1, 'ValueA']]
                }
            });
            await new Promise(resolve => setTimeout(resolve, 0));

            // Verify grid content
            const rows = document.querySelectorAll('#grid-body tr');
            expect(rows.length).toEqual(1);
            const cells = rows[0].querySelectorAll('td');
            expect(cells[1].textContent).toEqual('ValueA');
        }
    );

    it('should handle sorting interactions', async () => {
        // Init
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });
        const dsReqId = getApiCall('/v1/dataset').reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReqId, success: true, data: { dataset: { id: '123', n: 10 } } });
        await new Promise(resolve => setTimeout(resolve, 0));
        const varsReqId = getApiCall('/v1/vars').reqId;
        triggerMessage({ type: 'apiResponse', reqId: varsReqId, success: true, data: { vars: [{ name: 'price' }, { name: 'mpg' }] } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Respond to initial page load to render grid
        const initPageReqId = getApiCall('/v1/page').reqId;
        triggerMessage({
            type: 'apiResponse',
            reqId: initPageReqId,
            success: true,
            data: { rows: [] }
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Wait for initial load
        vscodeMock.postMessage.mockReset();

        // Click 'price' header (Asc)
        const priceHeader = Array.from(document.querySelectorAll('th')).find(th => th.textContent.includes('price'));
        priceHeader.click();
        await new Promise(resolve => setTimeout(resolve, 0));

        const pageCall1 = getApiCall('/v1/page');
        expect(pageCall1).toBeTruthy();
        expect(JSON.parse(pageCall1.options.body).sortBy).toEqual(['price']);

        vscodeMock.postMessage.mockReset();

        // Click 'price' header again (Desc)
        priceHeader.click();
        await new Promise(resolve => setTimeout(resolve, 0));

        const pageCall2 = getApiCall('/v1/page');
        expect(JSON.parse(pageCall2.options.body).sortBy).toEqual(['-price']);

        vscodeMock.postMessage.mockReset();

        // Click 'price' header again (Clear)
        priceHeader.click();
        await new Promise(resolve => setTimeout(resolve, 0));

        const pageCall3 = getApiCall('/v1/page');
        expect(JSON.parse(pageCall3.options.body).sortBy).toEqual([]);
    });
});
