async function openPdfInline(filePath, baseDir, label) {
  try {
    const uri = resolveArtifactUri(filePath, baseDir);
    if (!uri) {
      vscode.window.showErrorMessage(`Could not resolve PDF: ${filePath}`);
      return;
    }
    await vscode.commands.executeCommand('vscode.open', uri, {
      preview: false,
      viewColumn: RunPanel.currentPanel?.viewColumn ?? vscode.ViewColumn.Beside,
      preserveFocus: false
    });
  } catch (err) {
    vscode.window.showErrorMessage(`Could not open PDF: ${err.message}`);
  }
}
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

class RunPanel {
  static currentPanel = null;
  static extensionUri = null;

  static setExtensionUri(uri) {
    RunPanel.extensionUri = uri;
  }

  static show({ title, result, reveal = true }) {
    const column = vscode.ViewColumn.Beside;
    if (!RunPanel.currentPanel) {
      RunPanel.currentPanel = vscode.window.createWebviewPanel(
        'stataRunOutput',
        'Stata Run Output',
        column,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(RunPanel.extensionUri, 'node_modules'), // for pdfjs
            vscode.Uri.joinPath(RunPanel.extensionUri, 'src', 'ui-shared')
          ]
        }
      );

      RunPanel.currentPanel.onDidDispose(() => {
        RunPanel.currentPanel = null;
      });

      RunPanel.currentPanel.webview.onDidReceiveMessage((message) => {
        if (message?.command === 'openArtifact' && message.path) {
          openArtifact(message.path, message.baseDir);
        }
        if (message?.command === 'openPdfInline' && message.path) {
          openPdfInline(message.path, message.baseDir, message.label || 'Stata PDF');
        }
      });
    }

    const pdfResources = resolvePdfResources(RunPanel.currentPanel.webview, RunPanel.extensionUri);
    const nonce = getNonce();
    RunPanel.currentPanel.title = title || 'Stata Run Output';
    RunPanel.currentPanel.webview.html = renderHtml(result, title, RunPanel.currentPanel.webview, RunPanel.extensionUri, pdfResources, nonce);
    if (reveal) {
      RunPanel.currentPanel.reveal(column);
    }
  }
}

