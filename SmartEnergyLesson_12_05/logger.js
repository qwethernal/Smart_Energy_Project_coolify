require('dotenv').config();

function log(level, message, context = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context
  };
  
  console.log(JSON.stringify(entry));
  
  if (process.env.LOKI_URL) {
    sendToLoki(level, message, context).catch(err => {
      console.error('Loki send failed:', err.message);
    });
  }
}

async function sendToLoki(level, message, context = {}) {
  const lokiUrl = process.env.LOKI_URL || 'http://loki:3100';
  try {
    const timestamp = Math.floor(Date.now() * 1e6).toString(); 
    const logLine = JSON.stringify({ level, message, ...context });
    
    const payload = {
      streams: [
        {
          stream: { 
            job: 'smart-energy-app',
            level: level.toLowerCase(),
            service: 'backend'
          },
          values: [[timestamp, logLine]]
        }
      ]
    };
    
    const response = await fetch(`${lokiUrl}/loki/api/v1/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000)
    });
    
    if (!response.ok) {
      throw new Error(`Loki HTTP ${response.status}`);
    }
  } catch (err) {
    return;
  }
}

module.exports = {
  info: (m, c) => log('INFO', m, c),
  warning: (m, c) => log('WARNING', m, c),
  error: (m, c) => log('ERROR', m, c),
  critical: (m, c) => log('CRITICAL', m, c)
};