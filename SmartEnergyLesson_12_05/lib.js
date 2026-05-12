function decideDeviceStatus(price, limit, critical = false, vacation = false) {
  const p = Number(price);
  const l = Number(limit);
  
  if (!Number.isFinite(p) || !Number.isFinite(l)) return 'off';
  
  if (critical) return 'on';
  if (vacation) return 'off';
  
  return p > l ? 'off' : 'on';
}

function calculateSavings(logs, fixedPrice = 0.2) {
  if (!Array.isArray(logs) || !logs.length) return { saved: 0, percent: 0, rows: 0 };
  
  const total = logs.reduce((sum, row) => {
    try {
      const hours = Number(row.hours || 1);
      const powerKw = Number(row.power_kw || 1);
      const actualPrice = Number(row.price || 0);
      
      if (!Number.isFinite(hours) || !Number.isFinite(powerKw) || !Number.isFinite(actualPrice)) {
        return sum;
      }
      
      const actual = actualPrice * hours * powerKw;
      const fixed = Number(fixedPrice) * hours * powerKw;
      return sum + Math.max(0, fixed - actual);
    } catch {
      return sum;
    }
  }, 0);
  
  const fixedPriceNum = Number(fixedPrice);
  const percent = fixedPriceNum > 0 ? (total / Math.max(0.0001, logs.length * fixedPriceNum)) * 100 : 0;
  
  return {
    saved: Number(total.toFixed(4)),
    percent: Number(Math.max(0, Math.min(100, percent)).toFixed(2)),
    rows: logs.length
  };
}

function validateNumber(value, min = 0, max = 9999) {
  try {
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max;
  } catch {
    return false;
  }
}

module.exports = { decideDeviceStatus, calculateSavings, validateNumber };
