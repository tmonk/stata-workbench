const fs = require('fs');
const path = require('path');

const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]); // PK\x05\x06
const LOCAL_FILE_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04

function listCandidates() {
    const candidates = [];
    const cwd = process.cwd();
    const rootFiles = fs.readdirSync(cwd);
    for (const f of rootFiles) {
        if (f.endsWith('.vsix')) candidates.push(path.join(cwd, f));
    }
    const distDir = path.join(cwd, 'dist');
    if (fs.existsSync(distDir)) {
        for (const f of fs.readdirSync(distDir)) {
            if (f.endsWith('.vsix')) candidates.push(path.join(distDir, f));
        }
    }
    return candidates;
}

function verifyVsix(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`VSIX not found: ${filePath}`);
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 100) {
        throw new Error(`VSIX is missing or too small: ${filePath} (${stat.size} bytes)`);
    }

    const fd = fs.openSync(filePath, 'r');
    try {
        const head = Buffer.alloc(4);
        fs.readSync(fd, head, 0, 4, 0);
        if (!head.equals(LOCAL_FILE_SIGNATURE)) {
            throw new Error(`VSIX does not look like a ZIP (bad header): ${filePath}`);
        }

        const tailSize = Math.min(65536 + 22, stat.size);
        const tail = Buffer.alloc(tailSize);
        fs.readSync(fd, tail, 0, tailSize, stat.size - tailSize);

        let found = false;
        for (let i = tail.length - 4; i >= 0; i--) {
            if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
                found = true;
                break;
            }
        }
        if (!found) {
            throw new Error(`VSIX missing ZIP end of central directory: ${filePath}`);
        }
    } finally {
        fs.closeSync(fd);
    }
}

const argPath = process.argv[2];
if (argPath) {
    verifyVsix(argPath);
    console.log(`VSIX OK: ${argPath}`);
    process.exit(0);
}

const candidates = listCandidates();
if (!candidates.length) {
    console.error('No VSIX files found to verify.');
    process.exit(1);
}

let failed = false;
for (const filePath of candidates) {
    try {
        verifyVsix(filePath);
        console.log(`VSIX OK: ${filePath}`);
    } catch (err) {
        failed = true;
        console.error(`VSIX FAILED: ${filePath}`);
        console.error(err.message || err);
    }
}

process.exit(failed ? 1 : 0);
