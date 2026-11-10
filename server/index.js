'use strict';

const fs = require('node:fs');
const { getConfig } = require('./config');
const { openDatabase, runMigrations } = require('./db/database');
const { seedDatabase } = require('./db/seed');
const { createApp } = require('./app');

function startServer() {
  const cfg = getConfig();
  if (!fs.existsSync(cfg.privateStorageDir)) {
    fs.mkdirSync(cfg.privateStorageDir, { recursive: true });
  }

  const db = openDatabase(cfg.dbPath);
  const migResult = runMigrations(db);

  if (cfg.autoSeedIfEmpty) {
    const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    if (userCount === 0) {
      seedDatabase(db);
      console.log('[BATON Server] Auto-seeded synthetic demo data into empty database.');
    }
  }

  const server = createApp(db);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[BATON Server] Listening on http://${cfg.host}:${cfg.port}`);
    console.log(`[BATON Server] Database: ${cfg.dbPath} (${migResult.applied.length} migrations active)`);
    console.log(`[BATON Server] Private Storage: ${cfg.privateStorageDir}`);
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
