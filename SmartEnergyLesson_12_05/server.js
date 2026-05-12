require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const client = require('prom-client');
const http = require('http');
const WebSocket = require('ws');
const pool = require('./db');
const logger = require('./logger');
const { decideDeviceStatus, calculateSavings, validateNumber } = require('./lib');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const PORT = process.env.PORT || 3000;
const register = new client.Registry();
client.collectDefaultMetrics({ register });
const httpRequests = new client.Counter({ name: 'smart_energy_http_requests_total', help: 'API request count', labelNames: ['method','route','status'] });
const httpLatency = new client.Histogram({ name: 'smart_energy_http_latency_seconds', help: 'API latency', labelNames: ['method','route','status'], buckets: [0.01,0.05,0.1,0.3,0.5,1,2] });
const commandCounter = new client.Counter({ name: 'smart_energy_device_commands_total', help: 'Device command count', labelNames: ['action'] });
const activeSessions = new client.Gauge({ name: 'smart_energy_active_sessions', help: 'Approximate active sessions' });
const priceErrorCounter = new client.Counter({ name: 'smart_energy_price_fetch_errors_total', help: 'Price API errors', labelNames: ['error_type'] });
register.registerMetric(httpRequests); register.registerMetric(httpLatency); register.registerMetric(commandCounter); register.registerMetric(activeSessions); register.registerMetric(priceErrorCounter);
const sessionUsers = new Set();
const userConnections = new Map();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
  const end = httpLatency.startTimer();
  res.on('finish', () => {
    const route = req.route?.path || req.path;
    httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
    end({ method: req.method, route, status: String(res.statusCode) });
    logger.info('API request', { method: req.method, path: req.path, status: res.statusCode });
  });
  next();
});
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Не авторизован' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Нет прав администратора' });
  next();
}
function isValidText(v, min = 1, max = 255) { 
  return typeof v === 'string' && v.trim().length >= min && v.trim().length <= max; 
}
function isValidEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return typeof email === 'string' && regex.test(email) && email.length <= 150;
}
function sanitizeString(str) {
  if (typeof str !== 'string') return '';
  return str.trim().substring(0, 255).replace(/[<>]/g, '');
}
function fallbackPrice() {
  const hour = new Date().getHours();
  if (hour >= 8 && hour <= 11) return 0.22;
  if (hour >= 17 && hour <= 21) return 0.28;
  if (hour >= 0 && hour <= 5) return 0.09;
  return 0.15;
}
async function fetchPrice() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const now = Math.floor(Date.now() / 1000);
    const start = now - 3600;
    const url = `https://dashboard.elering.ee/api/nps/price?start=${start}&end=${now}`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      priceErrorCounter.inc({ error_type: 'http_error' });
      throw new Error(`Elering status ${response.status}`);
    }
    const data = await response.json();
    const ee = data?.data?.ee || [];
    if (!ee.length) throw new Error('Empty price data');
    const latest = ee[ee.length - 1];
    let price = latest?.price ? Number(latest.price) / 1000 : fallbackPrice();
    
    if (price < 0) {
      logger.warning('Negative electricity price received', { price, timestamp: new Date().toISOString() });
    } else if (price > 100) {
      logger.warning('Unrealistic price value, using fallback', { price });
      price = fallbackPrice();
    }
    
    clearTimeout(timeout);
    await pool.query('INSERT INTO price_history (price, source) VALUES (?, ?)', [price, 'elering']);
    return { price, source: 'elering', warning: null };
  } catch (err) {
    clearTimeout(timeout);
    priceErrorCounter.inc({ error_type: err.name === 'AbortError' ? 'timeout' : 'network' });
    const price = fallbackPrice();
    logger.warning('Elering API unavailable, fallback price used', { error: err.message, price, timestamp: new Date().toISOString() });
    await pool.query('INSERT INTO price_history (price, source) VALUES (?, ?)', [price, 'fallback']);
    return { price, source: 'fallback', warning: 'Elering API недоступен, используется резервная цена' };
  }
}
async function notifyUser(user, message) {
  if (!user || user.notify_channel === 'none') return;
  let ok = false;
  try {
    if (user.notify_channel === 'discord' && user.discord_webhook) {
      const r = await fetch(user.discord_webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: message }) });
      ok = r.ok;
    }
    if (user.notify_channel === 'telegram' && process.env.TELEGRAM_BOT_TOKEN && user.telegram_chat_id) {
      const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: user.telegram_chat_id, text: message }) });
      ok = r.ok;
    }
  } catch (err) { logger.error('Notification failed', { error: err.message }); }
  await pool.query('INSERT INTO notifications (user_id, channel, message, status) VALUES (?, ?, ?, ?)', [user.id, user.notify_channel, message, ok ? 'sent' : 'failed']);
}
async function testConnection(type, value) {
  if (type === 'demo') return 'online';
  if (!value || value.length < 3) return 'offline';
  if (type === 'api') {
    try { const r = await fetch(value, { method: 'GET', signal: AbortSignal.timeout(1500) }); return r.ok ? 'online' : 'offline'; }
    catch { return 'offline'; }
  }
  return 'online';
}
async function sendDeviceCommand(device, action, price) {
  commandCounter.inc({ action });
  logger.info('Device command', { deviceId: device.id, action, price, connectionType: device.connection_type });
  await pool.query('INSERT INTO command_logs (device_id, action, price) VALUES (?, ?, ?)', [device.id, action, price]);
  return true;
}
async function applyAutomation(userId) {
  try {
    const { price, source, warning } = await fetchPrice();
    const [[user]] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return { price, source, warning, error: 'User not found' };
    
    const [devices] = await pool.query('SELECT * FROM devices WHERE user_id = ?', [userId]);
    if (price < 0) logger.warning('Negative electricity price received', { price });
    
    for (const d of devices) {
      if (d.manual_override) continue;
      const newStatus = decideDeviceStatus(price, d.price_limit, !!d.critical, !!user.vacation_mode);
      if (newStatus !== d.status) {
        await pool.query('UPDATE devices SET status = ? WHERE id = ?', [newStatus, d.id]);
        await sendDeviceCommand(d, `AUTO_${newStatus.toUpperCase()}`, price);
        await notifyUser(user, `${d.name}: AUTO_${newStatus.toUpperCase()} при цене ${price} €/kWh`);
      }
    }
    if (price >= Number(user.critical_price || 0.3)) await notifyUser(user, `Высокая цена электричества: ${price} €/kWh`);
    return { price, source, warning };
  } catch (err) {
    logger.error('Automation error', { userId, error: err.message });
    return { price: 0, source: 'error', warning: 'Ошибка автоматизации' };
  }
}

