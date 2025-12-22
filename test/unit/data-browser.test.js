const assert = require('chai').assert;
const sinon = require('sinon');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

describe('Data Browser Frontend (data-browser.js)', () => {
    let dom;
    let window;
    let document;
    let vscodeMock;
    let scriptContent;

    before(() => {
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
            postMessage: sinon.stub()
        };
        window.acquireVsCodeApi = () => vscodeMock;

        // Mock console to keep test output clean
        window.console = {
            log: sinon.stub(),
            error: sinon.stub(),
            warn: sinon.stub()
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
        return vscodeMock.postMessage.getCalls().find(c => 
            c.args[0] && 
            c.args[0].type === 'apiCall' && 
            c.args[0].url && 
            c.args[0].url.includes(urlPart)
        );
    }

    it('should initialize correctly with nested dataset object', async () => {
        // Trigger init
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });

        // Check if API calls were made (via postMessage proxy)
        assert.isTrue(vscodeMock.postMessage.calledWithMatch({ type: 'apiCall', url: 'http://test/v1/dataset' }));
        
        // Find the reqId for the dataset call
        const datasetCall = getApiCall('/v1/dataset');
        const datasetReqId = datasetCall.args[0].reqId;

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
        assert.ok(varsCall, 'Should have called /v1/vars');
        const varsReqId = varsCall.args[0].reqId;

        // Simulate response for vars
        triggerMessage({
            type: 'apiResponse',
            reqId: varsReqId,
            success: true,
            data: { vars: [{ name: 'make', type: 'str18' }, { name: 'price', type: 'int' }] }
        });

        await new Promise(resolve => setTimeout(resolve, 0));

        // Verify status text updated correctly (nested object parsing)
        assert.include(document.getElementById('status-text').textContent, '100 observations');
    });

    it('should handle /v1/vars response with "variables" property', async () => {
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });

        const dsReqId = getApiCall('/v1/dataset').args[0].reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReqId, success: true, data: { dataset: { id: '123', n: 100 } } });

        await new Promise(resolve => setTimeout(resolve, 0));

        const varsReqId = getApiCall('/v1/vars').args[0].reqId;
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
        assert.include(selector.innerHTML, 'mpg', 'Selector should contain variable from "variables" property');
    });

    it('should send integer limit and offset in loadPage', async () => {
        // Setup state via init
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });
        
        // Respond to dataset
        const datasetReqId = getApiCall('/v1/dataset').args[0].reqId;
        triggerMessage({
            type: 'apiResponse',
            reqId: datasetReqId,
            success: true,
            data: { dataset: { id: '123', n: 100 } }
        });

        await new Promise(resolve => setTimeout(resolve, 0));

        // Respond to vars
        const varsReqId = getApiCall('/v1/vars').args[0].reqId;
        triggerMessage({
            type: 'apiResponse',
            reqId: varsReqId,
            success: true,
            data: { vars: [{ name: 'make' }] }
        });

        await new Promise(resolve => setTimeout(resolve, 0));

        // Check page call
        const pageCall = getApiCall('/v1/page');
        assert.ok(pageCall, 'Should have called /v1/page');
        
        const body = JSON.parse(pageCall.args[0].options.body);
        assert.isNumber(body.limit, 'Limit should be a number');
        assert.isNumber(body.offset, 'Offset should be a number');
        assert.equal(body.limit, 100);
        assert.equal(body.offset, 0);
    });

    it('should render grid correctly using rows array', async () => {
        // Bypass full init sequence by mocking state if possible, or just running through it
        // Running through is safer given the closure scope.
        
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });
        
        // Dataset
        const dsReqId = getApiCall('/v1/dataset').args[0].reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReqId, success: true, data: { dataset: { id: '123', n: 10 } } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Vars
        const varsReqId = getApiCall('/v1/vars').args[0].reqId;
        triggerMessage({ type: 'apiResponse', reqId: varsReqId, success: true, data: { vars: [{ name: 'v1' }, { name: 'v2' }] } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Page
        const pageReqId = getApiCall('/v1/page').args[0].reqId;
        
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
        assert.equal(rows.length, 2, 'Should render 2 rows');
        
        const firstRowCells = rows[0].querySelectorAll('td');
        assert.equal(firstRowCells.length, 3); // Obs + v1 + v2
        assert.equal(firstRowCells[0].textContent, '1'); // _n
        assert.equal(firstRowCells[1].textContent, 'A'); // v1
        assert.equal(firstRowCells[2].textContent, '10'); // v2
    });

    it('should handle dataset ID mismatch by re-initializing', async () => {
        // 1. Initial State
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });
        const dsReqId = getApiCall('/v1/dataset').args[0].reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReqId, success: true, data: { dataset: { id: 'OLD_ID', n: 10 } } });
        await new Promise(resolve => setTimeout(resolve, 0));
        
        // Respond to vars
        const varsReqId = getApiCall('/v1/vars').args[0].reqId;
        triggerMessage({ type: 'apiResponse', reqId: varsReqId, success: true, data: { vars: [] } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // 2. Load Page returns NEW_ID
        const pageReqId = getApiCall('/v1/page').args[0].reqId;
        
        // Clear previous calls to check for re-init
        vscodeMock.postMessage.resetHistory();

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
        assert.isTrue(vscodeMock.postMessage.calledWithMatch({ type: 'apiCall', url: 'http://test/v1/dataset' }), 'Should re-fetch dataset info on ID mismatch');
    });

    it('should clamp invalid limit and offset before requesting a page', async () => {
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });

        const dsReqId = getApiCall('/v1/dataset').args[0].reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReqId, success: true, data: { dataset: { id: '123', n: 10 } } });
        await new Promise(resolve => setTimeout(resolve, 0));

        const varsReqId = getApiCall('/v1/vars').args[0].reqId;
        triggerMessage({ type: 'apiResponse', reqId: varsReqId, success: true, data: { vars: [{ name: 'v1' }] } });
        await new Promise(resolve => setTimeout(resolve, 0));

        vscodeMock.postMessage.resetHistory();

        window.__dataBrowserState.limit = 0;
        window.__dataBrowserState.offset = "bad";
        window.__loadPage();
        await new Promise(resolve => setTimeout(resolve, 0));

        const pageCall = getApiCall('/v1/page');
        assert.ok(pageCall, 'Should have called /v1/page');

        const body = JSON.parse(pageCall.args[0].options.body);
        assert.equal(body.limit, 100, 'Invalid limit should fall back to 100');
        assert.equal(body.offset, 0, 'Invalid offset should fall back to 0');
    });

    it('should use "filterExpr" property when applying filter', async () => {
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });

        // init flow
        const dsReqId = getApiCall('/v1/dataset').args[0].reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReqId, success: true, data: { dataset: { id: '123', n: 10 } } });
        await new Promise(resolve => setTimeout(resolve, 0));
        const varsReqId = getApiCall('/v1/vars').args[0].reqId;
        triggerMessage({ type: 'apiResponse', reqId: varsReqId, success: true, data: { vars: [] } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Simulate filter input
        document.getElementById('filter-input').value = 'price > 5000';
        document.getElementById('apply-filter').click();
        
        await new Promise(resolve => setTimeout(resolve, 0));

        // Check validation call
        const validateCall = getApiCall('/v1/filters/validate');
        assert.ok(validateCall, 'Should have called /v1/filters/validate');
        const valBody = JSON.parse(validateCall.args[0].options.body);
        assert.property(valBody, 'filterExpr', 'Body should contain filterExpr');
        assert.notProperty(valBody, 'filter', 'Body should NOT contain "filter" property');
        assert.equal(valBody.filterExpr, 'price > 5000');

        // Respond valid (using "ok" property as per latest finding)
        triggerMessage({ type: 'apiResponse', reqId: validateCall.args[0].reqId, success: true, data: { ok: true } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Check create view call
        const viewCall = getApiCall('/v1/views');
        assert.ok(viewCall, 'Should have called /v1/views');
        const viewBody = JSON.parse(viewCall.args[0].options.body);
        assert.property(viewBody, 'filterExpr', 'Body should contain filterExpr');
        assert.notProperty(viewBody, 'filter', 'Body should NOT contain "filter" property');
    });

    it('should load page from view endpoint after applying filter', async () => {
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });
        
        // Init calls
        const dsReqId = getApiCall('/v1/dataset').args[0].reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReqId, success: true, data: { dataset: { id: 'DS1', n: 100 } } });
        await new Promise(resolve => setTimeout(resolve, 0));
        
        const varsReqId = getApiCall('/v1/vars').args[0].reqId;
        triggerMessage({ type: 'apiResponse', reqId: varsReqId, success: true, data: { vars: [{name: 'v1'}] } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Initial loadPage call (clear it)
        vscodeMock.postMessage.resetHistory();

        // Apply Filter
        document.getElementById('filter-input').value = 'v1 > 0';
        document.getElementById('apply-filter').click();
        await new Promise(resolve => setTimeout(resolve, 0));

        // Validation response
        const validateReqId = getApiCall('/v1/filters/validate').args[0].reqId;
        triggerMessage({ type: 'apiResponse', reqId: validateReqId, success: true, data: { ok: true } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // View creation response (nested view object)
        const viewReqId = getApiCall('/v1/views').args[0].reqId;
        triggerMessage({ 
            type: 'apiResponse', 
            reqId: viewReqId, 
            success: true, 
            data: { view: { id: 'VIEW_1', filteredN: 50 } } 
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Should trigger loadPage with view endpoint
        const pageCall = getApiCall('/v1/views/VIEW_1/page');
        assert.ok(pageCall, 'Should have called /v1/views/VIEW_1/page');
        
        const body = JSON.parse(pageCall.args[0].options.body);
        assert.equal(body.datasetId, 'DS1');
        assert.equal(body.limit, 100);
    });

    it('should render grid correctly when response uses "variables" instead of "vars"', async () => {
        // Init
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });
        const dsReqId = getApiCall('/v1/dataset').args[0].reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReqId, success: true, data: { dataset: { id: '123', n: 10 } } });
        await new Promise(resolve => setTimeout(resolve, 0));
        const varsReqId = getApiCall('/v1/vars').args[0].reqId;
        triggerMessage({ type: 'apiResponse', reqId: varsReqId, success: true, data: { vars: [{ name: 'v1' }] } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Page response with "variables"
        const pageReqId = getApiCall('/v1/page').args[0].reqId;
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
        assert.equal(rows.length, 1, 'Should render 1 row');
        const cells = rows[0].querySelectorAll('td');
        assert.equal(cells[1].textContent, 'ValueA', 'Should find value using "variables" mapping');
    });

    it('should handle sorting interactions', async () => {
        // Init
        triggerMessage({ type: 'init', baseUrl: 'http://test', token: 'xyz' });
        const dsReqId = getApiCall('/v1/dataset').args[0].reqId;
        triggerMessage({ type: 'apiResponse', reqId: dsReqId, success: true, data: { dataset: { id: '123', n: 10 } } });
        await new Promise(resolve => setTimeout(resolve, 0));
        const varsReqId = getApiCall('/v1/vars').args[0].reqId;
        triggerMessage({ type: 'apiResponse', reqId: varsReqId, success: true, data: { vars: [{ name: 'price' }, { name: 'mpg' }] } });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Respond to initial page load to render grid
        const initPageReqId = getApiCall('/v1/page').args[0].reqId;
        triggerMessage({ 
            type: 'apiResponse', 
            reqId: initPageReqId, 
            success: true, 
            data: { rows: [] } 
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        // Wait for initial load
        vscodeMock.postMessage.resetHistory();

        // Click 'price' header (Asc)
        const priceHeader = Array.from(document.querySelectorAll('th')).find(th => th.textContent.includes('price'));
        priceHeader.click();
        await new Promise(resolve => setTimeout(resolve, 0));

        const pageCall1 = getApiCall('/v1/page');
        assert.ok(pageCall1, 'Should call /v1/page on sort');
        assert.deepEqual(JSON.parse(pageCall1.args[0].options.body).sortBy, ['price']);

        vscodeMock.postMessage.resetHistory();

        // Click 'price' header again (Desc)
        priceHeader.click();
        await new Promise(resolve => setTimeout(resolve, 0));

        const pageCall2 = getApiCall('/v1/page');
        assert.deepEqual(JSON.parse(pageCall2.args[0].options.body).sortBy, ['-price']);

        vscodeMock.postMessage.resetHistory();

        // Click 'price' header again (Clear)
        priceHeader.click();
        await new Promise(resolve => setTimeout(resolve, 0));

        const pageCall3 = getApiCall('/v1/page');
        assert.deepEqual(JSON.parse(pageCall3.args[0].options.body).sortBy, []);
    });
});
