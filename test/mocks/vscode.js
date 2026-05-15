const sinon = require('sinon');

const createVscodeMock = () => {
    const configuration = {
        get: jest.fn().mockImplementation((key, defaultValue) => {
            if (key === 'requestTimeoutMs') return 1000;
            if (key === 'runFileWorkingDirectory') return '';
            if (key === 'autoRevealOutput') return true;
            return defaultValue;
        })
    };

    const vscode = {
        extensions: {
            getExtension: jest.fn().mockReturnValue({
                isActive: false,
                activate: async function() {
                    this.isActive = true;
                    // Mocked commands that the real extension would register
                    vscode.commands._commands.push('stata-workbench.runSelection');
                    vscode.commands._commands.push('stata-workbench.runFile');
                    vscode.commands._commands.push('stata-workbench.viewData');
                    return this.exports;
                },
                exports: {
                    DataBrowserPanel: { _performRequest: jest.fn(), currentPanel: { dispose: jest.fn() } },
                    TerminalPanel: { 
                        _testOutgoingCapture: null,
                        _handleDownloadGraphPdf: jest.fn()
                    },
                    mcpClient: { getUiChannel: jest.fn() },
                    downloadGraphAsPdf: jest.fn()
                }
            })
        },
        workspace: {
            _configListeners: [],
            getConfiguration: jest.fn().mockReturnValue(configuration),
            onDidChangeConfiguration: jest.fn().mockImplementation((listener) => {
                vscode.workspace._configListeners.push(listener);
                return { dispose: () => { vscode.workspace._configListeners = vscode.workspace._configListeners.filter(l => l !== listener); } };
            }),
            _fireConfigChange: (event) => vscode.workspace._configListeners.forEach(l => l(event)),
            workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
            fs: {
                writeFile: jest.fn().mockResolvedValue(),
                readFile: jest.fn().mockResolvedValue(Buffer.from('')),
                stat: jest.fn().mockResolvedValue({ size: 100 })
            },
            openTextDocument: jest.fn().mockImplementation(async (options) => ({
                getText: () => options?.content || '',
                isDirty: false,
                fileName: '/tmp/test.do',
                save: jest.fn(),
                lineCount: (options?.content || '').split('\n').length,
                lineAt: (i) => ({ text: (options?.content || '').split('\n')[i] || '' }),
                uri: { fsPath: '/tmp/test.do' }
            }))
        },
        window: {
            createWebviewPanel: jest.fn().mockReturnValue({
                onDidDispose: jest.fn(),
                webview: {
                    onDidReceiveMessage: jest.fn(),
                    html: '',
                    cspSource: 'mock-csp-source',
                    postMessage: jest.fn().mockResolvedValue(),
                    asWebviewUri: jest.fn().mockImplementation((uri) => uri)
                },
                reveal: jest.fn()
            }),
            showErrorMessage: jest.fn().mockResolvedValue(),
            showInformationMessage: jest.fn().mockResolvedValue(),
            showTextDocument: jest.fn().mockResolvedValue({
                selection: { isEmpty: false },
                document: {
                    getText: jest.fn().mockReturnValue(''),
                    uri: { fsPath: '/tmp/test.do' }
                }
            }),
            showSaveDialog: jest.fn().mockResolvedValue(undefined),
            createOutputChannel: jest.fn().mockReturnValue({
                append: jest.fn(),
                appendLine: jest.fn(),
                show: jest.fn(),
                clear: jest.fn()
            }),
            createTerminal: jest.fn().mockReturnValue({
                show: jest.fn(),
                sendText: jest.fn(),
                dispose: jest.fn()
            }),
            createStatusBarItem: jest.fn().mockReturnValue({
                show: jest.fn(),
                hide: jest.fn(),
                dispose: jest.fn(),
                text: '',
                tooltip: '',
                command: undefined,
                backgroundColor: undefined
            }),
            withProgress: jest.fn().mockImplementation((_options, task) => task({ isCancellationRequested: false }))
        },
        commands: {
            _commands: [],
            registerCommand: jest.fn().mockImplementation((name, handler) => {
                vscode.commands._commands.push(name);
                if (!vscode.commands[name]) vscode.commands[name] = handler;
                return { dispose: () => { vscode.commands._commands = vscode.commands._commands.filter(c => c !== name); } };
            }),
            executeCommand: jest.fn().mockImplementation(async (name, ...args) => {
                if (vscode.commands[name]) return await vscode.commands[name](...args);
                return Promise.resolve();
            }),
            getCommands: jest.fn().mockImplementation(async () => vscode.commands._commands)
        },
        Uri: {
            file: (path) => ({ fsPath: path, with: () => ({ toString: () => `file://${path}` }), path }),
            parse: jest.fn().mockImplementation((str) => ({ toString: () => str })),
            joinPath: (uri, ...fragments) => {
                const base = uri?.fsPath || uri?.path || uri || '';
                return { fsPath: `${base}/${fragments.join('/')}`, path: `${base}/${fragments.join('/')}` };
            }
        },
        ViewColumn: {
            Beside: 2
        },
        StatusBarAlignment: {
            Right: 1,
            Left: 2
        },
        ProgressLocation: {
            Notification: 1,
            SourceControl: 2,
            Window: 10
        },
        ExtensionMode: {
            Production: 1,
            Development: 2,
            Test: 3
        },
        ThemeColor: function (name) { this.name = name; },
        env: {
            clipboard: {
                writeText: jest.fn().mockResolvedValue()
            },
            appName: 'Visual Studio Code',
            openExternal: jest.fn().mockResolvedValue(true)
        },
        EventEmitter: class {
            constructor() { this._listeners = []; }
            get event() { return (listener) => { this._listeners.push(listener); return { dispose: () => { } }; }; }
            fire(data) { this._listeners.forEach(l => l(data)); }
        },
        CancellationTokenSource: class {
            constructor() {
                this.token = {
                    isCancellationRequested: false,
                    onCancellationRequested: (cb) => {
                        this._listener = cb;
                        return { dispose: () => { this._listener = null; } };
                    }
                };
            }
            cancel() {
                this.token.isCancellationRequested = true;
                if (this._listener) {
                    this._listener();
                }
            }
        },
        Position: class {
            constructor(line, character) { this.line = line; this.character = character; }
        },
        Range: class {
            constructor(start, end) { this.start = start; this.end = end; }
        },
        Selection: class {
            constructor(anchorLine, anchorChar, activeLine, activeChar) {
                this.anchor = { line: anchorLine, character: anchorChar };
                this.active = { line: activeLine, character: activeChar };
            }
        }
    };

    return vscode;
};

const vscode = createVscodeMock();
try {
    const { setDefaultVscode } = require('../../src/runtime-context');
    setDefaultVscode(vscode);
} catch (_err) {
    // Ignore if runtime-context cannot be loaded (unlikely in test env)
}

module.exports = vscode;
module.exports.createVscodeMock = createVscodeMock;
