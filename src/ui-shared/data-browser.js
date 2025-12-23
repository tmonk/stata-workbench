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
    sortBy: [], // ["price", "-mpg"]
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
    frameName: document.getElementById('frame-name'),
    obsCount: document.getElementById('obs-count'),
    varCount: document.getElementById('var-count'),
    loading: document.getElementById('loading-overlay'),
    error: document.getElementById('error-banner')
};

// --- Initialization ---
window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.type) {
        case 'init':
            console.log('[DataBrowser Webview] Received init message. BaseURL:', message.baseUrl);
            if (message.baseUrl && message.token) {
                initBrowser(message.baseUrl, message.token);
            } else {
                console.error('[DataBrowser Webview] Init message missing credentials');
                showError('Initialization failed: Missing credentials');
            }
            break;

        case 'refresh':
            console.log('[DataBrowser Webview] Received refresh message.');
            if (isInitialized && state.baseUrl && state.token) {
                initBrowser(state.baseUrl, state.token);
            } else {
                console.log('[DataBrowser] Refresh pending - waiting for init');
                pendingRefresh = true;
            }
            break;

        case 'apiResponse':
            handleApiResponse(message);
            break;

        default:
            console.warn('[DataBrowser Webview] Unknown message type:', message.type);
    }
});


function handleApiResponse(msg) {
    const { reqId, success, data, error } = msg;
    
    if (pendingRequests.has(reqId)) {
        const { resolve, reject } = pendingRequests.get(reqId);
        pendingRequests.delete(reqId);
        
        if (success) {
            resolve(data);
        } else {
            // Check for Dataset ID conflict
            if (error && (error.includes('409') || error.includes('datasetId') || error.includes('identity'))) {
                console.warn('[DataBrowser] Dataset changed detected. Re-initializing...');
                
                // Re-initialize with existing credentials
                if (state.baseUrl && state.token) {
                    initBrowser(state.baseUrl, state.token);  // ✅ Pass credentials
                }
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

function showError(msg) {
    setError(msg);
}

function hideError() {
    setError(null);
}

function showLoading() {
    setLoading(true);
}

function hideLoading() {
    setLoading(false);
}


function updateDataSummary(nObs, nVars) {
    if (dom.obsCount) dom.obsCount.textContent = nObs.toLocaleString();
    if (dom.varCount) dom.varCount.textContent = nVars.toLocaleString();
}

function populateVariableSelector(variables) {
    state.vars = variables;
    state.selectedVars = variables.map(v => v.name);
    updateVarSelector();
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


let isInitialized = false;
let pendingRefresh = false;
const pendingRequests = new Map();
function initBrowser(baseUrl, token) {
    if (!baseUrl || !token) {
        console.warn('[DataBrowser] Cannot initialize without baseUrl and token');
        pendingRefresh = true;
        return;
    }

    console.log('[DataBrowser Webview] Initializing Browser...');
    
    state.baseUrl = baseUrl;
    state.token = token;
    isInitialized = true;
    pendingRefresh = false;

    hideError();
    showLoading();

    apiCall('/v1/dataset', 'GET') 
        .then(response => {
            const datasetInfo = response.dataset || response;
            state.datasetId = datasetInfo.id;
            state.totalObs = datasetInfo.n || 0;
            
            log(`Dataset Info: ${JSON.stringify(response)}`);
            updateDataSummary(state.totalObs, 0);
            
            return apiCall('/v1/vars', 'GET');
        })
        .then(response => {
            const variables = response.vars || response.variables || [];
            log(`Loaded ${variables.length} variables`);
            
            populateVariableSelector(variables);
            updateDataSummary(state.totalObs, variables.length);
            
            return loadPage();
        })
        .then(() => {
            hideLoading();
            console.log('[DataBrowser Webview] Initialization complete');
            
            if (pendingRefresh) {
                console.log('[DataBrowser Webview] Pending refresh completed');
                pendingRefresh = false;
            }
        })
        .catch(err => {
            console.error('[DataBrowser Webview Error]', err);
            showError(`Initialization failed: ${err.message}`);
            hideLoading();
        });
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
            sortBy: state.sortBy,
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
                if (state.baseUrl && state.token) {
                    initBrowser(state.baseUrl, state.token);
                }
            }
        }
    } catch (err) {
        if (err instanceof ApiError && err.code === 'no_data_in_memory') {
             // Handle race condition where data was cleared after init
             if (state.baseUrl && state.token) {
                console.log('Re-initializing after no_data_in_memory error');
                initBrowser(state.baseUrl, state.token);
            }
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
            filterExpr: filterExpr
        });
        
        // Accept ok, valid, or isValid property
        const isOk = valid && (valid.ok === true || valid.isValid === true || valid.valid === true);

        if (!isOk) {
            throw new Error(valid?.error || `Invalid filter expression (Response: ${JSON.stringify(valid)})`);
        }

        // 2. Create View
        const viewRes = await apiCall('/v1/views', 'POST', {
            datasetId: state.datasetId,
            filterExpr: filterExpr
        });

        // Handle nested view object (e.g. { view: { id: "...", filteredN: ... } })
        const viewData = viewRes.view || viewRes;

        if (viewData && viewData.id) {
            log(`View created: ${viewData.id}`);
            state.viewId = viewData.id;
            state.offset = 0;
            if (viewData.filteredN !== undefined) {
                if (dom.obsCount) dom.obsCount.textContent = viewData.filteredN.toLocaleString();
            } else if (viewData.n !== undefined) {
                if (dom.obsCount) dom.obsCount.textContent = viewData.n.toLocaleString();
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

function handleSort(varName, isMulti = false) {
    const currentSort = state.sortBy || [];
    let newSort = [];

    // Check if var is already sorted
    const existingIdx = currentSort.findIndex(s => s === varName || s === `-${varName}` || s === `+${varName}`);
    
    if (existingIdx === -1) {
        // Not sorted -> Sort Ascending
        if (isMulti) {
            newSort = [...currentSort, varName];
        } else {
            newSort = [varName];
        }
    } else {
        const existing = currentSort[existingIdx];
        const isDesc = existing.startsWith('-');
        
        if (!isDesc) {
            // Asc -> Desc
            if (isMulti) {
                newSort = [...currentSort];
                newSort[existingIdx] = `-${varName}`;
            } else {
                newSort = [`-${varName}`];
            }
        } else {
            // Desc -> Remove (or default)
            if (isMulti) {
                newSort = currentSort.filter((_, i) => i !== existingIdx);
            } else {
                newSort = [];
            }
        }
    }
    
    state.sortBy = newSort;
    state.offset = 0; // Reset pagination
    loadPage();
}

function renderGrid(pageData) {
    const varCount = pageData.vars?.length || pageData.variables?.length || 0;
    log(`Render Grid. Vars: ${varCount}, Rows: ${pageData.rows?.length || pageData.data?.length}`);
    // Header
    dom.header.innerHTML = '';
    const obsTh = document.createElement('th');
    obsTh.textContent = '#';
    obsTh.style.width = '60px';
    dom.header.appendChild(obsTh);

    const displayVars = state.vars.filter(v => state.selectedVars.includes(v.name));

    displayVars.forEach(v => {
        const th = document.createElement('th');
        th.classList.add('sortable');
        th.onclick = (e) => handleSort(v.name, e.shiftKey || e.metaKey || e.ctrlKey);
        
        let sortIcon = '';
        const sortState = (state.sortBy || []).find(s => s === v.name || s === `-${v.name}` || s === `+${v.name}`);
        if (sortState) {
            const isDesc = sortState.startsWith('-');
            sortIcon = `<span class="sort-icon">${isDesc ? '↓' : '↑'}</span>`;
            th.classList.add('sorted');
        }

        th.innerHTML = `
            <div style="display:flex; align-items:center; justify-content: space-between;">
                <div style="display:flex; align-items:center;">
                    <span class="type-indicator type-${getTypeClass(v.type)}"></span>
                    <span title="${v.label || v.name}">${v.name}</span>
                </div>
                ${sortIcon}
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
        
        const returnedVars = pageData.vars || pageData.variables || [];
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
    dom.pageInfo.textContent = returnedCount > 0 ? `rows ${start} - ${end}` : '0 - 0';
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
        if (state.baseUrl && state.token) {
            initBrowser(state.baseUrl, state.token);
        } else {
            console.warn('[DataBrowser] Cannot refresh - missing credentials');
        }
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
