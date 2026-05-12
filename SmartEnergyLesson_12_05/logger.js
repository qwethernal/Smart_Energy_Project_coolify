function log(level, message, context = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...context
  };
  console.log(JSON.stringify(entry));
}
module.exports = {
  info: (m, c) => log('INFO', m, c),
  warning: (m, c) => log('WARNING', m, c),
  error: (m, c) => log('ERROR', m, c),
  critical: (m, c) => log('CRITICAL', m, c)
};
