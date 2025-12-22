const vscode = acquireVsCodeApi();

function log(message, isError = false) {
    vscode.postMessage({
        type: isError ? 'error' : 'log',
        message: message
    });
}

let state = {
    baseUrl: '',
    token: '',
    datasetId: '',
    viewId: null,
    vars: [], // [{name, type, label, format}]
    selectedVars: [],
    offset: 0,
    limit: 100,
    totalObs: 0,
    filter: '',
    isLoading: false
};

const dom = {
    grid: document.getElementById('grid-body'),
    header: document.getElementById('grid-header'),
    filterInput: document.getElementById('filter-input'),
    applyFilterBtn: document.getElementById('apply-filter'),
    prevBtn: document.getElementById('btn-prev'),
    nextBtn: document.getElementById('btn-next'),
    refreshBtn: document.getElementById('btn-refresh'),
    varSelector: document.getElementById('variable-selector'),
    pageInfo: document.getElementById('page-info'),
    statusText: document.getElementById('status-text'),
    loading: document.getElementById('loading-overlay'),
    error: document.getElementById('error-banner')
};

// --- Initialization ---

window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
        case 'init':
            log(`Received init message. BaseURL: ${message.baseUrl}`);
            state.baseUrl = message.baseUrl;
            state.token = message.token;
            initBrowser();
            break;
        case 'apiResponse':
            handleApiResponse(message);
            break;
    }
});

const pendingRequests = new Map();

function handleApiResponse(msg) {
    const { reqId, success, data, error } = msg;
    if (pendingRequests.has(reqId)) {
        const { resolve, reject } = pendingRequests.get(reqId);
        pendingRequests.delete(reqId);
        if (success) {
            resolve(data);
        } else {
            // Check for Dataset ID conflict (often 409 or specific error message)
            if (error && (error.includes('409') || error.includes('datasetId') || error.includes('identity'))) {
                log('Dataset changed detected via API error. Re-initializing...', true);
                initBrowser();
            }
            reject(new Error(error));
        }
    }
}

function setLoading(loading) {
    state.isLoading = loading;
    if (loading) {
        dom.loading.classList.remove('hidden');
    } else {
        dom.loading.classList.add('hidden');
    }
}

function setError(msg) {
    if (msg) {
        log(`Error displayed to user: ${msg}`, true);
        dom.error.textContent = msg;
        dom.error.classList.remove('hidden');
        // Auto-hide after 5s unless we're in tests.
        if (!window.__DATA_BROWSER_TEST__) {
            setTimeout(() => dom.error.classList.add('hidden'), 5000);
        }
    } else {
        dom.error.classList.add('hidden');
    }
}

// --- API Calls ---

