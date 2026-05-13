/**
 * Tests for artifact-utils — file resolution, clipboard, opening artifacts.
 *
 * Uses proxyquire to mock @sentry/node, relies on runtime-context defaults
 * for vscode mocking, and creates real temp files when needed.
 */
const { describe, it, beforeEach, afterEach, expect, jest } = require('bun:test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const proxyquire = require('proxyquire').noPreserveCache();
const { setDefaultVscode, setDefaultFs } = require('../../src/runtime-context');

const mockClipboardWriteText = jest.fn().mockResolvedValue(undefined);
const mockExecuteCommand = jest.fn().mockResolvedValue(undefined);
const mockShowErrorMessage = jest.fn().mockResolvedValue(undefined);

const mockVscode = {
    Uri: {
        file: (p) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
        parse: jest.fn((s) => ({ toString: () => s, scheme: s.startsWith('https') ? 'https' : s.startsWith('data:') ? 'data' : 'unknown' })),
    },
    commands: { executeCommand: mockExecuteCommand },
    window: { showErrorMessage: mockShowErrorMessage },
    env: { clipboard: { writeText: mockClipboardWriteText } },
    ViewColumn: { Active: 1 },
    workspace: { workspaceFolders: undefined },
};

// Create a temp file we can use in tests that need "file exists"
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'));
const tmpFilePath = path.join(tmpDir, 'test.do');
fs.writeFileSync(tmpFilePath, 'display "hello"', 'utf8');

describe('artifact-utils', () => {
    let openArtifact, revealArtifact, copyToClipboard, resolveArtifactUri;

    beforeEach(() => {
        jest.clearAllMocks();
        mockVscode.workspace.workspaceFolders = undefined;

        // Set runtime-context defaults BEFORE loading the module
        setDefaultVscode(mockVscode);
        setDefaultFs(fs); // Use real fs

        const mod = proxyquire('../../src/artifact-utils', {
            '@sentry/node': { captureException: jest.fn() },
        });
        openArtifact = mod.openArtifact;
        revealArtifact = mod.revealArtifact;
        copyToClipboard = mod.copyToClipboard;
        resolveArtifactUri = mod.resolveArtifactUri;
    });

    afterEach(() => {
        setDefaultVscode(null);
        setDefaultFs(require('fs'));
    });

    // ==================================================================
    // resolveArtifactUri
    // ==================================================================
    describe('resolveArtifactUri', () => {
        it('returns null for null/undefined input', () => {
            expect(resolveArtifactUri(null)).toBeNull();
            expect(resolveArtifactUri(undefined)).toBeNull();
            expect(resolveArtifactUri('')).toBeNull();
        });

        it('trims whitespace and strips surrounding quotes', () => {
            const result = resolveArtifactUri('  "/path/to/file.do"  ');
            expect(result).toBeDefined();
            expect(result.fsPath).toBe('/path/to/file.do');
        });

        it('resolves absolute paths as file URIs', () => {
            const result = resolveArtifactUri('/absolute/path/file.do');
            expect(result.scheme).toBe('file');
            expect(result.fsPath).toBe('/absolute/path/file.do');
        });

        it('resolves https URLs as parsed URIs', () => {
            const result = resolveArtifactUri('https://example.com/file.pdf');
            expect(result.toString()).toBe('https://example.com/file.pdf');
        });

        it('resolves data URIs', () => {
            const result = resolveArtifactUri('data:image/png;base64,abc');
            expect(result.toString()).toContain('data:');
        });

        it('resolves relative paths using baseDir', () => {
            const result = resolveArtifactUri('relative/file.do', '/base');
            expect(result.scheme).toBe('file');
            expect(result.fsPath).toBe(path.resolve('/base', 'relative/file.do'));
        });

        it('resolves relative paths using workspace root when baseDir not provided', () => {
            mockVscode.workspace.workspaceFolders = [{ uri: { fsPath: '/workspace' } }];

            const result = resolveArtifactUri('relative/file.do');
            // No baseDir, workspace has /workspace, but relative/file.do doesn't exist there
            // Falls back to returning the candidate (first one) as URI
            expect(result).toBeDefined();
            expect(result.scheme).toBe('file');
        });

        it('returns first candidate when baseDir path does not exist and workspace path does', () => {
            // Use a real temp file for the workspace candidate
            mockVscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpDir } }];

            const result = resolveArtifactUri('test.do', '/nonexistent-base');
            // The file exists in tmpDir (workspace) but not in /nonexistent-base
            // Should find the workspace candidate
            expect(result.fsPath.endsWith('test.do')).toBe(true);
            // Should NOT point to /nonexistent-base
            expect(result.fsPath).not.toContain('nonexistent-base');
        });
    });

    // ==================================================================
    // openArtifact
    // ==================================================================
    describe('openArtifact', () => {
        it('calls vscode.open with resolved file URI when file exists', () => {
            openArtifact(tmpFilePath);

            expect(mockExecuteCommand).toHaveBeenCalledWith(
                'vscode.open',
                expect.objectContaining({ fsPath: tmpFilePath }),
                expect.objectContaining({ preview: false })
            );
        });

        it('shows error when file does not exist', () => {
            openArtifact('/path/to/definitely/missing/file.do');

            expect(mockShowErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('Artifact not found')
            );
            expect(mockExecuteCommand).not.toHaveBeenCalled();
        });

        it('shows error when URI cannot be resolved', () => {
            openArtifact(null);

            expect(mockShowErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('Could not resolve artifact')
            );
            expect(mockExecuteCommand).not.toHaveBeenCalled();
        });

        it('opens https URIs directly without file existence check', () => {
            openArtifact('https://example.com/file.pdf');

            expect(mockExecuteCommand).toHaveBeenCalledWith(
                'vscode.open',
                expect.any(Object),
                expect.any(Object)
            );
        });
    });

    // ==================================================================
    // revealArtifact
    // ==================================================================
    describe('revealArtifact', () => {
        it('calls revealFileInOS with resolved file URI', async () => {
            await revealArtifact(tmpFilePath);

            expect(mockExecuteCommand).toHaveBeenCalledWith(
                'revealFileInOS',
                expect.objectContaining({ fsPath: tmpFilePath })
            );
        });

        it('shows error when file does not exist', async () => {
            await revealArtifact('/path/to/definitely/missing/file.do');

            expect(mockShowErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('Artifact not found')
            );
            expect(mockExecuteCommand).not.toHaveBeenCalledWith(
                'revealFileInOS',
                expect.anything()
            );
        });

        it('shows error when URI cannot be resolved', async () => {
            await revealArtifact(null);

            expect(mockShowErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('Could not resolve artifact')
            );
        });
    });

    // ==================================================================
    // copyToClipboard
    // ==================================================================
    describe('copyToClipboard', () => {
        it('writes text to clipboard', async () => {
            await copyToClipboard('hello world');
            expect(mockClipboardWriteText).toHaveBeenCalledWith('hello world');
        });

        it('handles null/undefined by writing empty string', async () => {
            await copyToClipboard(null);
            expect(mockClipboardWriteText).toHaveBeenCalledWith('');

            await copyToClipboard(undefined);
            expect(mockClipboardWriteText).toHaveBeenCalledWith('');
        });

        it('converts non-string values to string', async () => {
            await copyToClipboard(42);
            expect(mockClipboardWriteText).toHaveBeenCalledWith('42');

            await copyToClipboard({ key: 'value' });
            expect(mockClipboardWriteText).toHaveBeenCalledWith('[object Object]');
        });

        it('does not throw when clipboard write fails', async () => {
            mockClipboardWriteText.mockRejectedValueOnce(new Error('clipboard error'));
            await expect(copyToClipboard('test')).resolves.toBeUndefined();
        });
    });
});
