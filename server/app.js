'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { openDatabase, withTransaction } = require('./db/database');
const { seedDatabase } = require('./db/seed');
const { getConfig } = require('./config');
const {
  authenticateRequest,
  requireProjectRole,
  verifyPasswordScrypt,
  sha256Hex,
  parseCookies,
  checkRateLimit,
  resetRateLimits
} = require('./middleware/authRbac');
const { storePrivateUpload, ALLOWED_SOURCE_TYPES } = require('./services/storageService');
const { indexSourceSpans } = require('./services/spanIndexer');
const {
  VALID_RECORD_TYPES,
  VALID_EVIDENCE_STATUSES,
  VALID_APPROVAL_STATUSES,
  rebuildProjectContinuityEdges,
  runReconstruction
} = require('./services/aiReconstructor');
const {
  CANONICAL_EVIDENCE_STATE_DEFINITIONS,
  EPISTEMIC_CITATION_NOTICE,
  normalizeEvidenceStateInput,
  inspectAndEnrichRecord,
  flagCitationLink
} = require('./services/evidenceInspector');
const {
  RECEIPT_DISCLAIMER,
  buildContinuationPlan,
  buildRoleFilteredHandoverResponse
} = require('./services/handoverService');
const {
  issueStepUpChallenge,
  verifyStepUpAction,
  validateStepUpToken,
  listStepUpEvents
} = require('./services/stepUpService');
const { logAuditEvent } = require('./services/auditService');

const ALL_PROJECT_ROLES = ['PI_LEAD', 'RESEARCHER', 'REVIEWER', 'INCOMING_MEMBER', 'AUDITOR'];

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'",
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function sanitizeErrorMessage(rawMessage) {
  if (!rawMessage || typeof rawMessage !== 'string') {
    return 'An unexpected error occurred.';
  }
  // Never leak file-system paths, stack trace frames, SQLite internal details, or API keys
  return rawMessage
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '[REDACTED_PATH]')
    .replace(/\/Users\/[^\s'"]+/g, '[REDACTED_PATH]')
    .replace(/\bat\s+[^\n]+/g, '')
    .trim();
}

function sendError(res, err) {
  const statusCode = err.statusCode || 500;
  const errorCode = err.errorCode || (statusCode === 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED');
  const safeMessage =
    statusCode === 500
      ? 'An internal server error occurred. Detailed diagnostics have been withheld.'
      : sanitizeErrorMessage(err.message);
  const payload = {
    error: {
      code: errorCode,
      message: safeMessage,
      ...(err.details && statusCode !== 500 ? { details: err.details } : {})
    }
  };
  sendJson(res, statusCode, payload);
}

function readJsonBody(req, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(
          Object.assign(new Error('Request JSON payload exceeds size limit.'), {
            statusCode: 400,
            errorCode: 'PAYLOAD_TOO_LARGE'
          })
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(
            Object.assign(new Error('Request body must be a JSON object.'), {
              statusCode: 400,
              errorCode: 'INVALID_PAYLOAD'
            })
          );
          return;
        }
        resolve(parsed);
      } catch (e) {
        reject(
          Object.assign(new Error(`Malformed JSON body: ${e.message}`), {
            statusCode: 400,
            errorCode: 'INVALID_PAYLOAD'
          })
        );
      }
    });
    req.on('error', reject);
  });
}

function rejectTruthProbabilityFields(body) {
  const forbiddenKeys = [
    'truth_probability',
    'confidence_percentage',
    'confidence_score',
    'truth_score',
    'probability_pct'
  ];
  for (const key of forbiddenKeys) {
    if (body[key] !== undefined) {
      throw Object.assign(
        new Error(`Field '${key}' is prohibited. BATON uses categorical evidence_status only and never invents truth-probability percentages.`),
        { statusCode: 422, errorCode: 'INVALID_EVIDENCE_STATUS' }
      );
    }
  }
  if (typeof body.evidence_status === 'string' && /%|\d/.test(body.evidence_status)) {
    throw Object.assign(
      new Error('evidence_status must be a categorical status, not a percentage or number.'),
      { statusCode: 422, errorCode: 'INVALID_EVIDENCE_STATUS' }
    );
  }
}

function enrichRecordWithLinks(db, record, callerRole) {
  return inspectAndEnrichRecord(db, record, callerRole);
}

function classifyHandoverSection(recordType) {
  if (['EXPERIMENT', 'PROTOCOL', 'METHOD', 'DECISION', 'TASK', 'CONTACT'].includes(recordType)) {
    return 'PROTOCOLS_METHODS';
  }
  if (['RISK', 'GAP', 'QUESTION', 'DEPENDENCY', 'OPEN_QUESTION', 'RISK_LIMITATION'].includes(recordType)) {
    return 'OPEN_RISKS_GAPS';
  }
  return 'CORE_FINDINGS';
}

