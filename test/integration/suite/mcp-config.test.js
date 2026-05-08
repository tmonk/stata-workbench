const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('MCP Installer Integration', () => {
    jest.setTimeout(120000);

    const enabled = process.env.MCP_STATA_INTEGRATION === '1';

    let tempRoot;
    let runMcpInstaller;
    let extensionPath;

    beforeAll(async () => {
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        if (!extension.isActive) {
            await extension.activate();
        }
        runMcpInstaller = extension.exports.runMcpInstaller;
        extensionPath = extension.extensionPath;
    });

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stata-wb-mcp-int-'));
    });

    afterEach(() => {
        if (tempRoot && fs.existsSync(tempRoot)) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    test('executes installer in dry-run mode on current platform', async () => {
        if (!enabled) return;

        const options = {
            extensionPath,
            background: false,
            dryRun: true
        };

        await runMcpInstaller(options);
    });

    test('runMcpInstaller handles background execution', async () => {
        if (!enabled) return;

        const extensionPath = path.resolve(__dirname, '../../../');
        const options = {
            extensionPath,
            background: true,
            dryRun: true
        };

        await runMcpInstaller(options);
    });

    test('updates existing config and preserves other servers (mocked locations)', async () => {
        if (!enabled) return;

        // Define mock config path based on platform, matching setup_toolkit.py logic
        let configPath;
        const homeEnv = {};
        if (process.platform === 'win32') {
            const appData = path.join(tempRoot, 'AppData', 'Roaming');
            configPath = path.join(appData, 'Code', 'User', 'mcp.json');
            homeEnv.APPDATA = appData;
            homeEnv.USERPROFILE = tempRoot;
            homeEnv.LOCALAPPDATA = path.join(tempRoot, 'AppData', 'Local');
        } else {
            const configDir = process.platform === 'darwin' 
                ? path.join(tempRoot, 'Library', 'Application Support', 'Code', 'User')
                : path.join(tempRoot, '.config', 'Code', 'User');
            configPath = path.join(configDir, 'mcp.json');
            homeEnv.HOME = tempRoot;
            homeEnv.XDG_CONFIG_HOME = path.join(tempRoot, '.config');
        }

        // 1. Create directory and initial config with a third-party server
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        const initialConfig = {
            servers: {
                other_server: {
                    command: "foo",
                    args: ["bar"]
                }
            }
        };
        fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2));

        // 2. Run installer (Foreground, NOT dry-run, but with mocked HOME)
        // We use the local repo as source to avoid network calls.
        const options = {
            extensionPath,
            background: false,
            // dryRun: true, // Restored to false
            env: {
                ...homeEnv,
                // Ensure uv can find its binaries if installed to the mock home
                PATH: `${process.platform === 'win32' ? '' : path.join(tempRoot, '.local', 'bin')}${path.delimiter}${process.env.PATH}`,
                MCP_STATA_PACKAGE_SPEC: extensionPath + '/mcp-stata'
            }
        };

        try {
            await runMcpInstaller(options);
        } catch (err) {
            console.error(`[TEST] runMcpInstaller failed: ${err.message}`);
            throw err;
        }

        // 3. Verify mcp-stata was added and other_server preserved
        expect(fs.existsSync(configPath)).toBe(true);
        const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        
        expect(updated.servers.other_server).toEqual(initialConfig.servers.other_server);
        expect(updated.servers['mcp-stata']).toBeDefined();
        // The installer script should have configured it to run via uvx or uv run
        expect(updated.servers['mcp-stata'].command).toMatch(/uv/);

        // 4. Run uninstaller
        await runMcpInstaller({ ...options, uninstall: true });

        // 5. Verify mcp-stata was removed and other_server preserved
        const final = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        expect(final.servers.other_server).toEqual(initialConfig.servers.other_server);
        expect(final.servers['mcp-stata']).toBeUndefined();
    });
});
