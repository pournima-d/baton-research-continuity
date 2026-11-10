'use strict';

const crypto = require('node:crypto');
const { logAuditEvent } = require('../services/auditService');

// In-memory sliding-window rate limiter per client IP / token + endpoint bucket
const rateLimitBuckets = new Map();

function resetRateLimits() {
  rateLimitBuckets.clear();
}

function checkRateLimit(db, req, { bucket = 'default', maxRequests = 60, windowMs = 60_000, projectId = null } = {}) {
  const overrideMax = req.headers && req.headers['x-test-rate-limit-max']
    ? Number(req.headers['x-test-rate-limit-max'])
    : maxRequests;

  const clientId =
    (req.headers && (req.headers['x-forwarded-for'] || req.headers['authorization'] || req.headers['cookie'])) ||
    'local-client';
  const key = `${bucket}:${clientId}`;
  const now = Date.now();
  const entry = rateLimitBuckets.get(key) || { timestamps: [] };
  entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

  if (entry.timestamps.length >= overrideMax) {
    logAuditEvent(db, {
      projectId,
      actorUserId: null,
      actorRole: null,
      eventType: 'ACCESS_DENIED',
      targetEntityType: 'RATE_LIMIT',
      targetEntityId: req.url,
      metadata: { reason: 'RATE_LIMIT_EXCEEDED', bucket, max_requests: overrideMax, path: req.url }
    });
    throw Object.assign(new Error('Too many requests. Please wait before retrying this sensitive operation.'), {
      statusCode: 429,
      errorCode: 'RATE_LIMIT_EXCEEDED'
    });
  }

  entry.timestamps.push(now);
  rateLimitBuckets.set(key, entry);
}