function createApp(customDb = null) {
  const getDb = () => customDb || openDatabase();

  async function handleRequest(req, res) {
    const db = getDb();
    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
    const method = req.method.toUpperCase();

    try {
      // Safe CORS enforcement: reject untrusted cross-origin requests; never emit wildcard Access-Control-Allow-Origin: *
      const origin = req.headers && (req.headers['origin'] || req.headers['Origin']);
      if (origin) {
        const cfg = getConfig();
        const allowedOrigins = new Set(cfg.allowedOrigins);
        if (!allowedOrigins.has(origin)) {
          logAuditEvent(db, {
            projectId: null,
            actorUserId: null,
            actorRole: null,
            eventType: 'ACCESS_DENIED',
            targetEntityType: 'CORS',
            targetEntityId: pathname,
            metadata: { reason: 'DISALLOWED_ORIGIN', origin, method }
          });
          throw Object.assign(new Error('Cross-origin request from untrusted origin is forbidden.'), {
            statusCode: 403,
            errorCode: 'FORBIDDEN_CORS_ORIGIN'
          });
        }
      }

      // Prevent any direct access to /storage/* paths and log ACCESS_DENIED
      if (pathname.startsWith('/storage')) {
        logAuditEvent(db, {
          projectId: null,
          actorUserId: null,
          actorRole: null,
          eventType: 'ACCESS_DENIED',
          targetEntityType: 'PRIVATE_FILE',
          targetEntityId: pathname,
          metadata: { reason: 'DIRECT_STORAGE_PATH_FORBIDDEN', method, path: pathname }
        });
        throw Object.assign(new Error('Direct access to private upload storage is forbidden.'), {
          statusCode: 403,
          errorCode: 'FORBIDDEN_STORAGE_PATH'
        });
      }

      // Health check (verifies SQLite migrations and private storage readiness)
      if (method === 'GET' && pathname === '/api/health') {
        const cfg = getConfig();
        if (!fs.existsSync(cfg.privateStorageDir)) {
          fs.mkdirSync(cfg.privateStorageDir, { recursive: true });
        }
        const migCount = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c;
        return sendJson(res, 200, {
          status: 'ok',
          service: 'baton-api',
          version: '2.0.0',
          database: 'connected',
          migrations_applied: migCount,
          private_storage: 'ready'
        });
      }

      // Explicit demo seed reset endpoint (kept separate from normal runtime operations)
      if (method === 'POST' && pathname === '/api/demo/reset') {
        resetRateLimits();
        const summary = seedDatabase(db);
        return sendJson(res, 200, { status: 'seeded', summary });
      }

      // POST /api/auth/login (Password-authenticated session creation with HttpOnly, SameSite=Strict, Secure cookies & CSRF token)
      if (method === 'POST' && pathname === '/api/auth/login') {
        checkRateLimit(db, req, { bucket: 'auth_login', maxRequests: 15, windowMs: 60_000 });
        const body = await readJsonBody(req);
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        const password = typeof body.password === 'string' ? body.password : '';

        if (!email || !password) {
          throw Object.assign(new Error('Both email and password are required.'), {
            statusCode: 400,
            errorCode: 'INVALID_PAYLOAD'
          });
        }

        const userRow = db
          .prepare('SELECT id, email, full_name, department, password_hash, created_at FROM users WHERE LOWER(email) = ?')
          .get(email);

        if (!userRow || !verifyPasswordScrypt(password, userRow.password_hash)) {
          logAuditEvent(db, {
            projectId: null,
            actorUserId: userRow ? userRow.id : null,
            actorRole: null,
            eventType: 'ACCESS_DENIED',
            targetEntityType: 'AUTH',
            targetEntityId: email,
            metadata: { reason: 'INVALID_CREDENTIALS', path: pathname }
          });
          throw Object.assign(new Error('Invalid email or password.'), {
            statusCode: 401,
            errorCode: 'INVALID_CREDENTIALS'
          });
        }

        const rawSessionToken = `sess_${crypto.randomBytes(24).toString('hex')}`;
        const csrfToken = `csrf_${crypto.randomBytes(18).toString('hex')}`;
        const sessionId = `asn_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();

        db.prepare(`
          INSERT INTO auth_sessions (
            id, user_id, session_token_sha256, csrf_token, expires_at, revoked, created_at
          ) VALUES (?, ?, ?, ?, ?, 0, ?)
        `).run(sessionId, userRow.id, sha256Hex(rawSessionToken), csrfToken, expiresAt, now.toISOString());

        logAuditEvent(db, {
          projectId: null,
          actorUserId: userRow.id,
          actorRole: null,
          eventType: 'SESSION_LOGIN',
          targetEntityType: 'AUTH_SESSION',
          targetEntityId: sessionId,
          metadata: { email: userRow.email }
        });

        const cookieHeader = [
          `baton_session=${encodeURIComponent(rawSessionToken)}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=28800`,
          `baton_csrf=${encodeURIComponent(csrfToken)}; SameSite=Strict; Secure; Path=/; Max-Age=28800`
        ];

        return sendJson(
          res,
          200,
          {
            user: {
              id: userRow.id,
              email: userRow.email,
              full_name: userRow.full_name,
              department: userRow.department
            },
            session_token: rawSessionToken,
            csrf_token: csrfToken,
            expires_at: expiresAt
          },
          { 'Set-Cookie': cookieHeader }
        );
      }

      // POST /api/auth/logout
      if (method === 'POST' && pathname === '/api/auth/logout') {
        const user = authenticateRequest(db, req);
        const cookies = parseCookies(req);
        if (cookies.baton_session) {
          db.prepare('UPDATE auth_sessions SET revoked = 1 WHERE session_token_sha256 = ?').run(
            sha256Hex(cookies.baton_session)
          );
        }
        return sendJson(
          res,
          200,
          { status: 'logged_out', user_id: user.id },
          {
            'Set-Cookie': [
              'baton_session=; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=0',
              'baton_csrf=; SameSite=Strict; Secure; Path=/; Max-Age=0'
            ]
          }
        );
      }

      // Demo personas list (safe metadata for evaluation UI switcher)
      if (method === 'GET' && pathname === '/api/auth/demo-users') {
        const users = db
          .prepare(`
            SELECT u.id, u.email, u.full_name, u.department, u.api_token,
                   m.project_id, m.role_id, r.name AS role_name
            FROM users u
            LEFT JOIN memberships m ON m.user_id = u.id
            LEFT JOIN roles r ON r.id = m.role_id
            ORDER BY u.id ASC
          `)
          .all();
        return sendJson(res, 200, { demo_users: users });
      }

      // Current session identity
      if (method === 'GET' && pathname === '/api/auth/session') {
        const user = authenticateRequest(db, req);
        const memberships = db
          .prepare(`
            SELECT m.id, m.project_id, p.name AS project_name, m.role_id, r.name AS role_name, r.can_access_restricted
            FROM memberships m
            JOIN projects p ON p.id = m.project_id
            JOIN roles r ON r.id = m.role_id
            WHERE m.user_id = ?
          `)
          .all(user.id);
        return sendJson(res, 200, { user, memberships });
      }

      // GET /api/projects
      if (method === 'GET' && pathname === '/api/projects') {
        const user = authenticateRequest(db, req);
        const rows = db
          .prepare(`
            SELECT p.*, m.role_id, r.name AS role_name
            FROM projects p
            JOIN memberships m ON m.project_id = p.id
            JOIN roles r ON r.id = m.role_id
            WHERE m.user_id = ?
            ORDER BY p.created_at DESC
          `)
          .all(user.id);

        const projects = rows.map((p) => {
          const sourcesCount = db
            .prepare(
              p.role_id === 'PI_LEAD'
                ? 'SELECT COUNT(*) AS c FROM sources WHERE project_id = ?'
                : "SELECT COUNT(*) AS c FROM sources WHERE project_id = ? AND visibility_level = 'PROJECT_SHARED'"
            )
            .get(p.id).c;
          const recordsCount = db.prepare('SELECT COUNT(*) AS c FROM extracted_records WHERE project_id = ?').get(p.id).c;
          const handoversCount = db.prepare('SELECT COUNT(*) AS c FROM handover_packages WHERE project_id = ?').get(p.id).c;
          return {
            ...p,
            counts: { sources: sourcesCount, records: recordsCount, handovers: handoversCount }
          };
        });

        return sendJson(res, 200, { projects });
      }

      // POST /api/projects
      if (method === 'POST' && pathname === '/api/projects') {
        const user = authenticateRequest(db, req);
        const body = await readJsonBody(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const description = typeof body.description === 'string' ? body.description.trim() : '';
        if (!name || !description) {
          throw Object.assign(new Error('Both name and description are required to create a project.'), {
            statusCode: 400,
            errorCode: 'INVALID_PAYLOAD'
          });
        }

        const slugBase = (typeof body.slug === 'string' && body.slug.trim() ? body.slug.trim() : name)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 48);
        const slug = `${slugBase || 'project'}-${crypto.randomBytes(3).toString('hex')}`;
        const projectId = `prj_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        const now = new Date().toISOString();

        const created = withTransaction(db, () => {
          db.prepare(`
            INSERT INTO projects (id, slug, name, description, owner_user_id, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)
          `).run(projectId, slug, name, description, user.id, now);

          const membershipId = `mem_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
          db.prepare(`
            INSERT INTO memberships (id, project_id, user_id, role_id, added_by_user_id, created_at)
            VALUES (?, ?, ?, 'PI_LEAD', ?, ?)
          `).run(membershipId, projectId, user.id, user.id, now);

          logAuditEvent(db, {
            projectId,
            actorUserId: user.id,
            actorRole: 'PI_LEAD',
            eventType: 'PROJECT_CREATED',
            targetEntityType: 'PROJECT',
            targetEntityId: projectId,
            metadata: { slug, name }
          });

          return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
        });

        return sendJson(res, 201, { project: created, role_id: 'PI_LEAD' });
      }

      // Match /api/projects/:projectId...
      const projMatch = pathname.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
      if (projMatch) {
        const projectId = decodeURIComponent(projMatch[1]);
        const subPath = projMatch[2] || '';

        // GET /api/projects/:projectId
        if (method === 'GET' && subPath === '') {
          const { project, membership } = requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);
          const members = db
            .prepare(`
              SELECT m.id, m.user_id, u.full_name, u.email, u.department, m.role_id, r.name AS role_name, m.created_at
              FROM memberships m
              JOIN users u ON u.id = m.user_id
              JOIN roles r ON r.id = m.role_id
              WHERE m.project_id = ?
              ORDER BY m.created_at ASC
            `)
            .all(projectId);

          const totalSources = db.prepare('SELECT COUNT(*) AS c FROM sources WHERE project_id = ?').get(projectId).c;
          const sharedSources = db
            .prepare("SELECT COUNT(*) AS c FROM sources WHERE project_id = ? AND visibility_level = 'PROJECT_SHARED'")
            .get(projectId).c;
          const visibleSourceCount = membership.role_id === 'PI_LEAD' ? totalSources : sharedSources;
          const restrictedHiddenCount = membership.role_id === 'PI_LEAD' ? 0 : totalSources - sharedSources;

          const allRecords = db
            .prepare('SELECT id, record_type, evidence_status, approval_status FROM extracted_records WHERE project_id = ?')
            .all(projectId);

          const openLoopTypes = new Set(['GAP', 'RISK', 'QUESTION', 'TASK', 'DEPENDENCY', 'OPEN_QUESTION', 'RISK_LIMITATION']);
          const openLoopsCount = allRecords.filter(
            (r) =>
              openLoopTypes.has(r.record_type) ||
              ['UNVERIFIED', 'WEAK', 'CONTRADICTED', 'BROKEN_PROVENANCE'].includes(r.evidence_status) ||
              r.approval_status === 'NEEDS_REVISION'
          ).length;

          const pendingReviewsCount = allRecords.filter((r) =>
            ['DRAFT', 'PENDING_REVIEW', 'NEEDS_REVISION'].includes(r.approval_status)
          ).length;

          const approvedRecordsCount = allRecords.filter((r) => r.approval_status === 'APPROVED').length;

          const handovers = db
            .prepare('SELECT id, title, status, created_at, published_at, acknowledged_at FROM handover_packages WHERE project_id = ? ORDER BY created_at DESC')
            .all(projectId);

          const latestHandover = handovers[0] || null;

          const recentActivity = db
            .prepare(`
              SELECT ae.id, ae.event_type, ae.target_entity_type, ae.target_entity_id,
                     ae.actor_role, ae.created_at, u.full_name AS actor_name
              FROM audit_events ae
              LEFT JOIN users u ON u.id = ae.actor_user_id
              WHERE ae.project_id = ? AND ae.event_type != 'ACCESS_DENIED'
              ORDER BY ae.created_at DESC
              LIMIT 12
            `)
            .all(projectId);

          return sendJson(res, 200, {
            project,
            caller_membership: membership,
            memberships: members,
            dashboard: {
              source_count: visibleSourceCount,
              restricted_hidden_count: restrictedHiddenCount,
              total_records_count: allRecords.length,
              open_loops_count: openLoopsCount,
              pending_reviews_count: pendingReviewsCount,
              approved_records_count: approvedRecordsCount,
              handover_count: handovers.length,
              handover_status: latestHandover ? latestHandover.status : 'NONE',
              latest_handover: latestHandover
            },
            recent_activity: recentActivity
          });
        }

        // GET /api/projects/:projectId/memberships
        if (method === 'GET' && subPath === '/memberships') {
          requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);
          const memberships = db
            .prepare(`
              SELECT m.id, m.project_id, m.user_id, u.full_name, u.email, u.department, m.role_id, r.name AS role_name, m.created_at
              FROM memberships m
              JOIN users u ON u.id = m.user_id
              JOIN roles r ON r.id = m.role_id
              WHERE m.project_id = ?
              ORDER BY m.created_at ASC
            `)
            .all(projectId);
          return sendJson(res, 200, { memberships });
        }

        // POST /api/projects/:projectId/memberships
        if (method === 'POST' && subPath === '/memberships') {
          const { user } = requireProjectRole(db, req, projectId, ['PI_LEAD']);
          const body = await readJsonBody(req);
          const targetUserId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
          const roleId = typeof body.role_id === 'string' ? body.role_id.trim() : '';

          if (!targetUserId || !ALL_PROJECT_ROLES.includes(roleId)) {
            throw Object.assign(
              new Error(`Valid user_id and role_id (${ALL_PROJECT_ROLES.join(', ')}) are required.`),
              { statusCode: 400, errorCode: 'INVALID_PAYLOAD' }
            );
          }

          const targetUser = db.prepare('SELECT id, email, full_name FROM users WHERE id = ?').get(targetUserId);
          if (!targetUser) {
            throw Object.assign(new Error(`User '${targetUserId}' not found.`), {
              statusCode: 404,
              errorCode: 'RESOURCE_NOT_FOUND'
            });
          }

          const now = new Date().toISOString();
          const resultMembership = withTransaction(db, () => {
            const existing = db
              .prepare('SELECT id FROM memberships WHERE project_id = ? AND user_id = ?')
              .get(projectId, targetUserId);

            let memId;
            if (existing) {
              memId = existing.id;
              db.prepare('UPDATE memberships SET role_id = ?, added_by_user_id = ? WHERE id = ?').run(
                roleId,
                user.id,
                memId
              );
            } else {
              memId = `mem_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
              db.prepare(`
                INSERT INTO memberships (id, project_id, user_id, role_id, added_by_user_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
              `).run(memId, projectId, targetUserId, roleId, user.id, now);
            }

            logAuditEvent(db, {
              projectId,
              actorUserId: user.id,
              actorRole: 'PI_LEAD',
              eventType: 'MEMBERSHIP_UPDATED',
              targetEntityType: 'MEMBERSHIP',
              targetEntityId: memId,
              metadata: { target_user_id: targetUserId, role_id: roleId }
            });

            return db.prepare('SELECT * FROM memberships WHERE id = ?').get(memId);
          });

          return sendJson(res, 201, { membership: resultMembership });
        }

        // GET /api/projects/:projectId/sources
        if (method === 'GET' && subPath === '/sources') {
          const { membership } = requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);
          const allSources = db
            .prepare(`
              SELECT s.id, s.project_id, s.title, s.file_name, s.file_extension, s.mime_type, s.byte_size,
                     s.source_type, s.processing_status, s.processing_error,
                     s.page_count, s.row_count, s.has_prompt_injection_pattern,
                     s.visibility_level, s.exclude_from_ai, s.content_hash,
                     s.uploaded_by_user_id, u.full_name AS uploaded_by_name, s.created_at,
                     (SELECT COUNT(*) FROM source_spans sp WHERE sp.source_id = s.id) AS span_count
              FROM sources s
              JOIN users u ON u.id = s.uploaded_by_user_id
              WHERE s.project_id = ?
              ORDER BY s.created_at ASC
            `)
            .all(projectId);

          if (membership.role_id === 'PI_LEAD') {
            return sendJson(res, 200, {
              sources: allSources,
              restricted_hidden_count: 0
            });
          }

          const sharedSources = allSources.filter((s) => s.visibility_level === 'PROJECT_SHARED');
          const restrictedHiddenCount = allSources.length - sharedSources.length;
          return sendJson(res, 200, {
            sources: sharedSources,
            restricted_hidden_count: restrictedHiddenCount
          });
        }

        // POST /api/projects/:projectId/sources
        if (method === 'POST' && subPath === '/sources') {
          checkRateLimit(db, req, { bucket: 'source_upload', maxRequests: 60, windowMs: 60_000, projectId });
          const { user, membership } = requireProjectRole(db, req, projectId, ['PI_LEAD', 'RESEARCHER']);
          const body = await readJsonBody(req);

          const title = typeof body.title === 'string' ? body.title.trim() : '';
          const fileName = typeof body.file_name === 'string' ? body.file_name.trim() : '';
          const sourceType = typeof body.source_type === 'string' ? body.source_type.trim() : '';
          const rawContent = typeof body.raw_content === 'string' ? body.raw_content : '';
          const visibilityLevel = body.visibility_level || 'PROJECT_SHARED';
          const excludeFromAi =
            visibilityLevel === 'RESTRICTED_PI_ONLY' ? 1 : body.exclude_from_ai ? 1 : 0;

          if (!title) {
            throw Object.assign(new Error('title is required.'), {
              statusCode: 400,
              errorCode: 'INVALID_PAYLOAD'
            });
          }
          if (!ALLOWED_SOURCE_TYPES.has(sourceType)) {
            throw Object.assign(
              new Error(`source_type must be one of: ${Array.from(ALLOWED_SOURCE_TYPES).join(', ')}`),
              { statusCode: 400, errorCode: 'INVALID_SOURCE_TYPE' }
            );
          }
          if (!['PROJECT_SHARED', 'RESTRICTED_PI_ONLY'].includes(visibilityLevel)) {
            throw Object.assign(
              new Error("visibility_level must be 'PROJECT_SHARED' or 'RESTRICTED_PI_ONLY'."),
              { statusCode: 400, errorCode: 'INVALID_PAYLOAD' }
            );
          }

          const stored = storePrivateUpload({
            fileName,
            sourceType,
            rawContent,
            mimeType: body.mime_type,
            maxBytesOverride: body.max_bytes_override ?? null
          });

          // Deterministic duplicate check by SHA-256 content_hash within the same project
          const existingDuplicate = db
            .prepare('SELECT id, title, file_name, created_at FROM sources WHERE project_id = ? AND content_hash = ?')
            .get(projectId, stored.contentHash);

          if (existingDuplicate && body.allow_duplicate !== true) {
            logAuditEvent(db, {
              projectId,
              actorUserId: user.id,
              actorRole: membership.role_id,
              eventType: 'DUPLICATE_UPLOAD_REJECTED',
              targetEntityType: 'SOURCE',
              targetEntityId: existingDuplicate.id,
              metadata: {
                file_name: stored.safeFileName,
                content_hash: stored.contentHash,
                existing_source_id: existingDuplicate.id
              }
            });
            throw Object.assign(
              new Error(
                `Duplicate source content detected: matches existing source '${existingDuplicate.title}' (${existingDuplicate.id}). Pass allow_duplicate=true to override.`
              ),
              {
                statusCode: 409,
                errorCode: 'DUPLICATE_SOURCE',
                details: {
                  existing_source_id: existingDuplicate.id,
                  existing_title: existingDuplicate.title,
                  content_hash: stored.contentHash
                }
              }
            );
          }

          const sourceId = `src_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
          const now = new Date().toISOString();

          let createdSource;
          let createdSpans;
          try {
            const txOut = withTransaction(db, () => {
              db.prepare(`
                INSERT INTO sources (
                  id, project_id, title, file_name, file_extension, mime_type, byte_size, storage_key,
                  source_type, processing_status, processing_error,
                  visibility_level, exclude_from_ai, content_hash, raw_content,
                  has_prompt_injection_pattern, uploaded_by_user_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROCESSING', NULL, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                sourceId,
                projectId,
                title,
                stored.safeFileName,
                stored.fileExtension,
                stored.mimeType,
                stored.byteSize,
                stored.storageKey,
                sourceType,
                visibilityLevel,
                excludeFromAi,
                stored.contentHash,
                rawContent,
                stored.hasPromptInjectionPattern,
                user.id,
                now
              );

              const spans = indexSourceSpans(db, {
                sourceId,
                projectId,
                sourceType,
                rawContent
              });

              db.prepare("UPDATE sources SET processing_status = 'READY' WHERE id = ?").run(sourceId);

              if (stored.hasPromptInjectionPattern) {
                logAuditEvent(db, {
                  projectId,
                  actorUserId: user.id,
                  actorRole: membership.role_id,
                  eventType: 'UNTRUSTED_PROMPT_PATTERN_SANDBOXED',
                  targetEntityType: 'SOURCE',
                  targetEntityId: sourceId,
                  metadata: {
                    file_name: stored.safeFileName,
                    matched_patterns: stored.matchedInjectionPatterns,
                    action: 'TREATED_AS_LITERAL_DOCUMENT_CONTENT'
                  }
                });
              }

              logAuditEvent(db, {
                projectId,
                actorUserId: user.id,
                actorRole: membership.role_id,
                eventType: 'SOURCE_UPLOADED',
                targetEntityType: 'SOURCE',
                targetEntityId: sourceId,
                metadata: {
                  file_name: stored.safeFileName,
                  source_type: sourceType,
                  visibility_level: visibilityLevel,
                  span_count: spans.length,
                  has_prompt_injection_pattern: stored.hasPromptInjectionPattern
                }
              });

              const srcRow = db
                .prepare(`
                  SELECT id, project_id, title, file_name, file_extension, mime_type, byte_size,
                         source_type, processing_status, processing_error,
                         page_count, row_count, has_prompt_injection_pattern,
                         visibility_level, exclude_from_ai,
                         content_hash, uploaded_by_user_id, created_at
                  FROM sources WHERE id = ?
                `)
                .get(sourceId);

              return { createdSource: srcRow, createdSpans: spans };
            });
            createdSource = txOut.createdSource;
            createdSpans = txOut.createdSpans;
          } catch (procErr) {
            if (procErr.errorCode === 'SCANNED_PDF_NEEDS_OCR') {
              // Persist NEEDS_OCR status so the user/UI can inspect the honest status
              db.prepare(`
                INSERT INTO sources (
                  id, project_id, title, file_name, file_extension, mime_type, byte_size, storage_key,
                  source_type, processing_status, processing_error, page_count, row_count,
                  visibility_level, exclude_from_ai, content_hash, raw_content,
                  has_prompt_injection_pattern, uploaded_by_user_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEEDS_OCR', ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                sourceId,
                projectId,
                title,
                stored.safeFileName,
                stored.fileExtension,
                stored.mimeType,
                stored.byteSize,
                stored.storageKey,
                sourceType,
                procErr.message,
                visibilityLevel,
                excludeFromAi,
                stored.contentHash,
                rawContent,
                stored.hasPromptInjectionPattern,
                user.id,
                now
              );
              logAuditEvent(db, {
                projectId,
                actorUserId: user.id,
                actorRole: membership.role_id,
                eventType: 'SOURCE_NEEDS_OCR',
                targetEntityType: 'SOURCE',
                targetEntityId: sourceId,
                metadata: { file_name: stored.safeFileName, error: procErr.message }
              });
              procErr.details = {
                source_id: sourceId,
                processing_status: 'NEEDS_OCR',
                file_name: stored.safeFileName
              };
            }
            throw procErr;
          }

          return sendJson(res, 201, { source: createdSource, spans: createdSpans });
        }

        // Source detail, status, spans, file download, and retry routes: /sources/:sourceId[/status|/spans|/file|/retry]
        const srcMatch = subPath.match(/^\/sources\/([^/]+)(\/status|\/spans|\/file|\/retry)?$/);
        if (srcMatch && (method === 'GET' || (method === 'POST' && srcMatch[2] === '/retry'))) {
          const sourceId = decodeURIComponent(srcMatch[1]);
          const action = srcMatch[2] || '';

          if (action === '/retry' && method === 'POST') {
            const { user, membership } = requireProjectRole(db, req, projectId, ['PI_LEAD', 'RESEARCHER']);
            const srcFull = db.prepare('SELECT * FROM sources WHERE id = ? AND project_id = ?').get(sourceId, projectId);
            if (!srcFull) {
              logAuditEvent(db, {
                projectId,
                actorUserId: user.id,
                actorRole: membership.role_id,
                eventType: 'ACCESS_DENIED',
                targetEntityType: 'SOURCE',
                targetEntityId: sourceId,
                metadata: { reason: 'GUESSED_OR_NONEXISTENT_SOURCE_ID', path: pathname }
              });
              throw Object.assign(new Error(`Source '${sourceId}' not found in project.`), {
                statusCode: 404,
                errorCode: 'RESOURCE_NOT_FOUND'
              });
            }
            const reindexedSpans = withTransaction(db, () => {
              db.prepare('DELETE FROM source_spans WHERE source_id = ?').run(sourceId);
              const spans = indexSourceSpans(db, {
                sourceId,
                projectId,
                sourceType: srcFull.source_type,
                rawContent: srcFull.raw_content
              });
              db.prepare("UPDATE sources SET processing_status = 'READY', processing_error = NULL WHERE id = ?").run(sourceId);
              logAuditEvent(db, {
                projectId,
                actorUserId: user.id,
                actorRole: membership.role_id,
                eventType: 'SOURCE_REPROCESSED',
                targetEntityType: 'SOURCE',
                targetEntityId: sourceId,
                metadata: { span_count: spans.length }
              });
              return spans;
            });
            const updatedSource = db
              .prepare(`
                SELECT id, project_id, title, file_name, mime_type, byte_size,
                       source_type, processing_status, processing_error,
                       visibility_level, exclude_from_ai, content_hash,
                       uploaded_by_user_id, created_at
                FROM sources WHERE id = ?
              `)
              .get(sourceId);
            return sendJson(res, 200, { source: updatedSource, spans: reindexedSpans });
          }

          const { user, membership } = requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);

          const source = db
            .prepare(`
              SELECT id, project_id, title, file_name, file_extension, mime_type, byte_size, storage_key,
                     source_type, processing_status, processing_error,
                     page_count, row_count, has_prompt_injection_pattern,
                     visibility_level, exclude_from_ai, content_hash,
                     substr(raw_content, 1, 2500) AS raw_content_preview,
                     raw_content,
                     uploaded_by_user_id, created_at
              FROM sources
              WHERE id = ? AND project_id = ?
            `)
            .get(sourceId, projectId);

          if (!source) {
            logAuditEvent(db, {
              projectId,
              actorUserId: user.id,
              actorRole: membership.role_id,
              eventType: 'ACCESS_DENIED',
              targetEntityType: 'SOURCE',
              targetEntityId: sourceId,
              metadata: { reason: 'GUESSED_OR_CROSS_PROJECT_SOURCE_ID', path: pathname }
            });
            throw Object.assign(new Error(`Source '${sourceId}' not found in project.`), {
              statusCode: 404,
              errorCode: 'RESOURCE_NOT_FOUND'
            });
          }

          if (source.visibility_level === 'RESTRICTED_PI_ONLY' && membership.role_id !== 'PI_LEAD') {
            logAuditEvent(db, {
              projectId,
              actorUserId: user.id,
              actorRole: membership.role_id,
              eventType: 'ACCESS_DENIED',
              targetEntityType: 'SOURCE',
              targetEntityId: sourceId,
              metadata: { reason: 'RESTRICTED_PI_ONLY_SOURCE', path: pathname }
            });
            throw Object.assign(
              new Error('Access denied: This source is marked RESTRICTED_PI_ONLY and requires PI_LEAD authorization.'),
              { statusCode: 403, errorCode: 'RESTRICTED_RESOURCE' }
            );
          }

          // Authorised private file access endpoint: GET /api/projects/:projectId/sources/:sourceId/file
          if (action === '/file') {
            const cfg = getConfig();
            const safeStorageKey = path.basename(source.storage_key || '');
            const filePath = path.join(cfg.privateStorageDir, safeStorageKey);
            let fileContent = source.raw_content;
            if (safeStorageKey && fs.existsSync(filePath)) {
              fileContent = fs.readFileSync(filePath, 'utf8');
            }
            logAuditEvent(db, {
              projectId,
              actorUserId: user.id,
              actorRole: membership.role_id,
              eventType: 'PRIVATE_FILE_ACCESSED',
              targetEntityType: 'SOURCE',
              targetEntityId: sourceId,
              metadata: { file_name: source.file_name, visibility_level: source.visibility_level }
            });
            // Strip internal storage_key and full raw_content from metadata object
            const { storage_key: _sk, raw_content: _rc, ...safeSourceMeta } = source;
            return sendJson(res, 200, {
              source: safeSourceMeta,
              file: {
                file_name: source.file_name,
                mime_type: source.mime_type,
                byte_size: source.byte_size,
                content_hash: source.content_hash,
                content: fileContent
              }
            });
          }

          const { storage_key: _sk, raw_content: _rc, ...safeSource } = source;

          const spans = db
            .prepare('SELECT * FROM source_spans WHERE source_id = ? ORDER BY span_index ASC')
            .all(sourceId);

          if (action === '/status') {
            return sendJson(res, 200, {
              source_id: safeSource.id,
              processing_status: safeSource.processing_status,
              processing_error: safeSource.processing_error,
              span_count: spans.length
            });
          }

          if (action === '/spans') {
            return sendJson(res, 200, { source: safeSource, spans });
          }

          return sendJson(res, 200, { source: safeSource, spans });
        }

        // POST /api/projects/:projectId/reconstruct
        if (method === 'POST' && subPath === '/reconstruct') {
          checkRateLimit(db, req, { bucket: 'reconstruct', maxRequests: 40, windowMs: 60_000, projectId });
          const { user, membership } = requireProjectRole(db, req, projectId, ['PI_LEAD', 'RESEARCHER']);
          const body = await readJsonBody(req);
          const result = runReconstruction(db, {
            projectId,
            sourceIds: Array.isArray(body.source_ids) ? body.source_ids : null,
            extractionFocus: typeof body.extraction_focus === 'string' ? body.extraction_focus : '',
            candidateProposals: body.candidate_proposals ?? null,
            simulateModelTimeout:
              body.simulate_model_timeout === true || req.headers['x-simulate-model-timeout'] === '1',
            simulateExtractorFailure:
              body.simulate_extractor_failure === true || req.headers['x-simulate-extractor-failure'] === '1',
            actorUserId: user.id,
            actorRole: membership.role_id
          });
          return sendJson(res, 201, result);
        }

        // GET /api/projects/:projectId/records (and /continuity-map)
        if (method === 'GET' && (subPath === '/records' || subPath === '/continuity-map')) {
          const { membership } = requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);
          const records = db
            .prepare('SELECT * FROM extracted_records WHERE project_id = ? ORDER BY created_at ASC')
            .all(projectId)
            .map((r) => enrichRecordWithLinks(db, r, membership.role_id));

          const edges = db
            .prepare('SELECT * FROM record_edges WHERE project_id = ? ORDER BY created_at ASC')
            .all(projectId)
            .map((e) => ({
              ...e,
              supporting_span_ids: JSON.parse(e.supporting_span_ids_json || '[]')
            }));

          return sendJson(res, 200, {
            records,
            edges,
            evidence_state_definitions: CANONICAL_EVIDENCE_STATE_DEFINITIONS,
            epistemic_notice: EPISTEMIC_CITATION_NOTICE
          });
        }

        // GET /api/projects/:projectId/evidence-states
        if (method === 'GET' && subPath === '/evidence-states') {
          requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);
          return sendJson(res, 200, {
            states: Object.keys(CANONICAL_EVIDENCE_STATE_DEFINITIONS),
            definitions: CANONICAL_EVIDENCE_STATE_DEFINITIONS,
            epistemic_notice: EPISTEMIC_CITATION_NOTICE
          });
        }

        // POST /api/projects/:projectId/records
        if (method === 'POST' && subPath === '/records') {
          const { user, membership } = requireProjectRole(db, req, projectId, ['PI_LEAD', 'RESEARCHER']);
          const body = await readJsonBody(req);
          rejectTruthProbabilityFields(body);

          const recordType = typeof body.record_type === 'string' ? body.record_type.trim() : '';
          const title = typeof body.title === 'string' ? body.title.trim() : '';
          const statement = typeof body.statement === 'string' ? body.statement.trim() : '';
          const rationale = typeof body.rationale === 'string' ? body.rationale.trim() : '';
          const evidenceStatus = normalizeEvidenceStateInput(body.evidence_status || 'UNVERIFIED');

          if (!VALID_RECORD_TYPES.has(recordType)) {
            throw Object.assign(
              new Error(`Invalid record_type '${recordType}'. Allowed: ${Array.from(VALID_RECORD_TYPES).join(', ')}`),
              { statusCode: 400, errorCode: 'INVALID_RECORD_TYPE' }
            );
          }
          if (!title || !statement) {
            throw Object.assign(new Error('Both title and statement are required.'), {
              statusCode: 400,
              errorCode: 'INVALID_PAYLOAD'
            });
          }
          if (!VALID_EVIDENCE_STATUSES.has(evidenceStatus)) {
            throw Object.assign(
              new Error(`Invalid evidence_status '${evidenceStatus}'. Allowed: ${Array.from(VALID_EVIDENCE_STATUSES).join(', ')}`),
              { statusCode: 422, errorCode: 'INVALID_EVIDENCE_STATUS' }
            );
          }

          const rawLinks = Array.isArray(body.evidence_links) ? body.evidence_links : [];
          const recordId = `rec_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
          const now = new Date().toISOString();

          const verifiedLinks = [];
          for (const link of rawLinks) {
            const anySpan = db
              .prepare(`
                SELECT sp.*, s.visibility_level
                FROM source_spans sp
                JOIN sources s ON s.id = sp.source_id
                WHERE sp.id = ?
              `)
              .get(link.span_id);

            if (!anySpan) {
              throw Object.assign(
                new Error(`Cited span_id '${link.span_id}' does not exist in stored spans.`),
                { statusCode: 422, errorCode: 'PROVENANCE_VALIDATION_FAILED' }
              );
            }
            if (anySpan.project_id !== projectId) {
              logAuditEvent(db, {
                projectId,
                actorUserId: user.id,
                actorRole: membership.role_id,
                eventType: 'ACCESS_DENIED',
                targetEntityType: 'SOURCE_SPAN',
                targetEntityId: link.span_id,
                metadata: { reason: 'CROSS_PROJECT_EVIDENCE_VIOLATION', span_project_id: anySpan.project_id }
              });
              throw Object.assign(
                new Error(`Cross-project evidence violation: span '${link.span_id}' belongs to a different project.`),
                { statusCode: 422, errorCode: 'CROSS_PROJECT_EVIDENCE_VIOLATION' }
              );
            }
            if (anySpan.is_deleted === 1 || anySpan.is_corrupted === 1) {
              throw Object.assign(
                new Error(`Cited span '${link.span_id}' is deleted or corrupted and cannot resolve as valid support.`),
                { statusCode: 422, errorCode: 'PROVENANCE_VALIDATION_FAILED' }
              );
            }
            const span = anySpan;
            if (span.visibility_level === 'RESTRICTED_PI_ONLY') {
              logAuditEvent(db, {
                projectId,
                actorUserId: user.id,
                actorRole: membership.role_id,
                eventType: 'ACCESS_DENIED',
                targetEntityType: 'SOURCE_SPAN',
                targetEntityId: link.span_id,
                metadata: { reason: 'RESTRICTED_PI_ONLY_SPAN_CITATION' }
              });
              throw Object.assign(
                new Error('Restricted PI-only spans cannot be linked to shared continuity records.'),
                { statusCode: 403, errorCode: 'RESTRICTED_RESOURCE' }
              );
            }
            const quote = typeof link.verbatim_quote === 'string' ? link.verbatim_quote.trim() : '';
            if (!quote || !span.content_text.includes(quote)) {
              throw Object.assign(
                new Error(`verbatim_quote does not match exact text in span '${span.id}'.`),
                { statusCode: 422, errorCode: 'PROVENANCE_VALIDATION_FAILED' }
              );
            }

            verifiedLinks.push({
              id: `evl_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
              span_id: span.id,
              relationship_type: link.relationship_type || 'SUPPORTS',
              verbatim_quote: quote,
              quote_verified: 1
            });
          }

          if (
            evidenceStatus === 'SUPPORTED' &&
            verifiedLinks.filter((l) => l.relationship_type === 'SUPPORTS' && l.quote_verified === 1).length === 0
          ) {
            throw Object.assign(
              new Error('Cannot mark record SUPPORTED without at least one resolved supporting citation.'),
              { statusCode: 422, errorCode: 'PROVENANCE_VALIDATION_FAILED' }
            );
          }

          const createdRecord = withTransaction(db, () => {

            const statedOwner =
              typeof body.stated_owner === 'string' && body.stated_owner.trim() ? body.stated_owner.trim() : null;
            const recordedDate =
              typeof body.recorded_date === 'string' && body.recorded_date.trim() ? body.recorded_date.trim() : null;
            const dueDate =
              typeof body.due_date === 'string' && body.due_date.trim() ? body.due_date.trim() : null;
            const directStmt =
              typeof body.direct_source_statement === 'string' && body.direct_source_statement.trim()
                ? body.direct_source_statement.trim()
                : statement;
            const aiSummary =
              typeof body.ai_summary_or_inference === 'string' && body.ai_summary_or_inference.trim()
                ? body.ai_summary_or_inference.trim()
                : null;
            const structuredFields =
              body.structured_fields && typeof body.structured_fields === 'object' ? body.structured_fields : {};
            const isStale = evidenceStatus === 'STALE' || body.is_stale ? 1 : 0;
            const staleReason =
              typeof body.stale_reason === 'string' && body.stale_reason.trim()
                ? body.stale_reason.trim()
                : isStale
                ? body.verification_notes || 'Evidence outdated relative to newer dated source or explicit validity rule.'
                : null;
            const validityWindowDays =
              typeof body.validity_window_days === 'number' ? body.validity_window_days : null;
            const hasConflict =
              evidenceStatus === 'CONFLICTING' || evidenceStatus === 'CONTRADICTED' || body.has_conflict ? 1 : 0;
            const conflictSummary =
              typeof body.conflict_summary === 'string' && body.conflict_summary.trim()
                ? body.conflict_summary.trim()
                : null;
            const conflictingPassagesJson = Array.isArray(body.conflicting_passages)
              ? JSON.stringify(body.conflicting_passages)
              : '[]';

            const missingFields = Array.isArray(body.missing_fields) ? [...body.missing_fields] : [];
            if (!statedOwner && !missingFields.includes('stated_owner')) missingFields.push('stated_owner');
            if (!recordedDate && !missingFields.includes('recorded_date')) missingFields.push('recorded_date');
            if (verifiedLinks.length === 0 && !missingFields.includes('evidence_links')) {
              missingFields.push('evidence_links');
            }
            const isIncomplete = missingFields.length > 0 || verifiedLinks.length === 0 ? 1 : 0;

            db.prepare(`
              INSERT INTO extracted_records (
                id, project_id, record_type, title, statement,
                direct_source_statement, ai_summary_or_inference,
                rationale, stated_owner, recorded_date, due_date,
                structured_fields_json, is_incomplete, missing_fields_json,
                has_conflict, conflict_summary, conflicting_passages_json,
                is_stale, stale_reason, validity_window_days,
                origin_mode, evidence_status, verification_notes,
                approval_status, current_version,
                extractor_provider, extractor_model, extractor_version, extracted_at,
                created_by_user_id, updated_at, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL_ENTRY', ?, ?, 'DRAFT', 1, 'manual-entry', 'human-authored', '2.5.0', ?, ?, ?, ?)
            `).run(
              recordId,
              projectId,
              recordType,
              title,
              statement,
              directStmt,
              aiSummary,
              rationale,
              statedOwner,
              recordedDate,
              dueDate,
              JSON.stringify(structuredFields),
              isIncomplete,
              JSON.stringify(missingFields),
              hasConflict,
              conflictSummary,
              conflictingPassagesJson,
              isStale,
              staleReason,
              validityWindowDays,
              evidenceStatus,
              body.verification_notes || '',
              now,
              user.id,
              now,
              now
            );

            for (const vl of verifiedLinks) {
              db.prepare(`
                INSERT INTO evidence_links (
                  id, record_id, span_id, original_span_id, relationship_type,
                  verbatim_quote, quote_verified, created_by_user_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(vl.id, recordId, vl.span_id, vl.span_id, vl.relationship_type, vl.verbatim_quote, 1, user.id, now);
            }

            rebuildProjectContinuityEdges(db, projectId);

            db.prepare(`
              INSERT INTO record_versions (
                id, record_id, version_number, change_reason,
                changes_json, snapshot_json, changed_by_user_id, created_at
              ) VALUES (?, ?, 1, 'INITIAL_EXTRACTION', ?, ?, ?, ?)
            `).run(
              `ver_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
              recordId,
              JSON.stringify({ created: true, origin_mode: 'MANUAL_ENTRY' }),
              JSON.stringify({
                id: recordId,
                record_type: recordType,
                title,
                statement,
                evidence_status: evidenceStatus,
                approval_status: 'DRAFT',
                span_ids: verifiedLinks.map((l) => l.span_id)
              }),
              user.id,
              now
            );

            logAuditEvent(db, {
              projectId,
              actorUserId: user.id,
              actorRole: membership.role_id,
              eventType: 'RECORD_CREATED',
              targetEntityType: 'EXTRACTED_RECORD',
              targetEntityId: recordId,
              metadata: { record_type: recordType, evidence_status: evidenceStatus }
            });

            const rec = db.prepare('SELECT * FROM extracted_records WHERE id = ?').get(recordId);
            return enrichRecordWithLinks(db, rec, membership.role_id);
          });

          return sendJson(res, 201, { record: createdRecord });
        }

        // Citation flag route: POST /api/projects/:projectId/records/:recordId/(citations|evidence)/:linkId/flag
        const flagMatch = subPath.match(/^\/records\/([^/]+)\/(?:citations|evidence)\/([^/]+)\/flag$/);
        if (flagMatch && method === 'POST') {
          const recordId = decodeURIComponent(flagMatch[1]);
          const linkId = decodeURIComponent(flagMatch[2]);
          const { user, membership } = requireProjectRole(db, req, projectId, ['PI_LEAD', 'RESEARCHER', 'REVIEWER']);
          const body = await readJsonBody(req);
          const flaggedResult = flagCitationLink(db, {
            projectId,
            recordId,
            linkId,
            flagReason: body.flag_reason || body.reason || 'INCORRECT_EXCERPT',
            notes: body.notes || body.comments || '',
            actorUserId: user.id,
            actorRole: membership.role_id
          });
          return sendJson(res, 200, flaggedResult);
        }

        // Record subroutes: /records/:recordId[/evidence|/verify|/reviews|/versions|/inspect]
        const recMatch = subPath.match(/^\/records\/([^/]+)(\/evidence|\/verify|\/reviews|\/versions|\/inspect)?$/);
        if (recMatch) {
          const recordId = decodeURIComponent(recMatch[1]);
          const recAction = recMatch[2] || '';

          const existingRecord = db
            .prepare('SELECT * FROM extracted_records WHERE id = ? AND project_id = ?')
            .get(recordId, projectId);

          if (!existingRecord) {
            // Ensure caller is at least authenticated & member before returning 404
            const { user, membership } = requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);
            logAuditEvent(db, {
              projectId,
              actorUserId: user.id,
              actorRole: membership.role_id,
              eventType: 'ACCESS_DENIED',
              targetEntityType: 'EXTRACTED_RECORD',
              targetEntityId: recordId,
              metadata: { reason: 'GUESSED_OR_CROSS_PROJECT_RECORD_ID', path: pathname }
            });
            throw Object.assign(new Error(`Record '${recordId}' not found in project.`), {
              statusCode: 404,
              errorCode: 'RESOURCE_NOT_FOUND'
            });
          }

          // GET /api/projects/:projectId/records/:recordId or /inspect
          if (method === 'GET' && (recAction === '' || recAction === '/inspect')) {
            const { membership } = requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);
            const enriched = enrichRecordWithLinks(db, existingRecord, membership.role_id);
            const reviews = db
              .prepare(`
                SELECT rv.*, u.full_name AS reviewer_name
                FROM reviews rv
                JOIN users u ON u.id = rv.reviewer_user_id
                WHERE rv.record_id = ?
                ORDER BY rv.created_at ASC
              `)
              .all(recordId);
            return sendJson(res, 200, {
              record: enriched,
              reviews,
              evidence_state_definitions: CANONICAL_EVIDENCE_STATE_DEFINITIONS,
              epistemic_notice: EPISTEMIC_CITATION_NOTICE
            });
          }

          // PATCH /api/projects/:projectId/records/:recordId
          if (method === 'PATCH' && recAction === '') {
            const { user, membership } = requireProjectRole(db, req, projectId, ['PI_LEAD', 'RESEARCHER']);
            const body = await readJsonBody(req);
            rejectTruthProbabilityFields(body);

            if (body.approval_status === 'APPROVED') {
              throw Object.assign(
                new Error('Cannot set approval_status to APPROVED via direct edit. Submit a review decision via /reviews.'),
                { statusCode: 403, errorCode: 'FORBIDDEN_APPROVAL_BYPASS' }
              );
            }
            if (body.approval_status && !['DRAFT', 'PENDING_REVIEW', 'REJECTED'].includes(body.approval_status)) {
              throw Object.assign(
                new Error("Direct edit may only set approval_status to 'DRAFT', 'PENDING_REVIEW', or 'REJECTED'."),
                { statusCode: 400, errorCode: 'INVALID_PAYLOAD' }
              );
            }

            const newTitle = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : existingRecord.title;
            const newStatement = typeof body.statement === 'string' && body.statement.trim() ? body.statement.trim() : existingRecord.statement;
            const newDirectStmt =
              typeof body.direct_source_statement === 'string' && body.direct_source_statement.trim()
                ? body.direct_source_statement.trim()
                : body.statement && typeof body.statement === 'string'
                ? body.statement.trim()
                : existingRecord.direct_source_statement || existingRecord.statement;
            const newRationale = typeof body.rationale === 'string' ? body.rationale.trim() : existingRecord.rationale;
            const newContextNotes =
              typeof body.context_notes === 'string' ? body.context_notes.trim() : existingRecord.context_notes || '';
            const newStatedOwner =
              body.stated_owner !== undefined
                ? typeof body.stated_owner === 'string' && body.stated_owner.trim()
                  ? body.stated_owner.trim()
                  : null
                : existingRecord.stated_owner;
            const newRecordedDate =
              body.recorded_date !== undefined
                ? typeof body.recorded_date === 'string' && body.recorded_date.trim()
                  ? body.recorded_date.trim()
                  : null
                : existingRecord.recorded_date;
            const newDueDate =
              body.due_date !== undefined
                ? typeof body.due_date === 'string' && body.due_date.trim()
                  ? body.due_date.trim()
                  : null
                : existingRecord.due_date;
            const newType = typeof body.record_type === 'string' && body.record_type.trim() ? body.record_type.trim() : existingRecord.record_type;

            if (!VALID_RECORD_TYPES.has(newType)) {
              throw Object.assign(new Error(`Invalid record_type '${newType}'.`), {
                statusCode: 400,
                errorCode: 'INVALID_RECORD_TYPE'
              });
            }

            let newEvidenceStatus = existingRecord.evidence_status;
            if (body.evidence_status !== undefined) {
              newEvidenceStatus = normalizeEvidenceStateInput(body.evidence_status);
              if (!VALID_EVIDENCE_STATUSES.has(newEvidenceStatus)) {
                throw Object.assign(new Error(`Invalid evidence_status '${newEvidenceStatus}'.`), {
                  statusCode: 422,
                  errorCode: 'INVALID_EVIDENCE_STATUS'
                });
              }
            }

            // Stage 07 Rule 4: Approval applies to a specific version.
            // If an APPROVED record changes, the new version MUST return to PENDING_REVIEW
            // (unless explicitly set to REJECTED or DRAFT) and invalidate the old version's approval.
            const wasApproved = existingRecord.approval_status === 'APPROVED';
            let newApproval;
            if (body.approval_status) {
              newApproval = body.approval_status;
            } else if (wasApproved) {
              newApproval = 'PENDING_REVIEW';
            } else {
              newApproval = existingRecord.approval_status;
            }

            const editReason =
              typeof body.reason === 'string' && body.reason.trim()
                ? body.reason.trim()
                : typeof body.edit_reason === 'string' && body.edit_reason.trim()
                ? body.edit_reason.trim()
                : 'MANUAL_EDIT';

            const changedFields = [];
            const fieldDiffs = {};
            const trackDiff = (field, oldVal, newVal) => {
              if (oldVal !== newVal) {
                changedFields.push(field);
                fieldDiffs[field] = { from: oldVal ?? null, to: newVal ?? null };
              }
            };
            trackDiff('record_type', existingRecord.record_type, newType);
            trackDiff('title', existingRecord.title, newTitle);
            trackDiff('statement', existingRecord.statement, newStatement);
            trackDiff('rationale', existingRecord.rationale, newRationale);
            trackDiff('context_notes', existingRecord.context_notes || '', newContextNotes);
            trackDiff('stated_owner', existingRecord.stated_owner ?? null, newStatedOwner ?? null);
            trackDiff('recorded_date', existingRecord.recorded_date ?? null, newRecordedDate ?? null);
            trackDiff('due_date', existingRecord.due_date ?? null, newDueDate ?? null);
            trackDiff('evidence_status', existingRecord.evidence_status, newEvidenceStatus);
            trackDiff('approval_status', existingRecord.approval_status, newApproval);

            const now = new Date().toISOString();
            const nextVersion = existingRecord.current_version + 1;

            const updated = withTransaction(db, () => {
              db.prepare(`
                UPDATE extracted_records
                SET record_type = ?, title = ?, statement = ?, direct_source_statement = ?,
                    rationale = ?, context_notes = ?,
                    stated_owner = ?, recorded_date = ?, due_date = ?,
                    evidence_status = ?, approval_status = ?,
                    approved_version = NULL, approved_by_user_id = NULL, approved_at = NULL,
                    last_edit_reason = ?, current_version = ?, updated_at = ?
                WHERE id = ?
              `).run(
                newType,
                newTitle,
                newStatement,
                newDirectStmt,
                newRationale,
                newContextNotes,
                newStatedOwner,
                newRecordedDate,
                newDueDate,
                newEvidenceStatus,
                newApproval,
                editReason,
                nextVersion,
                now,
                recordId
              );

              const rec = db.prepare('SELECT * FROM extracted_records WHERE id = ?').get(recordId);
              const enriched = enrichRecordWithLinks(db, rec, membership.role_id);

              db.prepare(`
                INSERT INTO record_versions (
                  id, record_id, version_number, change_reason,
                  changes_json, snapshot_json, changed_by_user_id, created_at
                ) VALUES (?, ?, ?, 'MANUAL_EDIT', ?, ?, ?, ?)
              `).run(
                `ver_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
                recordId,
                nextVersion,
                JSON.stringify({
                  actor_user_id: user.id,
                  timestamp: now,
                  reason: editReason,
                  changed_fields: changedFields,
                  field_diffs: fieldDiffs,
                  approval_invalidated: wasApproved,
                  previous_approved_version: wasApproved
                    ? existingRecord.approved_version || existingRecord.current_version
                    : null,
                  title: newTitle !== existingRecord.title,
                  statement: newStatement !== existingRecord.statement,
                  approval_status: newApproval
                }),
                JSON.stringify(enriched),
                user.id,
                now
              );

              logAuditEvent(db, {
                projectId,
                actorUserId: user.id,
                actorRole: membership.role_id,
                eventType: 'RECORD_EDITED',
                targetEntityType: 'EXTRACTED_RECORD',
                targetEntityId: recordId,
                metadata: {
                  version_number: nextVersion,
                  reason: editReason,
                  changed_fields: changedFields,
                  approval_invalidated: wasApproved,
                  approval_status: newApproval
                }
              });

              return enriched;
            });

            return sendJson(res, 200, {
              record: updated,
              changed_fields: changedFields,
              field_diffs: fieldDiffs,
              approval_invalidated: wasApproved
            });
          }

          // GET & POST /api/projects/:projectId/records/:recordId/evidence
          if (recAction === '/evidence') {
            if (method === 'GET') {
              const { membership } = requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);
              const enriched = enrichRecordWithLinks(db, existingRecord, membership.role_id);
              return sendJson(res, 200, { evidence_links: enriched.evidence_links });
            }
            if (method === 'POST') {
              const { user, membership } = requireProjectRole(db, req, projectId, ['PI_LEAD', 'RESEARCHER', 'REVIEWER']);
              const body = await readJsonBody(req);
              const spanId = typeof body.span_id === 'string' ? body.span_id.trim() : '';
              const verbatimQuote = typeof body.verbatim_quote === 'string' ? body.verbatim_quote.trim() : '';
              const relationshipType = body.relationship_type || 'SUPPORTS';

              const anySpan = db
                .prepare(`
                  SELECT sp.*, s.visibility_level
                  FROM source_spans sp
                  JOIN sources s ON s.id = sp.source_id
                  WHERE sp.id = ?
                `)
                .get(spanId);

              if (!anySpan) {
                throw Object.assign(new Error(`Span '${spanId}' not found in stored spans.`), {
                  statusCode: 422,
                  errorCode: 'PROVENANCE_VALIDATION_FAILED'
                });
              }
              if (anySpan.project_id !== projectId) {
                logAuditEvent(db, {
                  projectId,
                  actorUserId: user.id,
                  actorRole: membership.role_id,
                  eventType: 'ACCESS_DENIED',
                  targetEntityType: 'SOURCE_SPAN',
                  targetEntityId: spanId,
                  metadata: { reason: 'CROSS_PROJECT_EVIDENCE_VIOLATION', span_project_id: anySpan.project_id }
                });
                throw Object.assign(
                  new Error(`Cross-project evidence violation: span '${spanId}' belongs to a different project.`),
                  { statusCode: 422, errorCode: 'CROSS_PROJECT_EVIDENCE_VIOLATION' }
                );
              }
              if (anySpan.is_deleted === 1 || anySpan.is_corrupted === 1) {
                throw Object.assign(new Error(`Span '${spanId}' is deleted or corrupted.`), {
                  statusCode: 422,
                  errorCode: 'PROVENANCE_VALIDATION_FAILED'
                });
              }
              const span = anySpan;
              if (span.visibility_level === 'RESTRICTED_PI_ONLY') {
                throw Object.assign(new Error('Restricted PI-only spans cannot be linked to shared records.'), {
                  statusCode: 403,
                  errorCode: 'RESTRICTED_RESOURCE'
                });
              }
              if (!verbatimQuote || !span.content_text.includes(verbatimQuote)) {
                throw Object.assign(
                  new Error(`verbatim_quote is not an exact substring of span '${spanId}'.`),
                  { statusCode: 422, errorCode: 'PROVENANCE_VALIDATION_FAILED' }
                );
              }

              const linkId = `evl_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
              const now = new Date().toISOString();
              db.prepare(`
                INSERT INTO evidence_links (
                  id, record_id, span_id, original_span_id, relationship_type,
                  verbatim_quote, quote_verified, created_by_user_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
              `).run(linkId, recordId, spanId, spanId, relationshipType, verbatimQuote, user.id, now);

              const enriched = enrichRecordWithLinks(db, existingRecord, membership.role_id);
              return sendJson(res, 201, { evidence_links: enriched.evidence_links });
            }
          }

          // POST /api/projects/:projectId/records/:recordId/verify
          if (method === 'POST' && recAction === '/verify') {
            const { user, membership } = requireProjectRole(db, req, projectId, ['PI_LEAD', 'RESEARCHER', 'REVIEWER']);
            const body = await readJsonBody(req);
            rejectTruthProbabilityFields(body);

            const evidenceStatus = normalizeEvidenceStateInput(body.evidence_status);
            if (!VALID_EVIDENCE_STATUSES.has(evidenceStatus)) {
              throw Object.assign(
                new Error(`evidence_status must be one of: ${Array.from(VALID_EVIDENCE_STATUSES).join(', ')}`),
                { statusCode: 422, errorCode: 'INVALID_EVIDENCE_STATUS' }
              );
            }

            const now = new Date().toISOString();
            const nextVersion = existingRecord.current_version + 1;

            const result = withTransaction(db, () => {
              if (Array.isArray(body.evidence_links)) {
                db.prepare('DELETE FROM evidence_links WHERE record_id = ?').run(recordId);
                for (const link of body.evidence_links) {
                  const anySpan = db
                    .prepare(`
                      SELECT sp.*, s.visibility_level
                      FROM source_spans sp
                      JOIN sources s ON s.id = sp.source_id
                      WHERE sp.id = ?
                    `)
                    .get(link.span_id);

                  if (!anySpan) {
                    throw Object.assign(new Error(`Cited span '${link.span_id}' does not exist in stored spans.`), {
                      statusCode: 422,
                      errorCode: 'PROVENANCE_VALIDATION_FAILED'
                    });
                  }
                  if (anySpan.project_id !== projectId) {
                    logAuditEvent(db, {
                      projectId,
                      actorUserId: user.id,
                      actorRole: membership.role_id,
                      eventType: 'ACCESS_DENIED',
                      targetEntityType: 'SOURCE_SPAN',
                      targetEntityId: link.span_id,
                      metadata: { reason: 'CROSS_PROJECT_EVIDENCE_VIOLATION', span_project_id: anySpan.project_id }
                    });
                    throw Object.assign(
                      new Error(`Cross-project evidence violation: span '${link.span_id}' belongs to another project.`),
                      { statusCode: 422, errorCode: 'CROSS_PROJECT_EVIDENCE_VIOLATION' }
                    );
                  }
                  if (anySpan.is_deleted === 1 || anySpan.is_corrupted === 1) {
                    throw Object.assign(
                      new Error(`Cited span '${link.span_id}' is deleted or corrupted and cannot resolve as valid support.`),
                      { statusCode: 422, errorCode: 'PROVENANCE_VALIDATION_FAILED' }
                    );
                  }
                  const span = anySpan;
                  if (span.visibility_level === 'RESTRICTED_PI_ONLY') {
                    throw Object.assign(new Error('Restricted PI-only spans cannot be linked to shared records.'), {
                      statusCode: 403,
                      errorCode: 'RESTRICTED_RESOURCE'
                    });
                  }
                  const quote = typeof link.verbatim_quote === 'string' ? link.verbatim_quote.trim() : '';
                  const exact = quote.length > 0 && span.content_text.includes(quote);
                  if (!exact && evidenceStatus === 'SUPPORTED') {
                    throw Object.assign(
                      new Error(`Cannot mark record SUPPORTED when verbatim_quote does not match span '${span.id}'.`),
                      { statusCode: 422, errorCode: 'PROVENANCE_VALIDATION_FAILED' }
                    );
                  }

                  db.prepare(`
                    INSERT INTO evidence_links (
                      id, record_id, span_id, original_span_id, relationship_type,
                      verbatim_quote, quote_verified, created_by_user_id, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                  `).run(
                    `evl_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
                    recordId,
                    span.id,
                    span.id,
                    link.relationship_type || 'SUPPORTS',
                    quote,
                    exact ? 1 : 0,
                    user.id,
                    now
                  );
                }
              }

              const currentLinks = db.prepare('SELECT * FROM evidence_links WHERE record_id = ?').all(recordId);
              const validSupportLinks = currentLinks.filter(
                (l) => l.quote_verified === 1 && l.citation_status === 'RESOLVED' && l.relationship_type === 'SUPPORTS'
              );
              if (
                evidenceStatus === 'SUPPORTED' &&
                (validSupportLinks.length === 0 || currentLinks.some((l) => !l.quote_verified || l.citation_status !== 'RESOLVED'))
              ) {
                throw Object.assign(
                  new Error('Record cannot be marked SUPPORTED without resolved, verified verbatim supporting evidence.'),
                  { statusCode: 422, errorCode: 'PROVENANCE_VALIDATION_FAILED' }
                );
              }

              const isStale = evidenceStatus === 'STALE' || body.is_stale ? 1 : existingRecord.is_stale || 0;
              const staleReason =
                typeof body.stale_reason === 'string' && body.stale_reason.trim()
                  ? body.stale_reason.trim()
                  : isStale
                  ? (typeof body.verification_notes === 'string' && body.verification_notes.trim()) ||
                    existingRecord.stale_reason ||
                    'Evidence outdated relative to a newer dated source or explicit validity rule.'
                  : existingRecord.stale_reason;

              const hasConflict =
                evidenceStatus === 'CONFLICTING' || evidenceStatus === 'CONTRADICTED' || body.has_conflict
                  ? 1
                  : existingRecord.has_conflict || 0;
              const conflictSummary =
                typeof body.conflict_summary === 'string' && body.conflict_summary.trim()
                  ? body.conflict_summary.trim()
                  : existingRecord.conflict_summary;
              const conflictingPassagesJson = Array.isArray(body.conflicting_passages)
                ? JSON.stringify(body.conflicting_passages)
                : existingRecord.conflicting_passages_json || '[]';

              // Note: Verification updates evidence_status ONLY and never alters approval_status
              db.prepare(`
                UPDATE extracted_records
                SET evidence_status = ?, verification_notes = ?,
                    is_stale = ?, stale_reason = ?,
                    has_conflict = ?, conflict_summary = ?, conflicting_passages_json = ?,
                    verified_by_user_id = ?, verified_at = ?,
                    current_version = ?, updated_at = ?
                WHERE id = ?
              `).run(
                evidenceStatus,
                typeof body.verification_notes === 'string' ? body.verification_notes.trim() : existingRecord.verification_notes,
                isStale,
                staleReason,
                hasConflict,
                conflictSummary,
                conflictingPassagesJson,
                user.id,
                now,
                nextVersion,
                now,
                recordId
              );

              const updatedRec = enrichRecordWithLinks(
                db,
                db.prepare('SELECT * FROM extracted_records WHERE id = ?').get(recordId),
                membership.role_id
              );

              db.prepare(`
                INSERT INTO record_versions (
                  id, record_id, version_number, change_reason,
                  changes_json, snapshot_json, changed_by_user_id, created_at
                ) VALUES (?, ?, ?, 'EVIDENCE_VERIFICATION', ?, ?, ?, ?)
              `).run(
                `ver_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
                recordId,
                nextVersion,
                JSON.stringify({
                  previous_evidence_status: existingRecord.evidence_status,
                  new_evidence_status: evidenceStatus,
                  approval_status_unchanged: existingRecord.approval_status
                }),
                JSON.stringify(updatedRec),
                user.id,
                now
              );

              logAuditEvent(db, {
                projectId,
                actorUserId: user.id,
                actorRole: membership.role_id,
                eventType: 'RECORD_VERIFIED',
                targetEntityType: 'EXTRACTED_RECORD',
                targetEntityId: recordId,
                metadata: {
                  previous_evidence_status: existingRecord.evidence_status,
                  new_evidence_status: evidenceStatus,
                  approval_status: existingRecord.approval_status
                }
              });

              return {
                record: updatedRec,
                deterministic_checks: {
                  all_spans_exist: currentLinks.length > 0,
                  all_quotes_exact: currentLinks.every((l) => l.quote_verified === 1)
                }
              };
            });

            return sendJson(res, 200, result);
          }

          // GET & POST /api/projects/:projectId/records/:recordId/reviews
          if (recAction === '/reviews') {
            if (method === 'GET') {
              requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);
              const reviews = db
                .prepare(`
                  SELECT rv.*, u.full_name AS reviewer_name
                  FROM reviews rv
                  JOIN users u ON u.id = rv.reviewer_user_id
                  WHERE rv.record_id = ?
                  ORDER BY rv.created_at ASC
                `)
                .all(recordId);
              return sendJson(res, 200, { reviews });
            }

            if (method === 'POST') {
              const { user, membership } = requireProjectRole(db, req, projectId, ['PI_LEAD', 'REVIEWER']);
              const body = await readJsonBody(req);
              rejectTruthProbabilityFields(body);

              const decision = typeof body.decision === 'string' ? body.decision.trim() : '';
              const comments = typeof body.comments === 'string' ? body.comments.trim() : '';

              const decisionToApproval = {
                APPROVE: 'APPROVED',
                REQUEST_CHANGES: 'NEEDS_REVISION',
                FLAG_GAP: 'NEEDS_REVISION',
                REJECT: 'REJECTED'
              };

              if (!decisionToApproval[decision]) {
                throw Object.assign(
                  new Error("decision must be one of: 'APPROVE', 'REQUEST_CHANGES', 'FLAG_GAP', 'REJECT'."),
                  { statusCode: 400, errorCode: 'INVALID_PAYLOAD' }
                );
              }
              if (!comments) {
                throw Object.assign(new Error('Reviewer comments are required.'), {
                  statusCode: 400,
                  errorCode: 'INVALID_PAYLOAD'
                });
              }

              const newApprovalStatus = decisionToApproval[decision];
              const nextVersion = existingRecord.current_version + 1;
              const now = new Date().toISOString();

              const reviewOutcome = withTransaction(db, () => {
                // CRITICAL INVARIANT: Human approval updates approval_status ONLY.
                // It NEVER modifies or upgrades evidence_status (e.g., WEAK remains WEAK).
                const isApprove = decision === 'APPROVE';
                db.prepare(`
                  UPDATE extracted_records
                  SET approval_status = ?,
                      approved_version = ?,
                      approved_by_user_id = ?,
                      approved_at = ?,
                      current_version = ?,
                      updated_at = ?
                  WHERE id = ?
                `).run(
                  newApprovalStatus,
                  isApprove ? nextVersion : null,
                  isApprove ? user.id : null,
                  isApprove ? now : null,
                  nextVersion,
                  now,
                  recordId
                );

                const reviewId = `rev_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
                db.prepare(`
                  INSERT INTO reviews (
                    id, project_id, record_id, record_version,
                    reviewer_user_id, decision, evidence_status_at_review,
                    comments, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                  reviewId,
                  projectId,
                  recordId,
                  nextVersion,
                  user.id,
                  decision,
                  existingRecord.evidence_status,
                  comments,
                  now
                );

                const updatedRec = enrichRecordWithLinks(
                  db,
                  db.prepare('SELECT * FROM extracted_records WHERE id = ?').get(recordId),
                  membership.role_id
                );

                db.prepare(`
                  INSERT INTO record_versions (
                    id, record_id, version_number, change_reason,
                    changes_json, snapshot_json, changed_by_user_id, created_at
                  ) VALUES (?, ?, ?, 'REVIEW_DECISION', ?, ?, ?, ?)
                `).run(
                  `ver_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
                  recordId,
                  nextVersion,
                  JSON.stringify({
                    actor_user_id: user.id,
                    timestamp: now,
                    decision,
                    approved_version: isApprove ? nextVersion : null,
                    previous_approval_status: existingRecord.approval_status,
                    new_approval_status: newApprovalStatus,
                    preserved_evidence_status: existingRecord.evidence_status
                  }),
                  JSON.stringify(updatedRec),
                  user.id,
                  now
                );

                logAuditEvent(db, {
                  projectId,
                  actorUserId: user.id,
                  actorRole: membership.role_id,
                  eventType: 'REVIEW_SUBMITTED',
                  targetEntityType: 'REVIEW',
                  targetEntityId: reviewId,
                  metadata: {
                    record_id: recordId,
                    record_version: nextVersion,
                    decision,
                    approved_version: isApprove ? nextVersion : null,
                    new_approval_status: newApprovalStatus,
                    preserved_evidence_status: existingRecord.evidence_status
                  }
                });

                const reviewRow = db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId);
                return { review: reviewRow, record: updatedRec };
              });

              return sendJson(res, 201, reviewOutcome);
            }
          }

          // GET /api/projects/:projectId/records/:recordId/versions
          if (method === 'GET' && recAction === '/versions') {
            requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);
            const versions = db
              .prepare(`
                SELECT rv.*, u.full_name AS changed_by_name
                FROM record_versions rv
                JOIN users u ON u.id = rv.changed_by_user_id
                WHERE rv.record_id = ?
                ORDER BY rv.version_number ASC
              `)
              .all(recordId)
              .map((v) => {
                const parsedChanges = JSON.parse(v.changes_json || '{}');
                return {
                  ...v,
                  change_reason: parsedChanges.reason || v.change_reason,
                  changed_fields: Array.isArray(parsedChanges.changed_fields) ? parsedChanges.changed_fields : [],
                  field_diffs: parsedChanges.field_diffs || {},
                  changes: parsedChanges,
                  snapshot: JSON.parse(v.snapshot_json || '{}')
                };
              });

            const reviews = db
              .prepare(`
                SELECT r.*, u.full_name AS reviewer_name
                FROM reviews r
                JOIN users u ON u.id = r.reviewer_user_id
                WHERE r.record_id = ?
                ORDER BY r.created_at ASC
              `)
              .all(recordId);

            return sendJson(res, 200, { versions, reviews });
          }
        }

        // Handovers routes: /handovers, /handovers/:handoverId, /publish, /items/:itemId/check, /acknowledge, /versions
        if (subPath === '/handovers' && method === 'GET') {
          const { membership } = requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);
          const handovers = db
            .prepare(`
              SELECT h.*,
                     u_cr.full_name AS created_by_name,
                     u_pub.full_name AS published_by_name,
                     u_rec.full_name AS recipient_name,
                     u_ack.full_name AS acknowledged_by_name,
                     (SELECT COUNT(*) FROM handover_items hi WHERE hi.handover_id = h.id) AS item_count,
                     (SELECT COUNT(*) FROM handover_items hi WHERE hi.handover_id = h.id AND hi.recipient_checked = 1) AS checked_count
              FROM handover_packages h
              LEFT JOIN users u_cr ON u_cr.id = h.created_by_user_id
              LEFT JOIN users u_pub ON u_pub.id = h.published_by_user_id
              LEFT JOIN users u_rec ON u_rec.id = h.recipient_user_id
              LEFT JOIN users u_ack ON u_ack.id = h.acknowledged_by_user_id
              WHERE h.project_id = ?
              ORDER BY h.version_number DESC, h.created_at DESC
            `)
            .all(projectId)
            .map((h) => ({
              ...h,
              continuation_plan: JSON.parse(h.continuation_plan_json || '{}'),
              role_filtered_view: {
                viewer_role: membership.role_id,
                restricted_records_excluded_server_side: true,
                restricted_spans_excluded_server_side: true
              }
            }));
          return sendJson(res, 200, { handovers });
        }

        if (subPath === '/handovers' && method === 'POST') {
          const { user, membership } = requireProjectRole(db, req, projectId, ['PI_LEAD', 'RESEARCHER']);
          const body = await readJsonBody(req);
          const title = typeof body.title === 'string' ? body.title.trim() : '';
          const recipientUserId = typeof body.recipient_user_id === 'string' ? body.recipient_user_id.trim() : null;
          const autoSelectApproved = body.auto_select_approved === true;

          let recordIds = Array.isArray(body.record_ids) ? body.record_ids : [];
          if (autoSelectApproved && recordIds.length === 0) {
            const allApprovedRows = db
              .prepare(`
                SELECT id FROM extracted_records
                WHERE project_id = ? AND approval_status = 'APPROVED'
                  AND (approved_version IS NULL OR approved_version = current_version)
                ORDER BY created_at ASC
              `)
              .all(projectId);
            recordIds = allApprovedRows
              .map((r) => r.id)
              .filter((rid) => {
                const restCount = db
                  .prepare(`
                    SELECT COUNT(*) AS c
                    FROM evidence_links el
                    JOIN source_spans sp ON sp.id = el.span_id
                    JOIN sources s ON s.id = sp.source_id
                    WHERE el.record_id = ? AND (s.visibility_level = 'RESTRICTED_PI_ONLY' OR s.exclude_from_ai = 1)
                  `)
                  .get(rid).c;
                return restCount === 0;
              });
          }

          if (!title || recordIds.length === 0) {
            throw Object.assign(
              new Error('title and at least one APPROVED record are required to create a handover package.'),
              { statusCode: 400, errorCode: 'INVALID_PAYLOAD' }
            );
          }

          const restrictedCount = db
            .prepare("SELECT COUNT(*) AS c FROM sources WHERE project_id = ? AND (visibility_level = 'RESTRICTED_PI_ONLY' OR exclude_from_ai = 1)")
            .get(projectId).c;

          const projectRow = db.prepare('SELECT id, name, status FROM projects WHERE id = ?').get(projectId);

          const createdHandover = withTransaction(db, () => {
            const selectedRecords = [];
            const enrichedApprovedRecords = [];
            for (const rid of recordIds) {
              const rec = db
                .prepare('SELECT * FROM extracted_records WHERE id = ? AND project_id = ?')
                .get(rid, projectId);
              if (!rec) {
                throw Object.assign(new Error(`Record '${rid}' not found in project.`), {
                  statusCode: 404,
                  errorCode: 'RESOURCE_NOT_FOUND'
                });
              }
              if (
                rec.approval_status !== 'APPROVED' ||
                (rec.approved_version !== null &&
                  rec.approved_version !== undefined &&
                  rec.approved_version !== rec.current_version)
              ) {
                throw Object.assign(
                  new Error(
                    `Record '${rid}' (v${rec.current_version}) has approval_status='${rec.approval_status}' (approved_version=${rec.approved_version ?? 'none'}). Only currently APPROVED record versions can be included in a handover package.`
                  ),
                  { statusCode: 422, errorCode: 'UNAPPROVED_RECORD_IN_HANDOVER' }
                );
              }

              // Ensure no restricted source span is attached
              const restrictedLinks = db
                .prepare(`
                  SELECT COUNT(*) AS c
                  FROM evidence_links el
                  JOIN source_spans sp ON sp.id = el.span_id
                  JOIN sources s ON s.id = sp.source_id
                  WHERE el.record_id = ? AND (s.visibility_level = 'RESTRICTED_PI_ONLY' OR s.exclude_from_ai = 1)
                `)
                .get(rid).c;

              if (restrictedLinks > 0) {
                throw Object.assign(
                  new Error(`Record '${rid}' references restricted source spans and cannot be included in a shared handover package.`),
                  { statusCode: 403, errorCode: 'RESTRICTED_RESOURCE' }
                );
              }

              selectedRecords.push(rec);
              enrichedApprovedRecords.push(enrichRecordWithLinks(db, rec, 'RESEARCHER'));
            }

            const maxVerRow = db
              .prepare('SELECT COALESCE(MAX(version_number), 0) AS max_v FROM handover_packages WHERE project_id = ?')
              .get(projectId);
            const nextHandoverVersion = (maxVerRow ? maxVerRow.max_v : 0) + 1;

            const continuationPlan = buildContinuationPlan(
              enrichedApprovedRecords,
              projectRow,
              restrictedCount
            );

            const summaryLines = selectedRecords.map(
              (r) => `- [${r.record_type} | Evidence: ${r.evidence_status}] ${r.title}: ${r.statement}`
            );
            const executiveSummary =
              typeof body.executive_summary === 'string' && body.executive_summary.trim()
                ? body.executive_summary.trim()
                : `Continuation Plan v${nextHandoverVersion} containing ${selectedRecords.length} approved records (${restrictedCount} restricted source(s) excluded server-side):\n` +
                  summaryLines.join('\n');

            const handoverId = `hnd_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
            const now = new Date().toISOString();

            db.prepare(`
              INSERT INTO handover_packages (
                id, project_id, version_number, title, executive_summary,
                continuation_plan_json, status,
                restricted_sources_excluded_count, created_by_user_id,
                recipient_user_id, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)
            `).run(
              handoverId,
              projectId,
              nextHandoverVersion,
              title,
              executiveSummary,
              JSON.stringify(continuationPlan),
              restrictedCount,
              user.id,
              recipientUserId,
              now
            );

            for (const rec of selectedRecords) {
              const itemId = `hit_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
              const sectionGroup = classifyHandoverSection(rec.record_type);
              db.prepare(`
                INSERT INTO handover_items (
                  id, handover_id, record_id, record_version,
                  evidence_status_snapshot, approval_status_snapshot,
                  section_group, recipient_checked
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
              `).run(
                itemId,
                handoverId,
                rec.id,
                rec.current_version,
                rec.evidence_status,
                rec.approval_status,
                sectionGroup
              );
            }

            const hndRow = db.prepare('SELECT * FROM handover_packages WHERE id = ?').get(handoverId);
            const roleFiltered = buildRoleFilteredHandoverResponse(db, hndRow, membership.role_id);

            db.prepare(`
              INSERT INTO handover_versions (
                id, handover_id, project_id, version_number,
                lifecycle_event, snapshot_json, actor_user_id, created_at
              ) VALUES (?, ?, ?, ?, 'CREATED_DRAFT', ?, ?, ?)
            `).run(
              `hvr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
              handoverId,
              projectId,
              nextHandoverVersion,
              JSON.stringify(roleFiltered),
              user.id,
              now
            );

            logAuditEvent(db, {
              projectId,
              actorUserId: user.id,
              actorRole: membership.role_id,
              eventType: 'HANDOVER_CREATED',
              targetEntityType: 'HANDOVER',
              targetEntityId: handoverId,
              metadata: {
                version_number: nextHandoverVersion,
                item_count: roleFiltered.items.length,
                restricted_sources_excluded_count: restrictedCount,
                recipient_user_id: recipientUserId
              }
            });

            return buildRoleFilteredHandoverResponse(db, hndRow, membership.role_id);
          });

          return sendJson(res, 201, createdHandover);
        }

        const hndMatch = subPath.match(/^\/handovers\/([^/]+)(\/publish|\/acknowledge|\/versions|\/items\/([^/]+)\/check)?$/);
        if (hndMatch) {
          const handoverId = decodeURIComponent(hndMatch[1]);
          const hndAction = hndMatch[2] || '';
          const itemId = hndMatch[3] ? decodeURIComponent(hndMatch[3]) : null;

          const handover = db
            .prepare(`
              SELECT h.*,
                     u_cr.full_name AS created_by_name,
                     u_pub.full_name AS published_by_name,
                     u_rec.full_name AS recipient_name,
                     u_ack.full_name AS acknowledged_by_name
              FROM handover_packages h
              LEFT JOIN users u_cr ON u_cr.id = h.created_by_user_id
              LEFT JOIN users u_pub ON u_pub.id = h.published_by_user_id
              LEFT JOIN users u_rec ON u_rec.id = h.recipient_user_id
              LEFT JOIN users u_ack ON u_ack.id = h.acknowledged_by_user_id
              WHERE h.id = ? AND h.project_id = ?
            `)
            .get(handoverId, projectId);

          if (!handover) {
            requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);
            throw Object.assign(new Error(`Handover package '${handoverId}' not found.`), {
              statusCode: 404,
              errorCode: 'RESOURCE_NOT_FOUND'
            });
          }

          if (method === 'GET' && hndAction === '') {
            const { membership } = requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);
            const responsePayload = buildRoleFilteredHandoverResponse(db, handover, membership.role_id);
            return sendJson(res, 200, responsePayload);
          }

          if (method === 'GET' && hndAction === '/versions') {
            requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);
            const versions = db
              .prepare(`
                SELECT hv.*, u.full_name AS actor_name
                FROM handover_versions hv
                JOIN users u ON u.id = hv.actor_user_id
                WHERE hv.handover_id = ? AND hv.project_id = ?
                ORDER BY hv.version_number ASC, hv.created_at ASC
              `)
              .all(handoverId, projectId)
              .map((v) => ({
                ...v,
                snapshot: JSON.parse(v.snapshot_json || '{}')
              }));
            return sendJson(res, 200, { versions });
          }

          // POST /api/projects/:projectId/handovers/:handoverId/publish
          if (method === 'POST' && hndAction === '/publish') {
            const { user, membership } = requireProjectRole(db, req, projectId, ['PI_LEAD']);
            const body = await readJsonBody(req);

            const stepUpTokenRaw =
              (typeof body.step_up_token === 'string' && body.step_up_token.trim()) ||
              (typeof req.headers['x-step-up-token'] === 'string' && req.headers['x-step-up-token'].trim()) ||
              null;

            if (body.require_step_up === true || stepUpTokenRaw) {
              const verifiedStepUp = validateStepUpToken(db, {
                projectId,
                userId: user.id,
                requestedAction: 'PUBLISH_HANDOVER_PACKAGE',
                rawToken: stepUpTokenRaw
              });
              if (!verifiedStepUp) {
                logAuditEvent(db, {
                  projectId,
                  actorUserId: user.id,
                  actorRole: membership.role_id,
                  eventType: 'ACCESS_DENIED',
                  targetEntityType: 'HANDOVER',
                  targetEntityId: handoverId,
                  metadata: { reason: 'MISSING_OR_INVALID_STEP_UP_TOKEN', action: 'PUBLISH_HANDOVER_PACKAGE' }
                });
                throw Object.assign(
                  new Error(
                    'Step-up verification is required when require_step_up is enabled. Complete MFA/passkey step-up via camera-assisted or non-camera route.'
                  ),
                  { statusCode: 403, errorCode: 'STEP_UP_REQUIRED' }
                );
              }
            }

            if (handover.status !== 'DRAFT') {
              throw Object.assign(
                new Error(`Cannot publish handover in status '${handover.status}'. Must be 'DRAFT'.`),
                { statusCode: 409, errorCode: 'INVALID_STATE_TRANSITION' }
              );
            }

            const now = new Date().toISOString();
            const updatedPayload = withTransaction(db, () => {
              db.prepare(`
                UPDATE handover_packages
                SET status = 'PUBLISHED', published_by_user_id = ?, published_at = ?
                WHERE id = ?
              `).run(user.id, now, handoverId);

              const updatedRow = db
                .prepare(`
                  SELECT h.*,
                         u_cr.full_name AS created_by_name,
                         u_pub.full_name AS published_by_name,
                         u_rec.full_name AS recipient_name,
                         u_ack.full_name AS acknowledged_by_name
                  FROM handover_packages h
                  LEFT JOIN users u_cr ON u_cr.id = h.created_by_user_id
                  LEFT JOIN users u_pub ON u_pub.id = h.published_by_user_id
                  LEFT JOIN users u_rec ON u_rec.id = h.recipient_user_id
                  LEFT JOIN users u_ack ON u_ack.id = h.acknowledged_by_user_id
                  WHERE h.id = ?
                `)
                .get(handoverId);

              const roleFiltered = buildRoleFilteredHandoverResponse(db, updatedRow, membership.role_id);

              db.prepare(`
                INSERT INTO handover_versions (
                  id, handover_id, project_id, version_number,
                  lifecycle_event, snapshot_json, actor_user_id, created_at
                ) VALUES (?, ?, ?, ?, 'PUBLISHED', ?, ?, ?)
              `).run(
                `hvr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
                handoverId,
                projectId,
                updatedRow.version_number,
                JSON.stringify(roleFiltered),
                user.id,
                now
              );

              logAuditEvent(db, {
                projectId,
                actorUserId: user.id,
                actorRole: 'PI_LEAD',
                eventType: 'HANDOVER_PUBLISHED',
                targetEntityType: 'HANDOVER',
                targetEntityId: handoverId,
                metadata: {
                  version_number: updatedRow.version_number,
                  published_by_user_id: user.id,
                  published_at: now
                }
              });

              return buildRoleFilteredHandoverResponse(db, updatedRow, membership.role_id);
            });

            return sendJson(res, 200, updatedPayload);
          }

          // POST /api/projects/:projectId/handovers/:handoverId/items/:itemId/check
          if (method === 'POST' && itemId) {
            const { user, membership } = requireProjectRole(db, req, projectId, ['INCOMING_MEMBER', 'PI_LEAD']);
            const body = await readJsonBody(req);
            const checked = body.recipient_checked === false ? 0 : 1;

            const existingItem = db
              .prepare('SELECT * FROM handover_items WHERE id = ? AND handover_id = ?')
              .get(itemId, handoverId);

            if (!existingItem) {
              throw Object.assign(new Error(`Handover item '${itemId}' not found.`), {
                statusCode: 404,
                errorCode: 'RESOURCE_NOT_FOUND'
              });
            }

            db.prepare('UPDATE handover_items SET recipient_checked = ? WHERE id = ?').run(checked, itemId);
            logAuditEvent(db, {
              projectId,
              actorUserId: user.id,
              actorRole: membership.role_id,
              eventType: 'HANDOVER_ITEM_CHECKED',
              targetEntityType: 'HANDOVER',
              targetEntityId: handoverId,
              metadata: { item_id: itemId, recipient_checked: checked }
            });

            const updatedItem = db.prepare('SELECT * FROM handover_items WHERE id = ?').get(itemId);
            return sendJson(res, 200, { item: updatedItem });
          }

          // POST /api/projects/:projectId/handovers/:handoverId/acknowledge
          if (method === 'POST' && hndAction === '/acknowledge') {
            const { user, membership } = requireProjectRole(db, req, projectId, ['INCOMING_MEMBER']);
            const body = await readJsonBody(req);
            const notes = typeof body.acknowledgement_notes === 'string' ? body.acknowledgement_notes.trim() : '';

            if (!notes) {
              throw Object.assign(new Error('acknowledgement_notes is required to acknowledge a handover.'), {
                statusCode: 400,
                errorCode: 'INVALID_PAYLOAD'
              });
            }

            if (handover.recipient_user_id && handover.recipient_user_id !== user.id) {
              throw Object.assign(
                new Error('Only the designated intended recipient can acknowledge receipt of this handover package.'),
                { statusCode: 403, errorCode: 'FORBIDDEN_ROLE' }
              );
            }

            if (handover.status !== 'PUBLISHED') {
              throw Object.assign(
                new Error(`Handover must be 'PUBLISHED' before acknowledgement (current status: '${handover.status}').`),
                { statusCode: 409, errorCode: 'INVALID_STATE_TRANSITION' }
              );
            }

            if (body.check_all_items === true) {
              db.prepare('UPDATE handover_items SET recipient_checked = 1 WHERE handover_id = ?').run(handoverId);
            }

            const items = db.prepare('SELECT * FROM handover_items WHERE handover_id = ?').all(handoverId);
            const unchecked = items.filter((i) => Number(i.recipient_checked) !== 1);
            if (unchecked.length > 0) {
              throw Object.assign(
                new Error(`All handover items must be checked before acknowledgement (${unchecked.length} item(s) remain unchecked).`),
                { statusCode: 422, errorCode: 'UNCHECKED_HANDOVER_ITEMS' }
              );
            }

            const now = new Date().toISOString();
            const ackResult = withTransaction(db, () => {
              db.prepare(`
                UPDATE handover_packages
                SET status = 'ACKNOWLEDGED', acknowledged_by_user_id = ?,
                    acknowledged_at = ?, acknowledgement_notes = ?
                WHERE id = ?
              `).run(user.id, now, notes, handoverId);

              const ackId = `ack_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
              db.prepare(`
                INSERT INTO handover_acknowledgements (
                  id, handover_id, handover_version, recipient_user_id,
                  acknowledgement_type, acknowledgement_disclaimer,
                  notes, checked_item_count, created_at
                ) VALUES (?, ?, ?, ?, 'RECEIPT_ONLY_NOT_AGREEMENT_OR_UNDERSTANDING', ?, ?, ?, ?)
              `).run(
                ackId,
                handoverId,
                handover.version_number,
                user.id,
                RECEIPT_DISCLAIMER,
                notes,
                items.length,
                now
              );

              const updatedRow = db
                .prepare(`
                  SELECT h.*,
                         u_cr.full_name AS created_by_name,
                         u_pub.full_name AS published_by_name,
                         u_rec.full_name AS recipient_name,
                         u_ack.full_name AS acknowledged_by_name
                  FROM handover_packages h
                  LEFT JOIN users u_cr ON u_cr.id = h.created_by_user_id
                  LEFT JOIN users u_pub ON u_pub.id = h.published_by_user_id
                  LEFT JOIN users u_rec ON u_rec.id = h.recipient_user_id
                  LEFT JOIN users u_ack ON u_ack.id = h.acknowledged_by_user_id
                  WHERE h.id = ?
                `)
                .get(handoverId);

              const roleFiltered = buildRoleFilteredHandoverResponse(db, updatedRow, membership.role_id);

              db.prepare(`
                INSERT INTO handover_versions (
                  id, handover_id, project_id, version_number,
                  lifecycle_event, snapshot_json, actor_user_id, created_at
                ) VALUES (?, ?, ?, ?, 'ACKNOWLEDGED', ?, ?, ?)
              `).run(
                `hvr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
                handoverId,
                projectId,
                handover.version_number,
                JSON.stringify(roleFiltered),
                user.id,
                now
              );

              logAuditEvent(db, {
                projectId,
                actorUserId: user.id,
                actorRole: 'INCOMING_MEMBER',
                eventType: 'HANDOVER_ACKNOWLEDGED',
                targetEntityType: 'HANDOVER',
                targetEntityId: handoverId,
                metadata: {
                  acknowledgement_id: ackId,
                  handover_version: handover.version_number,
                  acknowledgement_type: 'RECEIPT_ONLY_NOT_AGREEMENT_OR_UNDERSTANDING',
                  checked_item_count: items.length
                }
              });

              return {
                handover: roleFiltered.handover,
                acknowledgement: db.prepare('SELECT * FROM handover_acknowledgements WHERE id = ?').get(ackId),
                versions: roleFiltered.versions
              };
            });

            return sendJson(res, 200, ackResult);
          }
        }

        // Stage 09: Optional Camera-Assisted / Non-Camera Step-Up Verification
        if (subPath === '/step-up/challenge' && method === 'POST') {
          const { user, membership } = requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);
          const body = await readJsonBody(req);
          const challenge = issueStepUpChallenge(db, { projectId, user, membership, body });
          return sendJson(res, 200, challenge);
        }

        if (subPath === '/step-up/verify' && method === 'POST') {
          const { user, membership } = requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);
          const body = await readJsonBody(req);
          const result = verifyStepUpAction(db, { projectId, user, membership, body });
          return sendJson(res, 200, result);
        }

        if (subPath === '/step-up/events' && method === 'GET') {
          requireProjectRole(db, req, projectId, ['PI_LEAD', 'AUDITOR']);
          const events = listStepUpEvents(db, projectId);
          return sendJson(res, 200, { step_up_events: events });
        }

        // GET /api/projects/:projectId/audit-events (Append-only: reject any edit/delete/mutation attempt)
        if (subPath === '/audit-events' || subPath.startsWith('/audit-events/')) {
          if (method !== 'GET' || subPath !== '/audit-events') {
            const { user, membership } = requireProjectRole(db, req, projectId, ALL_PROJECT_ROLES);
            logAuditEvent(db, {
              projectId,
              actorUserId: user.id,
              actorRole: membership.role_id,
              eventType: 'ACCESS_DENIED',
              targetEntityType: 'AUDIT_LOG',
              targetEntityId: subPath,
              metadata: { reason: 'AUDIT_HISTORY_APPEND_ONLY_IMMUTABLE', attempted_method: method, path: pathname }
            });
            throw Object.assign(
              new Error('Audit history is append-only and immutable. Edit and delete operations on audit_events are prohibited.'),
              { statusCode: 405, errorCode: 'AUDIT_LOG_IMMUTABLE' }
            );
          }
          requireProjectRole(db, req, projectId, ['PI_LEAD', 'AUDITOR']);
          const events = db
            .prepare(`
              SELECT ae.*, u.full_name AS actor_name
              FROM audit_events ae
              LEFT JOIN users u ON u.id = ae.actor_user_id
              WHERE ae.project_id = ? OR ae.project_id IS NULL
              ORDER BY ae.created_at DESC
              LIMIT 200
            `)
            .all(projectId)
            .map((e) => ({
              ...e,
              metadata: JSON.parse(e.metadata_json || '{}')
            }));
          return sendJson(res, 200, { audit_events: events });
        }
      }

      // Serve static frontend files if present in public/ (for Stage 03+)
      if (method === 'GET' && !pathname.startsWith('/api')) {
        const publicDir = path.resolve(__dirname, '..', 'public');
        const requestedFile = pathname === '/' ? 'index.html' : pathname.slice(1);
        const safeTarget = path.resolve(publicDir, requestedFile);
        if (safeTarget.startsWith(publicDir) && fs.existsSync(safeTarget) && fs.statSync(safeTarget).isFile()) {
          const ext = path.extname(safeTarget).toLowerCase();
          const mimeMap = {
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.svg': 'image/svg+xml'
          };
          res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'text/plain; charset=utf-8' });
          res.end(fs.readFileSync(safeTarget));
          return;
        }
      }

      throw Object.assign(new Error(`Route '${method} ${pathname}' not found.`), {
        statusCode: 404,
        errorCode: 'ROUTE_NOT_FOUND'
      });
    } catch (err) {
      return sendError(res, err);
    }
  }

  const server = http.createServer(handleRequest);
  server.handleRequest = handleRequest;
  return server;
}

module.exports = { createApp };
