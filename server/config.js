'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

function loadDotEnv() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadDotEnv();

function getConfig(overrides = {}) {
  const dbPathRaw = overrides.dbPath || process.env.DB_PATH || './data/baton.db';
  const storageDirRaw = overrides.privateStorageDir || process.env.PRIVATE_STORAGE_DIR || './storage/private_uploads';
  const extraOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedOrigins = Array.from(
    new Set(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost', ...extraOrigins])
  );
  return {
    rootDir: ROOT_DIR,
    port: Number(overrides.port ?? process.env.PORT ?? 3000),
    host: overrides.host || process.env.HOST || '127.0.0.1',
    dbPath: path.isAbsolute(dbPathRaw) ? dbPathRaw : path.resolve(ROOT_DIR, dbPathRaw),
    privateStorageDir: path.isAbsolute(storageDirRaw) ? storageDirRaw : path.resolve(ROOT_DIR, storageDirRaw),
    maxUploadBytes: Number(overrides.maxUploadBytes ?? process.env.MAX_UPLOAD_BYTES ?? 2 * 1024 * 1024),
    allowedOrigins,
    autoSeedIfEmpty:
      overrides.autoSeedIfEmpty !== undefined
        ? Boolean(overrides.autoSeedIfEmpty)
        : process.env.AUTO_SEED_IF_EMPTY !== 'false',
    geminiApiKey: overrides.geminiApiKey ?? process.env.GEMINI_API_KEY ?? '',
    geminiModel: overrides.geminiModel || process.env.GEMINI_MODEL || 'gemini-2.5-flash'
  };
}

module.exports = { getConfig, ROOT_DIR };