class ApiError extends Error {
    constructor(message, status, code, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

async function apiCall(endpoint, method = 'GET', body = null) {
    const url = `${state.baseUrl}${endpoint}`;
    log(`API Call (Proxy): ${method} ${url}`);
    
    const reqId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    return new Promise((resolve, reject) => {
        pendingRequests.set(reqId, { resolve, reject });
        
        vscode.postMessage({
            type: 'apiCall',
            reqId,
            url,
            options: {
                method,
                headers: {
                    'Authorization': `Bearer ${state.token}`,
                    'Content-Type': body ? 'application/json' : undefined
                },
                body: body ? JSON.stringify(body) : undefined
            }
        });

        setTimeout(() => {
            if (pendingRequests.has(reqId)) {
                pendingRequests.delete(reqId);
                reject(new Error('Request timed out'));
            }
        }, 30000);
    }).catch(err => {
        // Parse error message if it looks like JSON from our proxy
        // format: "API Request Failed (400): {...}"
        const match = err.message.match(/API Request Failed \((\d+)\): (.+)/);
        if (match) {
            const status = parseInt(match[1], 10);
            try {
                const json = JSON.parse(match[2]);
                const code = json.error?.code;
                const msg = json.error?.message || err.message;
                throw new ApiError(msg, status, code, json);
            } catch (e) {
                // Not JSON
            }
        }
        log(`API Proxy Failed: ${err.message}`, true);
        throw err;
    });
}

async function initBrowser() {
    log('Initializing Browser...');
    setLoading(true);
    try {
        // Clear state
        state.viewId = null;
        state.offset = 0;

        // 1. Get Dataset Info
        let dsResp;
        try {
            dsResp = await apiCall('/v1/dataset');
        } catch (err) {
            if (err instanceof ApiError && err.code === 'no_data_in_memory') {
                log('No data in memory - showing empty state');
                state.datasetId = 'empty';
                state.totalObs = 0;
                dom.statusText.textContent = 'No data in memory';
                dom.grid.innerHTML = '<tr><td colspan="100%" style="text-align:center; padding: 20px; color: var(--text-tertiary);">No dataset loaded in Stata</td></tr>';
                updatePagination({ rows: [] });
                if (dom.varSelector) dom.varSelector.innerHTML = '<option value="">No Variables</option>';
                return;
            }
            throw err;
        }

        if (!dsResp) {
            log('Failed to get dataset info', true);
            return;
        }
        log(`Dataset Info: ${JSON.stringify(dsResp)}`);
        
        const dsInfo = dsResp.dataset || dsResp;
        state.datasetId = dsInfo.id;
        state.totalObs = dsInfo.n;
        dom.statusText.textContent = `${(dsInfo.n || 0).toLocaleString()} observations, ${dsInfo.k} variables (Frame: ${dsInfo.frame})`;

        // 2. Get Vars
        const varData = await apiCall('/v1/vars');
        
        let vars = null;
        if (Array.isArray(varData)) {
            vars = varData;
        } else if (varData) {
            vars = varData.vars || varData.variables;
        }

        if (vars) {
            log(`Loaded ${vars.length} variables`);
            state.vars = vars;
            if (!state.selectedVars.length) {
                state.selectedVars = state.vars.slice(0, 50).map(v => v.name);
            } else {
                state.selectedVars = state.selectedVars.filter(name => state.vars.some(v => v.name === name));
            }
            updateVarSelector();
        } else {
            log('No variables found in response', true);
        }

        // 3. Initial Load
        await loadPage();

    } catch (err) {
        setError(`Initialization failed: ${err.message}`);
    } finally {
        setLoading(false);
    }
}

function updateVarSelector() {
    if (!dom.varSelector) return;
    dom.varSelector.innerHTML = '<option value="">Select Variables...</option>';
    state.vars.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.name;
        opt.textContent = (state.selectedVars.includes(v.name) ? '✓ ' : '') + v.name;
        dom.varSelector.appendChild(opt);
    });
}

async function loadPage() {
    if (state.totalObs === 0) return; // Skip if empty

    log(`Loading page. Offset: ${state.offset}, Limit: ${state.limit}, View: ${state.viewId}`);
    setLoading(true);
    try {
        let endpoint = '/v1/page';
        const parsedOffset = parseInt(state.offset, 10);
        const parsedLimit = parseInt(state.limit, 10);
        const safeOffset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
        const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100;
        state.offset = safeOffset;
        state.limit = safeLimit;
        
        let body = {
            datasetId: state.datasetId,
            offset: safeOffset,
            limit: safeLimit,
            vars: state.selectedVars,
            includeObsNo: true
        };

        if (state.viewId) {
            endpoint = `/v1/views/${state.viewId}/page`;
        }

        const data = await apiCall(endpoint, 'POST', body);
        if (data) {
            log(`Page loaded. Records: ${data.rows?.length || data.data?.length}`);
            renderGrid(data);
            updatePagination(data);
            
            if (data.datasetId && data.datasetId !== state.datasetId) {
                log('Response datasetId mismatch. Re-initializing.', true);
                initBrowser();
            }
        }
    } catch (err) {
        if (err instanceof ApiError && err.code === 'no_data_in_memory') {
             // Handle race condition where data was cleared after init
             initBrowser();
             return;
        }
        setError(`Failed to load page: ${err.message}`);
    } finally {
        setLoading(false);
    }
}

async function applyFilter() {
    const filterExpr = dom.filterInput.value.trim();
    log(`Applying filter: "${filterExpr}"`);
    
    if (!filterExpr) {
        if (state.viewId) {
            await apiCall(`/v1/views/${state.viewId}`, 'DELETE').catch(() => {});
            state.viewId = null;
        }
        state.offset = 0;
        await loadPage();
        return;
    }

    setLoading(true);
    try {
        // 1. Validate filter
        const valid = await apiCall('/v1/filters/validate', 'POST', {
            datasetId: state.datasetId,
            filter: filterExpr
        });

        if (!valid || !valid.isValid) {
            throw new Error(valid?.error || 'Invalid filter expression');
        }

        // 2. Create View
        const viewRes = await apiCall('/v1/views', 'POST', {
            datasetId: state.datasetId,
            filter: filterExpr
        });

        if (viewRes && viewRes.viewId) {
            log(`View created: ${viewRes.viewId}`);
            state.viewId = viewRes.viewId;
            state.offset = 0;
            if (viewRes.n !== undefined) {
                dom.statusText.textContent = `Filtered: ${viewRes.n.toLocaleString()} observations`;
            }
            await loadPage();
        }
    } catch (err) {
        setError(`Filter failed: ${err.message}`);
    } finally {
        setLoading(false);
    }
}

