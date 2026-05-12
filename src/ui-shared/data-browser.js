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
        beforeSend(event, hint) {
            const error = hint.originalException;
            if (error) {
                const msg = (error.message || String(error)).toLowerCase();

                // 1. SHUTDOWN & CONNECTIVITY NOISE (Broadly)
                const isLifecycleError =
                    msg.includes('canceled') ||
                    msg.includes('aborted') ||
                    msg.includes('channel has been closed') ||
                    msg.includes('connection closed') ||
                    msg.includes('failed to fetch') ||
                    msg.includes('network error') ||
                    msg.includes('request timed out') ||
                    msg.includes('disposed');

                if (isLifecycleError) {
                    // If we're offline, or the message is about a closure, ignore it
                    if (!window.navigator.onLine) return null;
                    if (msg.includes('closed') || msg.includes('disposed')) return null;
                }
            }
            return event;
        }
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
    vars: [],
    selectedVars: [],
    offset: 0,
    limit: 100,
    totalObs: 0,
    filter: '',
    isLoading: false,
    currentPageData: null,
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

// --- Message Listener (Register early) ---
window.addEventListener('message', async (event) => {
    const message = event.data;
    switch (message.type) {
        case 'init':
            if (message.variables) {
                state.totalObs = message.obs_count || 0;
                updateDataSummary(state.totalObs, message.var_count || message.variables.length);
                populateVariableSelector(message.variables);
                if (message.config) state.config = message.config;
                isInitialized = true;
                await loadPage();
            }
            break;
        case 'arrow-page':
            await handleArrowPage(message);
            break;
        case 'filterResult':
            handleFilterResult(message);
            break;
        case 'error':
            showError(message.message);
            break;
    }
});

// Notify the extension that we are starting
console.log("[DataBrowser Webview] Webview script booting...");
vscode.postMessage({ type: 'ready' });

// --- Utility Functions ---

function log(message, isError = false) {
    if (isError) {
        console.error(`[DataBrowser] ${message}`);
    } else {
        console.log(`[DataBrowser] ${message}`);
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


function requestVariables() {
    vscode.postMessage({ type: 'requestVariables' });
}

async function loadPage() {
    if (state.totalObs === 0) return;
    showLoading();
    vscode.postMessage({
        type: 'requestPage',
        start: state.offset,
        count: state.limit,
        varlist: state.selectedVars,
    });
}

async function handleArrowPage(message) {
    try {
        perf.start('arrowParse');
        const data = new Uint8Array(message.data);
        const table = tableFromIPC(data);
        const vars = table.schema.fields.map(f => f.name);
        const parseTime = perf.end('arrowParse');
        perf.log('Arrow Parse', parseTime);

        state.currentPageData = { table, vars };
        hideLoading();
        renderGrid({ table, vars });
        updatePagination({ table });
    } catch (e) {
        showError(`Arrow parsing failed: ${e.message}`);
        hideLoading();
    }
}

async function applyFilter() {
    const filterExpr = dom.filterInput.value.trim();
    if (!filterExpr) {
        state.offset = 0;
        await loadPage();
        return;
    }
    showLoading();
    vscode.postMessage({ type: 'filter', expr: filterExpr });
}

function handleFilterResult(msg) {
    hideLoading();
    if (msg.valid) {
        state.filteredIndices = msg.indices;
        state.offset = 0;
        loadPage();
    } else {
        showError('Filter: ' + msg.error);
    }
}


function renderGrid(pageData) {
    const table = pageData.table;
    if (!table) return;

    dom.header.innerHTML = '';
    const obsTh = document.createElement('th');
    obsTh.textContent = '#';
    obsTh.style.width = '60px';
    dom.header.appendChild(obsTh);

    const displayVars = state.vars.filter(v => state.selectedVars.includes(v.name));
    displayVars.forEach(v => {
        const th = document.createElement('th');
        th.innerHTML = `<div style="display:flex; align-items:center;"><span class="type-indicator type-${getTypeClass(v.type)}"></span><span title="${v.label || v.name}">${v.name}</span></div>`;
        dom.header.appendChild(th);
    });

    dom.grid.innerHTML = '';
    for (let i = 0; i < table.numRows; i++) {
        const tr = document.createElement('tr');
        const tdObs = document.createElement('td');
        tdObs.textContent = state.offset + i + 1;
        tdObs.style.color = 'var(--text-tertiary)';
        tr.appendChild(tdObs);

        displayVars.forEach(v => {
            const td = document.createElement('td');
            const idx = pageData.vars.indexOf(v.name);
            let val = null;
            if (idx !== -1) val = table.getChildAt(idx).get(i);
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

    const returnedCount = data.table ? data.table.numRows : 0;

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
    requestVariables();
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
