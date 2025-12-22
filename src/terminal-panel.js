const { openArtifact, revealArtifact, copyToClipboard, resolveArtifactUri } = require('./artifact-utils');
const path = require('path');
const vscode = require('vscode');

class TerminalPanel {
  static currentPanel = null;
  static extensionUri = null;
  static _testCapture = null;
  static _testOutgoingCapture = null;
  static variableProvider = null;
  static _defaultRunCommand = null;
  static _downloadGraphPdf = null;
  static _cancelHandler = null;
  static _clearHandler = null;
  static _activeRunId = null;
  static _activeFilePath = null;
  static _webviewReady = true;
  static _pendingWebviewMessages = [];

  static setExtensionUri(uri) {
    TerminalPanel.extensionUri = uri;
  }


  /**
  * Show (or reveal) the terminal panel and seed it with an initial entry.
   * @param {Object} options
   * @param {string} options.filePath
   * @param {string} options.initialCode
   * @param {object} options.initialResult
   * @param {(code: string, hooks?: object) => Promise<object>} options.runCommand
   * @param {(graphName: string) => Promise<void>} [options.downloadGraphPdf]
   * @param {() => Promise<void>} [options.cancelRun]
   * @param {() => Promise<void>} [options.clearAll]
   */
  static show({ filePath, initialCode, initialResult, runCommand, variableProvider, downloadGraphPdf, cancelRun, clearAll }) {
    const column = vscode.ViewColumn.Beside;
    TerminalPanel._activeFilePath = filePath || null;
    if (typeof variableProvider === 'function') {
      TerminalPanel.variableProvider = variableProvider;
    }
    if (typeof downloadGraphPdf === 'function') {
      TerminalPanel._downloadGraphPdf = downloadGraphPdf;
    }
    if (typeof cancelRun === 'function') {
      TerminalPanel._cancelHandler = cancelRun;
    }
    if (typeof clearAll === 'function') {
      TerminalPanel._clearHandler = clearAll;
    }
    if (!TerminalPanel.currentPanel) {
      TerminalPanel.currentPanel = vscode.window.createWebviewPanel(
        'stataTerminal',
        'Stata Terminal',
        column,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(TerminalPanel.extensionUri, 'src', 'ui-shared')
          ]
        }
      );

      TerminalPanel.currentPanel.onDidDispose(() => {
        TerminalPanel.currentPanel = null;
        TerminalPanel._webviewReady = true;
        TerminalPanel._pendingWebviewMessages = [];
      });

      TerminalPanel.currentPanel.webview.onDidReceiveMessage(async (message) => {
        if (!message || typeof message !== 'object') return;

        // Test hook
        if (TerminalPanel._testCapture) {
          TerminalPanel._testCapture(message);
        }

        if (message.type === 'ready') {
          TerminalPanel._webviewReady = true;
          TerminalPanel._flushPendingMessages();
          return;
        }

        if (message.type === 'openDataBrowser') {
          vscode.commands.executeCommand('stata-workbench.viewData');
          return;
        }

        if (message.type === 'showGraphs') {
          vscode.commands.executeCommand('stata-workbench.showGraphs');
          return;
        }

        if (message.type === 'run' && typeof message.code === 'string') {
          await TerminalPanel.handleRun(message.code, runCommand);
        }
        if ((message.command === 'download-graph-pdf' || message.type === 'downloadGraphPdf') && message.graphName) {
          await TerminalPanel._handleDownloadGraphPdf(message.graphName);
        }
        if (message.type === 'cancelRun') {
          await TerminalPanel._handleCancelRun();
        }
        if (message.type === 'clearAll') {
          await TerminalPanel._handleClearAll();
        }
        if (message.type === 'openArtifact' && message.path) {
          openArtifact(message.path, message.baseDir);
        }
        if (message.type === 'revealArtifact' && message.path) {
          await revealArtifact(message.path, message.baseDir);
        }
        if (message.type === 'copyArtifactPath' && message.path) {
          const uri = resolveArtifactUri(message.path, message.baseDir);
          if (uri?.scheme === 'file') {
            await copyToClipboard(uri.fsPath);
          } else if (uri) {
            await copyToClipboard(uri.toString());
          } else {
            await copyToClipboard(message.path);
          }
        }
        if (message.type === 'requestVariables') {
          const provider = TerminalPanel.variableProvider;
          if (typeof provider === 'function') {
            try {
              const vars = await provider();
              webview.postMessage({ type: 'variables', variables: vars || [] });
            } catch (error) {
              webview.postMessage({ type: 'variables', variables: [], error: error?.message || String(error) });
            }
          } else {
            webview.postMessage({ type: 'variables', variables: [] });
          }
        }
        if (message.type === 'log') {
          console.log(`[Client Log] ${message.level || 'info'}: ${message.message}`);
        }
      });

