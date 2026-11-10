'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getConfig } = require('../config');

const ALLOWED_SOURCE_TYPES = new Set([
  'PDF_DOCUMENT',
  'LAB_NOTE',
  'CSV_DATASET',
  'JSON_RECORDS'
]);

const EXTENSIONS_BY_TYPE = {
  PDF_DOCUMENT: new Set(['.pdf']),
  LAB_NOTE: new Set(['.md', '.markdown', '.txt']),
  CSV_DATASET: new Set(['.csv']),
  JSON_RECORDS: new Set(['.json'])
};

const ALL_SUPPORTED_EXTENSIONS = new Set(['.pdf', '.md', '.markdown', '.txt', '.csv', '.json']);

const ALLOWED_MIMES_BY_TYPE = {
  PDF_DOCUMENT: new Set(['application/pdf', 'text/plain']),
  LAB_NOTE: new Set(['text/markdown', 'text/plain', 'text/x-markdown']),
  CSV_DATASET: new Set(['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel']),
  JSON_RECORDS: new Set(['application/json', 'text/json', 'text/plain'])
};

const DEFAULT_MIME_BY_TYPE = {
  PDF_DOCUMENT: 'application/pdf',
  LAB_NOTE: 'text/markdown',
  CSV_DATASET: 'text/csv',
  JSON_RECORDS: 'application/json'
};

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /system\s+prompt\s*:/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /<\|im_start\|>/i,
  /<\/system>/i,
  /(?:call|invoke|trigger|execute)\s+tool\s*[:(]/i,
  /override\s+system\s+instructions/i,
  /set\s+approval_status\s*=\s*['"]?APPROVED/i
];

function detectPromptInjectionPattern(rawContent) {
  const matched = [];
  for (const rx of PROMPT_INJECTION_PATTERNS) {
    const m = rawContent.match(rx);
    if (m) matched.push(m[0]);
  }
  return {
    hasPromptInjectionPattern: matched.length > 0 ? 1 : 0,
    matchedPatterns: matched
  };
}

function validateAndSanitizeFileName(rawName, sourceType) {
  if (typeof rawName !== 'string' || !rawName.trim()) {
    throw Object.assign(new Error('file_name is required and must be a non-empty string.'), {
      statusCode: 400,
      errorCode: 'INVALID_FILE_NAME'
    });
  }

  const trimmed = rawName.trim();
  if (trimmed.length > 128) {
    throw Object.assign(new Error('file_name exceeds maximum length of 128 characters.'), {
      statusCode: 400,
      errorCode: 'UNSAFE_FILENAME'
    });
  }

  // Explicitly reject path traversal, directory separators, null bytes, or unsafe shell/HTML characters
  if (
    trimmed.includes('..') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0') ||
    /[<>|:"?*;`&$]/.test(trimmed) ||
    trimmed.startsWith('.')
  ) {
    throw Object.assign(
      new Error(`Rejected unsafe file_name '${trimmed}'. Path traversal ('..', '/', '\\') and special characters are prohibited.`),
      { statusCode: 400, errorCode: 'UNSAFE_FILENAME' }
    );
  }

  const ext = path.extname(trimmed).toLowerCase();
  if (!ext || !ALL_SUPPORTED_EXTENSIONS.has(ext)) {
    throw Object.assign(
      new Error(`Unsupported file extension '${ext || 'none'}'. Supported extensions: .pdf, .md, .txt, .csv, .json.`),
      { statusCode: 400, errorCode: 'UNSUPPORTED_FILE_TYPE' }
    );
  }

  if (sourceType && EXTENSIONS_BY_TYPE[sourceType] && !EXTENSIONS_BY_TYPE[sourceType].has(ext)) {
    throw Object.assign(
      new Error(
        `File extension '${ext}' does not match source_type '${sourceType}'. Allowed extensions for ${sourceType}: ${Array.from(EXTENSIONS_BY_TYPE[sourceType]).join(', ')}.`
      ),
      { statusCode: 400, errorCode: 'UNSUPPORTED_FILE_TYPE' }
    );
  }

  return {
    safeFileName: trimmed,
    fileExtension: ext
  };
}

function validateMimeType(mimeType, sourceType) {
  if (!mimeType) {
    return DEFAULT_MIME_BY_TYPE[sourceType] || 'text/plain';
  }
  const normalized = String(mimeType).split(';')[0].trim().toLowerCase();
  const allowedSet = ALLOWED_MIMES_BY_TYPE[sourceType];
  if (!allowedSet || !allowedSet.has(normalized)) {
    throw Object.assign(
      new Error(
        `Unsupported MIME type '${normalized}' for source_type '${sourceType}'. Allowed: ${allowedSet ? Array.from(allowedSet).join(', ') : 'none'}.`
      ),
      { statusCode: 400, errorCode: 'UNSUPPORTED_MIME_TYPE' }
    );
  }
  return normalized;
}

function storePrivateUpload({ fileName, sourceType, rawContent, mimeType, maxBytesOverride = null }) {
  const cfg = getConfig();
  if (!ALLOWED_SOURCE_TYPES.has(sourceType)) {
    throw Object.assign(
      new Error(`Invalid source_type '${sourceType}'. Allowed: ${Array.from(ALLOWED_SOURCE_TYPES).join(', ')}`),
      { statusCode: 400, errorCode: 'INVALID_SOURCE_TYPE' }
    );
  }

  const { safeFileName, fileExtension } = validateAndSanitizeFileName(fileName, sourceType);
  const validatedMime = validateMimeType(mimeType, sourceType);

  if (typeof rawContent !== 'string' || !rawContent.trim()) {
    throw Object.assign(new Error('Uploaded file is empty. Provide non-empty source content.'), {
      statusCode: 400,
      errorCode: 'EMPTY_SOURCE_CONTENT'
    });
  }

  const maxAllowed = maxBytesOverride !== null ? Number(maxBytesOverride) : cfg.maxUploadBytes;
  const buffer = Buffer.from(rawContent, 'utf8');
  if (buffer.byteLength > maxAllowed) {
    throw Object.assign(
      new Error(`Upload size (${buffer.byteLength} bytes) exceeds maximum allowed limit of ${maxAllowed} bytes.`),
      { statusCode: 413, errorCode: 'UPLOAD_TOO_LARGE' }
    );
  }

  const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const injectionCheck = detectPromptInjectionPattern(rawContent);

  // Non-guessable opaque storage key outside any public directory
  const opaqueId = crypto.randomBytes(24).toString('hex');
  const storageKey = `priv_${opaqueId}.dat`;

  if (!fs.existsSync(cfg.privateStorageDir)) {
    fs.mkdirSync(cfg.privateStorageDir, { recursive: true });
  }

  const targetPath = path.join(cfg.privateStorageDir, storageKey);
  fs.writeFileSync(targetPath, buffer, { mode: 0o600 });

  return {
    safeFileName,
    fileExtension,
    mimeType: validatedMime,
    byteSize: buffer.byteLength,
    storageKey,
    contentHash,
    hasPromptInjectionPattern: injectionCheck.hasPromptInjectionPattern,
    matchedInjectionPatterns: injectionCheck.matchedPatterns
  };
}

module.exports = {
  ALLOWED_SOURCE_TYPES,
  validateAndSanitizeFileName,
  validateMimeType,
  detectPromptInjectionPattern,
  storePrivateUpload
};
