const { openArtifact } = require('./artifact-utils');
const path = require('path');
const vscode = require('vscode');

class InteractivePanel {
  static currentPanel = null;
  static extensionUri = null;
  static _testCapture = null;

  static setExtensionUri(uri) {
    InteractivePanel.extensionUri = uri;
  }


  /**
   * Show (or reveal) the interactive panel and seed it with an initial entry.
   * @param {Object} options
   * @param {string} options.filePath
   * @param {string} options.initialCode
   * @param {object} options.initialResult
   * @param {(code: string) => Promise<object>} options.runCommand
   */
  static show({ filePath, initialCode, initialResult, runCommand }) {
    const column = vscode.ViewColumn.Beside;
    if (!InteractivePanel.currentPanel) {
      InteractivePanel.currentPanel = vscode.window.createWebviewPanel(
        'stataInteractive',
        'Stata Interactive',
        column,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(InteractivePanel.extensionUri, 'src', 'ui-shared')
          ]
        }
      );

      InteractivePanel.currentPanel.onDidDispose(() => {
        InteractivePanel.currentPanel = null;
      });

      InteractivePanel.currentPanel.webview.onDidReceiveMessage(async (message) => {
        if (!message || typeof message !== 'object') return;

        // Test hook
        if (InteractivePanel._testCapture) {
          InteractivePanel._testCapture(message);
        }

        if (message.type === 'run' && typeof message.code === 'string') {
          await InteractivePanel.handleRun(message.code, runCommand);
        }
        if (message.type === 'openArtifact' && message.path) {
          openArtifact(message.path, message.baseDir);
        }
        if (message.type === 'log') {
          console.log(`[Client Log] ${message.level || 'info'}: ${message.message}`);
        }
      });
    }

    const webview = InteractivePanel.currentPanel.webview;
    const nonce = getNonce();

    // Convert initial data to history entry format for embedding
    const initialHistory = (initialCode && initialResult)
      ? [toEntry(initialCode, initialResult)]
      : [];

    InteractivePanel.currentPanel.webview.html = renderHtml(webview, InteractivePanel.extensionUri, nonce, filePath, initialHistory);
    InteractivePanel.currentPanel.reveal(column);



  }

  static async handleRun(code, runCommand) {
    if (!InteractivePanel.currentPanel) return;
    const webview = InteractivePanel.currentPanel.webview;
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
   * Appends an entry to the interactive panel, showing it if necessary.
   * @param {string} code
   * @param {object} result
   * @param {string} [filePath] - associated file path to update title if needed
   * @param {(code: string) => Promise<object>} [runCommand] - command runner if panel needs initialization
   */
  static addEntry(code, result, filePath, runCommand) {
    if (!InteractivePanel.currentPanel) {
      // If panel not open, open it with this as initial state
      InteractivePanel.show({
        filePath,
        initialCode: code,
        initialResult: result,
        runCommand: runCommand || (async () => { throw new Error('Session not fully initialized'); })
      });
      return;
    }

    // Panel exists, just append
    const webview = InteractivePanel.currentPanel.webview;
    webview.postMessage({
      type: 'append',
      entry: toEntry(code, result)
    });

    // Explicitly reveal it
    InteractivePanel.currentPanel.reveal(vscode.ViewColumn.Beside);
  }

}

module.exports = { InteractivePanel, toEntry, normalizeArtifacts };

function renderHtml(webview, extensionUri, nonce, filePath, initialEntries = []) {
  const designUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'design.css'));
  const mainJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'main.js'));
  const fileName = filePath ? path.basename(filePath) : 'Interactive Session';
  const escapedTitle = escapeHtml(fileName);
  const initialJson = JSON.stringify(initialEntries).replace(/</g, '\\u003c'); // Safe JSON embedding

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${designUri}">
  <title>Stata Interactive</title>
  <script nonce="${nonce}">
    window.initialEntries = ${initialJson};
  </script>
</head>
<body>
  
  <main class="chat-stream" id="chat-stream">
    <!-- Entries injected here -->
  </main>

  <!-- Floating Input Area -->
  <footer class="input-area">
    <div class="input-container">
      <textarea id="command-input" placeholder="Run Stata command..." rows="1" autofocus></textarea>
      <div class="input-footer">
        <div class="key-hint">
          <span class="kbd">Enter</span> <span>to run</span>
          <span class="kbd" style="margin-left: 6px;">Shift + Enter</span> <span>newline</span>
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

    let busy = false;

    // ... (rest of the listeners) ...

    // Auto-resize textarea
    input.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 200) + 'px';
      if (this.value === '') this.style.height = 'auto';
    });

    // Handle keys
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            doRun();
        }
    });

    runBtn.addEventListener('click', doRun);

    // Bind shared artifact events (delegated)
    window.stataUI.bindArtifactEvents(vscode);

    function doRun() {
        if (busy) return;
        const code = input.value.trim();
        if (!code) return;
        
        vscode.postMessage({ type: 'run', code });
        
        // Optimistically append user message
        appendUserMessage(code);
        
        input.value = '';
        input.style.height = 'auto';
        input.focus();
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

