require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');


async function ensureColumn(connection, tableName, columnName, definition) {
  const [rows] = await connection.query(
    `SHOW COLUMNS FROM \`${tableName}\` LIKE ?`,
    [columnName]
  );

  if (rows.length === 0) {
    await connection.query(`ALTER TABLE \`${tableName}\` ADD COLUMN ${definition}`);
    console.log(`Added ${tableName}.${columnName} column`);
  }
}

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || ''
  });

  const dbName = process.env.DB_NAME || 'smart_energy';
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  await connection.query(`USE \`${dbName}\``);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(100) NOT NULL UNIQUE,
      email VARCHAR(150) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      role ENUM('user','admin') DEFAULT 'user',
      active BOOLEAN DEFAULT TRUE,
      vacation_mode BOOLEAN DEFAULT FALSE,
      fixed_price DECIMAL(10,4) DEFAULT 0.2000,
      notify_channel ENUM('none','telegram','discord') DEFAULT 'none',
      telegram_chat_id VARCHAR(150),
      discord_webhook TEXT,
      critical_price DECIMAL(10,4) DEFAULT 0.3000,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(120) NOT NULL,
      description TEXT,
      connection_type ENUM('api','mqtt','ip','demo') DEFAULT 'demo',
      connection_value VARCHAR(255) DEFAULT 'demo://device',
      price_limit DECIMAL(10,4) NOT NULL DEFAULT 0.1500,
      power_kw DECIMAL(10,3) DEFAULT 1.000,
      status ENUM('on','off') DEFAULT 'off',
      connection_status ENUM('unknown','online','offline') DEFAULT 'unknown',
      manual_override BOOLEAN DEFAULT FALSE,
      critical BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS command_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      device_id INT NOT NULL,
      action VARCHAR(100) NOT NULL,
      price DECIMAL(10,4),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      price DECIMAL(10,4) NOT NULL,
      source VARCHAR(50) DEFAULT 'fallback',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      channel VARCHAR(50) NOT NULL,
      message TEXT NOT NULL,
      status ENUM('pending','sent','failed') DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);


  // Database migrations for already existing MySQL volumes.
  // CREATE TABLE IF NOT EXISTS does not update old tables, so we add missing columns manually.
  await ensureColumn(connection, 'users', 'email', "email VARCHAR(150) NOT NULL DEFAULT 'user@example.com'");
  await ensureColumn(connection, 'users', 'role', "role ENUM('user','admin') DEFAULT 'user'");
  await ensureColumn(connection, 'users', 'active', 'active BOOLEAN DEFAULT TRUE');
  await ensureColumn(connection, 'users', 'vacation_mode', 'vacation_mode BOOLEAN DEFAULT FALSE');
  await ensureColumn(connection, 'users', 'fixed_price', 'fixed_price DECIMAL(10,4) DEFAULT 0.2000');
  await ensureColumn(connection, 'users', 'notify_channel', "notify_channel ENUM('none','telegram','discord') DEFAULT 'none'");
  await ensureColumn(connection, 'users', 'telegram_chat_id', 'telegram_chat_id VARCHAR(150) NULL');
  await ensureColumn(connection, 'users', 'discord_webhook', 'discord_webhook TEXT NULL');
  await ensureColumn(connection, 'users', 'critical_price', 'critical_price DECIMAL(10,4) DEFAULT 0.3000');
  await ensureColumn(connection, 'users', 'created_at', 'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');

  await ensureColumn(connection, 'devices', 'description', 'description TEXT NULL');
  await ensureColumn(connection, 'devices', 'connection_type', "connection_type ENUM('api','mqtt','ip','demo') DEFAULT 'demo'");
  await ensureColumn(connection, 'devices', 'connection_value', "connection_value VARCHAR(255) DEFAULT 'demo://device'");
  await ensureColumn(connection, 'devices', 'price_limit', 'price_limit DECIMAL(10,4) NOT NULL DEFAULT 0.1500');
  await ensureColumn(connection, 'devices', 'power_kw', 'power_kw DECIMAL(10,3) DEFAULT 1.000');
  await ensureColumn(connection, 'devices', 'status', "status ENUM('on','off') DEFAULT 'off'");
  await ensureColumn(connection, 'devices', 'connection_status', "connection_status ENUM('unknown','online','offline') DEFAULT 'unknown'");
  await ensureColumn(connection, 'devices', 'manual_override', 'manual_override BOOLEAN DEFAULT FALSE');
  await ensureColumn(connection, 'devices', 'critical', 'critical BOOLEAN DEFAULT FALSE');
  await ensureColumn(connection, 'devices', 'created_at', 'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');

  const [adminRows] = await connection.query('SELECT id FROM users WHERE username = ?', ['admin']);
  if (adminRows.length === 0) {
    const hash = await bcrypt.hash('123456', 10);
    await connection.query(
      'INSERT INTO users (username, email, password, role, active) VALUES (?, ?, ?, ?, ?)',
      ['admin', 'admin@example.com', hash, 'admin', true]
    );
    console.log('Default admin created: admin / 123456');
  }

  await connection.end();
  console.log('Database initialized successfully');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
