// --- Global Redirection for Logging (Must be first) ---
const vscode = acquireVsCodeApi();
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

function safeStringify(obj) {
    try {
        return JSON.stringify(obj, (key, value) => {
            if (value instanceof Node) return `[DOM Node: ${value.nodeName}]`;
            if (value instanceof Window) return '[Window]';
            return value;
        }, 2);
    } catch (e) {
        return `[Unstringifiable Object: ${e.message}]`;
    }
}

console.log = (...args) => {
    originalConsoleLog.apply(console, args);
    const msg = args.map(a => typeof a === 'object' ? safeStringify(a) : String(a)).join(' ');
    vscode.postMessage({ type: 'log', message: msg });
};
console.error = (...args) => {
    originalConsoleError.apply(console, args);
    const msg = args.map(a => typeof a === 'object' ? safeStringify(a) : String(a)).join(' ');
    vscode.postMessage({ type: 'error', message: msg });
};
console.warn = (...args) => {
    originalConsoleWarn.apply(console, args);
    const msg = args.map(a => typeof a === 'object' ? safeStringify(a) : String(a)).join(' ');
    vscode.postMessage({ type: 'log', message: `[WARN] ${msg}` });
};

window.onerror = function (msg, url, line, col, error) {
    console.error(`[DataBrowser Webview Runtime Error] ${msg} at ${line}:${col}. Error: ${error?.message || 'N/A'}`);
    return false;
};

// --- Sentry Initialization ---
const Sentry = typeof require !== 'undefined' ? require("@sentry/browser") : null;