      const webview = TerminalPanel.currentPanel.webview;
      if (webview && typeof webview.postMessage === 'function' && !webview.__stataWorkbenchWrapped) {
        const originalPostMessage = webview.postMessage.bind(webview);
        webview.postMessage = (msg) => {
          try {
            if (TerminalPanel._testOutgoingCapture) {
              TerminalPanel._testOutgoingCapture(msg);
            }
          } catch (_err) {
          }
          return originalPostMessage(msg);
        };
        webview.__stataWorkbenchWrapped = true;
      }
    }

    const webview = TerminalPanel.currentPanel.webview;
    if (typeof runCommand === 'function') {
      TerminalPanel._defaultRunCommand = runCommand;
    }
    const nonce = getNonce();

    // Convert initial data to history entry format for embedding
    const initialHistory = (initialCode && initialResult)
      ? [toEntry(initialCode, initialResult)]
      : [];

    TerminalPanel.currentPanel.webview.html = renderHtml(webview, TerminalPanel.extensionUri, nonce, filePath, initialHistory);
    TerminalPanel._webviewReady = false;
    TerminalPanel._pendingWebviewMessages = [];
    TerminalPanel.currentPanel.reveal(column);

  }

  static _postMessage(msg) {
    if (!TerminalPanel.currentPanel) return;
    const webview = TerminalPanel.currentPanel.webview;
    if (!webview || typeof webview.postMessage !== 'function') return;
    if (!TerminalPanel._webviewReady) {
      TerminalPanel._pendingWebviewMessages.push(msg);
      return;
    }
    webview.postMessage(msg);
  }

  static _flushPendingMessages() {
    if (!TerminalPanel.currentPanel) return;
    if (!TerminalPanel._webviewReady) return;
    const pending = Array.isArray(TerminalPanel._pendingWebviewMessages)
      ? TerminalPanel._pendingWebviewMessages
      : [];
    TerminalPanel._pendingWebviewMessages = [];
    for (const msg of pending) {
      TerminalPanel._postMessage(msg);
    }
  }

  static updateDatasetSummary(n, k) {
    TerminalPanel._postMessage({ type: 'datasetSummary', n, k });
  }

  static async handleRun(code, runCommand) {
    if (!TerminalPanel.currentPanel) return;
    const trimmed = (code || '').trim();
    if (!trimmed) return;

    const runId = TerminalPanel._generateRunId();
    TerminalPanel._activeRunId = runId;
    TerminalPanel._postMessage({ type: 'busy', value: true });
    TerminalPanel._postMessage({ type: 'runStarted', runId, code: trimmed });
    try {
      const cwd = TerminalPanel._activeFilePath ? path.dirname(TerminalPanel._activeFilePath) : null;
      const hooks = {
        onLog: (text) => {
          if (!text) return;
          TerminalPanel._postMessage({ type: 'runLogAppend', runId, text: String(text) });
        },
        onProgress: (progress, total, message) => {
          TerminalPanel._postMessage({ type: 'runProgress', runId, progress, total, message });
        },
        cwd
      };
      const result = await runCommand(trimmed, hooks);
      const success = isRunSuccess(result);
      TerminalPanel._postMessage({
        type: 'runFinished',
        runId,
        rc: typeof result?.rc === 'number' ? result.rc : null,
        success,
        durationMs: result?.durationMs ?? null,
        stdout: success ? (result?.stdout || result?.contentText || '') : (result?.stdout || ''),
        stderr: result?.stderr || '',
        artifacts: normalizeArtifacts(result),
        baseDir: result?.cwd || ''
      });
    } catch (error) {
      TerminalPanel._postMessage({ type: 'runFailed', runId, message: error?.message || String(error) });
    } finally {
      TerminalPanel._activeRunId = null;
      TerminalPanel._postMessage({ type: 'busy', value: false });
    }
  }

  static async _handleDownloadGraphPdf(graphName) {
    if (typeof TerminalPanel._downloadGraphPdf !== 'function') return;
    try {
      await TerminalPanel._downloadGraphPdf(graphName);
      TerminalPanel._postMessage({ type: 'downloadStatus', success: true, graphName });
    } catch (error) {
      console.error('[TerminalPanel] downloadGraphPdf failed:', error);
      TerminalPanel._postMessage({
        type: 'downloadStatus',
        success: false,
        graphName,
        message: error?.message || String(error)
      });
    }
  }

  static async _handleCancelRun() {
    if (typeof TerminalPanel._cancelHandler === 'function') {
      try {
        await TerminalPanel._cancelHandler();
        // Optimistically mark the active run as cancelled in the UI.
        const runId = TerminalPanel._activeRunId;
        if (runId) {
          TerminalPanel._postMessage({ type: 'runCancelled', runId, message: 'Run cancelled by user.' });
          TerminalPanel._postMessage({ type: 'busy', value: false });
        }
      } catch (error) {
        console.error('[TerminalPanel] cancelRun failed:', error);
      }
    }
  }

  static startStreamingEntry(code, filePath, runCommand, variableProvider, cancelRun, downloadGraphPdf) {
    const trimmed = (code || '').trim();
    if (!trimmed) return null;

    TerminalPanel._activeFilePath = filePath || TerminalPanel._activeFilePath || null;
    if (typeof variableProvider === 'function') {
      TerminalPanel.variableProvider = variableProvider;
    }
    if (typeof runCommand === 'function') {
      TerminalPanel._defaultRunCommand = runCommand;
    }
    if (typeof cancelRun === 'function') {
      TerminalPanel._cancelHandler = cancelRun;
    }
    if (typeof downloadGraphPdf === 'function') {
      TerminalPanel._downloadGraphPdf = downloadGraphPdf;
    }

    if (!TerminalPanel.currentPanel) {
      TerminalPanel.show({
        filePath,
        initialCode: null,
        initialResult: null,
        runCommand: runCommand || TerminalPanel._defaultRunCommand || (async () => { throw new Error('Session not fully initialized'); }),
        variableProvider: variableProvider || TerminalPanel.variableProvider,
        downloadGraphPdf: TerminalPanel._downloadGraphPdf,
        cancelRun: TerminalPanel._cancelHandler,
        clearAll: TerminalPanel._clearHandler
      });
    }

    if (!TerminalPanel.currentPanel) return null;
    const runId = TerminalPanel._generateRunId();
    TerminalPanel._postMessage({ type: 'busy', value: true });
    TerminalPanel._postMessage({ type: 'runStarted', runId, code: trimmed });
    TerminalPanel.currentPanel.reveal(vscode.ViewColumn.Beside);
    return runId;
  }

  static appendStreamingLog(runId, text) {
    if (!TerminalPanel.currentPanel || !runId) return;
    const chunk = String(text ?? '');
    if (!chunk) return;
    TerminalPanel._postMessage({ type: 'runLogAppend', runId, text: chunk });
  }

  static updateStreamingProgress(runId, progress, total, message) {
    if (!TerminalPanel.currentPanel || !runId) return;
    TerminalPanel._postMessage({ type: 'runProgress', runId, progress, total, message });
  }

  static finishStreamingEntry(runId, result) {
    if (!TerminalPanel.currentPanel || !runId) return;
    const success = isRunSuccess(result);
    TerminalPanel._postMessage({
      type: 'runFinished',
      runId,
      rc: typeof result?.rc === 'number' ? result.rc : null,
      success,
      durationMs: result?.durationMs ?? null,
      stdout: success ? (result?.stdout || result?.contentText || '') : (result?.stdout || ''),
      stderr: result?.stderr || '',
      artifacts: normalizeArtifacts(result),
      baseDir: result?.cwd || ''
    });
    TerminalPanel._postMessage({ type: 'busy', value: false });
  }

  static failStreamingEntry(runId, errorMessage) {
    if (!TerminalPanel.currentPanel || !runId) return;
    TerminalPanel._postMessage({ type: 'runFailed', runId, message: errorMessage });
    TerminalPanel._postMessage({ type: 'busy', value: false });
  }

  static _generateRunId() {
    return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
  * Appends an entry to the terminal panel, showing it if necessary.
   * @param {string} code
   * @param {object} result
   * @param {string} [filePath] - associated file path to update title if needed
   * @param {(code: string) => Promise<object>} [runCommand] - command runner if panel needs initialization
   */
  static addEntry(code, result, filePath, runCommand, variableProvider) {
    if (!TerminalPanel.currentPanel) {
      // If panel not open, open it with this as initial state
      if (typeof runCommand === 'function') {
        TerminalPanel._defaultRunCommand = runCommand;
      }
      if (typeof variableProvider === 'function') {
        TerminalPanel.variableProvider = variableProvider;
      }
      TerminalPanel.show({
        filePath,
        initialCode: code,
        initialResult: result,
        runCommand: runCommand || (async () => { throw new Error('Session not fully initialized'); }),
        variableProvider: variableProvider || TerminalPanel.variableProvider,
        downloadGraphPdf: TerminalPanel._downloadGraphPdf,
        cancelRun: TerminalPanel._cancelHandler,
        clearAll: TerminalPanel._clearHandler
      });
      return;
    }

    TerminalPanel._activeFilePath = filePath || TerminalPanel._activeFilePath || null;

    // Panel exists, just append
    TerminalPanel._postMessage({
      type: 'append',
      entry: toEntry(code, result)
    });

    // Explicitly reveal it
    TerminalPanel.currentPanel.reveal(vscode.ViewColumn.Beside);
  }

  static async _handleClearAll() {
  if (typeof TerminalPanel._clearHandler === 'function') {
    try {
      // Clear UI first, before running command
      TerminalPanel._postMessage({ type: 'cleared' });
      TerminalPanel._postMessage({ type: 'busy', value: true });
      await TerminalPanel._clearHandler();
      // Success - UI already cleared, no need to show anything
    } catch (error) {
      console.error('[TerminalPanel] clearAll failed:', error);
      TerminalPanel._postMessage({ type: 'error', message: 'Failed to clear: ' + error.message });
    } finally {
      TerminalPanel._postMessage({ type: 'busy', value: false });
    }
    return;
  }
  // Fallback: clear UI first, then run command silently
  TerminalPanel._postMessage({ type: 'cleared' });
  if (typeof TerminalPanel._defaultRunCommand === 'function') {
    // Run silently in background without showing in terminal
    try {
      await TerminalPanel._defaultRunCommand('clear all', {});
    } catch (error) {
      TerminalPanel._postMessage({ type: 'error', message: 'Failed to clear: ' + error.message });
    }
  }
}

}

