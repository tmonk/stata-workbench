const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

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
        // Open in VS Code tab instead of external app
        // Open in VS Code tab instead of external app
        vscode.commands.executeCommand('vscode.open', uri, {
            preview: false,
            viewColumn: vscode.ViewColumn.Active
        });
    } catch (err) {
        vscode.window.showErrorMessage(`Could not open artifact: ${err.message}`);
    }
}

async function revealArtifact(raw, baseDir) {
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
        await vscode.commands.executeCommand('revealFileInOS', uri);
    } catch (err) {
        vscode.window.showErrorMessage(`Could not reveal artifact: ${err.message}`);
    }
}

async function copyToClipboard(text) {
    try {
        await vscode.env.clipboard.writeText(String(text ?? ''));
    } catch (err) {
        vscode.window.showErrorMessage(`Could not copy to clipboard: ${err.message}`);
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

module.exports = {
    openArtifact,
    revealArtifact,
    copyToClipboard,
    resolveArtifactUri
};
