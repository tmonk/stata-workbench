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
        const binName = platform === 'win32' ? 'uv.exe' : 'uv';
        
        // Use the absolute path to where we expect the bundled binary to be
        // In the production extension, it's at <extPath>/bin/<platform>-<arch>/uv
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

    runIfEnabled('extension uses and successfully executes bundled binary (forced)', async () => {
        const ext = vscode.extensions.getExtension('tmonk.stata-workbench');
        const api = await ext.activate();
        
        if (!api || !api.refreshMcpPackage || !api.getUvCommand || !api.reDiscoverUv) {
            throw new Error('Extension API missing required test helpers');
        }

        // Force it via env var
        process.env.MCP_STATA_UVX_CMD = bundledPath;
        console.log(`[BUNDLED TEST] process.env.MCP_STATA_UVX_CMD is: ${process.env.MCP_STATA_UVX_CMD}`);
        
        // Force re-discovery
        const currentCommand = api.reDiscoverUv();
        
        console.log(`[BUNDLED TEST] Extension is using command: ${currentCommand}`);
        
        // Ensure it's using the binary we forced
        expect(currentCommand).toEqual(bundledPath);

        const version = api.refreshMcpPackage();
        expect(version).toBeTruthy();
        expect(version).not.toBe('unknown');
    });

    runIfEnabled('extension discovers bundled binary organically', async () => {
        const ext = vscode.extensions.getExtension('tmonk.stata-workbench');
        const api = await ext.activate();

        // UNSET the override
        delete process.env.MCP_STATA_UVX_CMD;
        
        // Force re-discovery
        const currentCommand = api.reDiscoverUv();
        
        console.log(`[BUNDLED TEST] Organic discovery found: ${currentCommand}`);
        
        // It should match bundledPath because we now prioritize bundled over system PATH
        expect(currentCommand).toEqual(bundledPath);
    });
});
