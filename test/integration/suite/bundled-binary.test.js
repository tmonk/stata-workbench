const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { spawnSync } = require('child_process');

describe('Bundled Binary Integration', () => {
    // This test is intended to be run locally or in specialized CI
    const enabled = process.env.MCP_STATA_BUNDLED_TEST === '1' || process.env.FORCE_BUNDLED_TEST === '1';
    
    // Increase timeout because we might be downloading
    jest.setTimeout(300000); 

    let bundledPath;

    beforeAll(async () => {
        if (!enabled) {
            return;
        }

        const platform = process.platform;
        const arch = process.arch;
        const binName = platform === 'win32' ? 'uvx.exe' : 'uvx';
        
        // Use the absolute path to where we expect the bundled binary to be
        // In the production extension, it's at <extPath>/bin/<platform>-<arch>/uvx
        // For tests, we'll check common project-relative paths
        const projectRoot = path.resolve(__dirname, '../../../');
        bundledPath = path.join(projectRoot, 'bin', `${platform}-${arch}`, binName);

        if (!fs.existsSync(bundledPath)) {
            console.log(`[BUNDLED TEST] Bundled binary not found at ${bundledPath}. Downloading...`);
            // Run the download script for the current platform
            const downloadScript = path.join(projectRoot, 'scripts', 'download-uv.js');
            const target = `${platform}-${arch}`;
            const downloadResult = spawnSync('node', [downloadScript, target], { 
                cwd: projectRoot,
                stdio: 'inherit'
            });
            
            if (downloadResult.status !== 0) {
                throw new Error(`Failed to download bundled binary for ${target}`);
            }
        }

        if (!fs.existsSync(bundledPath)) {
            throw new Error(`Bundled binary still missing at ${bundledPath} after download attempt`);
        }

        console.log(`[BUNDLED TEST] Using bundled binary: ${bundledPath}`);
        
        // Force the extension to use THIS binary by setting the env var
        process.env.MCP_STATA_UVX_CMD = bundledPath;
    });

    afterAll(async () => {
        // We don't necessarily want to delete the binary here as it might be useful for other tests
        // But we should reset the env var
        delete process.env.MCP_STATA_UVX_CMD;
    });

    const runIfEnabled = enabled ? test : test.skip;

    runIfEnabled('extension uses and successfully executes bundled binary', async () => {
        // The extension should have picked up MCP_STATA_UVX_CMD
        // To verify, we can trigger an action that uses it, like testConnection or just refreshMcpPackage
        
        // Since we are in an integration test, the extension is already activated.
        // We might need to manually trigger the find logic or just check if it's working.
        
        // We can use the exposed API from activate() if it's there
        // In extension.js:
        // if (context.extensionMode === vscode.ExtensionMode.Test) { return { ... } }
        
        const ext = vscode.extensions.getExtension('tmonk.stata-workbench');
        const api = await ext.activate();
        
        if (!api || !api.refreshMcpPackage) {
            // If API not exposed exactly as expected, try to verify via command
            // But refreshMcpPackage is exported in extension.js
            throw new Error('Extension API not found');
        }

        const version = api.refreshMcpPackage();
        expect(version).toBeTruthy();
        expect(version).not.toBe('unknown');
        console.log(`[BUNDLED TEST] Successfully executed bundled binary. Reported version/output: ${version}`);
    });
});
