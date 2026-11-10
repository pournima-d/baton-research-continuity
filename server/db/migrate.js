'use strict';

const fs = require('node:fs');
const { getConfig } = require('../config');
const { openDatabase, closeDatabase, runMigrations } = require('./database');

function executeMigrationCli(args = process.argv.slice(2)) {
  const clean = args.includes('--clean');
  const cfg = getConfig();

  if (clean) {
    closeDatabase();
    for (const suffix of ['', '-shm', '-wal']) {
      const candidate = cfg.dbPath + suffix;
      if (fs.existsSync(candidate)) {
        fs.unlinkSync(candidate);
      }
    }
    console.log(`[BATON Migrate] Removed existing database at ${cfg.dbPath}`);
  }

  const db = openDatabase(cfg.dbPath);
  const result = runMigrations(db);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);

  console.log(`[BATON Migrate] Database path: ${cfg.dbPath}`);
  console.log(`[BATON Migrate] Newly applied migrations (${result.newlyApplied.length}): ${result.newlyApplied.join(', ') || 'none'}`);
  console.log(`[BATON Migrate] Verified tables (${tables.length}): ${tables.join(', ')}`);

  return { dbPath: cfg.dbPath, ...result, tables };
}

if (require.main === module) {
  try {
    executeMigrationCli();
    closeDatabase();
  } catch (err) {
    console.error('[BATON Migrate] Migration failed:', err.message);
    process.exit(1);
  }
}

module.exports = { executeMigrationCli };
