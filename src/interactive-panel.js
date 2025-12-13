const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

class InteractivePanel {
  static currentPanel = null;
  static extensionUri = null;

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
        if (message.type === 'run' && typeof message.code === 'string') {
          await InteractivePanel.handleRun(message.code, runCommand);
        }
        if (message.type === 'openArtifact' && message.path) {
          openArtifact(message.path, message.baseDir);
        }
      });
    }

    const webview = InteractivePanel.currentPanel.webview;
    const nonce = getNonce();
    InteractivePanel.currentPanel.webview.html = renderHtml(webview, InteractivePanel.extensionUri, nonce, filePath);
    InteractivePanel.currentPanel.reveal(column);

    const history = [];
    if (initialCode && initialResult) {
      history.push(toEntry(initialCode, initialResult));
    }

    webview.postMessage({
      type: 'init',
      filePath: filePath || '',
      history
    });
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
}

module.exports = { InteractivePanel, toEntry, normalizeArtifacts };

function renderHtml(webview, extensionUri, nonce, filePath) {
  const designUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'design.css'));
  const mainJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'main.js'));
  const fileName = filePath ? path.basename(filePath) : 'Interactive Session';
  const escapedTitle = escapeHtml(fileName);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${designUri}">
  <title>Stata Interactive</title>
  <style>
    /* Panel Specific Overrides */
    body {
      padding-bottom: 80px; /* Space for fixed input */
    }
    .history-stream {
      display: flex;
      flex-direction: column;
      gap: var(--space-lg);
      padding: var(--space-md);
      max-width: 900px;
      margin: 0 auto;
      width: 100%;
    }
    
    .entry {
      opacity: 0;
      animation: slideUp 0.2s ease-out forwards;
    }

    .entry-header {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      margin-bottom: var(--space-xs);
    }
    
    .input-area {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: var(--bg-primary);
      border-top: 1px solid var(--border-subtle);
      padding: var(--space-md);
      z-index: 100;
      backdrop-filter: blur(10px);
    }
    
    .input-container {
      max-width: 900px;
      margin: 0 auto;
      display: flex;
      gap: var(--space-sm);
      position: relative;
    }
    
    #command-input {
      min-height: 48px;
      padding-right: 80px; /* Space for run button if we want inside, but here we keep outside */
      box-shadow: 0 -4px 12px rgba(0,0,0,0.05);
    }

    .timestamp {
      font-size: 11px;
      color: var(--fg-secondary);
      margin-left: auto;
    }

    .execution-info {
        display: flex;
        gap: 8px;
        align-items: center;
        font-size: 11px;
        color: var(--fg-secondary);
    }
  </style>
