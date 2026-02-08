const { getVscode } = require('../../src/runtime-context');

const handler = {
    get(_target, prop) {
        const vscode = getVscode();
        return vscode?.[prop];
    },
    set(_target, prop, value) {
        const vscode = getVscode();
        if (vscode) {
            vscode[prop] = value;
        }
        return true;
    },
    has(_target, prop) {
        const vscode = getVscode();
        return prop in (vscode || {});
    },
    ownKeys() {
        const vscode = getVscode();
        return Reflect.ownKeys(vscode || {});
    },
    getOwnPropertyDescriptor(_target, prop) {
        const vscode = getVscode();
        if (!vscode) return undefined;
        const desc = Object.getOwnPropertyDescriptor(vscode, prop);
        if (desc) return desc;
        return { configurable: true, enumerable: true, writable: true, value: vscode[prop] };
    }
};

module.exports = new Proxy({}, handler);