if (Sentry && Sentry.init) {
    Sentry.init({
        dsn: "https://97f5f46047e65ebbf758c0e9e4ffe6c5@o4510744386732032.ingest.de.sentry.io/4510744389550160",
        release: process.env.SENTRY_RELEASE,
        integrations: [
            Sentry.replayIntegration({
                maskAllText: true,
                blockAllMedia: true,
            }),
        ],
        // Session Replay
        replaysSessionSampleRate: 0.1,
        replaysOnErrorSampleRate: 1.0,
        tracePropagationTargets: ["localhost", /^\//, /^\/api\//],
    });
}

// --- Imports ---
import { tableFromIPC } from 'apache-arrow';

const perf = {
    marks: {},
    start(name) { this.marks[name] = performance.now(); },
    end(name) {
        if (!this.marks[name]) return 0;
        const duration = performance.now() - this.marks[name];
        delete this.marks[name];
        return duration;
    },
    log(name, duration) {
        console.log(`[Perf] ${name}: ${duration.toFixed(2)}ms`);
    }
};

// --- State and Constants ---
let state = {
    baseUrl: '',
    token: '',
    datasetId: '',
    viewId: null,
    vars: [],
    selectedVars: [],
    sortBy: [],
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
    error: document.getElementById('error-banner'),
    // Custom Variable Selector DOM
    btnVariables: document.getElementById('btn-variables'),
    varMenu: document.getElementById('var-dropdown-menu'),
    varSearch: document.getElementById('var-search-input'),
    varList: document.getElementById('var-list'),
    btnSelectAll: document.getElementById('btn-select-all'),
    btnSelectNone: document.getElementById('btn-select-none')
};

let isInitialized = false;
let pendingRefresh = false;
const pendingRequests = new Map();

// --- Message Listener (Register early) ---
window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
        case 'init':
            console.log('[DataBrowser Webview] Received init message. BaseURL:', message.baseUrl);
            isInitialized = true;
            if (message.baseUrl && message.token) {
                // Store config if provided
                if (message.config) {
                    state.config = message.config;
                }
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

// Notify the extension that we are starting
console.log("[DataBrowser Webview] Webview script booting...");
vscode.postMessage({ type: 'ready' });

function sendReady() {
    if (isInitialized) return;
    console.log('[DataBrowser Webview] Sending ready message...');
    vscode.postMessage({ type: 'ready' });
    setTimeout(sendReady, 1000);
}
sendReady();

// --- Utility Functions ---

function log(message, isError = false) {
    if (isError) {
        console.error(`[DataBrowser] ${message}`);
    } else {
        console.log(`[DataBrowser] ${message}`);
    }
}

function handleApiResponse(msg) {
    const { reqId, success, data, error, isBinary } = msg;

    if (pendingRequests.has(reqId)) {
        const { resolve, reject } = pendingRequests.get(reqId);
        pendingRequests.delete(reqId);

        if (success) {
            const isBinaryData = isBinary && data && (data instanceof Uint8Array || data.buffer instanceof ArrayBuffer || typeof data.byteLength === 'number');
            if (isBinaryData) {
                try {
                    perf.start('arrowParse');
                    const table = tableFromIPC(data);
                    // Optimization: Do NOT convert to rows array.
                    // Just extract vars for metadata, but keep table for lazy access.
                    const vars = table.schema.fields.map(f => f.name);

                    const parseTime = perf.end('arrowParse');
                    perf.log('Arrow Parse & Convert', parseTime);

                    resolve({ vars, table, totalObs: state.totalObs, datasetId: state.datasetId });
                } catch (e) {
                    reject(new Error(`Arrow Parsing Failed: ${e.message}`));
                }
            } else {
                resolve(data);
            }
        } else {
            // Check for Dataset ID conflict
            if (error && (error.includes('409') || error.includes('datasetId') || error.includes('identity'))) {
                console.warn('[DataBrowser] Dataset changed detected. Re-initializing...');
                if (state.baseUrl && state.token) {
                    initBrowser(state.baseUrl, state.token);
                }
            }
            reject(new Error(error));
        }
    }
}

function setLoading(loading) {
    state.isLoading = loading;
    if (dom.loading) {
        if (loading) dom.loading.classList.remove('hidden');
        else dom.loading.classList.add('hidden');
    }
}

function setError(msg) {
    if (dom.error) {
        if (msg) {
            log(`Error displayed to user: ${msg}`, true);
            dom.error.textContent = msg;
            dom.error.classList.remove('hidden');
            if (!window.__DATA_BROWSER_TEST__) {
                setTimeout(() => dom.error.classList.add('hidden'), 5000);
            }
        } else {
            dom.error.classList.add('hidden');
        }
    }
}

function showError(msg) { setError(msg); }
function hideError() { setError(null); }
function showLoading() { setLoading(true); }
function hideLoading() { setLoading(false); }

function updateDataSummary(nObs, nVars) {
    if (dom.obsCount) dom.obsCount.textContent = nObs.toLocaleString();
    if (dom.varCount) dom.varCount.textContent = nVars.toLocaleString();
    if (dom.statusText) {
        const obsText = `${nObs.toLocaleString()} observation${nObs !== 1 ? 's' : ''}`;
        const varText = nVars > 0 ? `, ${nVars.toLocaleString()} variable${nVars !== 1 ? 's' : ''}` : '';
        dom.statusText.textContent = obsText + varText;
    }
}

function renderVarList(filterText = '') {
    if (!dom.varList) return;
    dom.varList.innerHTML = '';
    const term = filterText.toLowerCase();

    state.vars.forEach(v => {
        if (term && !v.name.toLowerCase().includes(term) && !(v.label || '').toLowerCase().includes(term)) {
            return;
        }

        const div = document.createElement('div');
        div.className = 'dropdown-item';
        if (state.selectedVars.includes(v.name)) div.classList.add('checked');

        div.onclick = (e) => {
            e.stopPropagation();
            toggleVariable(v.name, div);
        };

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = state.selectedVars.includes(v.name);
        checkbox.onclick = (e) => {
            e.stopPropagation(); // let div click handle it or just handle here?
            // Actually, clearer if div handles it.
            // But clicking checkbox directly toggles it twice if we don't stop propagation.
            // Let's just let the div handle it, but prevent default on checkbox click?
            // No, best is:
            toggleVariable(v.name, div);
        };

        const span = document.createElement('span');
        span.textContent = v.label ? `${v.name} (${v.label})` : v.name;
        span.title = v.label || v.name;

        div.appendChild(checkbox);
        div.appendChild(span);
        dom.varList.appendChild(div);
    });
}

function toggleVariable(name, divItem) {
    if (state.selectedVars.includes(name)) {
        state.selectedVars = state.selectedVars.filter(v => v !== name);
        if (divItem) {
            divItem.classList.remove('checked');
            const cb = divItem.querySelector('input');
            if (cb) cb.checked = false;
        }
    } else {
        state.selectedVars.push(name);
        if (divItem) {
            divItem.classList.add('checked');
            const cb = divItem.querySelector('input');
            if (cb) cb.checked = true;
        }
    }
    // Debounce grid update? Or Update immediately?
    // Updating immediately might be too heavy if checking many.
    // But user expects feedback.
    // Let's debounce the loadPage call.
    debounceLoadPage();
}

let loadPageDebounceTimer = null;
function debounceLoadPage() {
    if (loadPageDebounceTimer) clearTimeout(loadPageDebounceTimer);
    loadPageDebounceTimer = setTimeout(() => {
        state.offset = 0;
        loadPage();
    }, 500);
}

function populateVariableSelector(variables) {
    perf.start('populateVars');
    state.vars = variables;

    // Determine limit from config (default to 50 if undefined)
    // If limit is 0, select all variables.
    let limit = 50;
    if (state.config && typeof state.config.variableLimit === 'number') {
        limit = state.config.variableLimit;
    }

    if (limit === 0) {
        state.selectedVars = variables.map(v => v.name);
    } else {
        state.selectedVars = variables.slice(0, limit).map(v => v.name);
    }

    renderVarList();
    const duration = perf.end('populateVars');
    perf.log('Variables Population', duration);
}

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
            },
        });

        setTimeout(() => {
            if (pendingRequests.has(reqId)) {
                pendingRequests.delete(reqId);
                reject(new Error('Request timed out'));
            }
        }, 30000);
    }).catch(err => {
        const match = err.message.match(/API Request Failed \((\d+)\): (.+)/);
        if (match) {
            const status = parseInt(match[1], 10);
            try {
                const json = JSON.parse(match[2]);
                const code = json.error?.code;
                const msg = json.error?.message || err.message;
                throw new ApiError(msg, status, code, json);
            } catch (e) { }
        }
        log(`API Proxy Failed: ${err.message}`, true);
        throw err;
    });
}

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
                pendingRefresh = false;
                initBrowser(state.baseUrl, state.token);
            }
        })
        .catch(err => {
            console.error('[DataBrowser Webview Error]', err);
            showError(`Initialization failed: ${err.message}`);
            hideLoading();
        });
}