</head>
<body>
  
  <main class="history-stream" id="history">
    <!-- Entries injected here -->
    <div style="text-align: center; color: var(--fg-secondary); margin-top: 40px; margin-bottom: 20px;">
        <div style="font-weight: 500; margin-bottom: 8px;">Stata Interactive</div>
        <div style="font-size: 12px;">Session connected to ${escapedTitle}</div>
    </div>
  </main>

  <footer class="input-area">
    <div class="input-container">
      <textarea id="command-input" placeholder="Enter Stata command (e.g., summarize price)..." rows="1"></textarea>
      <button id="run-btn" class="btn">
        <span>Run</span>
      </button>
    </div>
  </footer>

  <script src="${mainJsUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const historyContainer = document.getElementById('history');
    const input = document.getElementById('command-input');
    const runBtn = document.getElementById('run-btn');
    
    let busy = false;

    // Auto-resize textarea
    input.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = (this.scrollHeight) + 'px';
      if (this.value === '') this.style.height = 'auto';
    });

    // Handle Enter to run
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            doRun();
        }
    });

    runBtn.addEventListener('click', doRun);

    // Bind shared artifact events
    window.stataUI.bindArtifactEvents(vscode);

    function doRun() {
        if (busy) return;
        const code = input.value.trim();
        if (!code) return;
        
        vscode.postMessage({ type: 'run', code });
        input.value = '';
        input.style.height = 'auto';
    }

    function setBusy(value) {
        busy = value;
        runBtn.disabled = value;
        runBtn.textContent = value ? 'Running...' : 'Run';
        runBtn.style.opacity = value ? 0.7 : 1;
        input.disabled = value;
        if (!value) input.focus();
    }

    function appendEntry(entry) {
        const div = document.createElement('div');
        div.className = 'entry';
        
        const success = entry.success;
        const badgeClass = success ? 'success' : 'error';
        const badgeText = success ? 'Success' : 'Error';
        const rc = entry.rc !== null ? \`RC: \${entry.rc}\` : '';
        const dur = window.stataUI.formatDuration(entry.durationMs);

        // Code block
        const codeHtml = \`
            <div class="code-block" style="margin-bottom: var(--space-sm);">
                <code>\${window.stataUI.escapeHtml(entry.code)}</code>
            </div>
        \`;

        // Output block
        let outputHtml = '';
        if (entry.stdout) {
            outputHtml += \`
                <div style="margin-top: 8px;">
                     <div class="text-sm text-muted font-medium" style="margin-bottom:4px;">Output</div>
                     <div class="code-block" style="background:transparent; border:none; padding:0; color: var(--fg-primary);">
                        <pre style="margin:0; white-space:pre-wrap;">\${window.stataUI.escapeHtml(entry.stdout)}</pre>
                     </div>
                </div>
            \`;
        }
        if (entry.stderr) {
            outputHtml += \`
                <div style="margin-top: 8px;">
                     <div class="text-sm font-medium" style="color:var(--error-color); margin-bottom:4px;">Error</div>
                     <div class="code-block" style="border-color:var(--error-color); background: rgba(248, 113, 113, 0.05);">
                        <pre style="margin:0; white-space:pre-wrap; color:var(--error-color);">\${window.stataUI.escapeHtml(entry.stderr)}</pre>
                     </div>
                </div>
            \`;
        }

        // Artifacts
        let artifactsHtml = '';
        if (entry.artifacts && entry.artifacts.length > 0) {
            const items = entry.artifacts.map(a => {
                const label = window.stataUI.escapeHtml(a.label);
                const isImg = (a.previewDataUri || a.dataUri) && (a.previewDataUri || a.dataUri).startsWith('data:');
                const imgSrc = a.previewDataUri || a.dataUri;
                return \`
                    <div class="artifact-card" data-action="open-artifact" data-path="\${window.stataUI.escapeHtml(a.path)}" data-basedir="\${window.stataUI.escapeHtml(a.baseDir)}" data-label="\${label}" style="cursor:pointer;">
                        \${isImg ? \`<img src="\${imgSrc}" class="artifact-preview">\` : ''}
                        <div class="flex items-center gap-sm">
                            <span class="artifact-name">\${label}</span>
                            <span class="badge" style="margin-left:auto; font-size:9px;">OPEN</span>
                        </div>
                    </div>
                \`;
            }).join('');
            artifactsHtml = \`<div class="artifact-grid">\${items}</div>\`;
        }

        div.innerHTML = \`
            <div class="entry-header">
                <span class="badge \${badgeClass}"><div class="badge-dot"></div>\${badgeText}</span>
                <div class="execution-info">
                    \${rc ? \`<span>\${rc}</span>\` : ''}
                    \${dur ? \`<span>\${dur}</span>\` : ''}
                </div>
                <div class="timestamp">\${window.stataUI.formatTimestamp(entry.timestamp)}</div>
            </div>
            \${codeHtml}
            \${outputHtml}
            \${artifactsHtml}
        \`;

  historyContainer.appendChild(div);

  // Scroll to bottom
  window.scrollTo(0, document.body.scrollHeight);
}

window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.type === 'init') {
    if (msg.history) msg.history.forEach(appendEntry);
    if (!msg.history || msg.history.length === 0) input.focus();
  }
  if (msg.type === 'append') {
    appendEntry(msg.entry);
  }
  if (msg.type === 'busy') setBusy(msg.value);

  if (msg.type === 'error') {
    const div = document.createElement('div');
    div.className = 'entry';
    div.innerHTML = \`<div class="code-block" style="border-color:var(--error-color); color:var(--error-color);">\${window.stataUI.escapeHtml(msg.message)}</div>\`;
            historyContainer.appendChild(div);
            setBusy(false);
        }
    });

    // Notify ready
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

function openArtifact(raw, baseDir) {
  try {
    const uri = resolveArtifactUri(raw, baseDir);
    if (!uri) {
      vscode.window.showErrorMessage(`Could not resolve artifact: ${raw}`);
      return;
    }
    if (uri.scheme === 'file') {
      const exists = fs.existsSync(uri.fsPath);
      if (!exists) {
        vscode.window.showErrorMessage(`Artifact not found: ${uri.fsPath}`);
        return;
      }
    }
    vscode.env.openExternal(uri);
  } catch (err) {
    vscode.window.showErrorMessage(`Could not open artifact: ${err.message}`);
  }
}

function resolveArtifactUri(raw, baseDir) {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^"+|"+$/g, '');
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:')) {
    return vscode.Uri.parse(trimmed);
  }
  if (path.isAbsolute(trimmed)) {
    return vscode.Uri.file(trimmed);
  }
  const candidates = [];
  if (baseDir) candidates.push(path.resolve(baseDir, trimmed));
  const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (root) candidates.push(path.resolve(root, trimmed));
  const found = candidates.find((c) => c && fs.existsSync(c));
  return found ? vscode.Uri.file(found) : (candidates[0] ? vscode.Uri.file(candidates[0]) : null);
}

