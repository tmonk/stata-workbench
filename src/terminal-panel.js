const { openArtifact } = require('./artifact-utils');
const path = require('path');
const vscode = require('vscode');

class TerminalPanel {
  static currentPanel = null;
  static extensionUri = null;
  static _testCapture = null;
  static variableProvider = null;

  static setExtensionUri(uri) {
    TerminalPanel.extensionUri = uri;
  }


  /**
  * Show (or reveal) the terminal panel and seed it with an initial entry.
   * @param {Object} options
   * @param {string} options.filePath
   * @param {string} options.initialCode
   * @param {object} options.initialResult
   * @param {(code: string) => Promise<object>} options.runCommand
   */
  static show({ filePath, initialCode, initialResult, runCommand, variableProvider }) {
    const column = vscode.ViewColumn.Beside;
    if (typeof variableProvider === 'function') {
      TerminalPanel.variableProvider = variableProvider;
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
      });

      TerminalPanel.currentPanel.webview.onDidReceiveMessage(async (message) => {
        if (!message || typeof message !== 'object') return;

        // Test hook
        if (TerminalPanel._testCapture) {
          TerminalPanel._testCapture(message);
        }

        if (message.type === 'run' && typeof message.code === 'string') {
          await TerminalPanel.handleRun(message.code, runCommand);
        }
        if (message.type === 'openArtifact' && message.path) {
          openArtifact(message.path, message.baseDir);
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
    }

    const webview = TerminalPanel.currentPanel.webview;
    const nonce = getNonce();

    // Convert initial data to history entry format for embedding
    const initialHistory = (initialCode && initialResult)
      ? [toEntry(initialCode, initialResult)]
      : [];

    TerminalPanel.currentPanel.webview.html = renderHtml(webview, TerminalPanel.extensionUri, nonce, filePath, initialHistory);
    TerminalPanel.currentPanel.reveal(column);



  }

  static async handleRun(code, runCommand) {
    if (!TerminalPanel.currentPanel) return;
    const webview = TerminalPanel.currentPanel.webview;
    const trimmed = (code || '').trim();
    if (!trimmed) return;

    webview.postMessage({ type: 'busy', value: true });
    try {
      const result = await runCommand(trimmed);
      webview.postMessage({
        type: 'append',
        entry: toEntry(trimmed, result)
      });
    } catch (error) {
      webview.postMessage({
        type: 'error',
        message: error?.message || String(error)
      });
    } finally {
      webview.postMessage({ type: 'busy', value: false });
    }
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
      TerminalPanel.show({
        filePath,
        initialCode: code,
        initialResult: result,
        runCommand: runCommand || (async () => { throw new Error('Session not fully initialized'); }),
        variableProvider: variableProvider || TerminalPanel.variableProvider
      });
      return;
    }

    // Panel exists, just append
    const webview = TerminalPanel.currentPanel.webview;
    webview.postMessage({
      type: 'append',
      entry: toEntry(code, result)
    });

    // Explicitly reveal it
    TerminalPanel.currentPanel.reveal(vscode.ViewColumn.Beside);
  }

}

module.exports = { TerminalPanel, toEntry, normalizeArtifacts };

function renderHtml(webview, extensionUri, nonce, filePath, initialEntries = []) {
  const designUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'design.css'));
  const mainJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'main.js'));
  const fileName = filePath ? path.basename(filePath) : 'Terminal Session';
  const escapedTitle = escapeHtml(fileName);
  const initialJson = JSON.stringify(initialEntries).replace(/</g, '\\u003c'); // Safe JSON embedding

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${designUri}">
  <title>Stata Terminal</title>
  <script nonce="${nonce}">
    window.initialEntries = ${initialJson};
  </script>
