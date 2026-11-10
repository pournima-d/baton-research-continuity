'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const TEST_DB_PATH = path.resolve(__dirname, '..', 'data', 'test_stage09_step_up.db');
process.env.DB_PATH = TEST_DB_PATH;

const { openDatabase, closeDatabase, runMigrations } = require('../server/db/database');
const { seedDatabase } = require('../server/db/seed');
const { createApp } = require('../server/app');

function cleanTestDbFiles() {
  closeDatabase();
  for (const suffix of ['', '-shm', '-wal']) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
    }
  }
}

async function apiRequest(server, method, route, { token = null, headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = route;
    req.headers = { 'content-type': 'application/json', ...headers };
    if (token) req.headers['authorization'] = `Bearer ${token}`;
    req.destroy = () => {};

    const res = {
      statusCode: 200,
      headers: {},
      writeHead(code, hdrs = {}) {
        this.statusCode = code;
        Object.assign(this.headers, hdrs);
      },
      end(chunk) {
        try {
          const text = chunk ? chunk.toString('utf8') : '{}';
          const json = JSON.parse(text);
          resolve({ status: this.statusCode, headers: this.headers, body: json, rawText: text });
        } catch (err) {
          reject(err);
        }
      }
    };

    server.handleRequest(req, res).catch(reject);

    process.nextTick(() => {
      if (body !== null && body !== undefined) {
        const raw = typeof body === 'string' ? body : JSON.stringify(body);
        req.emit('data', Buffer.from(raw, 'utf8'));
      }
      req.emit('end');
    });
  });
}

