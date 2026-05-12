const test = require('node:test');
const assert = require('node:assert/strict');
const { decideDeviceStatus, calculateSavings, validateNumber } = require('../lib');

test('threshold decision turns non-critical device off when price is high', () => {
  assert.equal(decideDeviceStatus(0.30, 0.20, false, false), 'off');
});

test('threshold decision keeps critical device on', () => {
  assert.equal(decideDeviceStatus(0.99, 0.20, true, false), 'on');
});

test('vacation mode turns non-critical devices off', () => {
  assert.equal(decideDeviceStatus(0.01, 0.20, false, true), 'off');
});

test('savings calculator returns positive result', () => {
  const result = calculateSavings([{ price: 0.1, power_kw: 1, hours: 1 }, { price: 0.15, power_kw: 2, hours: 1 }], 0.2);
  assert.ok(result.saved > 0);
});

test('number validation rejects invalid values', () => {
  assert.equal(validateNumber('abc'), false);
  assert.equal(validateNumber(0.2, 0, 1), true);
});
