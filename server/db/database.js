'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { getConfig } = require('../config');

let activeDb = null;
let activeDbPath = null;

function openDatabase(customDbPath) {
  const cfg = getConfig(customDbPath ? { dbPath: customDbPath } : {});
  const targetPath = cfg.dbPath;

  if (activeDb && activeDbPath === targetPath) {
    return activeDb;
  }

  if (activeDb) {
    try {
      activeDb.close();
    } catch (_) {
      // ignore already closed
    }
    activeDb = null;
    activeDbPath = null;
  }

  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(targetPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');

  activeDb = db;
  activeDbPath = targetPath;
  return db;
}

function closeDatabase() {
  if (activeDb) {
    try {
      activeDb.close();
    } catch (_) {
      // ignore
    }
    activeDb = null;
    activeDbPath = null;
  }
}

function runMigrations(dbInstance) {
  const db = dbInstance || openDatabase();
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    db
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((r) => r.id)
  );

  const newlyApplied = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        file,
        new Date().toISOString()
      );
      db.exec('COMMIT');
      newlyApplied.push(file);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    totalMigrations: files.length,
    newlyApplied,
    alreadyApplied: files.filter((f) => applied.has(f))
  };
}

function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      // ignore rollback error
    }
    throw err;
  }
}

module.exports = {
  openDatabase,
  closeDatabase,
  runMigrations,
  withTransaction
};