function openArtifact(filePath, baseDir) {
  try {
    const uri = resolveArtifactUri(filePath, baseDir);
    if (!uri) {
      vscode.window.showErrorMessage(`Could not resolve artifact: ${filePath}`);
      return;
    }
    if (uri.scheme === 'file' && uri.fsPath.toLowerCase().endsWith('.pdf')) {
      openPdfInline(uri.fsPath, baseDir, path.basename(uri.fsPath));
      return;
    }
    if (uri.scheme === 'file') {
      const exists = fs.existsSync(uri.fsPath);
      if (!exists) {
        vscode.window.showErrorMessage(`Artifact file not found: ${uri.fsPath}`);
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
  const stripLeadingSlash = trimmed.startsWith('/') && trimmed.indexOf('/', 1) === -1 ? trimmed.slice(1) : trimmed;
  const candidates = [];

  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:')) {
    return vscode.Uri.parse(trimmed);
  }

  // Absolute candidate
  if (path.isAbsolute(trimmed)) candidates.push(trimmed);
  // If absolute-but-filename-only (/file.pdf), try stripping leading slash
  if (path.isAbsolute(trimmed) && stripLeadingSlash) candidates.push(path.join(baseDir || '', stripLeadingSlash));
  // Base dir
  if (baseDir) candidates.push(path.resolve(baseDir, trimmed));
  // Workspace root
  const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (root) candidates.push(path.resolve(root, trimmed));

  for (const c of candidates) {
    if (!c) continue;
    const uri = vscode.Uri.file(c);
    if (fs.existsSync(uri.fsPath)) return uri;
  }

  // Fallback: return first candidate even if missing, so caller can show path
  const fallback = candidates.find(Boolean);
  return fallback ? vscode.Uri.file(fallback) : null;
}

function renderHtml(result, title, webview, extensionUri, pdfResources, nonce) {
  const designUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'design.css'));
  const mainJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'main.js'));

  const success = isRunSuccess(result);
  const badgeClass = success ? 'success' : 'error';
  const badgeText = success ? 'Success' : 'Error';
  const rcText = typeof result?.rc === 'number' ? result.rc : 'n/a';
  const durationText = formatDuration(result?.durationMs);
  const started = result?.startedAt ? formatTimestamp(result.startedAt) : '';
  const command = escapeHtml(result?.command || '');
  const stdout = escapeHtml(result?.stdout || result?.contentText || '');
  const stderr = escapeHtml(result?.stderr || '');

  // Merge artifacts
  const mergedArtifacts = Array.isArray(result?.artifacts) && result.artifacts.length
    ? result.artifacts
    : (Array.isArray(result?.graphArtifacts) ? result.graphArtifacts : []);
  const baseDir = escapeHtml(result?.cwd || (result?.filePath ? path.dirname(result.filePath) : '') || '');

  const artifactsHtml = mergedArtifacts.length
    ? mergedArtifacts.map((entry, idx) => {
      const isObj = entry && typeof entry === 'object';
      const rawPath = isObj ? (entry.dataUri || entry.path) : entry;
      if (!rawPath) return null;
      const displayLabel = isObj ? (entry.label || path.basename(rawPath || '') || `Artifact ${idx + 1}`) : (path.basename(rawPath || '') || `Artifact ${idx + 1}`);
      const label = escapeHtml(displayLabel);
      const full = escapeHtml(rawPath || '');
      const resolvedBase = escapeHtml(isObj ? (entry.baseDir || '') : '');
      const isPdf = rawPath.toLowerCase().endsWith('.pdf') || rawPath.startsWith('data:application/pdf');
      const isInlineImage = rawPath.startsWith('data:image/') || rawPath.match(/\.(png|jpg|jpeg|gif|svg)$/i);

      // Use previewDataUri if available (PNG), otherwise fallback to dataUri or placeholder
      const isImg = (entry.previewDataUri || entry.dataUri) && (entry.previewDataUri || entry.dataUri).startsWith('data:');
      const imgSrc = entry.previewDataUri || entry.dataUri;

      return `
            <div class="artifact-card" data-action="open-artifact" data-path="${full}" data-basedir="${resolvedBase || baseDir}" data-label="${label}" style="cursor:pointer;">
                ${isImg ? `<img src="${imgSrc}" class="artifact-preview">` :
          `<div class="artifact-preview" style="display:flex;align-items:center;justify-content:center;color:var(--fg-secondary);font-size:24px;">📄</div>`}
                <div class="flex items-center gap-sm">
                    <span class="artifact-name">${label}</span>
                </div>
            </div>`;
    }).filter(Boolean).join('')
    : '<div class="text-muted" style="padding: var(--space-sm);">No artifacts generated.</div>';

  return `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}' ${webview.cspSource} https:; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource} https:; worker-src ${webview.cspSource} https: blob:; connect-src ${webview.cspSource} https:;">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <link rel="stylesheet" href="${designUri}">
                <title>Stata Run Output</title>
                <style>
                  body {
                    padding: var(--space-lg);
                  max-width: 1000px;
                  margin: 0 auto;
    }
                  .header {
                    display: flex;
                  align-items: flex-start;
                  justify-content: space-between;
                  margin-bottom: var(--space-xl);
                  padding-bottom: var(--space-md);
                  border-bottom: 1px solid var(--border-subtle);
    }
                  .header-main {
                    display: flex;
                  flex-direction: column;
                  gap: var(--space-xs);
    }
                  .header-meta {
                    text - align: right;
                  font-size: 11px;
                  color: var(--fg-secondary);
                  display: flex;
                  flex-direction: column;
                  gap: 2px;
    }
                  .command-display {
                    font - family: var(--font-mono);
                  background: var(--bg-secondary);
                  padding: 4px 8px;
                  border-radius: var(--radius-sm);
                  margin-top: var(--space-sm);
                  display: inline-block;
                  font-size: 12px;
    }
                </style>
              </head>
              <body>

                <header class="header">
                  <div class="header-main">
                    <div class="flex items-center gap-md">
                      <span style="font-size: 16px; font-weight: 600;">Run Result</span>
                      <span class="badge ${badgeClass}"><div class="badge-dot"></div>${badgeText}</span>
                    </div>
                    ${command ? `<div class="command-display">${command}</div>` : ''}
                  </div>
                  <div class="header-meta">
                    <div>Return Code: ${rcText}</div>
                    ${durationText ? `<div>Duration: ${durationText}</div>` : ''}
                    ${started ? `<div>${started}</div>` : ''}
                  </div>
                </header>

                <main>
                  ${stderr ? `
        <div style="margin-bottom: var(--space-lg);">
            <div class="text-sm font-medium" style="color:var(--error-color); margin-bottom:var(--space-sm);">Stderr</div>
            <div class="code-block" style="border-color:var(--error-color); background: rgba(248, 113, 113, 0.05); color:var(--error-color);">
                <pre style="margin:0; white-space:pre-wrap;">${stderr}</pre>
            </div>
        </div>
    ` : ''}

                  <div style="margin-bottom: var(--space-lg);">
                    <div class="text-sm text-muted font-medium" style="margin-bottom:var(--space-sm);">Stdout</div>
                    <div class="code-block" style="min-height: 100px;">
                      <pre style="margin:0; white-space:pre-wrap;">${stdout || 'No output'}</pre>
                    </div>
                  </div>

                  <div>
                    <div class="text-sm text-muted font-medium" style="margin-bottom:var(--space-sm);">Artifacts</div>
                    <div class="artifact-grid">
                      ${artifactsHtml}
                    </div>
                  </div>
                </main>

                <script src="${mainJsUri}"></script>
                <script nonce="${nonce}">
                  const vscode = acquireVsCodeApi();
                  window.stataUI.bindArtifactEvents(vscode);

                // Pdf inline support specifically for this panel if needed via main.js event delegation?
                // main.js handles generic openArtifact. 
                // If we want specific PDF handling we can add listener here or trust extension side to handle 'openArtifact' 
                // which delegates to openPdfInline if pdf.
                // In this file, openArtifact calls openPdfInline if extension is .pdf
                // So main.js sending 'openArtifact' message to extension is fine! The extension (RunPanel class) listens for it.
                </script>
              </body>
            </html>`;
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

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '';
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds - minutes * 60;
  return `${minutes}m ${rem.toFixed(0)}s`;
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

module.exports = { RunPanel, renderHtml };

// Keep the pdf resolver for potential future usage or other Webviews
function resolvePdfResources(webview, extensionUri) {
  if (!extensionUri) return {};
  try {
    // Use non-minified UMD build to ensure window.pdfjsLib is defined (pdfjs-dist v5+).
    const libUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js')).toString();
    const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.js')).toString();
    return { libUri, workerUri };
  } catch (err) {
    console.error('Failed to resolve pdfjs resources', err);
    return {};
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}