</head>
<body>

  <!-- Context Header -->
  <div class="context-header" id="context-header">
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
  </div>

  <main class="chat-stream" id="chat-stream">
    <!-- Entries injected here -->
  </main>

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
        <button id="run-btn" class="btn btn-primary btn-sm">
          <span>Run</span>
        </button>
      </div>
    </div>
  </footer>

  <script src="${mainJsUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    
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
    
    // Initial history embedded from server
    const initialEntries = window.initialEntries || [];
    const history = [];
    let historyIndex = -1; // -1 means not currently traversing history
    const variables = [];
    let variablesPending = false;
    let lastCompletion = null;

    let busy = false;

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

    // Bind shared artifact events (delegated)
    window.stataUI.bindArtifactEvents(vscode);

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

      // Optimistically append user message
      appendUserMessage(code);

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
        runBtn.disabled = value;
        runBtn.style.opacity = value ? 0.7 : 1;
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
        scrollToBottom();
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
            outputContent += \`<div class="output-content">\${window.stataUI.escapeHtml(entry.stdout)}</div>\`;
        }
        
        // Artifacts
        let artifactsHtml = '';
        if (entry.artifacts && entry.artifacts.length > 0) {
            const items = entry.artifacts.map(a => {
                const label = window.stataUI.escapeHtml(a.label);
                const isImg = (a.previewDataUri || a.dataUri) && (a.previewDataUri || a.dataUri).startsWith('data:');
                const imgSrc = a.previewDataUri || a.dataUri;
                const icon = isImg ? \`<img src="\${imgSrc}" style="width:100%; height:100%; object-fit:cover; border-radius:4px;">\` : '<span style="font-size:16px;">📄</span>';
                
                return \`
                    <div class="artifact-card" data-action="open-artifact" data-path="\${window.stataUI.escapeHtml(a.path)}" data-basedir="\${window.stataUI.escapeHtml(a.baseDir)}" data-label="\${label}">
                        <div class="artifact-icon">
                            \${icon}
                        </div>
                        <div class="artifact-info">
                            <div class="artifact-name">\${label}</div>
                            <div class="artifact-meta">Click to open</div>
                        </div>
                    </div>
                \`;
            }).join('');
            artifactsHtml = \`<div class="artifact-grid">\${items}</div>\`;
        }

        // System Bubble (Card)
        const systemHtml = \`
            <div class="system-bubble">
               <div class="output-card">
                  <div class="output-header">
                      <div class="flex items-center gap-xs">
                        <span class="\${entry.success ? 'text-muted' : 'text-error'}" style="color: \${entry.success ? 'var(--accent-success)' : 'var(--accent-error)'}; font-size:16px;">●</span>
                        <span>Stata Output</span>
                      </div>
                      <div class="flex items-center gap-sm">
                         \${entry.rc !== null ? \`<span>RC \${entry.rc}</span>\` : ''}
                         \${entry.durationMs ? \`<span>\${window.stataUI.formatDuration(entry.durationMs)}</span>\` : ''}
                      </div>
                  </div>
                  \${outputContent}
               </div>
               \${artifactsHtml}
            </div>
        \`;

        const div = document.createElement('div');
        div.className = 'message-group entry';
        div.innerHTML = userHtml + systemHtml;
        chatStream.appendChild(div);
        scrollToBottom();
    }

    function scrollToBottom() {
        window.scrollTo(0, document.body.scrollHeight);
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'init') {
          // Legacy init support if needed, but we prefer embedded
          if (msg.history) msg.history.forEach(appendEntry);
      }
      if (msg.type === 'append') {
        appendEntry(msg.entry);
      }
      if (msg.type === 'busy') setBusy(msg.value);

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
        div.innerHTML = \`<div class="system-bubble"><div class="output-content error">\${window.stataUI.escapeHtml(msg.message)}</div></div>\`;
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
    setTimeout(scrollToBottom, 50);

    window.addEventListener('resize', () => {
        updateSpacer();
        if (isAtBottom()) scrollToBottom();
    });
    
    input.addEventListener('input', () => {
        // Allow resize to happen first
        setTimeout(() => {
            updateSpacer();
            scrollToBottom(); // Keep bottom visible when typing
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
  return {
    code,
    stdout: (typeof result?.stdout === 'string') ? result.stdout : (result?.contentText || ''),
    stderr: result?.stderr || '',
    rc: typeof result?.rc === 'number' ? result.rc : null,
    success: isRunSuccess(result),
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
  const artifacts = result?.artifacts || result?.graphArtifacts || [];
  if (!Array.isArray(artifacts)) return [];
  return artifacts.map((a) => {
    if (!a) return null;
    const label = a.label || path.basename(a.path || '') || 'artifact';
    const dataUri = a.dataUri && typeof a.dataUri === 'string' ? a.dataUri : null;
    const baseDir = a.baseDir || result?.cwd || (result?.filePath ? path.dirname(result.filePath) : null);
    return {
      label,
      path: a.path || a.dataUri || '',
      dataUri,
      previewDataUri: a.previewDataUri || null,
      baseDir
    };
  }).filter(Boolean);
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