// --- Rendering ---

function renderGrid(pageData) {
    // Header
    dom.header.innerHTML = '';
    const obsTh = document.createElement('th');
    obsTh.textContent = '#';
    obsTh.style.width = '60px';
    dom.header.appendChild(obsTh);

    const displayVars = state.vars.filter(v => state.selectedVars.includes(v.name));

    displayVars.forEach(v => {
        const th = document.createElement('th');
        th.innerHTML = `
            <div style="display:flex; align-items:center;">
                <span class="type-indicator type-${getTypeClass(v.type)}"></span>
                <span title="${v.label || v.name}">${v.name}</span>
            </div>
        `;
        dom.header.appendChild(th);
    });

    // Body
    dom.grid.innerHTML = '';
    
    // API returns "rows" as array of arrays.
    // The first element is usually observation number if includeObsNo=true
    const rows = pageData.rows || pageData.data || [];
    
    rows.forEach(row => {
        const tr = document.createElement('tr');
        
        // Obs No is usually the first element in the row array if requested
        // but we need to map columns correctly.
        // The API returns 'vars': ["_n", "make", "price"] so we can map indices.
        
        const returnedVars = pageData.vars || [];
        const obsIndex = returnedVars.indexOf('_n'); // Stata obs number
        
        const tdObs = document.createElement('td');
        tdObs.textContent = (obsIndex !== -1 ? row[obsIndex] : '') || '';
        tdObs.style.color = 'var(--text-tertiary)';
        tr.appendChild(tdObs);

        displayVars.forEach(v => {
            const td = document.createElement('td');
            // Find index of this var in the returned row
            const idx = returnedVars.indexOf(v.name);
            const val = (idx !== -1) ? row[idx] : null;
            
            td.textContent = formatValue(val, v);
            tr.appendChild(td);
        });
        dom.grid.appendChild(tr);
    });
}

function getTypeClass(type) {
    if (!type) return 'str';
    if (type.startsWith('str')) return 'str';
    if (['byte', 'int', 'long'].includes(type)) return 'int';
    return 'float'; // float, double
}

function formatValue(val, meta) {
    if (val === null || val === undefined) return '.';
    return String(val);
}

function updatePagination(data) {
    dom.prevBtn.disabled = state.offset <= 0;
    
    const rows = data.rows || data.data || [];
    const returnedCount = rows.length;
    const isEnd = returnedCount < state.limit;
    dom.nextBtn.disabled = isEnd;

    const start = state.offset + 1;
    const end = state.offset + returnedCount;
    dom.pageInfo.textContent = returnedCount > 0 ? `${start} - ${end}` : '0 - 0';
}

// --- Event Listeners ---

dom.prevBtn.addEventListener('click', () => {
    if (state.offset > 0) {
        state.offset = Math.max(0, state.offset - state.limit);
        loadPage();
    }
});

dom.nextBtn.addEventListener('click', () => {
    state.offset += state.limit;
    loadPage();
});

if (dom.refreshBtn) {
    dom.refreshBtn.addEventListener('click', () => {
        initBrowser();
    });
}

if (dom.varSelector) {
    dom.varSelector.addEventListener('change', (e) => {
        const name = e.target.value;
        if (!name) return;
        
        if (state.selectedVars.includes(name)) {
            state.selectedVars = state.selectedVars.filter(v => v !== name);
        } else {
            state.selectedVars.push(name);
        }
        
        updateVarSelector();
        e.target.value = ''; // Reset select
        state.offset = 0;
        loadPage();
    });
}

dom.filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        applyFilter();
    }
});

dom.applyFilterBtn.addEventListener('click', applyFilter);

if (typeof window !== 'undefined' && window.__DATA_BROWSER_TEST__) {
    window.__dataBrowserState = state;
    window.__loadPage = loadPage;
}
