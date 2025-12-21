const sinon = require('sinon');

const configuration = {
    get: sinon.stub().callsFake((key, defaultValue) => {
        if (key === 'requestTimeoutMs') return 1000;
        if (key === 'runFileWorkingDirectory') return '';
        if (key === 'autoRevealOutput') return true;
        return defaultValue;
    })
};

const vscode = {
    workspace: {
        getConfiguration: sinon.stub().returns(configuration),
        workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }]
    },
    window: {
        createWebviewPanel: sinon.stub().returns({
            onDidDispose: sinon.stub(),
            webview: {
                onDidReceiveMessage: sinon.stub(),
                html: '',
                cspSource: 'mock-csp-source',
                postMessage: sinon.stub().resolves(),
                asWebviewUri: sinon.stub().callsFake((uri) => uri)
            },
            reveal: sinon.stub()
        }),
        showErrorMessage: sinon.stub().resolves(),
        showInformationMessage: sinon.stub().resolves(),
        createOutputChannel: sinon.stub().returns({
            appendLine: sinon.stub(),
            show: sinon.stub(),
            clear: sinon.stub()
        })
    },
    commands: {
        registerCommand: sinon.stub(),
        executeCommand: sinon.stub().resolves()
    },
    Uri: {
        file: (path) => ({ fsPath: path, with: () => ({ toString: () => `file://${path}` }) }),
        joinPath: (uri, ...fragments) => {
            // Handle both string and Uri-like inputs for tests
            const base = uri?.fsPath || uri || '';
            return { fsPath: `${base}/${fragments.join('/')}` };
        }
    },
    ViewColumn: {
        Beside: 2
    },
    env: {
        clipboard: {
            writeText: sinon.stub().resolves()
        }
    }
};

module.exports = vscode;