test('Stage 09 — Optional Camera-Assisted Step-Up Suite', async (t) => {
  cleanTestDbFiles();
  const db = openDatabase(TEST_DB_PATH);
  runMigrations(db);
  seedDatabase(db);
  const server = createApp(db);

  t.after(() => {
    cleanTestDbFiles();
  });

  await t.test('1. Step-up challenge is optional, risk-triggered, explains why camera permission is requested, provides a non-camera route, and makes no false identity or liveness claims', async () => {
    const chRes = await apiRequest(
      server,
      'POST',
      '/api/projects/prj_solidstate_01/step-up/challenge',
      {
        token: 'tok_pi_lead_01',
        body: { requested_action: 'PUBLISH_HANDOVER_PACKAGE' }
      }
    );
    assert.equal(chRes.status, 200);
    assert.equal(chRes.body.optional_feature, true);
    assert.equal(chRes.body.requested_action, 'PUBLISH_HANDOVER_PACKAGE');
    assert.ok(chRes.body.camera_permission_explanation.includes('local-only video preview'));
    assert.ok(chRes.body.epistemic_disclosure.includes('does NOT perform facial recognition'));
    assert.ok(chRes.body.epistemic_disclosure.includes('verify identity, prove who is present, or prove liveness'));

    const disc = chRes.body.capabilities_disclaimer;
    assert.equal(disc.facial_recognition, false);
    assert.equal(disc.identity_verification_by_camera, false);
    assert.equal(disc.liveness_verification, false);
    assert.equal(disc.proof_of_presence, false);
    assert.equal(disc.actual_security_control, 'AUTHENTICATED_SESSION_PLUS_MFA_OR_PASSKEY');
    assert.equal(disc.media_recorded_or_stored, false);

    const routes = chRes.body.available_routes.map((r) => r.route);
    assert.deepEqual(routes, ['NON_CAMERA_MFA_PASSKEY', 'CAMERA_ASSISTED_MFA']);

    // Unauthorised role (RESEARCHER) cannot request step-up for PI-only PUBLISH_HANDOVER_PACKAGE
    const deniedRole = await apiRequest(
      server,
      'POST',
      '/api/projects/prj_solidstate_01/step-up/challenge',
      {
        token: 'tok_researcher_01',
        body: { requested_action: 'PUBLISH_HANDOVER_PACKAGE' }
      }
    );
    assert.equal(deniedRole.status, 403);
    assert.equal(deniedRole.body.error.code, 'FORBIDDEN_ROLE');
  });

  await t.test('2. Camera permission denied, no camera device, unsupported browser, and device errors are handled cleanly and support fallback to the non-camera route', async () => {
    const errorStatuses = ['PERMISSION_DENIED', 'NO_DEVICE', 'UNSUPPORTED_BROWSER', 'DEVICE_ERROR'];

    // Without automatic fallback: returns 200 with camera_error_handled=true and points to NON_CAMERA_MFA_PASSKEY
    for (const status of errorStatuses) {
      const errRes = await apiRequest(
        server,
        'POST',
        '/api/projects/prj_solidstate_01/step-up/verify',
        {
          token: 'tok_pi_lead_01',
          body: {
            requested_action: 'PUBLISH_HANDOVER_PACKAGE',
            verification_route: 'CAMERA_ASSISTED_MFA',
            camera_stream_status: status,
            allow_non_camera_fallback: false
          }
        }
      );
      assert.equal(errRes.status, 200);
      assert.equal(errRes.body.verified, false);
      assert.equal(errRes.body.camera_error_handled, true);
      assert.equal(errRes.body.camera_stream_status, status);
      assert.equal(errRes.body.outcome, 'CAMERA_ERROR_HANDLED');
      assert.equal(errRes.body.alternative_route, 'NON_CAMERA_MFA_PASSKEY');
      assert.equal(errRes.body.media_stored, 0);
    }

    // With allow_non_camera_fallback=true and valid MFA code: seamlessly completes via NON_CAMERA_MFA_PASSKEY
    const fallbackRes = await apiRequest(
      server,
      'POST',
      '/api/projects/prj_solidstate_01/step-up/verify',
      {
        token: 'tok_pi_lead_01',
        body: {
          requested_action: 'PUBLISH_HANDOVER_PACKAGE',
          verification_route: 'CAMERA_ASSISTED_MFA',
          camera_stream_status: 'PERMISSION_DENIED',
          mfa_code: '654321',
          allow_non_camera_fallback: true
        }
      }
    );
    assert.equal(fallbackRes.status, 200);
    assert.equal(fallbackRes.body.verified, true);
    assert.equal(fallbackRes.body.verification_route, 'NON_CAMERA_MFA_PASSKEY');
    assert.equal(fallbackRes.body.camera_stream_status, 'PERMISSION_DENIED');
    assert.equal(fallbackRes.body.outcome, 'CAMERA_FALLBACK_TO_NON_CAMERA');
    assert.equal(fallbackRes.body.media_stored, 0);
    assert.ok(fallbackRes.body.step_up_token);
  });

  await t.test('3. User cancellation is allowed, handled cleanly, and logged without storing biometric data', async () => {
    const cancelRes = await apiRequest(
      server,
      'POST',
      '/api/projects/prj_solidstate_01/step-up/verify',
      {
        token: 'tok_pi_lead_01',
        body: {
          requested_action: 'PUBLISH_HANDOVER_PACKAGE',
          verification_route: 'CAMERA_ASSISTED_MFA',
          camera_stream_status: 'CANCELLED',
          cancelled: true
        }
      }
    );
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.verified, false);
    assert.equal(cancelRes.body.cancelled, true);
    assert.equal(cancelRes.body.outcome, 'CANCELLED_BY_USER');
    assert.equal(cancelRes.body.alternative_route, 'NON_CAMERA_MFA_PASSKEY');
    assert.equal(cancelRes.body.media_stored, 0);
  });

  await t.test('4. Equivalent non-camera route (NON_CAMERA_MFA_PASSKEY) completes step-up verification using MFA/passkey or password re-authentication', async () => {
    // Non-camera route with passkey assertion
    const nonCamPasskey = await apiRequest(
      server,
      'POST',
      '/api/projects/prj_solidstate_01/step-up/verify',
      {
        token: 'tok_pi_lead_01',
        body: {
          requested_action: 'ACCESS_RESTRICTED_SOURCE',
          verification_route: 'NON_CAMERA_MFA_PASSKEY',
          passkey_assertion: 'passkey_verified_assertion_v1'
        }
      }
    );
    assert.equal(nonCamPasskey.status, 200);
    assert.equal(nonCamPasskey.body.verified, true);
    assert.equal(nonCamPasskey.body.verification_route, 'NON_CAMERA_MFA_PASSKEY');
    assert.equal(nonCamPasskey.body.camera_stream_status, 'NOT_REQUESTED');
    assert.equal(nonCamPasskey.body.mfa_verified, true);
    assert.equal(nonCamPasskey.body.outcome, 'STEP_UP_SUCCEEDED');
    assert.equal(nonCamPasskey.body.media_stored, 0);
    assert.ok(nonCamPasskey.body.step_up_token);

    // Non-camera route with scrypt password re-authentication
    const nonCamPassword = await apiRequest(
      server,
      'POST',
      '/api/projects/prj_solidstate_01/step-up/verify',
      {
        token: 'tok_pi_lead_01',
        body: {
          requested_action: 'APPROVE_SENSITIVE_RECORD',
          verification_route: 'NON_CAMERA_MFA_PASSKEY',
          password: 'BatonDemoPass!2026'
        }
      }
    );
    assert.equal(nonCamPassword.status, 200);
    assert.equal(nonCamPassword.body.verified, true);
    assert.equal(nonCamPassword.body.mfa_method, 'PASSWORD_REAUTH');
    assert.equal(nonCamPassword.body.media_stored, 0);
  });

  await t.test('5. Successful camera-assisted step-up requires real MFA/passkey control (camera stream alone is rejected) and authorizes risk-triggered handover publication', async () => {
    // Camera stream available WITHOUT valid MFA/passkey -> MUST FAIL with 401 STEP_UP_MFA_REQUIRED
    const streamOnlyFail = await apiRequest(
      server,
      'POST',
      '/api/projects/prj_solidstate_01/step-up/verify',
      {
        token: 'tok_pi_lead_01',
        body: {
          requested_action: 'PUBLISH_HANDOVER_PACKAGE',
          verification_route: 'CAMERA_ASSISTED_MFA',
          camera_stream_status: 'STREAM_AVAILABLE',
          mfa_code: ''
        }
      }
    );
    assert.equal(streamOnlyFail.status, 401);
    assert.equal(streamOnlyFail.body.error.code, 'STEP_UP_MFA_REQUIRED');

    // Camera stream available WITH valid MFA code -> SUCCEEDS
    const camSuccess = await apiRequest(
      server,
      'POST',
      '/api/projects/prj_solidstate_01/step-up/verify',
      {
        token: 'tok_pi_lead_01',
        body: {
          requested_action: 'PUBLISH_HANDOVER_PACKAGE',
          verification_route: 'CAMERA_ASSISTED_MFA',
          camera_stream_status: 'STREAM_AVAILABLE',
          mfa_code: '654321'
        }
      }
    );
    assert.equal(camSuccess.status, 200);
    assert.equal(camSuccess.body.verified, true);
    assert.equal(camSuccess.body.verification_route, 'CAMERA_ASSISTED_MFA');
    assert.equal(camSuccess.body.camera_stream_status, 'STREAM_AVAILABLE');
    assert.equal(camSuccess.body.mfa_verified, true);
    assert.equal(camSuccess.body.outcome, 'STEP_UP_SUCCEEDED');
    assert.equal(camSuccess.body.media_stored, 0);
    const stepUpToken = camSuccess.body.step_up_token;
    assert.ok(stepUpToken);

    // Create a draft handover package and test risk-triggered step-up enforcement on publish
    const createHnd = await apiRequest(
      server,
      'POST',
      '/api/projects/prj_solidstate_01/handovers',
      {
        token: 'tok_pi_lead_01',
        body: {
          title: 'Stage 09 Step-Up Verified Handover Package',
          recipient_user_id: 'usr_inc_01',
          record_ids: ['rec_seed_01']
        }
      }
    );
    assert.equal(createHnd.status, 201);
    const handoverId = createHnd.body.handover.id;

    // Publishing with require_step_up=true and invalid token is rejected with 403 STEP_UP_REQUIRED
    const pubWithoutToken = await apiRequest(
      server,
      'POST',
      `/api/projects/prj_solidstate_01/handovers/${handoverId}/publish`,
      {
        token: 'tok_pi_lead_01',
        body: { require_step_up: true, step_up_token: 'suptok_forged_invalid' }
      }
    );
    assert.equal(pubWithoutToken.status, 403);
    assert.equal(pubWithoutToken.body.error.code, 'STEP_UP_REQUIRED');

    // Publishing with valid step_up_token succeeds
    const pubWithToken = await apiRequest(
      server,
      'POST',
      `/api/projects/prj_solidstate_01/handovers/${handoverId}/publish`,
      {
        token: 'tok_pi_lead_01',
        body: { require_step_up: true, step_up_token: stepUpToken }
      }
    );
    assert.equal(pubWithToken.status, 200);
    assert.equal(pubWithToken.body.handover.status, 'PUBLISHED');
  });

  await t.test('6. No image, video, or biometric data is stored by default, and any attempt to upload media/biometrics is rejected and logged', async () => {
    for (const prohibitedField of ['image', 'video', 'biometric_data', 'face_embedding']) {
      const res = await apiRequest(
        server,
        'POST',
        '/api/projects/prj_solidstate_01/step-up/verify',
        {
          token: 'tok_pi_lead_01',
          body: {
            requested_action: 'PUBLISH_HANDOVER_PACKAGE',
            verification_route: 'CAMERA_ASSISTED_MFA',
            camera_stream_status: 'STREAM_AVAILABLE',
            mfa_code: '654321',
            [prohibitedField]: 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
          }
        }
      );
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'MEDIA_UPLOAD_PROHIBITED');
    }

    // Verify database check constraint prevents media_stored != 0
    assert.throws(() => {
      db.prepare("UPDATE step_up_events SET media_stored = 1").run();
    }, /CHECK constraint failed/);

    // Verify all step_up_events and audit_events logged action, route, timestamp, and outcome with zero media stored
    const eventsRes = await apiRequest(
      server,
      'GET',
      '/api/projects/prj_solidstate_01/step-up/events',
      { token: 'tok_auditor_01' }
    );
    assert.equal(eventsRes.status, 200);
    const stepUpEvents = eventsRes.body.step_up_events;
    assert.ok(stepUpEvents.length >= 8);

    for (const ev of stepUpEvents) {
      assert.equal(ev.media_stored, 0);
      assert.ok(ev.requested_action);
      assert.ok(ev.verification_route);
      assert.ok(ev.created_at);
      assert.ok(ev.outcome);
    }

    const outcomes = new Set(stepUpEvents.map((e) => e.outcome));
    assert.ok(outcomes.has('CHALLENGE_ISSUED'));
    assert.ok(outcomes.has('CAMERA_ERROR_HANDLED'));
    assert.ok(outcomes.has('CAMERA_FALLBACK_TO_NON_CAMERA'));
    assert.ok(outcomes.has('CANCELLED_BY_USER'));
    assert.ok(outcomes.has('FAILED_MFA'));
    assert.ok(outcomes.has('STEP_UP_SUCCEEDED'));
  });
});
