const path = require('path');
const fs = require('fs');
const os = require('os');
const { runTests } = require('@vscode/test-electron');

async function main() {
    let userDataDir;
    let extDir;
    let workspacePath;
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');

        // Use a real workspace folder so integration tests can write Workspace settings.
        // Use a temp folder to avoid mutating this repo's .vscode/settings.json.
        workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'stata-wb-ws-'));

        // Optional: run uvx against a local mcp-stata repo instead of PyPI.
        // This is intended for integration tests in this mono-workspace.
        if (!process.env.MCP_STATA_PACKAGE_SPEC) {
            const localRepo = process.env.MCP_STATA_LOCAL_REPO || path.resolve(__dirname, '../../../mcp-stata');
            if (fs.existsSync(localRepo)) {
                process.env.MCP_STATA_PACKAGE_SPEC = localRepo;
            }
        }

        // Use fresh temp dirs per run to avoid mutex/file-lock issues on Windows between runs.
        userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-test-user-'));
        extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-test-exts-'));

        // Ensure the test workspace has the local dev server config
        const dotVscode = path.join(workspacePath, '.vscode');
        if (!fs.existsSync(dotVscode)) fs.mkdirSync(dotVscode);
        const mcpJson = path.join(dotVscode, 'mcp.json');
        const config = {
            servers: {
                mcp_stata: {
                    command: "uv",
                    args: [
                        "run",
                        "--directory",
                        "/Users/tom/Dropbox/projects/mcp-stata/",
                        "mcp-stata"
                    ]
                }
            }
        };
        fs.writeFileSync(mcpJson, JSON.stringify(config, null, 2));

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: ['--user-data-dir', userDataDir, '--extensions-dir', extDir, workspacePath]
        });
    } catch (err) {
        console.error('Failed to run integration tests', err);
        if (userDataDir) {
            dumpMcpLogs(userDataDir);
        }
        if (workspacePath && fs.existsSync(workspacePath)) {
            try {
                fs.rmSync(workspacePath, { recursive: true, force: true });
            } catch (_err) {
            }
        }
        process.exit(1);
    }

    if (workspacePath && fs.existsSync(workspacePath)) {
        try {
            fs.rmSync(workspacePath, { recursive: true, force: true });
        } catch (_err) {
        }
    }
}

function dumpMcpLogs(userDataDir) {
    try {
        const logsRoot = path.join(userDataDir, 'logs');
        if (!fs.existsSync(logsRoot)) {
            console.error(`No logs dir at ${logsRoot}`);
            return;
        }
        const stampDirs = fs.readdirSync(logsRoot).sort();
        const latestStamp = stampDirs[stampDirs.length - 1];
        const stampPath = path.join(logsRoot, latestStamp);
        const candidates = [];

        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir)) {
                const full = path.join(dir, entry);
                const stat = fs.statSync(full);
                if (stat.isDirectory()) {
                    walk(full);
                } else if (/Stata Workbench\.log$/i.test(entry) || /mcp-stata/i.test(entry)) {
                    candidates.push(full);
                }
            }
        };

        walk(stampPath);
        if (!candidates.length) {
            console.error(`No MCP logs found under ${stampPath}`);
            return;
        }

        for (const file of candidates) {
            try {
                const content = fs.readFileSync(file, 'utf8');
                const lines = content.split(/\r?\n/);
                const tail = lines.slice(-200).join('\n');
                console.error(`\n--- MCP log tail: ${file} ---\n${tail}\n--- end MCP log tail ---`);
            } catch (readErr) {
                console.error(`Failed to read log ${file}: ${readErr.message}`);
            }
        }
    } catch (logErr) {
        console.error(`Failed to dump MCP logs: ${logErr.message}`);
    }
}

main();
