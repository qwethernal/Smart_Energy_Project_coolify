function decideDeviceStatus(price, limit, critical = false, vacation = false) {
  if (critical) return 'on';
  if (vacation) return 'off';
  return Number(price) > Number(limit) ? 'off' : 'on';
}

function calculateSavings(logs, fixedPrice = 0.2) {
  const total = logs.reduce((sum, row) => {
    const hours = Number(row.hours || 1);
    const powerKw = Number(row.power_kw || 1);
    const actual = Number(row.price || 0) * hours * powerKw;
    const fixed = Number(fixedPrice) * hours * powerKw;
    return sum + Math.max(0, fixed - actual);
  }, 0);
  return {
    saved: Number(total.toFixed(4)),
    percent: Number((fixedPrice > 0 ? (total / Math.max(0.0001, logs.length * fixedPrice)) * 100 : 0).toFixed(2))
  };
}

function validateNumber(value, min = 0, max = 9999) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max;
}

module.exports = { decideDeviceStatus, calculateSavings, validateNumber };