module.exports = { TerminalPanel, toEntry, normalizeArtifacts };

function renderHtml(webview, extensionUri, nonce, filePath, initialEntries = []) {
  const designUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'design.css'));
  const mainJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'main.js'));
  
  const fileName = filePath ? path.basename(filePath) : 'Terminal Session';
  const escapedTitle = escapeHtml(fileName);
  const initialJson = JSON.stringify(initialEntries).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource} https://unpkg.com; font-src ${webview.cspSource} https://unpkg.com;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${designUri}">
  <title>Stata Terminal</title>
  <script nonce="${nonce}">
    window.initialEntries = ${initialJson};
  </script>
  <style nonce="${nonce}">
    @import url('https://unpkg.com/@vscode/codicons@0.0.44/dist/codicon.css');

    .context-container {
      display: flex;
      justify-content: space-between;
      align-items: center;
      max-width: 900px;
      margin: 0 auto;
      width: 100%;
    }

    .context-info {
      margin: 0 !important;
      max-width: none !important;
      flex: 1;
    }

    .context-right {
      display: flex;
      align-items: center;
      gap: var(--space-md);
    }

    .data-summary {
      display: flex;
      gap: var(--space-sm);
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--text-secondary);
      background: rgba(255, 255, 255, 0.03);
      padding: 2px 8px;
      border-radius: var(--radius-pill);
      border: 1px solid var(--border-subtle);
    }

    .summary-item {
      display: flex;
      gap: 4px;
    }

    .summary-item span {
      color: var(--text-primary);
      font-weight: 600;
    }

    #btn-open-browser {
      padding: 4px;
      height: 24px;
      width: 24px;
      justify-content: center;
    }
  </style>
