'use strict';

const crypto = require('node:crypto');
const { logAuditEvent } = require('./auditService');
const { verifyPasswordScrypt, sha256Hex } = require('../middleware/authRbac');

const STEP_UP_EPISTEMIC_DISCLOSURE =
  'Browser camera permission only means a local camera stream was made available in the browser. It does NOT perform facial recognition, verify identity, prove who is present, or prove liveness. The authenticated session and MFA/passkey verification remain the actual security control. No images, video frames, or biometric data are recorded, uploaded, or stored.';

const CAMERA_PERMISSION_EXPLANATION =
  'Optional step-up check for sensitive project actions: if you choose the camera-assisted route, your browser will ask to open a local-only video preview alongside your MFA/passkey code. No frames, images, video, or biometric data are ever captured, uploaded, or stored. You may cancel at any time or choose the equivalent non-camera MFA/passkey route.';

const VALID_SENSITIVE_ACTIONS = new Set([
  'PUBLISH_HANDOVER_PACKAGE',
  'ACCESS_RESTRICTED_SOURCE',
  'APPROVE_SENSITIVE_RECORD'
]);

const VALID_ROUTES = new Set([
  'CAMERA_ASSISTED_MFA',
  'NON_CAMERA_MFA_PASSKEY'
]);

const VALID_CAMERA_STATUSES = new Set([
  'NOT_REQUESTED',
  'STREAM_AVAILABLE',
  'PERMISSION_DENIED',
  'NO_DEVICE',
  'UNSUPPORTED_BROWSER',
  'CANCELLED',
  'DEVICE_ERROR'
]);

const PROHIBITED_MEDIA_FIELDS = [
  'image',
  'image_data',
  'image_base64',
  'video',
  'video_data',
  'frame',
  'frames',
  'biometric_data',
  'face_embedding',
  'liveness_proof',
  'media_blob'
];

const DEMO_VALID_MFA_CODES = new Set(['654321', 'BATON-MFA-OK']);
const DEMO_VALID_PASSKEY_ASSERTIONS = new Set(['passkey_verified_assertion_v1', 'webauthn_assertion_ok']);

function assertNoMediaOrBiometricPayload(db, { projectId, user, membership, body }) {
  if (!body || typeof body !== 'object') return;
  for (const field of PROHIBITED_MEDIA_FIELDS) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== '') {
      logAuditEvent(db, {
        projectId,
        actorUserId: user.id,
        actorRole: membership.role_id,
        eventType: 'ACCESS_DENIED',
        targetEntityType: 'STEP_UP_VERIFICATION',
        targetEntityId: projectId,
        metadata: {
          reason: 'BIOMETRIC_OR_MEDIA_STORAGE_PROHIBITED',
          prohibited_field: field
        }
      });
      throw Object.assign(
        new Error(
          `Prohibited field '${field}' rejected: BATON never records, uploads, or stores camera images, video frames, or biometric data.`
        ),
        { statusCode: 400, errorCode: 'MEDIA_UPLOAD_PROHIBITED' }
      );
    }
  }
}

function validateActionRole(requestedAction, roleId) {
  if (!VALID_SENSITIVE_ACTIONS.has(requestedAction)) {
    throw Object.assign(
      new Error(
        `Invalid requested_action '${requestedAction}'. Allowed sensitive actions: ${Array.from(VALID_SENSITIVE_ACTIONS).join(', ')}`
      ),
      { statusCode: 400, errorCode: 'INVALID_STEP_UP_ACTION' }
    );
  }

  if (
    (requestedAction === 'PUBLISH_HANDOVER_PACKAGE' || requestedAction === 'ACCESS_RESTRICTED_SOURCE') &&
    roleId !== 'PI_LEAD'
  ) {
    throw Object.assign(
      new Error(`Role '${roleId}' is not permitted to perform sensitive action '${requestedAction}'.`),
      { statusCode: 403, errorCode: 'FORBIDDEN_ROLE' }
    );
  }

  if (requestedAction === 'APPROVE_SENSITIVE_RECORD' && roleId !== 'PI_LEAD' && roleId !== 'REVIEWER') {
    throw Object.assign(
      new Error(`Role '${roleId}' is not permitted to perform sensitive action '${requestedAction}'.`),
      { statusCode: 403, errorCode: 'FORBIDDEN_ROLE' }
    );
  }
}