async function loadPage() {
    if (state.totalObs === 0) return;
    log(`Loading page. Offset: ${state.offset}, Limit: ${state.limit}, View: ${state.viewId}`);
    showLoading();
    try {
        let endpoint = '/v1/arrow';
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

        if (state.viewId) endpoint = `/v1/views/${state.viewId}/arrow`;

        perf.start('dataFetch');
        const data = await apiCall(endpoint, 'POST', body);
        const fetchTime = perf.end('dataFetch');
        perf.log('Data Fetch', fetchTime);

        if (data) {
            const numRows = data.table ? data.table.numRows : (data.rows?.length || data.data?.length);
            log(`Page loaded. Records: ${numRows}`);

            perf.start('renderGrid');
            renderGrid(data);
            const renderTime = perf.end('renderGrid');
            perf.log('Render Grid', renderTime);

            updatePagination(data);
            if (data.datasetId && data.datasetId !== state.datasetId) {
                log('Response datasetId mismatch. Re-initializing.', true);
                initBrowser(state.baseUrl, state.token);
            }
        }
    } catch (err) {
        if (err instanceof ApiError && err.code === 'no_data_in_memory') {
            initBrowser(state.baseUrl, state.token);
            return;
        }
        showError(`Failed to load page: ${err.message}`);
    } finally {
        hideLoading();
    }
}

