-- BATON Migration 006: Stage 08 Permissions, Security & Audit Hardening
-- Adds password_hash (scrypt) and token_sha256 to users, creates auth_sessions
-- with CSRF tokens & expiration, and enforces append-only immutability on audit_events.

ALTER TABLE users ADD COLUMN password_hash TEXT NULL;
ALTER TABLE users ADD COLUMN token_sha256 TEXT NULL;

CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token_sha256 TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(session_token_sha256);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

-- Enforce append-only audit_events through normal application workflows
CREATE TRIGGER IF NOT EXISTS trg_audit_events_prevent_update
BEFORE UPDATE ON audit_events
BEGIN
    SELECT RAISE(ABORT, 'AUDIT_LOG_IMMUTABLE: audit_events is append-only and cannot be modified.');
END;
