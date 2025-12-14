const vscode = require('vscode');

function renderDataHtml(table, webview, extensionUri) {
    const designUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'design.css'));
    const columns = table?.columns || [];
    const data = table?.dataRows || [];
    const rows = table?.count || 0;
    const header = columns.map(c => `<th>${escapeHtml(c)}</th>`).join('');
    const body = data.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(String(cell ?? '.'))}</td>`).join('')}</tr>`).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="${designUri}">
  <title>Stata Data</title>
  <style>
    body { padding: var(--space-md); }
    table { width: 100%; border-collapse: separate; border-spacing: 0; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); overflow: hidden; }
    th, td { padding: 8px 12px; border-bottom: 1px solid var(--border-subtle); border-right: 1px solid var(--border-subtle); font-family: var(--font-mono); font-size: 12px; }
    th { background: var(--bg-secondary); font-weight: 600; position: sticky; top: 0; }
    tr:last-child td { border-bottom: none; }
    tr:nth-child(even) { background: rgba(255,255,255,0.01); }
    td:last-child, th:last-child { border-right: none; }
    .meta-bar { margin-bottom: var(--space-md); display: flex; justify-content: space-between; align-items: center; }
  </style>
</head>
<body>
  <div class="meta-bar">
    <span class="badge" style="font-weight:normal;">${rows} observations</span>
  </div>
  <div style="overflow-x: auto; border-radius: var(--radius-md); border: 1px solid var(--border-subtle);">
    <table style="border:none;">
        <thead><tr>${header}</tr></thead>
        <tbody>${body}</tbody>
    </table>
  </div>
</body></html>`;
}

function renderGraphHtml(graphDetails, webview, extensionUri) {
    const designUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'design.css'));
    const mainJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'main.js'));
    const items = Array.isArray(graphDetails) ? graphDetails : [];

    // Use artifact-card style for graphs
    const blocks = items.map(g => {
        const name = escapeHtml(g.name || 'graph');
        const resolved = g.previewDataUri ? escapeHtml(g.previewDataUri) : (g.dataUri ? escapeHtml(g.dataUri) : '');
        const error = g.error ? `<div class="code-block" style="color:var(--error-color);border-color:var(--error-color);">Error: ${escapeHtml(g.error)}</div>` : '';
        const image = resolved
            ? `<div class="artifact-preview" style="height:auto; min-height:200px; background:transparent; border:none;">
                 <img src="${resolved}" alt="${name}" style="max-width:100%; border-radius:var(--radius-sm); border:1px solid var(--border-subtle);">
               </div>`
            : '<div class="text-muted p-4">No image data</div>';

        // NOTE: We added 'data-action', 'data-path' etc to make it clickable
        const path = g.dataUri || g.path || '';
        const displayPath = escapeHtml(path);

        return `<div class="artifact-card" data-action="open-artifact" data-path="${displayPath}" data-label="${name}" style="cursor:pointer;">
          <div class="flex justify-between items-center" style="margin-bottom:var(--space-sm);">
             <span class="font-medium">${name}</span>
          </div>
          ${image}
          ${error}
        </div>`;
    }).join('') || '<div class="text-muted">No graphs available</div>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="${designUri}">
  <title>Stata Graphs</title>
  <style>
    body { padding: var(--space-md); }
    .artifact-grid { display: grid; grid-template-columns: 1fr; gap: var(--space-md); }
  </style>
</head>
<body>
  <div class="header" style="margin-bottom:var(--space-md);">
     <span class="font-bold" style="font-size:16px;">Stata Graphs</span>
  </div>
  <div class="artifact-grid">
    ${blocks}
  </div>
  <script src="${mainJsUri}"></script>
  <script>
     const vscode = acquireVsCodeApi();
     window.stataUI.bindArtifactEvents(vscode);
  </script>
</body></html>`;
}

function escapeHtml(text) {
    return (text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

module.exports = {
    renderDataHtml,
    renderGraphHtml,
    escapeHtml
};