async function applyFilter() {
    const filterExpr = dom.filterInput.value.trim();
    log(`Applying filter: "${filterExpr}"`);

    if (!filterExpr) {
        if (state.viewId) {
            await apiCall(`/v1/views/${state.viewId}`, 'DELETE').catch(() => { });
            state.viewId = null;
        }
        state.offset = 0;
        await loadPage();
        return;
    }

    showLoading();
    try {
        const valid = await apiCall('/v1/filters/validate', 'POST', {
            datasetId: state.datasetId,
            filterExpr: filterExpr
        });
        const isOk = valid && (valid.ok === true || valid.isValid === true || valid.valid === true);
        if (!isOk) throw new Error(valid?.error || `Invalid filter expression`);

        const viewRes = await apiCall('/v1/views', 'POST', {
            datasetId: state.datasetId,
            filterExpr: filterExpr
        });
        const viewData = viewRes.view || viewRes;

        if (viewData && viewData.id) {
            log(`View created: ${viewData.id}`);
            state.viewId = viewData.id;
            state.offset = 0;
            if (viewData.filteredN !== undefined) {
                if (dom.obsCount) dom.obsCount.textContent = viewData.filteredN.toLocaleString();
            }
            await loadPage();
        }
    } catch (err) {
        showError(`Filter failed: ${err.message}`);
    } finally {
        hideLoading();
    }
}

function handleSort(varName, isMulti = false) {
    const currentSort = state.sortBy || [];
    let newSort = [];
    const existingIdx = currentSort.findIndex(s => s === varName || s === `-${varName}` || s === `+${varName}`);

    if (existingIdx === -1) {
        newSort = isMulti ? [...currentSort, varName] : [varName];
    } else {
        const existing = currentSort[existingIdx];
        const isDesc = existing.startsWith('-');
        if (!isDesc) {
            newSort = [...currentSort];
            newSort[existingIdx] = `-${varName}`;
            if (!isMulti) newSort = [`-${varName}`];
        } else {
            newSort = isMulti ? currentSort.filter((_, i) => i !== existingIdx) : [];
        }
    }

    state.sortBy = newSort;
    state.offset = 0;
    loadPage();
}

function renderGrid(pageData) {
    const varCount = pageData.vars?.length || pageData.variables?.length || 0;
    log(`Render Grid. Vars: ${varCount}, Rows: ${pageData.rows?.length || pageData.data?.length}`);
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
            sortIcon = `<span class="sort-icon">${sortState.startsWith('-') ? '↓' : '↑'}</span>`;
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

    dom.grid.innerHTML = '';
    const table = pageData.table;
    const rows = pageData.rows || pageData.data || [];
    const returnedVars = pageData.vars || pageData.variables || [];
    const obsIndex = returnedVars.indexOf('_n');

    const numRows = table ? table.numRows : rows.length;

    for (let i = 0; i < numRows; i++) {
        const tr = document.createElement('tr');
        const tdObs = document.createElement('td');

        let obsVal = '';
        if (obsIndex !== -1) {
            if (table) {
                // Direct Arrow Access
                obsVal = table.getChildAt(obsIndex).get(i);
            } else {
                obsVal = rows[i][obsIndex];
            }
        }

        tdObs.textContent = obsVal || '';
        tdObs.style.color = 'var(--text-tertiary)';
        tr.appendChild(tdObs);

        displayVars.forEach(v => {
            const td = document.createElement('td');
            const idx = returnedVars.indexOf(v.name);
            let val = null;

            if (idx !== -1) {
                if (table) {
                    val = table.getChildAt(idx).get(i);
                } else {
                    val = rows[i][idx];
                }
            }

            td.textContent = (val === null || val === undefined) ? '.' : String(val);
            tr.appendChild(td);
        });
        dom.grid.appendChild(tr);
    }
}

