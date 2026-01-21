const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const UV_VERSION = 'latest'; // Or a specific version like '0.5.1'
const BASE_URL = `https://github.com/astral-sh/uv/releases/${UV_VERSION === 'latest' ? 'latest/download' : `download/${UV_VERSION}`}`;

const TARGETS = {
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-musl',
    'linux-arm64': 'aarch64-unknown-linux-musl',
};

async function download(target) {
    const uvTarget = TARGETS[target];
    if (!uvTarget) {
        console.error(`Unknown target: ${target}`);
        process.exit(1);
    }

    const isWindows = target.startsWith('win32');
    const extension = isWindows ? 'zip' : 'tar.gz';
    const filename = `uv-${uvTarget}.${extension}`;
    const url = `${BASE_URL}/${filename}`;
    
    const binDir = path.join(__dirname, '..', 'bin', target);
    
    // Clean whole bin directory to ensure only this target is bundled (if not --all)
    const topBinDir = path.join(__dirname, '..', 'bin');
    if (process.argv[2] !== '--all') {
        if (fs.existsSync(topBinDir)) {
            fs.rmSync(topBinDir, { recursive: true, force: true });
        }
    }
    
    if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
    }

    const tempFile = path.join(__dirname, '..', 'temp-' + filename);
    
    console.log(`Downloading ${url} ...`);
    
    // Use curl to download
    const curl = spawnSync('curl', ['-L', url, '-o', tempFile]);
    if (curl.status !== 0) {
        console.error(`Failed to download ${url}`);
        process.exit(1);
    }

    console.log(`Extracting ${tempFile} ...`);
    const extractDir = path.join(__dirname, '..', 'extract-temp');
    if (fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
    }
    fs.mkdirSync(extractDir, { recursive: true });

    if (isWindows) {
        if (process.platform === 'win32') {
            spawnSync('powershell', ['-Command', `Expand-Archive -Path "${tempFile}" -DestinationPath "${extractDir}" -Force`]);
        } else {
            // Building for Windows from Mac/Linux
            spawnSync('unzip', ['-o', tempFile, '-d', extractDir]);
        }
    } else {
        spawnSync('tar', ['-xzf', tempFile, '-C', extractDir]);
    }

    // Find the uv/uv.exe binary in the extracted files recursively
    function findBinary(dir, name) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            if (fs.statSync(fullPath).isDirectory()) {
                const found = findBinary(fullPath, name);
                if (found) return found;
            } else if (file === name) {
                return fullPath;
            }
        }
        return null;
    }

    const binaryName = isWindows ? 'uv.exe' : 'uv';
    const foundPath = findBinary(extractDir, binaryName);

    if (foundPath) {
        // Keep the original name 'uv' so it's unambiguous for the extension.
        // The extension will handle adding 'tool run' if needed.
        const finalPath = path.join(binDir, binaryName);
        fs.renameSync(foundPath, finalPath);
        if (!isWindows) {
            fs.chmodSync(finalPath, 0o755);
        }
        console.log(`Pinned ${binaryName} to ${finalPath}`);
    } else {
        console.error(`Could not find ${binaryName} in the extracted archive.`);
        process.exit(1);
    }

    // Clean up
    if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
    }
    if (fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
    }

    console.log(`Done for ${target}`);
}

const target = process.argv[2];
if (target === '--all') {
    Object.keys(TARGETS).forEach(t => download(t));
} else if (target) {
    download(target);
} else {
    console.log('Usage: node download-uv.js <target>|--all');
    console.log('Targets: ' + Object.keys(TARGETS).join(', '));
}
