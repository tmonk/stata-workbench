const path = require('path');
const Mocha = require('mocha');

function run() {
    const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 120000 });
    const fs = require('fs');
    const files = fs.readdirSync(__dirname);

    files.filter(f => f.endsWith('.test.js')).forEach(f => {
        mocha.addFile(path.resolve(__dirname, f));
    });

    return new Promise((resolve, reject) => {
        try {
            mocha.run((failures) => {
                if (failures > 0) {
                    reject(new Error(`${failures} integration tests failed.`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = { run };
