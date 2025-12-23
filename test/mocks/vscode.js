const sinon = require('sinon');

const configuration = {
    get: jest.fn().mockImplementation((key, defaultValue) => {
        if (key === 'requestTimeoutMs') return 1000;
        if (key === 'runFileWorkingDirectory') return '';
        if (key === 'autoRevealOutput') return true;
        return defaultValue;
    })
};

const vscode = {
    workspace: {
        getConfiguration: jest.fn().mockReturnValue(configuration),
        workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }]
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
        createOutputChannel: jest.fn().mockReturnValue({
            appendLine: jest.fn(),
            show: jest.fn(),
            clear: jest.fn()
        }),
        createStatusBarItem: jest.fn().mockReturnValue({
            show: jest.fn(),
            hide: jest.fn(),
            dispose: jest.fn(),
            text: '',
            tooltip: '',
            command: undefined,
            backgroundColor: undefined
        })
    },
    commands: {
        registerCommand: jest.fn(),
        executeCommand: jest.fn().mockResolvedValue(),
        getCommands: jest.fn().mockResolvedValue([])
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
    }
};

module.exports = vscode;
