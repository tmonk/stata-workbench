const assert = require('chai').assert;
const vscode = require('vscode');
const path = require('path');

suite('UI Integration', function () {
    this.timeout(60000);

    test('Extension should activate and register commands', async () => {
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        assert.ok(extension, 'Extension should be present');

        if (!extension.isActive) {
            await extension.activate();
        }
        assert.isTrue(extension.isActive, 'Extension should be active');

        const commands = await vscode.commands.getCommands(true);
        assert.include(commands, 'stata-workbench.runSelection');
        assert.include(commands, 'stata-workbench.runFile');
    });
});
