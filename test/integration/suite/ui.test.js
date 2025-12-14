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
        assert.include(commands, 'stata-workbench.showInteractive');
        assert.include(commands, 'stata-workbench.runSelection');
        assert.include(commands, 'stata-workbench.runFile');
    });

    test('showInteractive should open the Interactive Panel', async () => {
        // Trigger the command
        await vscode.commands.executeCommand('stata-workbench.showInteractive');

        // Wait a bit for the panel to be created
        await new Promise(r => setTimeout(r, 1000));

        // Use VS Code API to check for the panel tab
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
        const stataTab = tabs.find(tab => tab.label === 'Stata Interactive');

        assert.ok(stataTab, 'Stata Interactive tab should be found');
    });
});
