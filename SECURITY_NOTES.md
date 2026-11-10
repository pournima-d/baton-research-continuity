# BATON — Security Architecture, Controls & Known Limitations (`SECURITY_NOTES.md`)

> **Stage 08 Security & Audit Statement:** This document details the security controls enforced in BATON and explicitly states remaining architectural and operational limitations. **No claim of complete or perfect security is made.**

---

## 1. Enforced Server-Side Security & Governance Controls

1. **Deterministic Server-Side Authorization & Project Membership Checks (`server/middleware/authRbac.js`):**
   - Every `/api/projects/:projectId/*` endpoint validates both authentication and active project membership (`memberships` table) before executing any query or mutation.
   - Least-privilege role permissions strictly follow [`ROLE_PERMISSION_MATRIX.md`](./ROLE_PERMISSION_MATRIX.md) (`PI_LEAD`, `RESEARCHER`, `REVIEWER`, `INCOMING_MEMBER`, `AUDITOR`). UI controls are convenience mirrors only; all role checks are enforced on the server.
   - An LLM is **never** used to decide permissions, filter restricted content, or approve records.

2. **Resource-Level Authorization & Cross-Project Isolation (`server/app.js`, `server/services/evidenceInspector.js`):**
   - Projects, sources, provenance spans, continuity records, reviews, handovers, and audit events are scoped by `project_id` on every SQL query.
   - Guessed or cross-project resource IDs (`source_id`, `span_id`, `record_id`, `handover_id`) are rejected (`404 RESOURCE_NOT_FOUND` or `422 CROSS_PROJECT_EVIDENCE_VIOLATION`) and recorded as `ACCESS_DENIED` in `audit_events`.

3. **Pre-Retrieval & Pre-AI Restricted Data Filtering (`server/services/preAiFilter.js`, `server/services/handoverService.js`):**
   - Sources marked `visibility_level = 'RESTRICTED_PI_ONLY'` or `exclude_from_ai = 1` are filtered out in SQL before document retrieval, AI context construction (`POST /reconstruct`), summarisation, and handover package generation (`POST /handovers` & `GET /handovers/:id`).
   - Restricted text never enters a model prompt or shared handover view for an unauthorised role.

4. **Append-Only Audit Trail (`server/services/auditService.js`, `006_stage08_security_and_audit.sql`):**
   - Sensitive operations (`SOURCE_UPLOADED`, `RECONSTRUCTION_COMPLETED`, `RECORD_CREATED`, `RECORD_EDITED`, `RECORD_VERIFIED`, `REVIEW_SUBMITTED`, `HANDOVER_CREATED`, `HANDOVER_PUBLISHED`, `HANDOVER_ACKNOWLEDGED`, `PRIVATE_FILE_ACCESSED`) and all access denials (`ACCESS_DENIED`) are recorded in `audit_events`.
   - `audit_events` is append-only during normal runtime workflows: SQLite trigger `trg_audit_events_prevent_update` blocks `UPDATE` statements on `audit_events`, and any HTTP `POST`/`PUT`/`PATCH`/`DELETE` against `/api/projects/:id/audit-events` is rejected with `405 AUDIT_LOG_IMMUTABLE` and logged as `ACCESS_DENIED`.

5. **Sessions, Password Hashing, CSRF Protection, Rate Limiting & CORS (`server/middleware/authRbac.js`, `server/app.js`):**
   - **Passwords & Tokens:** User passwords are hashed with `crypto.scryptSync` (`scrypt$<salt>$<derived64>`) and verified via constant-time `crypto.timingSafeEqual`. API and session tokens are indexed by SHA-256 digest (`token_sha256`, `session_token_sha256`).
   - **Cookie Sessions & CSRF:** `POST /api/auth/login` issues `HttpOnly; SameSite=Strict; Secure` session cookies alongside a per-session `csrf_token`. Any state-changing request (`POST`, `PATCH`, `PUT`, `DELETE`) authenticated via session cookie requires a matching `X-CSRF-Token` header (`403 CSRF_VALIDATION_FAILED` on mismatch).
   - **Rate Limiting:** Sensitive endpoints (`/api/auth/login`, `/api/projects/:id/sources`, `/api/projects/:id/reconstruct`) enforce sliding-window rate limits (`429 RATE_LIMIT_EXCEEDED`).
   - **CORS & Security Headers:** Untrusted cross-origin `Origin` headers are rejected (`403 FORBIDDEN_CORS_ORIGIN`); responses never emit wildcard `Access-Control-Allow-Origin: *` and include `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Content-Security-Policy`.

6. **Private Upload Storage & Untrusted Prompt-Injection Sandboxing (`server/services/storageService.js`, `server/services/aiReconstructor.js`):**
   - Uploaded files are stored outside `public/` under `storage/private_uploads/` with non-guessable random 192-bit storage keys (`priv_<48-hex>.dat`). Direct `/storage/*` URL requests are blocked (`403 FORBIDDEN_STORAGE_PATH`), and authorised access via `GET /api/projects/:id/sources/:sourceId/file` enforces project membership and `RESTRICTED_PI_ONLY` checks.
   - Embedded prompt-injection strings (`IGNORE ALL PREVIOUS INSTRUCTIONS`, `System Prompt:`, tool-invocation strings, or `set approval_status='APPROVED'`) are detected on ingest (`UNTRUSTED_PROMPT_PATTERN_SANDBOXED`), stripped from extraction instructions, and never allowed to override system instructions, trigger tools, or self-approve records.
   - Error responses sanitize file-system paths and withhold stack traces, secrets, and restricted content.

---

## 2. Known Security Limitations (No Claim of Perfect Security)

1. **Local SQLite & Host Filesystem Trust Boundary:**
   - BATON uses a single-node SQLite database (`data/baton.db`) and local filesystem directory (`storage/private_uploads/`). Anyone with OS-level root/administrator access to the host machine can read the SQLite file or private upload files directly on disk (no at-rest KMS envelope encryption is enabled in this local prototype).
2. **In-Memory Rate Limiting:**
   - Sliding-window rate limit counters are stored in process memory (`Map`). In a multi-process or horizontally scaled deployment, rate limits would need a shared store (e.g., Redis) and reverse-proxy enforcement.
3. **Evaluation Demo Persona Switcher (`/api/auth/demo-users`):**
   - To support interactive evaluation of all 6 personas (`PI_LEAD`, `RESEARCHER`, `REVIEWER`, `INCOMING_MEMBER`, `AUDITOR`, and non-member) in the local prototype workspace, `/api/auth/demo-users` and `/api/demo/reset` are enabled. In a production deployment, `/api/auth/demo-users` and `/api/demo/reset` must be disabled and replaced exclusively with institutional SSO / OIDC or `/api/auth/login`.
4. **Heuristic Prompt-Injection Filtering:**
   - While BATON deterministically strips known prompt-injection patterns, validates output against a strict JSON schema, requires exact substring provenance verification against stored spans, and never grants tool-execution or approval privileges to the extractor, novel natural-language phrasing inside a shared document could still influence wording of candidate summaries until human verification and review in Stages 3–4.