wss.on('connection', (ws) => {
  let userId = null;
  logger.info('WebSocket connection established');
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'auth' && data.userId) {
        userId = data.userId;
        if (!userConnections.has(userId)) userConnections.set(userId, []);
        userConnections.get(userId).push(ws);
        ws.send(JSON.stringify({ type: 'auth', success: true }));
        logger.info('WebSocket authenticated', { userId });
      }
    } catch (err) {
      logger.error('WebSocket message error', { error: err.message });
    }
  });
  
  ws.on('close', () => {
    if (userId && userConnections.has(userId)) {
      const connections = userConnections.get(userId);
      const idx = connections.indexOf(ws);
      if (idx > -1) connections.splice(idx, 1);
      if (!connections.length) userConnections.delete(userId);
    }
    logger.info('WebSocket disconnected');
  });
});

function broadcastPrice(userId, priceData) {
  if (userConnections.has(userId)) {
    const connections = userConnections.get(userId);
    const message = JSON.stringify({ type: 'price_update', ...priceData, timestamp: new Date().toISOString() });
    connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.send(message);
    });
  }
}

async function priceUpdateLoop() {
  setInterval(async () => {
    const [users] = await pool.query('SELECT DISTINCT user_id FROM devices');
    for (const { user_id } of users) {
      const priceInfo = await fetchPrice();
      broadcastPrice(user_id, priceInfo);
    }
  }, 5 * 60 * 1000);
}
priceUpdateLoop();

app.get('/', (req, res) => res.redirect(req.session.user ? '/dashboard.html' : '/login.html'));
app.get('/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, db: 'connected' }); }
  catch (err) { logger.error('DB health check failed', { error: err.message }); res.status(500).json({ ok: false, db: 'error' }); }
});
app.get('/metrics', async (req, res) => { activeSessions.set(sessionUsers.size); res.set('Content-Type', register.contentType); res.end(await register.metrics()); });

