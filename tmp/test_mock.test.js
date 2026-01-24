const { mock, test, expect } = require('bun:test');

const myMock = {
    existsSync: () => true,
    foo: 'bar'
};

mock.module('fs', () => myMock);

const fs = require('fs');

test('fs mock', () => {
    console.log('fs keys:', Object.keys(fs));
    expect(fs.foo).toBe('bar');
});
