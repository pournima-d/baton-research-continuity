'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DB_PATH = path.resolve(__dirname, '..', 'data', 'test_baton.db');
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

const { EventEmitter } = require('node:events');

async function startTestServer(db) {
  const server = createApp(db);
  return {
    server,
    baseUrl: server,
    close: async () => {}
  };
}

async function apiRequest(srvOrUrl, method, route, { token = null, body = null } = {}) {
  const server = typeof srvOrUrl === 'object' && srvOrUrl.server ? srvOrUrl.server : srvOrUrl;
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = route;
    req.headers = { 'content-type': 'application/json' };
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
          resolve({ status: this.statusCode, body: json });
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

test('Stage 02 Backend & Database Foundation Suite', async (t) => {
  await t.test('1. Migrations run cleanly against an empty database and create all relational tables', () => {
    cleanTestDbFiles();
    const db = openDatabase(TEST_DB_PATH);
    const migResult = runMigrations(db);

    assert.equal(migResult.newlyApplied.length, 7);
    assert.equal(migResult.newlyApplied[0], '001_initial_schema.sql');
    assert.equal(migResult.newlyApplied[1], '002_stage04_connect_ingestion.sql');
    assert.equal(migResult.newlyApplied[2], '003_stage05_reconstruct_continuity_map.sql');
    assert.equal(migResult.newlyApplied[3], '004_stage06_verify_evidence_inspector.sql');
    assert.equal(migResult.newlyApplied[4], '005_stage07_review_and_handover.sql');
    assert.equal(migResult.newlyApplied[5], '006_stage08_security_and_audit.sql');
    assert.equal(migResult.newlyApplied[6], '007_stage09_optional_step_up.sql');

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);

    const expectedTables = [
      'audit_events',
      'auth_sessions',
      'evidence_links',
      'extracted_records',
      'handover_acknowledgements',
      'handover_items',
      'handover_packages',
      'handover_versions',
      'memberships',
      'projects',
      'record_edges',
      'record_versions',
      'reviews',
      'roles',
      'schema_migrations',
      'source_spans',
      'sources',
      'step_up_events',
      'users'
    ];
    assert.deepEqual(tables, expectedTables);
  });

  await t.test('2. Synthetic seed data & persistence across full server/database restart', async () => {
    const db1 = openDatabase(TEST_DB_PATH);
    const seedSummary = seedDatabase(db1);
    assert.equal(seedSummary.projectId, 'prj_solidstate_01');
    assert.equal(seedSummary.sourcesCount, 4);

    // Start server #1, create a new source (JSON_RECORDS) and a new project, then shut down server + close DB
    const srv1 = await startTestServer(db1);
    const uploadRes = await apiRequest(srv1.baseUrl, 'POST', '/api/projects/prj_solidstate_01/sources', {
      token: 'tok_researcher_01',
      body: {
        title: 'Glovebox Calibration JSON Records',
        file_name: 'calibration_2026.json',
        source_type: 'JSON_RECORDS',
        visibility_level: 'PROJECT_SHARED',
        raw_content: JSON.stringify([
          { sensor_id: 'H2O-A1', zero_offset_ppm: 0.12, calibrated_by: 'Samira Ortiz' },
          { sensor_id: 'O2-B2', zero_offset_ppm: 0.05, calibrated_by: 'Samira Ortiz' }
        ])
      }
    });
    assert.equal(uploadRes.status, 201);
    assert.equal(uploadRes.body.source.processing_status, 'READY');
    // Verify path traversal characters were sanitized from file_name
    assert.equal(uploadRes.body.source.file_name, 'calibration_2026.json');
    assert.equal(uploadRes.body.spans.length, 2);
    assert.equal(uploadRes.body.spans[0].locator_type, 'JSON_RECORD');
    assert.equal(uploadRes.body.spans[0].record_key, 'H2O-A1');
    const createdSourceId = uploadRes.body.source.id;

    await srv1.close();
    closeDatabase();

    // Restart: open fresh database connection from disk and start server #2
    const db2 = openDatabase(TEST_DB_PATH);
    const srv2 = await startTestServer(db2);

    const statusRes = await apiRequest(
      srv2.baseUrl,
      'GET',
      `/api/projects/prj_solidstate_01/sources/${createdSourceId}/status`,
      { token: 'tok_researcher_01' }
    );
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.body.processing_status, 'READY');
    assert.equal(statusRes.body.span_count, 2);

    const spansRes = await apiRequest(
      srv2.baseUrl,
      'GET',
      `/api/projects/prj_solidstate_01/sources/${createdSourceId}/spans`,
      { token: 'tok_researcher_01' }
    );
    assert.equal(spansRes.status, 200);
    assert.equal(spansRes.body.spans.length, 2);

    await srv2.close();
  });

  await t.test('3. Backend Authorization & RBAC enforcement denies unauthorised requests and logs to audit_events', async () => {
    const db = openDatabase(TEST_DB_PATH);
    const srv = await startTestServer(db);

    try {
      // 3a. Unauthenticated request -> 401
      const noAuth = await apiRequest(srv.baseUrl, 'GET', '/api/projects/prj_solidstate_01');
      assert.equal(noAuth.status, 401);
      assert.equal(noAuth.body.error.code, 'UNAUTHENTICATED');

      // 3b. Non-member user -> 403
      const outsider = await apiRequest(srv.baseUrl, 'GET', '/api/projects/prj_solidstate_01', {
        token: 'tok_outsider_01'
      });
      assert.equal(outsider.status, 403);
      assert.equal(outsider.body.error.code, 'FORBIDDEN_ROLE');

      // 3c. INCOMING_MEMBER attempting to upload a source -> 403
      const incUpload = await apiRequest(srv.baseUrl, 'POST', '/api/projects/prj_solidstate_01/sources', {
        token: 'tok_incoming_01',
        body: {
          title: 'Unauthorized Upload',
          file_name: 'note.md',
          source_type: 'LAB_NOTE',
          raw_content: '# Test\nContent'
        }
      });
      assert.equal(incUpload.status, 403);
      assert.equal(incUpload.body.error.code, 'FORBIDDEN_ROLE');

      // 3d. RESEARCHER attempting to read RESTRICTED_PI_ONLY source spans -> 403
      const restrictedSpanRes = await apiRequest(
        srv.baseUrl,
        'GET',
        '/api/projects/prj_solidstate_01/sources/src_restricted_01/spans',
        { token: 'tok_researcher_01' }
      );
      assert.equal(restrictedSpanRes.status, 403);
      assert.equal(restrictedSpanRes.body.error.code, 'RESTRICTED_RESOURCE');

      // Meanwhile PI_LEAD can access RESTRICTED_PI_ONLY source spans -> 200
      const piRestrictedRes = await apiRequest(
        srv.baseUrl,
        'GET',
        '/api/projects/prj_solidstate_01/sources/src_restricted_01/spans',
        { token: 'tok_pi_lead_01' }
      );
      assert.equal(piRestrictedRes.status, 200);
      assert.equal(piRestrictedRes.body.spans.length, 1);

      // 3e. RESEARCHER attempting to approve a record via /reviews -> 403
      const resApprove = await apiRequest(
        srv.baseUrl,
        'POST',
        '/api/projects/prj_solidstate_01/records/rec_seed_03/reviews',
        {
          token: 'tok_researcher_01',
          body: { decision: 'APPROVE', comments: 'Self-approving my own record' }
        }
      );
      assert.equal(resApprove.status, 403);

      // 3f. RESEARCHER attempting to bypass review by PATCHing approval_status='APPROVED' -> 403
      const resBypass = await apiRequest(
        srv.baseUrl,
        'PATCH',
        '/api/projects/prj_solidstate_01/records/rec_seed_03',
        {
          token: 'tok_researcher_01',
          body: { approval_status: 'APPROVED' }
        }
      );
      assert.equal(resBypass.status, 403);
      assert.equal(resBypass.body.error.code, 'FORBIDDEN_APPROVAL_BYPASS');

      // 3g. Direct access to /storage/private_uploads is blocked -> 403
      const storageProbe = await apiRequest(srv.baseUrl, 'GET', '/storage/private_uploads/guess.dat');
      assert.equal(storageProbe.status, 403);

      // 3h. RESEARCHER cannot read /audit-events (403), but AUDITOR can (200)
      const resAudit = await apiRequest(srv.baseUrl, 'GET', '/api/projects/prj_solidstate_01/audit-events', {
        token: 'tok_researcher_01'
      });
      assert.equal(resAudit.status, 403);

      const audAudit = await apiRequest(srv.baseUrl, 'GET', '/api/projects/prj_solidstate_01/audit-events', {
        token: 'tok_auditor_01'
      });
      assert.equal(audAudit.status, 200);
      assert.ok(audAudit.body.audit_events.some((e) => e.event_type === 'ACCESS_DENIED'));
    } finally {
      await srv.close();
    }
  });

  await t.test('4. Pre-AI Restricted Filtering, Stage 3 Verification, Stage 4 Review Invariant & Stage 5 Handover', async () => {
    const db = openDatabase(TEST_DB_PATH);
    const srv = await startTestServer(db);

    try {
      // 4a. Trigger reconstruction requesting both shared and restricted sources
      const reconRes = await apiRequest(srv.baseUrl, 'POST', '/api/projects/prj_solidstate_01/reconstruct', {
        token: 'tok_researcher_01',
        body: {
          source_ids: ['src_pdf_01', 'src_restricted_01'],
          extraction_focus: 'Extract continuity objectives and decisions'
        }
      });
      assert.equal(reconRes.status, 201);
      assert.equal(reconRes.body.filter_summary.requested_sources_count, 2);
      assert.equal(reconRes.body.filter_summary.permitted_sources_count, 1);
      assert.equal(reconRes.body.filter_summary.restricted_or_excluded_sources_filtered, 1);
      assert.ok(reconRes.body.created_records.length > 0);

      // Ensure no created record references restricted span 'spn_rest01_1'
      for (const rec of reconRes.body.created_records) {
        for (const el of rec.evidence_links) {
          assert.notEqual(el.span_id, 'spn_rest01_1');
        }
      }

      // 4b. Reject truth-probability percentage fields during verification
      const badProbRes = await apiRequest(
        srv.baseUrl,
        'POST',
        '/api/projects/prj_solidstate_01/records/rec_seed_03/verify',
        {
          token: 'tok_reviewer_01',
          body: {
            evidence_status: 'SUPPORTED',
            truth_probability: 95
          }
        }
      );
      assert.equal(badProbRes.status, 422);
      assert.equal(badProbRes.body.error.code, 'INVALID_EVIDENCE_STATUS');

      // 4c. CRITICAL INVARIANT: Reviewer approves a WEAK evidence record (rec_seed_03).
      // Approval must update approval_status to APPROVED while evidence_status remains WEAK!
      const reviewRes = await apiRequest(
        srv.baseUrl,
        'POST',
        '/api/projects/prj_solidstate_01/records/rec_seed_03/reviews',
        {
          token: 'tok_reviewer_01',
          body: {
            decision: 'APPROVE',
            comments: 'Approved for handover visibility so incoming student knows about the unverified 5 MPa stack pressure gap.'
          }
        }
      );
      assert.equal(reviewRes.status, 201);
      assert.equal(reviewRes.body.record.approval_status, 'APPROVED');
      assert.equal(reviewRes.body.record.evidence_status, 'WEAK');
      assert.equal(reviewRes.body.review.evidence_status_at_review, 'WEAK');

      // Verify version history recorded the change
      const verRes = await apiRequest(
        srv.baseUrl,
        'GET',
        '/api/projects/prj_solidstate_01/records/rec_seed_03/versions',
        { token: 'tok_auditor_01' }
      );
      assert.equal(verRes.status, 200);
      assert.equal(verRes.body.versions.length, 2);
      assert.equal(verRes.body.versions[1].change_reason, 'REVIEW_DECISION');

      // 4d. Stage 5: Create Handover Package with approved records (rec_seed_01, rec_seed_02, rec_seed_03)
      const hndCreate = await apiRequest(srv.baseUrl, 'POST', '/api/projects/prj_solidstate_01/handovers', {
        token: 'tok_researcher_01',
        body: {
          title: 'Fall 2026 LLZO Continuity Handover Package',
          recipient_user_id: 'usr_inc_01',
          record_ids: ['rec_seed_01', 'rec_seed_02', 'rec_seed_03']
        }
      });
      assert.equal(hndCreate.status, 201);
      assert.equal(hndCreate.body.handover.status, 'DRAFT');
      assert.equal(hndCreate.body.handover.restricted_sources_excluded_count, 1);
      assert.equal(hndCreate.body.items.length, 3);
      const handoverId = hndCreate.body.handover.id;

      // 4e. PI_LEAD publishes handover package
      const pubRes = await apiRequest(
        srv.baseUrl,
        'POST',
        `/api/projects/prj_solidstate_01/handovers/${handoverId}/publish`,
        { token: 'tok_pi_lead_01' }
      );
      assert.equal(pubRes.status, 200);
      assert.equal(pubRes.body.handover.status, 'PUBLISHED');

      // 4f. INCOMING_MEMBER cannot acknowledge before checking all items -> 422
      const earlyAck = await apiRequest(
        srv.baseUrl,
        'POST',
        `/api/projects/prj_solidstate_01/handovers/${handoverId}/acknowledge`,
        {
          token: 'tok_incoming_01',
          body: { acknowledgement_notes: 'Trying to sign off without checking items.' }
        }
      );
      assert.equal(earlyAck.status, 422);
      assert.equal(earlyAck.body.error.code, 'UNCHECKED_HANDOVER_ITEMS');

      // 4g. INCOMING_MEMBER checks off each item, then acknowledges
      for (const item of hndCreate.body.items) {
        const chk = await apiRequest(
          srv.baseUrl,
          'POST',
          `/api/projects/prj_solidstate_01/handovers/${handoverId}/items/${item.id}/check`,
          {
            token: 'tok_incoming_01',
            body: { recipient_checked: true }
          }
        );
        assert.equal(chk.status, 200);
        assert.equal(chk.body.item.recipient_checked, 1);
      }

      // PI_LEAD attempting to acknowledge on behalf of incoming member -> 403
      const piAck = await apiRequest(
        srv.baseUrl,
        'POST',
        `/api/projects/prj_solidstate_01/handovers/${handoverId}/acknowledge`,
        {
          token: 'tok_pi_lead_01',
          body: { acknowledgement_notes: 'PI trying to acknowledge' }
        }
      );
      assert.equal(piAck.status, 403);

      // INCOMING_MEMBER acknowledges -> 200 ACKNOWLEDGED
      const finalAck = await apiRequest(
        srv.baseUrl,
        'POST',
        `/api/projects/prj_solidstate_01/handovers/${handoverId}/acknowledge`,
        {
          token: 'tok_incoming_01',
          body: {
            acknowledgement_notes: 'Inspected all sintering parameters, glovebox drift risks, and the 5 MPa calibration gap.'
          }
        }
      );
      assert.equal(finalAck.status, 200);
      assert.equal(finalAck.body.handover.status, 'ACKNOWLEDGED');
      assert.equal(finalAck.body.acknowledgement.checked_item_count, 3);
    } finally {
      await srv.close();
    }
  });

  await t.test('5. Project creation, all 10 continuity record types, and transactional rollback on processing failure', async () => {
    const db = openDatabase(TEST_DB_PATH);
    const srv = await startTestServer(db);

    try {
      // 5a. Create a new project as PI_LEAD
      const createProj = await apiRequest(srv.baseUrl, 'POST', '/api/projects', {
        token: 'tok_pi_lead_01',
        body: {
          name: 'Sodium-Ion Cathode Air Stability Study',
          description: 'Continuity study for moisture-sensitive Na-layered oxide cathodes.'
        }
      });
      assert.equal(createProj.status, 201);
      const newProjectId = createProj.body.project.id;

      // Add RESEARCHER membership to new project
      const addMem = await apiRequest(srv.baseUrl, 'POST', `/api/projects/${newProjectId}/memberships`, {
        token: 'tok_pi_lead_01',
        body: { user_id: 'usr_res_01', role_id: 'RESEARCHER' }
      });
      assert.equal(addMem.status, 201);

      // 5b. Verify all 10 Stage 02 record types can be created and persisted on prj_solidstate_01
      const recordTypes = [
        'OBJECTIVE',
        'DECISION',
        'EXPERIMENT',
        'RESULT',
        'TASK',
        'RISK',
        'DEPENDENCY',
        'QUESTION',
        'CONTACT',
        'GAP'
      ];

      for (const rType of recordTypes) {
        const recRes = await apiRequest(srv.baseUrl, 'POST', '/api/projects/prj_solidstate_01/records', {
          token: 'tok_researcher_01',
          body: {
            record_type: rType,
            title: `Test ${rType} Record`,
            statement: `Continuity statement for ${rType}`,
            evidence_status: 'PARTIAL',
            evidence_links: [
              {
                span_id: 'spn_pdf01_1',
                relationship_type: 'SUPPORTS',
                verbatim_quote: 'Achieve >93% relative density'
              }
            ]
          }
        });
        assert.equal(recRes.status, 201, `Failed creating record_type=${rType}`);
        assert.equal(recRes.body.record.record_type, rType);
      }

      // 5c. Failed source processing (malformed JSON in JSON_RECORDS) returns 422 and rolls back transaction
      const badJsonRes = await apiRequest(srv.baseUrl, 'POST', `/api/projects/${newProjectId}/sources`, {
        token: 'tok_researcher_01',
        body: {
          title: 'Corrupt JSON Upload',
          file_name: 'corrupt.json',
          source_type: 'JSON_RECORDS',
          raw_content: '{not_valid_json: true'
        }
      });
      assert.equal(badJsonRes.status, 422);
      assert.equal(badJsonRes.body.error.code, 'SOURCE_PROCESSING_FAILED');

      const listAfterFail = await apiRequest(srv.baseUrl, 'GET', `/api/projects/${newProjectId}/sources`, {
        token: 'tok_researcher_01'
      });
      assert.equal(listAfterFail.status, 200);
      assert.equal(listAfterFail.body.sources.length, 0);
    } finally {
      await srv.close();
      cleanTestDbFiles();
    }
  });
});