function getTypeClass(type) {
    if (!type) return 'str';
    if (type.startsWith('str')) return 'str';
    if (['byte', 'int', 'long'].includes(type)) return 'int';
    return 'float';
}

function updatePagination(data) {
    if (!dom.prevBtn || !dom.nextBtn || !dom.pageInfo) return;
    dom.prevBtn.disabled = state.offset <= 0;

    // Support both Arrow Table and legacy array
    const returnedCount = data.table ? data.table.numRows : (data.rows || data.data || []).length;

    dom.nextBtn.disabled = returnedCount < state.limit;
    const start = state.offset + 1;
    const end = state.offset + returnedCount;
    dom.pageInfo.textContent = returnedCount > 0 ? `rows ${start} - ${end}` : '0 - 0';
}

// --- Event Listeners ---

if (dom.prevBtn) dom.prevBtn.addEventListener('click', () => {
    if (state.offset > 0) {
        state.offset = Math.max(0, state.offset - state.limit);
        loadPage();
    }
});

if (dom.nextBtn) dom.nextBtn.addEventListener('click', () => {
    state.offset += state.limit;
    loadPage();
});

if (dom.refreshBtn) dom.refreshBtn.addEventListener('click', () => {
    if (state.baseUrl && state.token) initBrowser(state.baseUrl, state.token);
});

if (dom.btnVariables) {
    dom.btnVariables.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.varMenu.classList.toggle('visible');
        dom.btnVariables.classList.toggle('active');
        if (dom.varMenu.classList.contains('visible') && dom.varSearch) {
            dom.varSearch.focus();
        }
    });
}

// Close menu when clicking outside
window.addEventListener('click', (e) => {
    if (dom.varMenu && dom.varMenu.classList.contains('visible')) {
        if (!dom.varMenu.contains(e.target) && !dom.btnVariables.contains(e.target)) {
            dom.varMenu.classList.remove('visible');
            dom.btnVariables.classList.remove('active');
        }
    }
});

// Avoid closing when clicking inside
if (dom.varMenu) {
    dom.varMenu.addEventListener('click', (e) => e.stopPropagation());
}

if (dom.varSearch) {
    dom.varSearch.addEventListener('input', (e) => {
        renderVarList(e.target.value);
    });
}

if (dom.btnSelectAll) {
    dom.btnSelectAll.addEventListener('click', () => {
        const term = dom.varSearch ? dom.varSearch.value.toLowerCase() : '';
        const visibleVars = state.vars.filter(v =>
            !term || v.name.toLowerCase().includes(term) || (v.label || '').toLowerCase().includes(term)
        );
        const newNames = visibleVars.map(v => v.name);
        // Add any that aren't already selected
        newNames.forEach(n => {
            if (!state.selectedVars.includes(n)) state.selectedVars.push(n);
        });
        renderVarList(term);
        debounceLoadPage();
    });
}

if (dom.btnSelectNone) {
    dom.btnSelectNone.addEventListener('click', () => {
        const term = dom.varSearch ? dom.varSearch.value.toLowerCase() : '';
        const visibleVars = state.vars.filter(v =>
            !term || v.name.toLowerCase().includes(term) || (v.label || '').toLowerCase().includes(term)
        );
        const visibleNames = visibleVars.map(v => v.name);
        state.selectedVars = state.selectedVars.filter(n => !visibleNames.includes(n));
        renderVarList(term);
        debounceLoadPage();
    });
}

if (dom.filterInput) dom.filterInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilter(); });
if (dom.applyFilterBtn) dom.applyFilterBtn.addEventListener('click', applyFilter);

if (typeof window !== 'undefined' && window.__DATA_BROWSER_TEST__) {
    window.__dataBrowserState = state;
    window.__loadPage = loadPage;
}

export default undefined;