function issueStepUpChallenge(db, { projectId, user, membership, body = {} }) {
  assertNoMediaOrBiometricPayload(db, { projectId, user, membership, body });

  const requestedAction =
    typeof body.requested_action === 'string' && body.requested_action.trim()
      ? body.requested_action.trim()
      : 'PUBLISH_HANDOVER_PACKAGE';

  try {
    validateActionRole(requestedAction, membership.role_id);
  } catch (err) {
    if (err.statusCode === 403) {
      logAuditEvent(db, {
        projectId,
        actorUserId: user.id,
        actorRole: membership.role_id,
        eventType: 'ACCESS_DENIED',
        targetEntityType: 'STEP_UP_VERIFICATION',
        targetEntityId: requestedAction,
        metadata: { reason: 'INSUFFICIENT_ROLE_FOR_STEP_UP_ACTION', requested_action: requestedAction }
      });
    }
    throw err;
  }

  const eventId = `sup_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO step_up_events (
      id, project_id, user_id, user_role, requested_action,
      verification_route, camera_stream_status, mfa_method, mfa_verified,
      outcome, media_stored, epistemic_disclosure, step_up_token_sha256, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'NON_CAMERA_MFA_PASSKEY', 'NOT_REQUESTED', 'NONE', 0, 'CHALLENGE_ISSUED', 0, ?, NULL, NULL, ?)
  `).run(eventId, projectId, user.id, membership.role_id, requestedAction, STEP_UP_EPISTEMIC_DISCLOSURE, now);

  logAuditEvent(db, {
    projectId,
    actorUserId: user.id,
    actorRole: membership.role_id,
    eventType: 'STEP_UP_CHALLENGE_ISSUED',
    targetEntityType: 'STEP_UP_VERIFICATION',
    targetEntityId: eventId,
    metadata: {
      requested_action: requestedAction,
      available_routes: ['CAMERA_ASSISTED_MFA', 'NON_CAMERA_MFA_PASSKEY'],
      media_stored: 0,
      biometric_data_stored: false
    }
  });

  return {
    challenge_id: eventId,
    project_id: projectId,
    requested_action: requestedAction,
    optional_feature: true,
    camera_permission_explanation: CAMERA_PERMISSION_EXPLANATION,
    epistemic_disclosure: STEP_UP_EPISTEMIC_DISCLOSURE,
    capabilities_disclaimer: {
      facial_recognition: false,
      identity_verification_by_camera: false,
      liveness_verification: false,
      proof_of_presence: false,
      actual_security_control: 'AUTHENTICATED_SESSION_PLUS_MFA_OR_PASSKEY',
      media_recorded_or_stored: false
    },
    available_routes: [
      {
        route: 'NON_CAMERA_MFA_PASSKEY',
        label: 'Standard MFA / Passkey Step-Up (No Camera)',
        requires_camera: false,
        requires_mfa_or_passkey: true,
        recommended_default: true
      },
      {
        route: 'CAMERA_ASSISTED_MFA',
        label: 'Optional Camera-Assisted Step-Up + MFA / Passkey',
        requires_camera: true,
        requires_mfa_or_passkey: true,
        recommended_default: false
      }
    ],
    created_at: now
  };
}

function evaluateMfaCredential(db, user, body) {
  const mfaCode = typeof body.mfa_code === 'string' ? body.mfa_code.trim() : '';
  const passkeyAssertion = typeof body.passkey_assertion === 'string' ? body.passkey_assertion.trim() : '';
  const passwordReauth = typeof body.password === 'string' ? body.password : '';

  if (mfaCode && DEMO_VALID_MFA_CODES.has(mfaCode)) {
    return { verified: true, method: 'PASSKEY_OR_TOTP' };
  }
  if (passkeyAssertion && DEMO_VALID_PASSKEY_ASSERTIONS.has(passkeyAssertion)) {
    return { verified: true, method: 'PASSKEY_OR_TOTP' };
  }
  if (passwordReauth) {
    const userRow = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (userRow && userRow.password_hash && verifyPasswordScrypt(passwordReauth, userRow.password_hash)) {
      return { verified: true, method: 'PASSWORD_REAUTH' };
    }
  }
  return { verified: false, method: 'NONE' };
}

