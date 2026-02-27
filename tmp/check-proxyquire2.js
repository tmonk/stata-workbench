// Pre-load runtime-context like tests would
const rtReal = require('../src/runtime-context.js');
const proxyquire = require('proxyquire').noCallThru().noPreserveCache();
const rtPath = require.resolve('../src/runtime-context.js');

// Check what's in cache before
const before = require.cache[rtPath];
console.log('Before: cached =', !!before, '| is real:', before && typeof before.exports.setDefaultVscode === 'function');

// Load help-panel with stub
proxyquire('../src/help-panel', {
    './runtime-context': { getVscode: () => null }
});

// Check what's in cache after
const after = require.cache[rtPath];
if (!after) {
    console.log('After: REMOVED from cache! (next require will create NEW instance)');
} else {
    const isStub = after.exports && typeof after.exports.setDefaultVscode !== 'function';
    console.log('After:', isStub ? 'STUB (polluted!)' : 'REAL module still in cache');
}
