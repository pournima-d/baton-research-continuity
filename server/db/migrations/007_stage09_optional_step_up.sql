-- =============================================================================
-- BATON Stage 09: Optional Camera-Assisted Step-Up Verification
-- =============================================================================

CREATE TABLE IF NOT EXISTS step_up_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  user_role TEXT NOT NULL,
  requested_action TEXT NOT NULL CHECK (
    requested_action IN (
      'PUBLISH_HANDOVER_PACKAGE',
      'ACCESS_RESTRICTED_SOURCE',
      'APPROVE_SENSITIVE_RECORD'
    )
  ),
  verification_route TEXT NOT NULL CHECK (
    verification_route IN (
      'CAMERA_ASSISTED_MFA',
      'NON_CAMERA_MFA_PASSKEY'
    )
  ),
  camera_stream_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED' CHECK (
    camera_stream_status IN (
      'NOT_REQUESTED',
      'STREAM_AVAILABLE',
      'PERMISSION_DENIED',
      'NO_DEVICE',
      'UNSUPPORTED_BROWSER',
      'CANCELLED',
      'DEVICE_ERROR'
    )
  ),
  mfa_method TEXT NOT NULL DEFAULT 'PASSKEY_OR_TOTP' CHECK (
    mfa_method IN ('PASSKEY_OR_TOTP', 'PASSWORD_REAUTH', 'NONE')
  ),
  mfa_verified INTEGER NOT NULL DEFAULT 0 CHECK (mfa_verified IN (0, 1)),
  outcome TEXT NOT NULL CHECK (
    outcome IN (
      'CHALLENGE_ISSUED',
      'STEP_UP_SUCCEEDED',
      'CAMERA_FALLBACK_TO_NON_CAMERA',
      'CANCELLED_BY_USER',
      'FAILED_MFA',
      'CAMERA_ERROR_HANDLED'
    )
  ),
  -- Schema-enforced guarantee: no image, video, or biometric data is ever stored (must remain 0)
  media_stored INTEGER NOT NULL DEFAULT 0 CHECK (media_stored = 0),
  epistemic_disclosure TEXT NOT NULL,
  step_up_token_sha256 TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_step_up_events_project_created
  ON step_up_events(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_step_up_events_token_sha256
  ON step_up_events(step_up_token_sha256);
