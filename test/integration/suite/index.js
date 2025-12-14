const path = require('path');
const Mocha = require('mocha');

function run() {
    const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 120000 });
    mocha.addFile(path.resolve(__dirname, './integration.test.js'));

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
