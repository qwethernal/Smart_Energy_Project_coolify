const test = require('node:test');
const assert = require('node:assert/strict');
const { decideDeviceStatus, calculateSavings, validateNumber } = require('../lib');
test('threshold decision turns non-critical device off when price is high', () => {
  assert.equal(decideDeviceStatus(0.30, 0.20, false, false), 'off');
});

test('threshold decision keeps device on when price is low', () => {
  assert.equal(decideDeviceStatus(0.10, 0.20, false, false), 'on');
});

test('threshold decision keeps critical device on regardless of price', () => {
  assert.equal(decideDeviceStatus(0.99, 0.20, true, false), 'on');
});

test('critical device stays on even at price zero', () => {
  assert.equal(decideDeviceStatus(0, 0.20, true, false), 'on');
});

test('vacation mode turns non-critical devices off', () => {
  assert.equal(decideDeviceStatus(0.01, 0.20, false, true), 'off');
});

test('vacation mode turns off even low-price devices', () => {
  assert.equal(decideDeviceStatus(0.001, 0.20, false, true), 'off');
});

test('negative price turns on non-critical device (grid pays)', () => {
  assert.equal(decideDeviceStatus(-0.05, 0.20, false, false), 'on');
});

test('handles NaN inputs safely', () => {
  assert.equal(decideDeviceStatus(NaN, 0.20, false, false), 'off');
  assert.equal(decideDeviceStatus(0.20, NaN, false, false), 'off');
});

test('handles null/undefined inputs', () => {
  assert.equal(decideDeviceStatus(null, 0.20, false, false), 'off');
  assert.equal(decideDeviceStatus(0.20, undefined, false, false), 'off');
});
test('savings calculator returns positive result', () => {
  const result = calculateSavings([{ price: 0.1, power_kw: 1, hours: 1 }, { price: 0.15, power_kw: 2, hours: 1 }], 0.2);
  assert.ok(result.saved > 0);
  assert.ok(result.percent > 0);
});

test('savings calculator handles empty logs', () => {
  const result = calculateSavings([], 0.2);
  assert.equal(result.saved, 0);
  assert.equal(result.percent, 0);
  assert.equal(result.rows, 0);
});

test('savings calculator handles null logs safely', () => {
  const result = calculateSavings(null, 0.2);
  assert.equal(result.saved, 0);
  assert.equal(result.percent, 0);
});

test('savings with fixed price zero', () => {
  const result = calculateSavings([{ price: 0.1, power_kw: 1, hours: 1 }], 0);
  assert.equal(result.saved, 0);
  assert.equal(result.percent, 0);
});

test('savings caps percent at 100', () => {
  const result = calculateSavings([{ price: 0.01, power_kw: 1, hours: 1 }], 0.2);
  assert.ok(result.percent <= 100);
});

test('savings with invalid data in logs', () => {
  const result = calculateSavings([{ price: NaN, power_kw: undefined, hours: 'invalid' }], 0.2);
  assert.equal(result.saved, 0);
});

test('savings with large numbers', () => {
  const result = calculateSavings([{ price: 0.1, power_kw: 100, hours: 100 }], 0.2);
  assert.ok(result.saved >= 0);
  assert.ok(Number.isFinite(result.saved));
});
test('number validation accepts valid values', () => {
  assert.equal(validateNumber(0.2, 0, 1), true);
  assert.equal(validateNumber(5, 0, 10), true);
  assert.equal(validateNumber(0, 0, 10), true);
});

test('number validation rejects invalid values', () => {
  assert.equal(validateNumber('abc'), false);
  assert.equal(validateNumber(NaN), false);
  assert.equal(validateNumber(Infinity), false);
});

test('number validation respects min constraint', () => {
  assert.equal(validateNumber(-1, 0, 10), false);
  assert.equal(validateNumber(0, 0, 10), true);
});

test('number validation respects max constraint', () => {
  assert.equal(validateNumber(11, 0, 10), false);
  assert.equal(validateNumber(10, 0, 10), true);
});

test('number validation with string numbers', () => {
  assert.equal(validateNumber('5', 0, 10), true);
  assert.equal(validateNumber('5.5', 0, 10), true);
  assert.equal(validateNumber('abc', 0, 10), false);
});

test('number validation handles null/undefined', () => {
  assert.equal(validateNumber(null), false);
  assert.equal(validateNumber(undefined), false);
});