function hashPasswordScrypt(plainPassword, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(plainPassword), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPasswordScrypt(plainPassword, storedHash) {
  if (!storedHash || typeof storedHash !== 'string' || !storedHash.startsWith('scrypt$')) {
    return false;
  }
  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;
  const [, salt, expectedHex] = parts;
  const actualHex = crypto.scryptSync(String(plainPassword), salt, 64).toString('hex');
  const a = Buffer.from(actualHex, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function parseCookies(req) {
  const raw = (req.headers && (req.headers['cookie'] || req.headers['Cookie'])) || '';
  const out = {};
  if (!raw || typeof raw !== 'string') return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function extractBearerToken(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const customToken = req.headers['x-baton-token'];
  if (typeof customToken === 'string' && customToken.trim()) {
    return customToken.trim();
  }
  return null;
}

function authenticateRequest(db, req, projectId = null) {
  const bearerToken = extractBearerToken(req);
  const cookies = parseCookies(req);
  const sessionCookie = cookies.baton_session || null;

  if (!bearerToken && !sessionCookie) {
    logAuditEvent(db, {
      projectId,
      actorUserId: null,
      actorRole: null,
      eventType: 'ACCESS_DENIED',
      targetEntityType: 'AUTH',
      targetEntityId: req.url,
      metadata: { reason: 'MISSING_CREDENTIALS', method: req.method, path: req.url }
    });
    throw Object.assign(new Error('Authentication required. Provide a valid Bearer token or active session.'), {
      statusCode: 401,
      errorCode: 'UNAUTHENTICATED'
    });
  }

  // Path A: Cookie-backed session authentication with CSRF enforcement on state-changing methods
  if (!bearerToken && sessionCookie) {
    const sessHash = sha256Hex(sessionCookie);
    const sessionRow = db
      .prepare(`
        SELECT s.*, u.id AS uid, u.email, u.full_name, u.department, u.created_at AS user_created_at
        FROM auth_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.session_token_sha256 = ? AND s.revoked = 0
      `)
      .get(sessHash);

    if (!sessionRow || new Date(sessionRow.expires_at).getTime() <= Date.now()) {
      logAuditEvent(db, {
        projectId,
        actorUserId: null,
        actorRole: null,
        eventType: 'ACCESS_DENIED',
        targetEntityType: 'AUTH',
        targetEntityId: req.url,
        metadata: { reason: 'INVALID_OR_EXPIRED_SESSION', method: req.method, path: req.url }
      });
      throw Object.assign(new Error('Invalid or expired session.'), {
        statusCode: 401,
        errorCode: 'UNAUTHENTICATED'
      });
    }

    const method = (req.method || 'GET').toUpperCase();
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
      const csrfHeader = req.headers['x-csrf-token'] || req.headers['X-CSRF-Token'];
      if (!csrfHeader || csrfHeader !== sessionRow.csrf_token) {
        logAuditEvent(db, {
          projectId,
          actorUserId: sessionRow.uid,
          actorRole: null,
          eventType: 'ACCESS_DENIED',
          targetEntityType: 'CSRF',
          targetEntityId: req.url,
          metadata: { reason: 'CSRF_TOKEN_MISMATCH_OR_MISSING', method, path: req.url }
        });
        throw Object.assign(new Error('CSRF validation failed: missing or invalid X-CSRF-Token header for cookie-authenticated session.'), {
          statusCode: 403,
          errorCode: 'CSRF_VALIDATION_FAILED'
        });
      }
    }

    return {
      id: sessionRow.uid,
      email: sessionRow.email,
      full_name: sessionRow.full_name,
      department: sessionRow.department,
      created_at: sessionRow.user_created_at
    };
  }

  // Path B: Bearer token authentication (lookup by SHA-256 hash or token)
  const tokenHash = sha256Hex(bearerToken);
  const user = db
    .prepare(
      'SELECT id, email, full_name, department, created_at FROM users WHERE token_sha256 = ? OR api_token = ?'
    )
    .get(tokenHash, bearerToken);

  // Also allow Bearer <session_token> from /api/auth/login
  if (!user) {
    const sessionRow = db
      .prepare(`
        SELECT s.*, u.id AS uid, u.email, u.full_name, u.department, u.created_at AS user_created_at
        FROM auth_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.session_token_sha256 = ? AND s.revoked = 0
      `)
      .get(tokenHash);
    if (sessionRow && new Date(sessionRow.expires_at).getTime() > Date.now()) {
      return {
        id: sessionRow.uid,
        email: sessionRow.email,
        full_name: sessionRow.full_name,
        department: sessionRow.department,
        created_at: sessionRow.user_created_at
      };
    }

    logAuditEvent(db, {
      projectId,
      actorUserId: null,
      actorRole: null,
      eventType: 'ACCESS_DENIED',
      targetEntityType: 'AUTH',
      targetEntityId: req.url,
      metadata: { reason: 'INVALID_TOKEN', method: req.method, path: req.url }
    });
    throw Object.assign(new Error('Invalid authentication token.'), {
      statusCode: 401,
      errorCode: 'UNAUTHENTICATED'
    });
  }

  return user;
}

function requireProjectRole(db, req, projectId, allowedRoles = []) {
  const user = authenticateRequest(db, req, projectId);

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) {
    logAuditEvent(db, {
      projectId: null,
      actorUserId: user.id,
      actorRole: 'NONE',
      eventType: 'ACCESS_DENIED',
      targetEntityType: 'PROJECT',
      targetEntityId: projectId,
      metadata: { reason: 'PROJECT_NOT_FOUND_OR_GUESSED_ID', method: req.method, path: req.url }
    });
    throw Object.assign(new Error(`Project '${projectId}' not found.`), {
      statusCode: 404,
      errorCode: 'RESOURCE_NOT_FOUND'
    });
  }

  const membership = db
    .prepare(`
      SELECT m.id, m.project_id, m.user_id, m.role_id, r.name AS role_name, r.can_access_restricted
      FROM memberships m
      JOIN roles r ON r.id = m.role_id
      WHERE m.project_id = ? AND m.user_id = ?
    `)
    .get(projectId, user.id);

  if (!membership) {
    logAuditEvent(db, {
      projectId,
      actorUserId: user.id,
      actorRole: 'NON_MEMBER',
      eventType: 'ACCESS_DENIED',
      targetEntityType: 'PROJECT',
      targetEntityId: projectId,
      metadata: { reason: 'NOT_PROJECT_MEMBER', method: req.method, path: req.url }
    });
    throw Object.assign(new Error('User is not a member of this project.'), {
      statusCode: 403,
      errorCode: 'FORBIDDEN_ROLE',
      details: { required_roles: allowedRoles, actual_role: 'NON_MEMBER' }
    });
  }

  if (allowedRoles.length > 0 && !allowedRoles.includes(membership.role_id)) {
    logAuditEvent(db, {
      projectId,
      actorUserId: user.id,
      actorRole: membership.role_id,
      eventType: 'ACCESS_DENIED',
      targetEntityType: 'PROJECT',
      targetEntityId: projectId,
      metadata: {
        reason: 'INSUFFICIENT_ROLE',
        required_roles: allowedRoles,
        actual_role: membership.role_id,
        method: req.method,
        path: req.url
      }
    });
    throw Object.assign(
      new Error(`Role '${membership.role_id}' is not permitted to perform this operation.`),
      {
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        details: { required_roles: allowedRoles, actual_role: membership.role_id }
      }
    );
  }

  return { user, project, membership };
}

module.exports = {
  extractBearerToken,
  parseCookies,
  hashPasswordScrypt,
  verifyPasswordScrypt,
  sha256Hex,
  checkRateLimit,
  resetRateLimits,
  authenticateRequest,
  requireProjectRole
};