</head>
<body>

  <!-- Context Header -->
  <div class="context-header" id="context-header">
    <div class="context-container">
      <div class="context-info">
        <div class="context-row">
          <span class="context-label">File:</span>
          <span class="context-value" id="context-file">${escapedTitle}</span>
        </div>
        <div class="context-row">
          <span class="context-label">Last command:</span>
          <span class="context-value context-command" id="last-command">—</span>
        </div>
      </div>
      <div class="context-right">
        <div class="data-summary" id="data-summary" style="display: none;">
          <span class="summary-item">n: <span id="obs-count">0</span></span>
          <span class="summary-item">v: <span id="var-count">0</span></span>
        </div>
        <button class="btn btn-ghost btn-icon" id="btn-open-browser" title="Open Data Browser">
          <i class="codicon codicon-table"></i>
        </button>
        <button class="btn btn-ghost btn-icon" id="btn-show-graphs" title="Show Graphs">
          <i class="codicon codicon-graph"></i>
        </button>
      </div>
    </div>
  </div>

  <main class="chat-stream" id="chat-stream">
    <!-- Entries injected here -->
  </main>

  <div class="artifact-modal hidden" id="artifact-modal" role="dialog" aria-modal="true" aria-hidden="true">
    <div class="artifact-modal-overlay" data-action="close-artifact-modal"></div>
    <div class="artifact-modal-panel">
      <div class="artifact-modal-header">
        <div class="artifact-modal-title" id="artifact-modal-title"></div>
        <button class="btn btn-sm" data-action="close-artifact-modal" type="button">Close</button>
      </div>
      <div class="artifact-modal-body">
        <img class="artifact-modal-img" id="artifact-modal-img" alt="" />
        <div class="artifact-modal-meta" id="artifact-modal-meta"></div>
      </div>
      <div class="artifact-modal-actions">
        <button class="btn btn-sm" id="artifact-modal-open" type="button">Open</button>
        <button class="btn btn-sm" id="artifact-modal-reveal" type="button">Reveal</button>
        <button class="btn btn-sm" id="artifact-modal-copy" type="button">Copy path</button>
        <button class="btn btn-sm btn-primary" id="artifact-modal-download" type="button">Download PDF</button>
      </div>
    </div>
  </div>

  <!-- Floating Input Area -->
  <footer class="input-area">
    <div class="input-container">
      <textarea id="command-input" placeholder="Run Stata command..." rows="1" autofocus></textarea>
      <div class="input-footer">
        <div class="key-hint">
          <span class="kbd">Enter</span><span>run</span>
          <span class="kbd">PgUp/Down</span><span>prev/next</span>
          <span class="kbd">Tab</span><span>complete</span>
        </div>
        <div class="input-actions">
          <button id="clear-btn" class="btn btn-sm btn-ghost" title="Clear all (Stata)">
            <i class="codicon codicon-trash"></i>
            <span>Clear</span>
          </button>
          <button id="stop-btn" class="btn btn-sm btn-ghost" title="Stop current run">
            <i class="codicon codicon-debug-stop"></i>
            <span>Stop</span>
          </button>
          <button id="run-btn" class="btn btn-primary btn-sm">
            <i class="codicon codicon-play"></i>
            <span>Run</span>
          </button>
        </div>
      </div>
    </div>
  </footer>

  <script src="${mainJsUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    vscode.postMessage({ type: 'log', level: 'info', message: 'Terminal webview booted' });

    // Defensive: if shared UI script fails to load, provide minimal helpers so the terminal still works.
    if (!window.stataUI) {
        window.stataUI = {
            escapeHtml: function (text) {
                return (text || '')
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#039;');
            },
            formatDuration: function (ms) {
                if (ms === null || ms === undefined) return '';
                if (ms < 1000) return ms + ' ms';
                const s = ms / 1000;
                if (s < 60) return s.toFixed(1) + ' s';
                const m = Math.floor(s / 60);
                const rem = s - m * 60;
                return m + 'm ' + rem.toFixed(0) + 's';
            },
            bindArtifactEvents: function () { }
        };
    }
    
    // Global error handler to surface script errors to extension
    window.onerror = function(message, source, lineno, colno, error) {
        vscode.postMessage({
            type: 'log',
            level: 'error',
            message: \`Client Error: \${message} (\${source}:\${lineno})\`
        });
    };

    const chatStream = document.getElementById('chat-stream');
    const input = document.getElementById('command-input');
    const runBtn = document.getElementById('run-btn');
    const stopBtn = document.getElementById('stop-btn');
    const clearBtn = document.getElementById('clear-btn');
    const btnOpenBrowser = document.getElementById('btn-open-browser');
    const btnShowGraphs = document.getElementById('btn-show-graphs');
    const dataSummary = document.getElementById('data-summary');
    const obsCount = document.getElementById('obs-count');
    const varCount = document.getElementById('var-count');
    
    if (btnOpenBrowser) {
        btnOpenBrowser.addEventListener('click', () => {
            vscode.postMessage({ type: 'openDataBrowser' });
        });
    }

    if (btnShowGraphs) {
        btnShowGraphs.addEventListener('click', () => {
            vscode.postMessage({ type: 'showGraphs' });
        });
    }

    // Initial history embedded from server
    const initialEntries = window.initialEntries || [];
    const history = [];
    let historyIndex = -1; // -1 means not currently traversing history
    const variables = [];
    let variablesPending = false;
    let lastCompletion = null;

    const runs = Object.create(null);

    let busy = false;

    function clearAllOutput() {
        // Clear the chat stream
        if (chatStream) {
            chatStream.innerHTML = '';
        }
        
        // Reset runs tracking
        for (const key in runs) {
            delete runs[key];
        }
        
        // Reset history
        history.length = 0;
        historyIndex = -1;
        
        // Reset last command display
        updateLastCommand('—');
        
        // Clear any optimistic messages
        const optimistic = chatStream.querySelectorAll('[data-optimistic="true"]');
        optimistic.forEach(el => el.remove());
        
        // Reset scroll
        autoScrollPinned = true;
        scrollToBottom();
    }

    function scrollToBottom() {
        const top = document.body.scrollHeight;
        try {
            window.scrollTo({ top, left: 0, behavior: 'auto' });
        } catch (_err) {
            window.scrollTo(0, top);
        }
    }

    function scrollToBottomSmooth() {
        const durationMs = 180;
        const startY = window.scrollY || 0;
        const startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

        const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

        const step = (now) => {
            const tNow = now ?? ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
            const elapsed = tNow - startTime;
            const t = Math.max(0, Math.min(1, elapsed / durationMs));
            const eased = easeOutCubic(t);

            const targetY = document.body.scrollHeight;
            const nextY = startY + (targetY - startY) * eased;
            window.scrollTo(0, nextY);

            if (t < 1) {
                requestAnimationFrame(step);
            } else {
                scrollToBottom();
            }
        };

        requestAnimationFrame(step);
    }

    let autoScrollPinned = true;
    let scrollScheduled = false;

    function scheduleScrollToBottom() {
        if (scrollScheduled) return;
        scrollScheduled = true;
        requestAnimationFrame(() => {
            scrollScheduled = false;
            scrollToBottom();
        });
    }

    // ... (rest of the listeners) ...

    // Auto-resize textarea
    input.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 200) + 'px';
      if (this.value === '') this.style.height = 'auto';
      lastCompletion = null;
    });

    // Handle keys
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doRun();
        return;
      }

      if (e.key === 'Tab') {
        // Always prevent focus from leaving the input; attempt completion if possible.
        e.preventDefault();
        const used = handleTabCompletion();
        if (!used) {
          requestVariables();
        }
        return;
      }

      if (e.key === 'PageUp') {
        // Navigate backward through history
        if (history.length === 0) return;
        e.preventDefault();
        if (historyIndex === -1) {
          historyIndex = history.length - 1;
        } else if (historyIndex > 0) {
          historyIndex -= 1;
        }
        applyHistory();
        return;
      }

      if (e.key === 'PageDown') {
        // Navigate forward through history (or clear if past newest)
        if (historyIndex === -1) return;
        e.preventDefault();
        if (historyIndex < history.length - 1) {
          historyIndex += 1;
          applyHistory();
        } else {
          historyIndex = -1;
          clearInput();
        }
      }
    });

    runBtn.addEventListener('click', doRun);
    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            if (!busy) return;
            stopBtn.disabled = true;
            vscode.postMessage({ type: 'cancelRun' });
            // Re-enable after a short delay in case host doesn't respond immediately
            setTimeout(() => { if (busy) stopBtn.disabled = false; }, 1200);
        });
    }

    if (clearBtn) {
    clearBtn.addEventListener('click', () => {
        if (busy) return;
        setBusy(true);
        
        // Clear UI immediately for better UX
        clearAllOutput();
        
        // Send message to extension to clear Stata session
        vscode.postMessage({ type: 'clearAll' });
    });
}

    // Bind shared artifact events (delegated)
    if (window.stataUI && typeof window.stataUI.bindArtifactEvents === 'function') {
        window.stataUI.bindArtifactEvents(vscode);
    }

    function requestVariables() {
      if (variablesPending) return;
      variablesPending = true;
      vscode.postMessage({ type: 'requestVariables' });
    }

    function updateLastCommand(code) {
        const lastCmd = document.getElementById('last-command');
        if (lastCmd) {
            lastCmd.textContent = code;
            lastCmd.title = code; // Full text on hover
        }
    }

    function doRun() {
      if (busy) return;
      const code = input.value.trim();
      if (!code) return;

      updateLastCommand(code);
      vscode.postMessage({ type: 'run', code });

      autoScrollPinned = true;

      // Optimistically append user message
      appendUserMessage(code);

      scrollToBottomSmooth();

      clearInput();
      historyIndex = -1; // reset traversal once we run a new command
    }

    function clearInput() {
      input.value = '';
      input.style.height = 'auto';
      input.focus();
    }

    function applyHistory() {
      if (historyIndex < 0 || historyIndex >= history.length) return;
      input.value = history[historyIndex] || '';
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';
      // Move cursor to end for quick editing
      const len = input.value.length;
      input.setSelectionRange(len, len);
      lastCompletion = null;
    }

    function setBusy(value) {
        busy = value;
        if (runBtn) {
            runBtn.disabled = value;
            runBtn.style.opacity = value ? 0.7 : 1;
        }
        if (stopBtn) {
            stopBtn.disabled = !value;
            stopBtn.style.opacity = value ? 1 : 0.6;
        }
        if (clearBtn) {
            clearBtn.disabled = value;
            clearBtn.style.opacity = value ? 0.6 : 1;
        }
        if (!value) setTimeout(() => input.focus(), 50);
    }

    function appendUserMessage(code) {
        const div = document.createElement('div');
        div.className = 'message-group';
        div.dataset.optimistic = 'true';
        div.innerHTML = \`
            <div class="user-bubble">
                \${window.stataUI.escapeHtml(code)}
            </div>
        \`;
        chatStream.appendChild(div);
        if (autoScrollPinned) scrollToBottom();
    }

    function ensureRunGroup(runId, code) {
        if (runs[runId]) return runs[runId];

        const lastGroup = chatStream.lastElementChild;
        if (lastGroup && lastGroup.dataset.optimistic) {
            lastGroup.remove();
        }

        if (code) {
          history.push(code);
          historyIndex = -1;
        }

        updateLastCommand(code || '');

        const userHtml = code ? (
            '<div class="user-bubble">'
            + window.stataUI.escapeHtml(code)
            + '</div>'
        ) : '';

        const systemHtml =
            '<div class="system-bubble">'
            +  '<div class="output-card">'
            +    '<div class="output-header">'
            +      '<div class="flex items-center gap-xs">'
            +        '<span class="text-muted" id="run-status-dot-' + runId + '" style="color: var(--accent-warning); font-size:16px;">●</span>'
            +        '<span id="run-status-title-' + runId + '">Stata Output (running…)</span>'
            +      '</div>'
            +      '<div class="flex items-center gap-sm">'
            +        '<span id="run-rc-' + runId + '"></span>'
            +        '<span id="run-duration-' + runId + '"></span>'
            +      '</div>'
            +    '</div>'
            +    '<div class="output-progress" id="run-progress-wrap-' + runId + '" style="display:none;">'
            +      '<div class="progress-row">'
            +        '<span class="progress-text" id="run-progress-text-' + runId + '"></span>'
            +        '<span class="progress-meta" id="run-progress-meta-' + runId + '"></span>'
            +      '</div>'
            +      '<div class="progress-bar"><div class="progress-fill" id="run-progress-fill-' + runId + '" style="width:0%;"></div></div>'
            +    '</div>'
            +    '<div class="output-content error" id="run-stderr-' + runId + '" style="display:none;"></div>'
            +    '<div class="output-content" id="run-stdout-' + runId + '"></div>'
            +  '</div>'
            +  '<div id="run-artifacts-' + runId + '"></div>'
            + '</div>';

        const div = document.createElement('div');
        div.className = 'message-group entry';
        div.dataset.runId = runId;
        div.innerHTML = userHtml + systemHtml;
        chatStream.appendChild(div);
        if (autoScrollPinned) scrollToBottom();

        runs[runId] = {
            group: div,
            stdoutEl: document.getElementById('run-stdout-' + runId),
            stderrEl: document.getElementById('run-stderr-' + runId),
            progressWrap: document.getElementById('run-progress-wrap-' + runId),
            progressText: document.getElementById('run-progress-text-' + runId),
            progressMeta: document.getElementById('run-progress-meta-' + runId),
            progressFill: document.getElementById('run-progress-fill-' + runId),
            statusDot: document.getElementById('run-status-dot-' + runId),
            statusTitle: document.getElementById('run-status-title-' + runId),
            rcEl: document.getElementById('run-rc-' + runId),
            durationEl: document.getElementById('run-duration-' + runId),
            artifactsEl: document.getElementById('run-artifacts-' + runId)
        };

        return runs[runId];
    }

    function appendEntry(entry) {
        const lastGroup = chatStream.lastElementChild;
        if (lastGroup && lastGroup.dataset.optimistic) {
            lastGroup.remove();
        }

      if (entry.code) {
        history.push(entry.code);
        historyIndex = -1; // newest entry resets traversal
      }

        // Update last command in header
        updateLastCommand(entry.code);

        // Build HTML
        const userHtml = \`
            <div class="user-bubble">
                \${window.stataUI.escapeHtml(entry.code)}
            </div>
        \`;

        let outputContent = '';
        if (entry.stderr) {
            outputContent += \`<div class="output-content error">\${window.stataUI.escapeHtml(entry.stderr)}</div>\`;
        }
        if (entry.stdout) {
            outputContent += '<div class="output-content">' + window.stataUI.escapeHtml(entry.stdout) + '</div>';
        }
        
        const artifactsHtml = renderArtifacts(entry.artifacts, entry.timestamp);

        // System Bubble (Card)
        const systemHtml =
            '<div class="system-bubble">'
            +   '<div class="output-card">'
            +     '<div class="output-header">'
            +       '<div class="flex items-center gap-xs">'
            +         '<span class="' + (entry.success ? 'text-muted' : 'text-error') + '" style="color: ' + (entry.success ? 'var(--accent-success)' : 'var(--accent-error)') + '; font-size:16px;">●</span>'
            +         '<span>Stata Output</span>'
            +       '</div>'
            +       '<div class="flex items-center gap-sm">'
            +         (entry.rc !== null ? ('<span>RC ' + entry.rc + '</span>') : '')
            +         (entry.durationMs ? ('<span>' + window.stataUI.formatDuration(entry.durationMs) + '</span>') : '')
            +       '</div>'
            +     '</div>'
            +     outputContent
            +   '</div>'
            +   artifactsHtml
            + '</div>';

        const div = document.createElement('div');
        div.className = 'message-group entry';
        div.innerHTML = userHtml + systemHtml;
        chatStream.appendChild(div);
        if (autoScrollPinned) scrollToBottom();
    }

    function renderArtifacts(artifacts, id) {
        if (!artifacts || !Array.isArray(artifacts) || artifacts.length === 0) return '';
        const artifactsId = window.stataUI.escapeHtml(String(id || Date.now()));
        const isCollapsed = collapsedArtifacts[artifactsId] === true;

        const tiles = artifacts.map((a, idx) => {
          const label = window.stataUI.escapeHtml(a.label || 'graph');
          const preview = a.dataUri || a.path; // Already converted to data URI by Node.js code
          const canPreview = !!preview && (String(preview).indexOf('data:image/') !== -1);
          
          const error = a.error ? String(a.error) : '';
          const errorHtml = error
              ? '<div class="artifact-tile-error">' + window.stataUI.escapeHtml(error) + '</div>'
              : '';
          const thumbHtml = canPreview
              ? '<img src="' + window.stataUI.escapeHtml(preview) + '" class="artifact-thumb-img" alt="' + label + '">' 
              : '<div class="artifact-thumb-fallback">PDF</div>';

            const tileAttrs = canPreview
                ? ('data-action="preview-graph" data-src="' + window.stataUI.escapeHtml(preview) + '"')
                : 'data-action="open-artifact"';

            return (
                '<div class="artifact-tile" ' + tileAttrs
                + ' data-path="' + window.stataUI.escapeHtml(a.path || '') + '"'
                + ' data-basedir="' + window.stataUI.escapeHtml(a.baseDir || '') + '"'
                + ' data-label="' + label + '"'
                + ' data-index="' + idx + '">' 
                +   '<div class="artifact-thumb">' + thumbHtml + '</div>'
                +   '<div class="artifact-tile-label" title="' + label + '">' + label + '</div>'
                +   errorHtml
                + '</div>'
            );
        }).join('');

        return (
            '<section class="artifacts-card" data-artifacts-id="' + artifactsId + '" data-collapsed="' + (isCollapsed ? 'true' : 'false') + '">' 
            + '<header class="artifacts-header">'
            +   '<div class="artifacts-title">Artifacts</div>'
            +   '<div class="artifacts-header-right">'
            +     '<span class="artifacts-count">' + artifacts.length + '</span>'
            +     '<button class="artifacts-toggle" type="button" data-action="toggle-artifacts" data-artifacts-id="' + artifactsId + '">' + (isCollapsed ? 'Show' : 'Hide') + '</button>'
            +   '</div>'
            + '</header>'
            + '<div class="artifacts-body ' + (isCollapsed ? 'hidden' : '') + '" data-artifacts-body="' + artifactsId + '">' 
            +   '<div class="artifact-gallery">' + tiles + '</div>'
            + '</div>'
            + '</section>'
        );
    }

    const collapsedArtifacts = Object.create(null);

    const modal = document.getElementById('artifact-modal');
    const modalTitle = document.getElementById('artifact-modal-title');
    const modalImg = document.getElementById('artifact-modal-img');
    const modalMeta = document.getElementById('artifact-modal-meta');
    const modalOpenBtn = document.getElementById('artifact-modal-open');
    const modalRevealBtn = document.getElementById('artifact-modal-reveal');
    const modalCopyBtn = document.getElementById('artifact-modal-copy');
    const modalDownloadBtn = document.getElementById('artifact-modal-download');
    let activeModalArtifact = null;

    function openArtifactModal(artifact) {
        activeModalArtifact = artifact;
        if (modalTitle) modalTitle.textContent = artifact.label || 'Graph';
        if (modalImg) {
            modalImg.src = artifact.src || '';
            modalImg.alt = artifact.label || 'Graph';
        }
        if (modalMeta) {
            modalMeta.textContent = artifact.path || '';
        }
        if (modalDownloadBtn) {
            // Enable download button if we have a graph name
            const ok = artifact.label || artifact.name;
            modalDownloadBtn.disabled = !ok;
            modalDownloadBtn.style.opacity = ok ? '1' : '0.6';
        }
        if (modal) {
            modal.classList.remove('hidden');
            modal.setAttribute('aria-hidden', 'false');
        }
    }

    function closeArtifactModal() {
        activeModalArtifact = null;
        if (modal) {
            modal.classList.add('hidden');
            modal.setAttribute('aria-hidden', 'true');
        }
        if (modalImg) modalImg.src = '';
    }

    // Download button handler - requests PDF export and downloads it
    if (modalDownloadBtn) {
        modalDownloadBtn.addEventListener('click', async () => {
            console.log('[Modal] Download button clicked');
            
            if (!activeModalArtifact) {
                console.error('[Modal] No active artifact');
                return;
            }
            
            const graphName = activeModalArtifact.label || activeModalArtifact.name;
            console.log('[Modal] Graph name:', graphName);
            
            if (!graphName) {
                console.error('[Modal] No graph name found');
                return;
            }
            
            try {
                const originalText = modalDownloadBtn.textContent;
                modalDownloadBtn.disabled = true;
                modalDownloadBtn.textContent = 'Downloading...';
                
                console.log('[Modal] Sending download-graph-pdf message:', graphName);
                
                // Request PDF export from the extension
                vscode.postMessage({
                    command: 'download-graph-pdf',
                    graphName: graphName
                });
                
                console.log('[Modal] Message sent successfully');
                
                // Reset button after a delay
                setTimeout(() => {
                    modalDownloadBtn.disabled = false;
                    modalDownloadBtn.textContent = originalText;
                    console.log('[Modal] Button reset');
                }, 3000);
            } catch (err) {
                console.error('[Modal] Download error:', err);
                modalDownloadBtn.disabled = false;
                modalDownloadBtn.textContent = 'Download PDF';
                alert('Download failed: ' + err.message);
            }
        });
    }

    // Close modal on overlay click
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.classList.contains('artifact-modal-overlay')) {
                closeArtifactModal();
            }
        });
    }

    // Close on escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
            closeArtifactModal();
        }
    });

    console.log('[Modal] Modal script loaded, vscode API:', typeof vscode);    

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'cleared') {
          clearAllOutput();
          setBusy(false);
          return;
      }

      if (msg.type === 'init') {
          // Legacy init support if needed, but we prefer embedded
          if (msg.history) msg.history.forEach(appendEntry);
      }
      if (msg.type === 'append') {
        appendEntry(msg.entry);
      }
      if (msg.type === 'busy') setBusy(msg.value);

      if (msg.type === 'datasetSummary') {
        if (dataSummary && obsCount && varCount) {
            if (msg.n === 0 && msg.k === 0) {
                dataSummary.style.display = 'none';
            } else {
                dataSummary.style.display = 'flex';
                obsCount.textContent = (msg.n || 0).toLocaleString();
                varCount.textContent = (msg.k || 0).toLocaleString();
            }
        }
      }

      if (msg.type === 'runStarted') {
        const runId = msg.runId;
        const code = String(msg.code || '');
        ensureRunGroup(runId, code);
      }

      if (msg.type === 'runCancelled') {
        const runId = msg.runId;
        const run = runs[runId];
        if (!run) return;
        if (run.statusDot) run.statusDot.style.color = 'var(--accent-warning)';
        if (run.statusTitle) run.statusTitle.textContent = 'Stata Output (cancelled)';
        if (run.stderrEl) {
            run.stderrEl.style.display = 'block';
            run.stderrEl.textContent = String(msg.message || 'Run cancelled.');
        }
        if (run.progressWrap) {
            if (run.progressText) run.progressText.textContent = '';
            if (run.progressMeta) run.progressMeta.textContent = '';
        }
        if (autoScrollPinned) scrollToBottomSmooth();
      }

      if (msg.type === 'downloadStatus') {
        // Reset modal download button state
        if (modalDownloadBtn) {
          modalDownloadBtn.disabled = false;
          modalDownloadBtn.textContent = 'Download PDF';
        }
        if (!msg.success && msg.message) {
          console.error('[Modal] Download failed:', msg.message);
        }
      }

      if (msg.type === 'runLogAppend') {
        const runId = msg.runId;
        const run = runs[runId];
        if (!run || !run.stdoutEl) return;
        const shouldStick = autoScrollPinned;
        const chunk = String(msg.text ?? '');
        if (!chunk) return;
        run.stdoutEl.textContent += chunk;
        if (shouldStick) scheduleScrollToBottom();
      }

      if (msg.type === 'runProgress') {
        const runId = msg.runId;
        const run = runs[runId];
        if (!run) return;
        const progress = msg.progress;
        const total = msg.total;
        const message = msg.message;
        if (run.progressWrap) run.progressWrap.style.display = 'block';
        if (run.progressText) run.progressText.textContent = message ? String(message) : '';
        let pct = null;
        if (typeof progress === 'number' && typeof total === 'number' && total > 0) {
            pct = Math.max(0, Math.min(100, (progress / total) * 100));
            if (run.progressMeta) run.progressMeta.textContent = String(progress) + '/' + String(total);
        } else if (typeof progress === 'number') {
            if (run.progressMeta) run.progressMeta.textContent = String(progress);
        } else {
            if (run.progressMeta) run.progressMeta.textContent = '';
        }
        if (run.progressFill) {
            run.progressFill.style.width = pct == null ? '0%' : (pct.toFixed(0) + '%');
        }
      }

      if (msg.type === 'runFinished') {
        const runId = msg.runId;
        const run = runs[runId];
        if (!run) return;

        const success = msg.success === true;
        if (run.statusDot) {
            run.statusDot.style.color = success ? 'var(--accent-success)' : 'var(--accent-error)';
        }
        if (run.statusTitle) {
            run.statusTitle.textContent = 'Stata Output';
        }

        if (run.rcEl) {
            run.rcEl.textContent = (msg.rc !== null && msg.rc !== undefined) ? ('RC ' + String(msg.rc)) : '';
        }
        if (run.durationEl) {
            run.durationEl.textContent = msg.durationMs ? window.stataUI.formatDuration(msg.durationMs) : '';
        }

        const stderr = String(msg.stderr || '');
        if (stderr && run.stderrEl) {
            run.stderrEl.style.display = 'block';
            run.stderrEl.textContent = stderr;
        }

        // Only backfill stdout if nothing was streamed (streamed transcript is canonical).
        const finalStdout = String(msg.stdout || '');
        if (finalStdout && run.stdoutEl && !run.stdoutEl.textContent) {
            run.stdoutEl.textContent = finalStdout;
        }

        if (run.progressWrap) {
            // Keep progress visible if it was ever shown, but it is now final.
            if (run.progressText) run.progressText.textContent = '';
            if (run.progressMeta) run.progressMeta.textContent = '';
        }

        const artifactsHtml = renderArtifacts(msg.artifacts, runId);
        if (run.artifactsEl) {
            run.artifactsEl.innerHTML = artifactsHtml;
        }

        if (autoScrollPinned) scrollToBottomSmooth();
      }

      if (msg.type === 'runFailed') {
        const runId = msg.runId;
        const run = runs[runId];
        if (!run) return;
        if (run.statusDot) run.statusDot.style.color = 'var(--accent-error)';
        if (run.statusTitle) run.statusTitle.textContent = 'Stata Output (failed)';
        if (run.stderrEl) {
            run.stderrEl.style.display = 'block';
            run.stderrEl.textContent = String(msg.message || 'Unknown error');
        }

        if (autoScrollPinned) scrollToBottomSmooth();
      }

      if (msg.type === 'variables') {
        variablesPending = false;
        const incoming = Array.isArray(msg.variables) ? msg.variables : [];
        variables.length = 0;
        incoming.forEach((v) => {
            if (typeof v === 'string') {
                variables.push(v);
                return;
            }
            if (v && typeof v === 'object' && v.name) {
                variables.push(v.name);
            }
        });
        lastCompletion = null;
      }

      if (msg.type === 'error') {
        const div = document.createElement('div');
        div.className = 'message-group';
        div.innerHTML = '<div class="system-bubble"><div class="output-content error">' + window.stataUI.escapeHtml(msg.message) + '</div></div>';
        chatStream.appendChild(div);
        setBusy(false);
        const lastGroup = chatStream.lastElementChild;
         if (lastGroup && lastGroup.dataset.optimistic) {
            lastGroup.remove();
        }
      }
    });

    // Render initial entries if any
    try {
        initialEntries.forEach(appendEntry);
        // Notify ready
        vscode.postMessage({ type: 'ready' });
      requestVariables();
    } catch (err) {
        console.error('Failed to render initial entries', err);
        vscode.postMessage({ type: 'log', level: 'error', message: err.message });
    }

    // Dynamic spacer for fixed input area
    const inputArea = document.querySelector('.input-area');
    const spacer = document.createElement('div');
    spacer.id = 'bottom-spacer';
    document.body.appendChild(spacer);

    function updateSpacer() {
        if (inputArea) {
            const height = inputArea.offsetHeight;
            // Height + bottom offset (24px) + buffer (30px)
            spacer.style.height = (height + 15) + 'px';
            spacer.style.width = '100%';
        }
    }
    
    // Update on load, resize, and input change
    updateSpacer();
    // Force scroll to bottom after initial layout
    setTimeout(() => {
        autoScrollPinned = true;
        scrollToBottom();
    }, 50);

    window.addEventListener('scroll', () => {
        autoScrollPinned = isAtBottom();
    }, { passive: true });

    document.addEventListener('click', (e) => {
        const toggle = e.target.closest('[data-action="toggle-artifacts"]');
        if (toggle) {
            const id = toggle.getAttribute('data-artifacts-id');
            if (!id) return;
            const body = document.querySelector('[data-artifacts-body="' + CSS.escape(id) + '"]');
            const card = document.querySelector('[data-artifacts-id="' + CSS.escape(id) + '"]');
            const collapsed = !(collapsedArtifacts[id] === true);
            collapsedArtifacts[id] = collapsed;
            if (body) body.classList.toggle('hidden', collapsed);
            if (card) card.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
            toggle.textContent = collapsed ? 'Show' : 'Hide';
            return;
        }

        const preview = e.target.closest('[data-action="preview-graph"]');
        if (preview) {
            const src = preview.getAttribute('data-src') || '';
            const path = preview.getAttribute('data-path') || '';
            const baseDir = preview.getAttribute('data-basedir') || '';
            const label = preview.getAttribute('data-label') || 'Graph';
            openArtifactModal({ src, path, baseDir, label });
            return;
        }

        const close = e.target.closest('[data-action="close-artifact-modal"]');
        if (close) {
            closeArtifactModal();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
            closeArtifactModal();
        }
    });

    if (modalOpenBtn) {
        modalOpenBtn.addEventListener('click', () => {
            if (!activeModalArtifact) return;
            vscode.postMessage({
                type: 'openArtifact',
                path: activeModalArtifact.path,
                baseDir: activeModalArtifact.baseDir,
                label: activeModalArtifact.label
            });
        });
    }

    if (modalRevealBtn) {
        modalRevealBtn.addEventListener('click', () => {
            if (!activeModalArtifact) return;
            vscode.postMessage({
                type: 'revealArtifact',
                path: activeModalArtifact.path,
                baseDir: activeModalArtifact.baseDir,
                label: activeModalArtifact.label
            });
        });
    }

    if (modalCopyBtn) {
        modalCopyBtn.addEventListener('click', () => {
            if (!activeModalArtifact) return;
            vscode.postMessage({
                type: 'copyArtifactPath',
                path: activeModalArtifact.path,
                baseDir: activeModalArtifact.baseDir,
                label: activeModalArtifact.label
            });
        });
    }

    if (modalDownloadBtn) {
        modalDownloadBtn.addEventListener('click', () => {
            if (!activeModalArtifact) return;
            const graphName = activeModalArtifact.label || activeModalArtifact.name || 'graph';
            vscode.postMessage({
                command: 'download-graph-pdf',
                graphName
            });
        });
    }

    window.addEventListener('resize', () => {
        updateSpacer();
        if (autoScrollPinned) scrollToBottom();
    });
    
    input.addEventListener('input', () => {
        // Allow resize to happen first
        setTimeout(() => {
            updateSpacer();
            if (autoScrollPinned) scrollToBottom(); // Keep bottom visible when typing
        }, 0);
    });
    
    // Also update when content changes
    const observer = new MutationObserver(() => {
        updateSpacer();
    });
    if (inputArea) {
        observer.observe(inputArea, { attributes: true, childList: true, subtree: true });
    }

    function isAtBottom() {
        return (window.innerHeight + window.scrollY) >= document.body.offsetHeight - 50;
    }

    setBusy(false);
    requestVariables();

    function handleTabCompletion() {
      if (!variables.length) {
        requestVariables();
        return false;
      }

      const token = currentToken();
      if (!token) return false;

      const names = variables.filter(Boolean);
      const matches = names.filter((name) => name.toLowerCase().startsWith(token.prefix.toLowerCase()));
      if (!matches.length) return false;

      if (!lastCompletion || lastCompletion.prefix !== token.prefix || lastCompletion.start !== token.start || lastCompletion.end !== token.end) {
        lastCompletion = { prefix: token.prefix, start: token.start, end: token.end, index: 0, matches };
      } else {
        lastCompletion.index = (lastCompletion.index + 1) % matches.length;
      }

      const replacement = matches[lastCompletion.index];
      applyReplacement(token.start, token.end, replacement);
      return true;
    }

    function currentToken() {
      const pos = input.selectionStart;
      if (pos === null || pos === undefined) return null;
      const text = input.value;
      const before = text.slice(0, pos);
      const beforeMatch = before.match(/([A-Za-z0-9_\.]+)$/);
      if (!beforeMatch) return null;
      const prefix = beforeMatch[1];
      const start = pos - prefix.length;
      const after = text.slice(pos);
      const afterMatch = after.match(/^([A-Za-z0-9_\.]+)/);
      const end = pos + (afterMatch ? afterMatch[1].length : 0);
      if (!prefix) return null;
      return { prefix, start, end };
    }

    function applyReplacement(start, end, replacement) {
      const value = input.value;
      input.value = value.slice(0, start) + replacement + value.slice(end);
      const cursor = start + replacement.length;
      input.setSelectionRange(cursor, cursor);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  </script>
</body>
</html>`;
}

function toEntry(code, result) {
  const success = isRunSuccess(result);
  return {
    code,
    stdout: (typeof result?.stdout === 'string') ? result.stdout : (success ? (result?.contentText || '') : ''),
    stderr: result?.stderr || '',
    rc: typeof result?.rc === 'number' ? result.rc : null,
    success,
    durationMs: result?.durationMs ?? null,
    timestamp: Date.now(),
    artifacts: normalizeArtifacts(result),
    baseDir: result?.cwd || (result?.filePath ? path.dirname(result.filePath) : '')
  };
}

/**
 * Normalizes artifact objects for display in the terminal panel.
 * The `previewDataUri` field is generated by the extension (mcp-client) from a local file path
 * to provide a base64 preview for the UI. This base64 data is NOT exposed to AI agents
 * as part of tool outputs, ensuring token efficiency.
 * @param {object} result
 * @returns {Array<object>}
 */
function normalizeArtifacts(result) {
  const preferred = Array.isArray(result?.graphArtifacts)
    ? result.graphArtifacts
    : (result?.artifacts || []);
  if (!Array.isArray(preferred)) return [];
  const normalized = preferred.map((a) => {
    if (!a) return null;
    const label = a.label || path.basename(a.path || '') || 'artifact';
    const dataUri = a.dataUri && typeof a.dataUri === 'string' ? a.dataUri : null;
    const baseDir = a.baseDir || result?.cwd || (result?.filePath ? path.dirname(result.filePath) : null);
    return {
      label,
      path: a.path || a.dataUri || '',
      dataUri,
      previewDataUri: a.previewDataUri || null,
      error: a.error || null,
      baseDir
    };
  }).filter(Boolean);

  const counts = Object.create(null);
  for (const a of normalized) {
    const k = a.label || 'artifact';
    counts[k] = (counts[k] || 0) + 1;
  }

  const seen = Object.create(null);
  for (const a of normalized) {
    const k = a.label || 'artifact';
    if ((counts[k] || 0) > 1) {
      seen[k] = (seen[k] || 0) + 1;
      a.label = k + ' (' + String(seen[k]) + ')';
    }
  }

  return normalized;
}

function isRunSuccess(result) {
  if (!result) return false;
  if (result.success === false) return false;
  if (typeof result.rc === 'number' && result.rc !== 0) return false;
  if (result.error) return false;
  return true;
}

function escapeHtml(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