app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!isValidText(username, 3, 100)) return res.status(400).json({ error: 'Логин: 3-100 символов' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Некорректный email' });
    if (!isValidText(password, 8, 100)) return res.status(400).json({ error: 'Пароль: минимум 8 символов' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [username.trim(), email.trim().toLowerCase(), hash]);
    logger.info('New user registered', { username, email });
    res.json({ success: true, message: 'Пользователь создан успешно' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Пользователь или email уже зарегистрирован' });
    }
    logger.error('Registration error', { error: err.message });
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!isValidText(username, 1, 100) || !isValidText(password, 1, 100)) {
      return res.status(400).json({ error: 'Логин и пароль обязательны' });
    }
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ? AND active = TRUE', [username.trim()]);
    if (!rows.length) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const user = rows[0];
    if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Неверный логин или пароль' });
    req.session.user = { id: user.id, username: user.username, role: user.role };
    sessionUsers.add(user.id);
    logger.info('User login', { userId: user.id, username: user.username, role: user.role });
    res.json({ success: true });
  } catch (err) {
    logger.error('Login error', { error: err.message });
    res.status(500).json({ error: 'Ошибка входа' });
  }
});
app.post('/api/logout', (req, res) => { if (req.session.user) sessionUsers.delete(req.session.user.id); req.session.destroy(() => res.json({ success: true })); });
app.get('/api/me', requireAuth, (req, res) => res.json(req.session.user));

app.get('/api/dashboard', requireAuth, async (req, res) => {
  const priceInfo = await applyAutomation(req.session.user.id);
  const [devices] = await pool.query('SELECT * FROM devices WHERE user_id = ? ORDER BY id DESC', [req.session.user.id]);
  const [[user]] = await pool.query('SELECT vacation_mode, fixed_price, critical_price, notify_channel FROM users WHERE id = ?', [req.session.user.id]);
  res.json({ ...priceInfo, devices, settings: user });
});
app.get('/api/forecast', requireAuth, async (req, res) => {
  const hours = Array.from({ length: 24 }).map((_, i) => {
    const hour = (new Date().getHours() + i) % 24;
    const price = hour >= 17 && hour <= 21 ? 0.28 : hour <= 5 ? 0.09 : 0.15;
    return { hour, price };
  });
  const [devices] = await pool.query('SELECT * FROM devices WHERE user_id = ?', [req.session.user.id]);
  const plan = hours.map(h => ({ ...h, actions: devices.map(d => ({ device: d.name, planned_status: decideDeviceStatus(h.price, d.price_limit, !!d.critical, false) })) }));
  res.json(plan);
});
app.get('/api/report', requireAuth, async (req, res) => {
  const [[user]] = await pool.query('SELECT fixed_price FROM users WHERE id=?', [req.session.user.id]);
  const [logs] = await pool.query(`SELECT c.*, d.power_kw FROM command_logs c JOIN devices d ON d.id=c.device_id WHERE d.user_id=? ORDER BY c.created_at DESC LIMIT 200`, [req.session.user.id]);
  res.json({ fixedPrice: user.fixed_price, ...calculateSavings(logs, Number(user.fixed_price || 0.2)), rows: logs });
});