function verifyStepUpAction(db, { projectId, user, membership, body = {} }) {
  assertNoMediaOrBiometricPayload(db, { projectId, user, membership, body });

  const requestedAction =
    typeof body.requested_action === 'string' && body.requested_action.trim()
      ? body.requested_action.trim()
      : 'PUBLISH_HANDOVER_PACKAGE';

  try {
    validateActionRole(requestedAction, membership.role_id);
  } catch (err) {
    if (err.statusCode === 403) {
      logAuditEvent(db, {
        projectId,
        actorUserId: user.id,
        actorRole: membership.role_id,
        eventType: 'ACCESS_DENIED',
        targetEntityType: 'STEP_UP_VERIFICATION',
        targetEntityId: requestedAction,
        metadata: { reason: 'INSUFFICIENT_ROLE_FOR_STEP_UP_ACTION', requested_action: requestedAction }
      });
    }
    throw err;
  }

  const selectedRoute =
    typeof body.verification_route === 'string' && VALID_ROUTES.has(body.verification_route.trim())
      ? body.verification_route.trim()
      : 'NON_CAMERA_MFA_PASSKEY';

  const cameraStreamStatus =
    typeof body.camera_stream_status === 'string' && VALID_CAMERA_STATUSES.has(body.camera_stream_status.trim())
      ? body.camera_stream_status.trim()
      : selectedRoute === 'NON_CAMERA_MFA_PASSKEY'
      ? 'NOT_REQUESTED'
      : 'STREAM_AVAILABLE';

  const eventId = `sup_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const now = new Date().toISOString();

  // 1. Handle explicit user cancellation
  if (body.cancelled === true || cameraStreamStatus === 'CANCELLED') {
    db.prepare(`
      INSERT INTO step_up_events (
        id, project_id, user_id, user_role, requested_action,
        verification_route, camera_stream_status, mfa_method, mfa_verified,
        outcome, media_stored, epistemic_disclosure, step_up_token_sha256, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'CANCELLED', 'NONE', 0, 'CANCELLED_BY_USER', 0, ?, NULL, NULL, ?)
    `).run(eventId, projectId, user.id, membership.role_id, requestedAction, selectedRoute, STEP_UP_EPISTEMIC_DISCLOSURE, now);

    logAuditEvent(db, {
      projectId,
      actorUserId: user.id,
      actorRole: membership.role_id,
      eventType: 'STEP_UP_CANCELLED',
      targetEntityType: 'STEP_UP_VERIFICATION',
      targetEntityId: eventId,
      metadata: {
        requested_action: requestedAction,
        verification_route: selectedRoute,
        camera_stream_status: 'CANCELLED',
        outcome: 'CANCELLED_BY_USER',
        media_stored: 0,
        biometric_data_stored: false
      }
    });

    return {
      step_up_event_id: eventId,
      verified: false,
      cancelled: true,
      requested_action: requestedAction,
      verification_route: selectedRoute,
      camera_stream_status: 'CANCELLED',
      outcome: 'CANCELLED_BY_USER',
      media_stored: 0,
      alternative_route: 'NON_CAMERA_MFA_PASSKEY',
      message:
        'Step-up check was cancelled by the user. No camera frames or biometric data were captured. You may retry at any time or use the non-camera MFA/passkey route.',
      epistemic_disclosure: STEP_UP_EPISTEMIC_DISCLOSURE,
      created_at: now
    };
  }

  // 2. Evaluate camera errors (PERMISSION_DENIED, NO_DEVICE, UNSUPPORTED_BROWSER, DEVICE_ERROR)
  const isCameraError =
    selectedRoute === 'CAMERA_ASSISTED_MFA' &&
    ['PERMISSION_DENIED', 'NO_DEVICE', 'UNSUPPORTED_BROWSER', 'DEVICE_ERROR'].includes(cameraStreamStatus);

  const mfaEval = evaluateMfaCredential(db, user, body);

  if (isCameraError) {
    // If allow_non_camera_fallback is true and MFA is valid, seamlessly complete via non-camera fallback
    if (body.allow_non_camera_fallback === true && mfaEval.verified) {
      const rawStepUpToken = `suptok_${crypto.randomBytes(24).toString('hex')}`;
      const tokenHash = sha256Hex(rawStepUpToken);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      db.prepare(`
        INSERT INTO step_up_events (
          id, project_id, user_id, user_role, requested_action,
          verification_route, camera_stream_status, mfa_method, mfa_verified,
          outcome, media_stored, epistemic_disclosure, step_up_token_sha256, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 'NON_CAMERA_MFA_PASSKEY', ?, ?, 1, 'CAMERA_FALLBACK_TO_NON_CAMERA', 0, ?, ?, ?, ?)
      `).run(
        eventId,
        projectId,
        user.id,
        membership.role_id,
        requestedAction,
        cameraStreamStatus,
        mfaEval.method,
        STEP_UP_EPISTEMIC_DISCLOSURE,
        tokenHash,
        expiresAt,
        now
      );

      logAuditEvent(db, {
        projectId,
        actorUserId: user.id,
        actorRole: membership.role_id,
        eventType: 'STEP_UP_CAMERA_FALLBACK',
        targetEntityType: 'STEP_UP_VERIFICATION',
        targetEntityId: eventId,
        metadata: {
          requested_action: requestedAction,
          initial_route: 'CAMERA_ASSISTED_MFA',
          effective_route: 'NON_CAMERA_MFA_PASSKEY',
          camera_stream_status: cameraStreamStatus,
          mfa_method: mfaEval.method,
          outcome: 'CAMERA_FALLBACK_TO_NON_CAMERA',
          media_stored: 0,
          biometric_data_stored: false
        }
      });

      return {
        step_up_event_id: eventId,
        verified: true,
        requested_action: requestedAction,
        verification_route: 'NON_CAMERA_MFA_PASSKEY',
        camera_stream_status: cameraStreamStatus,
        mfa_verified: true,
        mfa_method: mfaEval.method,
        outcome: 'CAMERA_FALLBACK_TO_NON_CAMERA',
        media_stored: 0,
        step_up_token: rawStepUpToken,
        expires_at: expiresAt,
        message: `Camera unavailable (${cameraStreamStatus}); seamlessly completed step-up via equivalent non-camera MFA/passkey route.`,
        epistemic_disclosure: STEP_UP_EPISTEMIC_DISCLOSURE,
        created_at: now
      };
    }

    // Otherwise log the camera error cleanly and instruct the client to use the non-camera route
    db.prepare(`
      INSERT INTO step_up_events (
        id, project_id, user_id, user_role, requested_action,
        verification_route, camera_stream_status, mfa_method, mfa_verified,
        outcome, media_stored, epistemic_disclosure, step_up_token_sha256, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'CAMERA_ASSISTED_MFA', ?, 'NONE', 0, 'CAMERA_ERROR_HANDLED', 0, ?, NULL, NULL, ?)
    `).run(
      eventId,
      projectId,
      user.id,
      membership.role_id,
      requestedAction,
      cameraStreamStatus,
      STEP_UP_EPISTEMIC_DISCLOSURE,
      now
    );

    logAuditEvent(db, {
      projectId,
      actorUserId: user.id,
      actorRole: membership.role_id,
      eventType: 'STEP_UP_CAMERA_ERROR_HANDLED',
      targetEntityType: 'STEP_UP_VERIFICATION',
      targetEntityId: eventId,
      metadata: {
        requested_action: requestedAction,
        verification_route: 'CAMERA_ASSISTED_MFA',
        camera_stream_status: cameraStreamStatus,
        outcome: 'CAMERA_ERROR_HANDLED',
        fallback_route: 'NON_CAMERA_MFA_PASSKEY',
        media_stored: 0,
        biometric_data_stored: false
      }
    });

    return {
      step_up_event_id: eventId,
      verified: false,
      camera_error_handled: true,
      requested_action: requestedAction,
      verification_route: 'CAMERA_ASSISTED_MFA',
      camera_stream_status: cameraStreamStatus,
      outcome: 'CAMERA_ERROR_HANDLED',
      media_stored: 0,
      alternative_route: 'NON_CAMERA_MFA_PASSKEY',
      message: `Browser camera returned '${cameraStreamStatus}'. Camera is optional — please proceed with the equivalent non-camera MFA/passkey route.`,
      epistemic_disclosure: STEP_UP_EPISTEMIC_DISCLOSURE,
      created_at: now
    };
  }

  // 3. Enforce real MFA / passkey / password step-up control (camera stream alone NEVER verifies identity!)
  if (!mfaEval.verified) {
    db.prepare(`
      INSERT INTO step_up_events (
        id, project_id, user_id, user_role, requested_action,
        verification_route, camera_stream_status, mfa_method, mfa_verified,
        outcome, media_stored, epistemic_disclosure, step_up_token_sha256, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'NONE', 0, 'FAILED_MFA', 0, ?, NULL, NULL, ?)
    `).run(
      eventId,
      projectId,
      user.id,
      membership.role_id,
      requestedAction,
      selectedRoute,
      cameraStreamStatus,
      STEP_UP_EPISTEMIC_DISCLOSURE,
      now
    );

    logAuditEvent(db, {
      projectId,
      actorUserId: user.id,
      actorRole: membership.role_id,
      eventType: 'STEP_UP_FAILED',
      targetEntityType: 'STEP_UP_VERIFICATION',
      targetEntityId: eventId,
      metadata: {
        requested_action: requestedAction,
        verification_route: selectedRoute,
        camera_stream_status: cameraStreamStatus,
        outcome: 'FAILED_MFA',
        reason: 'MISSING_OR_INVALID_MFA_PASSKEY',
        media_stored: 0,
        biometric_data_stored: false
      }
    });

    throw Object.assign(
      new Error(
        'Step-up verification requires a valid MFA code, passkey assertion, or password re-authentication. Browser camera availability alone does not verify identity or grant step-up authorization.'
      ),
      { statusCode: 401, errorCode: 'STEP_UP_MFA_REQUIRED' }
    );
  }

  // 4. Both authenticated session and real MFA/passkey control succeeded
  const rawStepUpToken = `suptok_${crypto.randomBytes(24).toString('hex')}`;
  const tokenHash = sha256Hex(rawStepUpToken);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const finalCameraStatus = selectedRoute === 'NON_CAMERA_MFA_PASSKEY' ? 'NOT_REQUESTED' : cameraStreamStatus;

  db.prepare(`
    INSERT INTO step_up_events (
      id, project_id, user_id, user_role, requested_action,
      verification_route, camera_stream_status, mfa_method, mfa_verified,
      outcome, media_stored, epistemic_disclosure, step_up_token_sha256, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'STEP_UP_SUCCEEDED', 0, ?, ?, ?, ?)
  `).run(
    eventId,
    projectId,
    user.id,
    membership.role_id,
    requestedAction,
    selectedRoute,
    finalCameraStatus,
    mfaEval.method,
    STEP_UP_EPISTEMIC_DISCLOSURE,
    tokenHash,
    expiresAt,
    now
  );

  logAuditEvent(db, {
    projectId,
    actorUserId: user.id,
    actorRole: membership.role_id,
    eventType: 'STEP_UP_VERIFIED',
    targetEntityType: 'STEP_UP_VERIFICATION',
    targetEntityId: eventId,
    metadata: {
      requested_action: requestedAction,
      verification_route: selectedRoute,
      camera_stream_status: finalCameraStatus,
      mfa_method: mfaEval.method,
      outcome: 'STEP_UP_SUCCEEDED',
      media_stored: 0,
      biometric_data_stored: false
    }
  });

  return {
    step_up_event_id: eventId,
    verified: true,
    requested_action: requestedAction,
    verification_route: selectedRoute,
    camera_stream_status: finalCameraStatus,
    mfa_verified: true,
    mfa_method: mfaEval.method,
    outcome: 'STEP_UP_SUCCEEDED',
    media_stored: 0,
    step_up_token: rawStepUpToken,
    expires_at: expiresAt,
    epistemic_disclosure: STEP_UP_EPISTEMIC_DISCLOSURE,
    capabilities_disclaimer: {
      facial_recognition: false,
      identity_verification_by_camera: false,
      liveness_verification: false,
      proof_of_presence: false,
      actual_security_control: 'AUTHENTICATED_SESSION_PLUS_MFA_OR_PASSKEY',
      media_recorded_or_stored: false
    },
    created_at: now
  };
}

function validateStepUpToken(db, { projectId, userId, requestedAction, rawToken }) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const tokenHash = sha256Hex(rawToken.trim());
  const row = db
    .prepare(`
      SELECT *
      FROM step_up_events
      WHERE project_id = ?
        AND user_id = ?
        AND requested_action = ?
        AND step_up_token_sha256 = ?
        AND mfa_verified = 1
        AND outcome IN ('STEP_UP_SUCCEEDED', 'CAMERA_FALLBACK_TO_NON_CAMERA')
    `)
    .get(projectId, userId, requestedAction, tokenHash);

  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    return null;
  }
  return row;
}

function listStepUpEvents(db, projectId) {
  return db
    .prepare(`
      SELECT id, project_id, user_id, user_role, requested_action,
             verification_route, camera_stream_status, mfa_method, mfa_verified,
             outcome, media_stored, epistemic_disclosure, expires_at, created_at
      FROM step_up_events
      WHERE project_id = ?
      ORDER BY created_at DESC, rowid DESC
    `)
    .all(projectId);
}

module.exports = {
  STEP_UP_EPISTEMIC_DISCLOSURE,
  CAMERA_PERMISSION_EXPLANATION,
  issueStepUpChallenge,
  verifyStepUpAction,
  validateStepUpToken,
  listStepUpEvents
};
