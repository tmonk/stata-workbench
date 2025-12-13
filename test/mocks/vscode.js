const sinon = require('sinon');

const vscode = {
    workspace: {
        getConfiguration: sinon.stub().returns({
            get: sinon.stub().returns(1000)
        }),
        workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }]
    },
    window: {
        createWebviewPanel: sinon.stub().returns({
            onDidDispose: sinon.stub(),
            webview: {
                onDidReceiveMessage: sinon.stub(),
                html: '',
                cspSource: 'mock-csp-source',
                postMessage: sinon.stub().resolves()
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
        joinPath: (uri, ...fragments) => ({ fsPath: `${uri.fsPath}/${fragments.join('/')}` })
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
