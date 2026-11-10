'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const TEST_DB_PATH = path.resolve(__dirname, '..', 'data', 'test_stage07_review_handover.db');
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

async function apiRequest(server, method, route, { token = null, body = null } = {}) {
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

test('Stage 07 Review, Approval and Handover Suite (Including Full End-to-End Test)', async (t) => {
  cleanTestDbFiles();
  const db = openDatabase(TEST_DB_PATH);
  runMigrations(db);
  seedDatabase(db);
  const server = createApp(db);

  let e2eProjectId = null;
  let sharedSourceId = null;
  let restrictedSourceId = null;
  let extractedRecords = [];
  let recordToApproveAndKeep = null;
  let recordToApproveThenEdit = null;
  let recordToReject = null;
  let taskRecordNoDeadline = null;
  let handoverV1Id = null;
  let handoverV2Id = null;

  await t.test('1. Create a fresh E2E project, assign roles, and upload shared + restricted sources', async () => {
    const createProj = await apiRequest(server, 'POST', '/api/projects', {
      token: 'tok_pi_lead_01',
      body: {
        name: 'Stage 07 E2E Cryo-EM Continuity Project',
        description: 'End-to-end verification of review, version-bound approval, and handover'
      }
    });
    assert.equal(createProj.status, 201);
    e2eProjectId = createProj.body.project.id;

    // Assign RESEARCHER, REVIEWER, INCOMING_MEMBER, AUDITOR
    const roleAssignments = [
      { user_id: 'usr_res_01', role_id: 'RESEARCHER' },
      { user_id: 'usr_rev_01', role_id: 'REVIEWER' },
      { user_id: 'usr_inc_01', role_id: 'INCOMING_MEMBER' },
      { user_id: 'usr_aud_01', role_id: 'AUDITOR' }
    ];
    for (const ra of roleAssignments) {
      const mRes = await apiRequest(server, 'POST', `/api/projects/${e2eProjectId}/memberships`, {
        token: 'tok_pi_lead_01',
        body: ra
      });
      assert.equal(mRes.status, 201);
    }

    // Upload a shared source with multiple spans (objective, decision, result, open task, risk, contact, question)
    const upShared = await apiRequest(server, 'POST', `/api/projects/${e2eProjectId}/sources`, {
      token: 'tok_researcher_01',
      body: {
        title: 'Cryo-EM Grid Preparation & Vitrification Notebook',
        file_name: 'cryoem_grid_prep_nov.md',
        source_type: 'LAB_NOTE',
        visibility_level: 'PROJECT_SHARED',
        exclude_from_ai: false,
        raw_content: [
          '# Section 1: Project Objective (2026-10-12)',
          'Objective: Achieve 2.4 Angstrom resolution map of Apoferritin using Quantifoil R1.2/1.3 gold grids. Owner: Dr. Marcus Vance.',
          '# Section 2: Vitrification Decision (2026-10-13)',
          'Decision: Standardized blot time at 3.5 seconds at 100% humidity and 4C because 2.0s blot left thick ice.',
          '# Section 3: Completed Work & Experimental Results (2026-10-15)',
          'Result: Collected 4,200 micrographs on Titan Krios G4 with defocus range -0.8 to -1.8 um.',
          '# Section 4: Open Tasks (2026-10-18)',
          'Task: Run 3D refinement and CTF correction on dataset batch B4.',
          '# Section 5: Risks & Blockers (2026-10-18)',
          'Risk: Liquid ethane dewar valve shows intermittent frost buildup during long plunge sessions.',
          '# Section 6: Contacts & Questions (2026-10-18)',
          'Contact: Cryo-EM Facility Manager Dr. Lin Zhao (lin.zhao@cryo.facility.org) for autoloader cassette alignment.',
          '# Section 7: Open Scientific Questions (2026-10-18)',
          'Question: Why does complex C2 exhibit preferred orientation on Quantifoil gold grids?'
        ].join('\n\n')
      }
    });
    assert.equal(upShared.status, 201);
    sharedSourceId = upShared.body.source.id;

    // Upload a RESTRICTED_PI_ONLY source containing confidential material
    const upRestricted = await apiRequest(server, 'POST', `/api/projects/${e2eProjectId}/sources`, {
      token: 'tok_pi_lead_01',
      body: {
        title: 'Confidential Inhibitor Patent Draft (Restricted PI Only)',
        file_name: 'confidential_inhibitor_patent.md',
        source_type: 'LAB_NOTE',
        visibility_level: 'RESTRICTED_PI_ONLY',
        exclude_from_ai: true,
        raw_content:
          '# Restricted Patent Claim\nCompound SECRET-MOL-778 binds allosteric pocket K142 with Ki = 0.4 nM. Strictly embargoed.'
      }
    });
    assert.equal(upRestricted.status, 201);
    restrictedSourceId = upRestricted.body.source.id;
  });

  await t.test('2. Extract candidate records and inspect evidence while filtering out restricted sources', async () => {
    const reconRes = await apiRequest(server, 'POST', `/api/projects/${e2eProjectId}/reconstruct`, {
      token: 'tok_researcher_01',
      body: {
        source_ids: [sharedSourceId, restrictedSourceId],
        extraction_focus: 'Full cryo-EM continuity extraction'
      }
    });
    assert.equal(reconRes.status, 201);
    assert.equal(reconRes.body.filter_summary.restricted_or_excluded_sources_filtered, 1);
    extractedRecords = reconRes.body.created_records;
    assert.ok(extractedRecords.length >= 4, 'Should extract multiple candidate records from shared notebook');

    // Verify no extracted record contains the restricted secret
    const serialized = JSON.stringify(extractedRecords);
    assert.equal(serialized.includes('SECRET-MOL-778'), false);

    // Inspect evidence on the first extracted record
    const inspectRes = await apiRequest(
      server,
      'GET',
      `/api/projects/${e2eProjectId}/records/${extractedRecords[0].id}`,
      { token: 'tok_researcher_01' }
    );
    assert.equal(inspectRes.status, 200);
    assert.ok(inspectRes.body.record.evidence_links.length >= 1);
    assert.equal(inspectRes.body.record.evidence_links[0].citation_status, 'RESOLVED');
  });

  await t.test('3. Authorised outgoing member corrects candidate record, adds context, flags uncertainty, and rejects an extraction; every edit creates a version with actor, timestamp, changed fields, and reason', async () => {
    recordToApproveAndKeep = extractedRecords[0];
    recordToApproveThenEdit = extractedRecords[1];
    recordToReject = extractedRecords[2];

    // Outgoing researcher corrects recordToApproveAndKeep, adds context_notes, and provides a reason
    const patchRes = await apiRequest(
      server,
      'PATCH',
      `/api/projects/${e2eProjectId}/records/${recordToApproveAndKeep.id}`,
      {
        token: 'tok_researcher_01',
        body: {
          title: `${recordToApproveAndKeep.title} (Calibrated)`,
          statement: `${recordToApproveAndKeep.statement} Confirmed on Vitrobot Mark IV.`,
          context_notes: 'Use tweezers pre-cooled in liquid nitrogen vapour before mounting.',
          reason: 'Added Vitrobot Mark IV instrument confirmation and outgoing tweezers handling context',
          approval_status: 'PENDING_REVIEW'
        }
      }
    );
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.body.record.current_version, 2);
    assert.equal(
      patchRes.body.record.context_notes,
      'Use tweezers pre-cooled in liquid nitrogen vapour before mounting.'
    );
    assert.ok(patchRes.body.changed_fields.includes('title'));
    assert.ok(patchRes.body.changed_fields.includes('statement'));
    assert.ok(patchRes.body.changed_fields.includes('context_notes'));

    // Check version history for actor, timestamp, changed_fields, and reason
    const verRes = await apiRequest(
      server,
      'GET',
      `/api/projects/${e2eProjectId}/records/${recordToApproveAndKeep.id}/versions`,
      { token: 'tok_researcher_01' }
    );
    assert.equal(verRes.status, 200);
    assert.equal(verRes.body.versions.length, 2);
    const v2 = verRes.body.versions.find((v) => v.version_number === 2);
    assert.equal(v2.changed_by_user_id, 'usr_res_01');
    assert.ok(v2.created_at);
    assert.equal(
      v2.change_reason,
      'Added Vitrobot Mark IV instrument confirmation and outgoing tweezers handling context'
    );
    assert.ok(Array.isArray(v2.changed_fields));
    assert.ok(v2.changed_fields.includes('title'));
    assert.ok(v2.changed_fields.includes('context_notes'));
    assert.ok(v2.field_diffs && v2.field_diffs.title);

    // Outgoing researcher flags uncertainty on recordToApproveThenEdit (e.g., PARTIAL / NEEDS REVIEW) without altering approval_status
    const flagRes = await apiRequest(
      server,
      'POST',
      `/api/projects/${e2eProjectId}/records/${recordToApproveThenEdit.id}/verify`,
      {
        token: 'tok_researcher_01',
        body: {
          evidence_status: 'NEEDS REVIEW',
          verification_notes: 'Ice thickness gradient across grid squares requires visual check.'
        }
      }
    );
    assert.equal(flagRes.status, 200);
    assert.equal(flagRes.body.record.evidence_status, 'NEEDS REVIEW');

    // Outgoing researcher rejects recordToReject directly via PATCH with reason
    const rejectPatch = await apiRequest(
      server,
      'PATCH',
      `/api/projects/${e2eProjectId}/records/${recordToReject.id}`,
      {
        token: 'tok_researcher_01',
        body: {
          approval_status: 'REJECTED',
          reason: 'Duplicate / noisy extraction not needed for continuation plan'
        }
      }
    );
    assert.equal(rejectPatch.status, 200);
    assert.equal(rejectPatch.body.record.approval_status, 'REJECTED');
  });

  await t.test('4. Unauthorised roles cannot approve, publish, or alter records (enforced server-side)', async () => {
    // INCOMING_MEMBER and AUDITOR and REVIEWER cannot alter/edit records
    for (const tok of ['tok_incoming_01', 'tok_auditor_01', 'tok_reviewer_01']) {
      const editAttempt = await apiRequest(
        server,
        'PATCH',
        `/api/projects/${e2eProjectId}/records/${recordToApproveAndKeep.id}`,
        {
          token: tok,
          body: { title: 'Unauthorised Title Edit' }
        }
      );
      assert.equal(editAttempt.status, 403);
    }

    // RESEARCHER, INCOMING_MEMBER, AUDITOR cannot approve/review records
    for (const tok of ['tok_researcher_01', 'tok_incoming_01', 'tok_auditor_01']) {
      const reviewAttempt = await apiRequest(
        server,
        'POST',
        `/api/projects/${e2eProjectId}/records/${recordToApproveAndKeep.id}/reviews`,
        {
          token: tok,
          body: { decision: 'APPROVE', comments: 'Self-approval attempt' }
        }
      );
      assert.equal(reviewAttempt.status, 403);
    }
  });

  await t.test('5. Authorised approver (REVIEWER / PI_LEAD) approves records; approval binds to specific version and keeps evidence_status independent', async () => {
    // Approve recordToApproveAndKeep (currently at v2)
    const app1 = await apiRequest(
      server,
      'POST',
      `/api/projects/${e2eProjectId}/records/${recordToApproveAndKeep.id}/reviews`,
      {
        token: 'tok_reviewer_01',
        body: {
          decision: 'APPROVE',
          comments: 'Verified against Cryo-EM notebook v2.'
        }
      }
    );
    assert.equal(app1.status, 201);
    assert.equal(app1.body.record.approval_status, 'APPROVED');
    assert.equal(app1.body.record.approved_version, app1.body.record.current_version);
    assert.equal(app1.body.record.approved_by_user_id, 'usr_rev_01');
    assert.ok(app1.body.record.approved_at);

    // Approve recordToApproveThenEdit (which has evidence_status = 'NEEDS REVIEW' -> canonical 'NEEDS_REVIEW' or 'NEEDS REVIEW')
    const app2 = await apiRequest(
      server,
      'POST',
      `/api/projects/${e2eProjectId}/records/${recordToApproveThenEdit.id}/reviews`,
      {
        token: 'tok_pi_lead_01',
        body: {
          decision: 'APPROVE',
          comments: 'Approved for handover while retaining NEEDS_REVIEW evidence status.'
        }
      }
    );
    assert.equal(app2.status, 201);
    assert.equal(app2.body.record.approval_status, 'APPROVED');
    assert.equal(app2.body.record.approved_version, app2.body.record.current_version);
    // Evidence status remains independent of approval status!
    assert.notEqual(app2.body.record.evidence_status, 'SUPPORTED');

    // Approve remaining non-rejected extracted records so we have rich continuation plan sections
    for (let i = 3; i < extractedRecords.length; i++) {
      const r = extractedRecords[i];
      const res = await apiRequest(
        server,
        'POST',
        `/api/projects/${e2eProjectId}/records/${r.id}/reviews`,
        {
          token: 'tok_reviewer_01',
          body: {
            decision: 'APPROVE',
            comments: 'Approved for E2E continuation plan.'
          }
        }
      );
      assert.equal(res.status, 201);
    }

    // Also create and approve an explicit TASK record without stated_owner or due_date to verify UNKNOWN labelling
    const spansRes = await apiRequest(
      server,
      'GET',
      `/api/projects/${e2eProjectId}/sources/${sharedSourceId}/spans`,
      { token: 'tok_researcher_01' }
    );
    const taskSpan = spansRes.body.spans[spansRes.body.spans.length - 1];
    const createTask = await apiRequest(server, 'POST', `/api/projects/${e2eProjectId}/records`, {
      token: 'tok_researcher_01',
      body: {
        record_type: 'TASK',
        title: 'Calibrate post-column energy filter zero-loss peak',
        statement: 'Run zero-loss peak alignment before batch B4 data collection.',
        evidence_status: 'SUPPORTED',
        evidence_links: [
          {
            span_id: taskSpan.id,
            relationship_type: 'SUPPORTS',
            verbatim_quote: taskSpan.content_text.slice(0, 45)
          }
        ]
      }
    });
    assert.equal(createTask.status, 201);
    taskRecordNoDeadline = createTask.body.record;

    const appTask = await apiRequest(
      server,
      'POST',
      `/api/projects/${e2eProjectId}/records/${taskRecordNoDeadline.id}/reviews`,
      {
        token: 'tok_pi_lead_01',
        body: { decision: 'APPROVE', comments: 'Approved open task with unknown owner/deadline.' }
      }
    );
    assert.equal(appTask.status, 201);
  });

  await t.test('6. Editing an APPROVED record creates a new version, returns it to PENDING_REVIEW, and invalidates its old approval', async () => {
    const beforeEdit = await apiRequest(
      server,
      'GET',
      `/api/projects/${e2eProjectId}/records/${recordToApproveThenEdit.id}`,
      { token: 'tok_researcher_01' }
    );
    assert.equal(beforeEdit.body.record.approval_status, 'APPROVED');
    const prevApprovedVersion = beforeEdit.body.record.approved_version;
    assert.ok(prevApprovedVersion >= 1);

    // Edit the approved record
    const editApprovedRes = await apiRequest(
      server,
      'PATCH',
      `/api/projects/${e2eProjectId}/records/${recordToApproveThenEdit.id}`,
      {
        token: 'tok_researcher_01',
        body: {
          statement: `${beforeEdit.body.record.statement} [Updated blot force to +2 after post-approval re-check]`,
          reason: 'Modified blot force parameter after initial approval'
        }
      }
    );
    assert.equal(editApprovedRes.status, 200);
    assert.equal(editApprovedRes.body.approval_invalidated, true);
    assert.equal(editApprovedRes.body.record.current_version, prevApprovedVersion + 1);
    assert.equal(editApprovedRes.body.record.approval_status, 'PENDING_REVIEW');
    assert.equal(editApprovedRes.body.record.approved_version, null);
    assert.equal(editApprovedRes.body.record.approved_by_user_id, null);
    assert.equal(editApprovedRes.body.record.approved_at, null);

    // Attempting to include this edited (now PENDING_REVIEW) record or the REJECTED record in a handover must fail with 422
    const badHandoverAttempt = await apiRequest(server, 'POST', `/api/projects/${e2eProjectId}/handovers`, {
      token: 'tok_researcher_01',
      body: {
        title: 'Invalid Handover With Unapproved Edited Record',
        record_ids: [recordToApproveAndKeep.id, recordToApproveThenEdit.id]
      }
    });
    assert.equal(badHandoverAttempt.status, 422);
    assert.equal(badHandoverAttempt.body.error.code, 'UNAPPROVED_RECORD_IN_HANDOVER');

    const rejectedHandoverAttempt = await apiRequest(
      server,
      'POST',
      `/api/projects/${e2eProjectId}/handovers`,
      {
        token: 'tok_researcher_01',
        body: {
          title: 'Invalid Handover With Rejected Record',
          record_ids: [recordToApproveAndKeep.id, recordToReject.id]
        }
      }
    );
    assert.equal(rejectedHandoverAttempt.status, 422);
    assert.equal(rejectedHandoverAttempt.body.error.code, 'UNAPPROVED_RECORD_IN_HANDOVER');
  });

  await t.test('7. Generate a continuation plan from approved records only, verify all required sections and UNKNOWN owner/deadline labels, and publish handover v1 as PI_LEAD', async () => {
    // Assemble handover using auto_select_approved: true (automatically selects only records with approval_status='APPROVED' and approved_version=current_version)
    const createHnd = await apiRequest(server, 'POST', `/api/projects/${e2eProjectId}/handovers`, {
      token: 'tok_researcher_01',
      body: {
        title: 'Cryo-EM Continuity Handover Package',
        recipient_user_id: 'usr_inc_01',
        auto_select_approved: true
      }
    });
    assert.equal(createHnd.status, 201);
    handoverV1Id = createHnd.body.handover.id;
    assert.equal(createHnd.body.handover.version_number, 1);
    assert.equal(createHnd.body.handover.status, 'DRAFT');

    // Verify neither recordToReject nor the unapproved edited recordToApproveThenEdit is in the handover
    const includedRecordIds = createHnd.body.items.map((it) => it.record_id);
    assert.ok(includedRecordIds.includes(recordToApproveAndKeep.id));
    assert.ok(includedRecordIds.includes(taskRecordNoDeadline.id));
    assert.equal(includedRecordIds.includes(recordToReject.id), false);
    assert.equal(includedRecordIds.includes(recordToApproveThenEdit.id), false);

    // Verify continuation_plan structure
    const plan = createHnd.body.handover.continuation_plan;
    assert.ok(plan, 'continuation_plan must be generated');
    assert.ok(plan.current_status && typeof plan.current_status === 'object');
    assert.ok(Array.isArray(plan.approved_decisions));
    assert.ok(Array.isArray(plan.completed_work_and_results));
    assert.ok(Array.isArray(plan.open_tasks_and_next_actions));
    assert.ok(Array.isArray(plan.blockers_and_risks));
    assert.ok(Array.isArray(plan.dependencies_and_contacts));
    assert.ok(Array.isArray(plan.unresolved_questions));

    // Verify unknown owners/deadlines are explicitly labelled UNKNOWN and never fabricated
    const openTaskEntry = plan.open_tasks_and_next_actions.find(
      (it) => it.record_id === taskRecordNoDeadline.id
    );
    assert.ok(openTaskEntry, 'Approved task must appear in open_tasks_and_next_actions');
    assert.equal(openTaskEntry.owner_is_unknown, true);
    assert.match(openTaskEntry.stated_owner, /^UNKNOWN/);
    assert.equal(openTaskEntry.deadline_is_unknown, true);
    assert.match(openTaskEntry.deadline, /^UNKNOWN/);
    assert.ok(openTaskEntry.source_evidence.length >= 1);

    // Verify unauthorised role (RESEARCHER, REVIEWER, INCOMING_MEMBER) cannot publish handover
    for (const tok of ['tok_researcher_01', 'tok_reviewer_01', 'tok_incoming_01']) {
      const pubDenied = await apiRequest(
        server,
        'POST',
        `/api/projects/${e2eProjectId}/handovers/${handoverV1Id}/publish`,
        { token: tok }
      );
      assert.equal(pubDenied.status, 403);
    }

    // Publish handover v1 as PI_LEAD
    const pubRes = await apiRequest(
      server,
      'POST',
      `/api/projects/${e2eProjectId}/handovers/${handoverV1Id}/publish`,
      { token: 'tok_pi_lead_01' }
    );
    assert.equal(pubRes.status, 200);
    assert.equal(pubRes.body.handover.status, 'PUBLISHED');
    assert.equal(pubRes.body.handover.published_by_user_id, 'usr_pi_01');
    assert.ok(pubRes.body.handover.published_at);
  });

  await t.test('8. Open handover as recipient (INCOMING_MEMBER), verify rejected items and restricted material are absent, and acknowledge receipt linked to handover version', async () => {
    const recView = await apiRequest(
      server,
      'GET',
      `/api/projects/${e2eProjectId}/handovers/${handoverV1Id}`,
      { token: 'tok_incoming_01' }
    );
    assert.equal(recView.status, 200);

    // Verify role_filtered_view metadata
    assert.equal(recView.body.handover.role_filtered_view.viewer_role, 'INCOMING_MEMBER');
    assert.equal(recView.body.handover.role_filtered_view.can_view_restricted_sources, false);
    assert.equal(recView.body.handover.role_filtered_view.restricted_records_redacted, 0);

    // Verify rejected items and edited-unapproved items and restricted material are completely absent from recipient response
    const rawRecipientPayload = JSON.stringify(recView.body);
    assert.equal(rawRecipientPayload.includes('SECRET-MOL-778'), false);
    assert.equal(rawRecipientPayload.includes('Confidential Inhibitor Patent Draft'), false);
    assert.equal(rawRecipientPayload.includes(recordToReject.id), false);
    assert.equal(rawRecipientPayload.includes(recordToApproveThenEdit.id), false);

    // Recipient checks off each item in the handover package
    for (const item of recView.body.items) {
      const chkRes = await apiRequest(
        server,
        'POST',
        `/api/projects/${e2eProjectId}/handovers/${handoverV1Id}/items/${item.id}/check`,
        {
          token: 'tok_incoming_01',
          body: { recipient_checked: true }
        }
      );
      assert.equal(chkRes.status, 200);
    }

    // Recipient acknowledges receipt of handover v1
    const ackRes = await apiRequest(
      server,
      'POST',
      `/api/projects/${e2eProjectId}/handovers/${handoverV1Id}/acknowledge`,
      {
        token: 'tok_incoming_01',
        body: {
          acknowledgement_notes:
            'Received Cryo-EM Continuity Handover v1 and verified all provenance links.'
        }
      }
    );
    assert.equal(ackRes.status, 200);
    assert.equal(ackRes.body.handover.status, 'ACKNOWLEDGED');
    assert.equal(ackRes.body.acknowledgement.handover_version, 1);
    assert.equal(
      ackRes.body.acknowledgement.acknowledgement_type,
      'RECEIPT_ONLY_NOT_AGREEMENT_OR_UNDERSTANDING'
    );
    assert.match(
      ackRes.body.acknowledgement.acknowledgement_disclaimer,
      /Acknowledgement means receipt, not agreement or proof of understanding/i
    );
  });

  await t.test('9. Re-approve edited record, publish Handover v2, and verify previous handover versions and audit history are preserved', async () => {
    // Re-approve recordToApproveThenEdit (now at v2)
    const reApprove = await apiRequest(
      server,
      'POST',
      `/api/projects/${e2eProjectId}/records/${recordToApproveThenEdit.id}/reviews`,
      {
        token: 'tok_reviewer_01',
        body: {
          decision: 'APPROVE',
          comments: 'Re-approved v2 after verifying updated blot force parameter.'
        }
      }
    );
    assert.equal(reApprove.status, 201);
    assert.equal(reApprove.body.record.approval_status, 'APPROVED');
    assert.equal(reApprove.body.record.approved_version, reApprove.body.record.current_version);

    // Create Handover v2
    const createHndV2 = await apiRequest(server, 'POST', `/api/projects/${e2eProjectId}/handovers`, {
      token: 'tok_researcher_01',
      body: {
        title: 'Cryo-EM Continuity Handover Package (v2 with Re-Approved Blot Force)',
        recipient_user_id: 'usr_inc_01',
        auto_select_approved: true
      }
    });
    assert.equal(createHndV2.status, 201);
    handoverV2Id = createHndV2.body.handover.id;
    assert.equal(createHndV2.body.handover.version_number, 2);
    assert.ok(createHndV2.body.items.some((it) => it.record_id === recordToApproveThenEdit.id));

    // Verify Handover v1 is still preserved and accessible with its snapshot versions
    const v1VersionsRes = await apiRequest(
      server,
      'GET',
      `/api/projects/${e2eProjectId}/handovers/${handoverV1Id}/versions`,
      { token: 'tok_pi_lead_01' }
    );
    assert.equal(v1VersionsRes.status, 200);
    const lifecycleEvents = v1VersionsRes.body.versions.map((v) => v.lifecycle_event);
    assert.ok(lifecycleEvents.includes('CREATED_DRAFT'));
    assert.ok(lifecycleEvents.includes('PUBLISHED'));
    assert.ok(lifecycleEvents.includes('ACKNOWLEDGED'));

    // Verify audit history preserves all review, invalidation, publication, and acknowledgement events
    const auditRes = await apiRequest(server, 'GET', `/api/projects/${e2eProjectId}/audit-events`, {
      token: 'tok_auditor_01'
    });
    assert.equal(auditRes.status, 200);
    const eventTypes = new Set(auditRes.body.audit_events.map((e) => e.event_type));
    assert.ok(eventTypes.has('RECORD_EDITED'));
    assert.ok(eventTypes.has('REVIEW_SUBMITTED'));
    assert.ok(eventTypes.has('HANDOVER_CREATED'));
    assert.ok(eventTypes.has('HANDOVER_PUBLISHED'));
    assert.ok(eventTypes.has('HANDOVER_ACKNOWLEDGED'));
    assert.ok(eventTypes.has('ACCESS_DENIED'));
  });

  t.after(() => {
    cleanTestDbFiles();
  });
});