app.get('/api/devices', requireAuth, async (req, res) => { const [devices] = await pool.query('SELECT * FROM devices WHERE user_id = ? ORDER BY id DESC', [req.session.user.id]); res.json(devices); });
app.post('/api/devices', requireAuth, async (req, res) => {
  try {
    const { name, description, price_limit, critical, connection_type, connection_value, power_kw } = req.body;
    if (!isValidText(name, 2, 120)) return res.status(400).json({ error: 'Название 2-120 символов' });
    if (!validateNumber(price_limit, -1, 10)) return res.status(400).json({ error: 'Цена: -1 до 10 €/kWh' });
    if (!validateNumber(power_kw, 0.1, 50)) return res.status(400).json({ error: 'Мощность: 0.1-50 кВт' });
    const status = await testConnection(connection_type || 'demo', connection_value || 'demo://device');
    await pool.query('INSERT INTO devices (user_id,name,description,price_limit,critical,connection_type,connection_value,connection_status,power_kw) VALUES (?,?,?,?,?,?,?,?,?)', [req.session.user.id, sanitizeString(name), sanitizeString(description || ''), Number(price_limit), critical ? 1 : 0, connection_type || 'demo', connection_value || 'demo://device', status, Number(power_kw || 1)]);
    logger.info('Device added', { userId: req.session.user.id, name, type: connection_type });
    res.json({ success: true, connection_status: status });
  } catch (err) {
    logger.error('Device creation error', { error: err.message, userId: req.session.user.id });
    res.status(500).json({ error: 'Ошибка добавления устройства' });
  }
});
app.put('/api/devices/:id', requireAuth, async (req, res) => {
  const { name, description, price_limit, critical, connection_type, connection_value, power_kw } = req.body;
  if (!isValidText(name, 2, 120) || !validateNumber(price_limit, -1, 10)) return res.status(400).json({ error: 'Название и корректный лимит обязательны' });
  const status = await testConnection(connection_type || 'demo', connection_value || 'demo://device');
  await pool.query('UPDATE devices SET name=?,description=?,price_limit=?,critical=?,connection_type=?,connection_value=?,connection_status=?,power_kw=? WHERE id=? AND user_id=?', [name, description || '', Number(price_limit), critical ? 1 : 0, connection_type || 'demo', connection_value || 'demo://device', status, Number(power_kw || 1), req.params.id, req.session.user.id]);
  res.json({ success: true, connection_status: status });
});
app.delete('/api/devices/:id', requireAuth, async (req, res) => { await pool.query('DELETE FROM devices WHERE id=? AND user_id=?', [req.params.id, req.session.user.id]); res.json({ success: true }); });
app.post('/api/devices/:id/toggle', requireAuth, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM devices WHERE id=? AND user_id=?', [req.params.id, req.session.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Устройство не найдено' });
  const device = rows[0]; const newStatus = device.status === 'on' ? 'off' : 'on'; const { price } = await fetchPrice();
  await pool.query('UPDATE devices SET status=?, manual_override=TRUE WHERE id=?', [newStatus, device.id]);
  await sendDeviceCommand(device, `MANUAL_${newStatus.toUpperCase()}`, price);
  res.json({ success: true });
});
app.post('/api/devices/:id/auto', requireAuth, async (req, res) => { await pool.query('UPDATE devices SET manual_override=FALSE WHERE id=? AND user_id=?', [req.params.id, req.session.user.id]); res.json({ success: true }); });
app.get('/api/history', requireAuth, async (req, res) => { const [logs] = await pool.query(`SELECT c.*, d.name AS device_name FROM command_logs c JOIN devices d ON d.id=c.device_id WHERE d.user_id=? ORDER BY c.created_at DESC LIMIT 100`, [req.session.user.id]); res.json(logs); });
app.get('/api/settings', requireAuth, async (req, res) => { const [[u]] = await pool.query('SELECT vacation_mode,fixed_price,notify_channel,telegram_chat_id,discord_webhook,critical_price FROM users WHERE id=?', [req.session.user.id]); res.json(u); });
app.put('/api/settings', requireAuth, async (req, res) => {
  const { vacation_mode, fixed_price, notify_channel, telegram_chat_id, discord_webhook, critical_price } = req.body;
  if (!validateNumber(fixed_price, 0, 10) || !validateNumber(critical_price, -1, 10)) return res.status(400).json({ error: 'Некорректные цены' });
  await pool.query('UPDATE users SET vacation_mode=?, fixed_price=?, notify_channel=?, telegram_chat_id=?, discord_webhook=?, critical_price=? WHERE id=?', [vacation_mode ? 1 : 0, fixed_price, notify_channel || 'none', telegram_chat_id || null, discord_webhook || null, critical_price, req.session.user.id]);
  res.json({ success: true });
});
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => { const [users] = await pool.query('SELECT id,username,email,role,active,created_at FROM users ORDER BY id'); res.json(users); });
app.put('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => { const { role, active } = req.body; await pool.query('UPDATE users SET role=?, active=? WHERE id=?', [role === 'admin' ? 'admin' : 'user', active ? 1 : 0, req.params.id]); res.json({ success: true }); });
app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => { await pool.query('DELETE FROM users WHERE id=? AND id<>?', [req.params.id, req.session.user.id]); res.json({ success: true }); });
app.get('/api/notifications', requireAuth, async (req, res) => { const [rows] = await pool.query('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50', [req.session.user.id]); res.json(rows); });

app.use((err, req, res, next) => { logger.error('Unhandled error', { error: err.message, path: req.path, stack: err.stack.split('\n')[0] }); res.status(500).json({ error: 'Серверная ошибка, но приложение не упало' }); });
server.listen(PORT, () => logger.info('Server started', { url: `http://localhost:${PORT}`, wsUrl: `ws://localhost:${PORT}/ws` }));
