'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const TEST_DB_PATH = path.resolve(__dirname, '..', 'data', 'test_stage06_verify.db');
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

test('Stage 06 — Verify: Evidence Inspector and Gap States Suite', async (t) => {
  cleanTestDbFiles();
  const db = openDatabase(TEST_DB_PATH);
  runMigrations(db);
  seedDatabase(db);
  const server = createApp(db);

  t.after(() => {
    cleanTestDbFiles();
  });

  await t.test('1. All six canonical evidence states (SUPPORTED, CONFLICTING, UNSUPPORTED, STALE, NEEDS REVIEW, NOT ESTABLISHED) are accurately represented with exact definitions and epistemic notice', async () => {
    const statesRes = await apiRequest(server, 'GET', '/api/projects/prj_solidstate_01/evidence-states', {
      token: 'tok_researcher_01'
    });
    assert.equal(statesRes.status, 200);

    const expectedStates = [
      'SUPPORTED',
      'CONFLICTING',
      'UNSUPPORTED',
      'STALE',
      'NEEDS REVIEW',
      'NOT ESTABLISHED'
    ];
    assert.deepEqual(statesRes.body.states, expectedStates);
    assert.equal(
      statesRes.body.epistemic_notice,
      'A citation shows where a claim came from; it does not prove the source itself is correct.'
    );

    // 1a. SUPPORTED claim: linked source passage directly supports the claim as written
    const supportedRes = await apiRequest(server, 'POST', '/api/projects/prj_solidstate_01/records', {
      token: 'tok_researcher_01',
      body: {
        record_type: 'RESULT',
        title: 'Supported Sintered Pellet Density & Conductivity',
        statement: 'Pellets sintered at 1150C for 6 hours in mother powder achieved 94.2% relative density and ionic conductivity of 0.68 mS/cm at 25C',
        stated_owner: 'Dr. Elena Vance',
        recorded_date: '2026-10-12',
        evidence_status: 'SUPPORTED',
        evidence_links: [
          {
            span_id: 'spn_pdf01_3',
            relationship_type: 'SUPPORTS',
            verbatim_quote: 'Pellets sintered at 1150C for 6 hours in mother powder achieved 94.2% relative density and ionic conductivity of 0.68 mS/cm at 25C'
          }
        ]
      }
    });
    assert.equal(supportedRes.status, 201);
    const supRec = supportedRes.body.record;
    assert.equal(supRec.evidence_status, 'SUPPORTED');
    assert.equal(supRec.approval_status, 'DRAFT'); // Rule 1: separate from approval_status
    assert.equal(supRec.evidence_links[0].citation_status, 'RESOLVED');
    assert.equal(supRec.evidence_links[0].is_valid_support, true);
    assert.equal(supRec.evidence_links[0].source_title, 'Li-Garnet Pellet Sintering & Cycling Report (Q3)');
    assert.ok(supRec.evidence_links[0].locator_label.includes('Page 2'));
    assert.ok(supRec.evidence_links[0].span_content_text.includes('94.2% relative density'));

    // 1b. UNSUPPORTED claim: no valid supporting evidence was found (and attempting SUPPORTED with 0 links fails 422)
    const invalidSupAttempt = await apiRequest(server, 'POST', '/api/projects/prj_solidstate_01/records', {
      token: 'tok_researcher_01',
      body: {
        record_type: 'CLAIM',
        title: 'Claim without citations trying to be SUPPORTED',
        statement: 'Unbacked claim',
        evidence_status: 'SUPPORTED',
        evidence_links: []
      }
    });
    assert.equal(invalidSupAttempt.status, 422);
    assert.equal(invalidSupAttempt.body.error.code, 'PROVENANCE_VALIDATION_FAILED');

    const unsupportedRes = await apiRequest(server, 'POST', '/api/projects/prj_solidstate_01/records', {
      token: 'tok_researcher_01',
      body: {
        record_type: 'CLAIM',
        title: 'Unsupported Dendrite Suppression Claim',
        statement: 'Claim that bare Al2O3 coating eliminates dendrites at 5.0 mA/cm2 without any source citation.',
        evidence_status: 'UNSUPPORTED',
        evidence_links: []
      }
    });
    assert.equal(unsupportedRes.status, 201);
    assert.equal(unsupportedRes.body.record.evidence_status, 'UNSUPPORTED');
    assert.equal(unsupportedRes.body.record.valid_supporting_citations_count, 0);
    assert.ok(unsupportedRes.body.record.missing_fields.includes('evidence_links'));

    // 1c. NEEDS REVIEW claim: evidence or interpretation is ambiguous/incomplete (with missing fields shown transparently)
    const needsReviewRes = await apiRequest(server, 'POST', '/api/projects/prj_solidstate_01/records', {
      token: 'tok_researcher_01',
      body: {
        record_type: 'GAP',
        title: 'Ambiguous Stack Pressure Fixture Calibration',
        statement: 'stack pressure fixture calibration at 5 MPa remains unverified.',
        stated_owner: null,
        recorded_date: null,
        evidence_status: 'NEEDS REVIEW',
        verification_notes: 'Torque-to-MPa load cell logs are incomplete and owner is unstated.',
        evidence_links: [
          {
            span_id: 'spn_pdf01_4',
            relationship_type: 'PARTIALLY_SUPPORTS',
            verbatim_quote: 'stack pressure fixture calibration at 5 MPa remains unverified.'
          }
        ]
      }
    });
    assert.equal(needsReviewRes.status, 201);
    assert.equal(needsReviewRes.body.record.evidence_status, 'NEEDS REVIEW');
    assert.equal(needsReviewRes.body.record.is_incomplete, 1);
    assert.deepEqual(needsReviewRes.body.record.missing_fields, ['stated_owner', 'recorded_date']);

    // 1d. NOT ESTABLISHED claim: sources do not establish the point; do not imply it is false
    const notEstablishedRes = await apiRequest(server, 'POST', '/api/projects/prj_solidstate_01/records', {
      token: 'tok_researcher_01',
      body: {
        record_type: 'QUESTION',
        title: 'Long-Term 1000-Cycle Stability at -20 C',
        statement: 'Whether Ta-LLZO pellets maintain <15 Ohm.cm2 ASR over 1000 cycles at -20 C.',
        evidence_status: 'NOT ESTABLISHED',
        verification_notes: 'Q3 report only tested room-temperature (25 C) cycling up to 40 cycles; does not establish sub-zero behavior.',
        evidence_links: [
          {
            span_id: 'spn_pdf01_4',
            relationship_type: 'CONTEXT_ONLY',
            verbatim_quote: 'High-current cycling (>0.8 mA/cm2) still exhibits interfacial voiding after 40 cycles'
          }
        ]
      }
    });
    assert.equal(notEstablishedRes.status, 201);
    assert.equal(notEstablishedRes.body.record.evidence_status, 'NOT ESTABLISHED');
    assert.equal(
      notEstablishedRes.body.record.evidence_state_definition,
      'sources do not establish the point; do not imply it is false.'
    );
  });

  await t.test('2. CONFLICTING state: credible linked sources disagree on a material point or date; shows both passages without choosing a winner automatically', async () => {
    const srcRes = await apiRequest(server, 'POST', '/api/projects/prj_solidstate_01/sources', {
      token: 'tok_researcher_01',
      body: {
        title: 'Disagreeing Annealing Logs for Sample SSE-88',
        file_name: 'conflict_sse88.md',
        source_type: 'LAB_NOTE',
        visibility_level: 'PROJECT_SHARED',
        exclude_from_ai: false,
        raw_content: [
          '# Notebook Log A',
          'Experiment: Sample SSE-88 was sintered on 2026-09-10 at 1100 C and showed zero grain-boundary cracking.',
          '# Characterization Report B',
          'Result: Sample SSE-88 was sintered on 2026-09-18 at 1180 C and exhibited severe micro-cracking across grain boundaries.'
        ].join('\n\n')
      }
    });
    assert.equal(srcRes.status, 201);
    const [spanA, spanB] = srcRes.body.spans;

    const conflictRecRes = await apiRequest(server, 'POST', '/api/projects/prj_solidstate_01/records', {
      token: 'tok_researcher_01',
      body: {
        record_type: 'RESULT',
        title: 'Sample SSE-88 Sintering Date & Micro-Cracking Disagreement',
        statement: 'Disagreement between Notebook Log A (2026-09-10, 1100 C, zero cracking) and Report B (2026-09-18, 1180 C, severe micro-cracking).',
        evidence_status: 'CONFLICTING',
        conflict_summary: 'Source A reports 2026-09-10 (1100 C, zero cracking) while Source B reports 2026-09-18 (1180 C, severe micro-cracking).',
        evidence_links: [
          {
            span_id: spanA.id,
            relationship_type: 'SUPPORTS',
            verbatim_quote: 'Sample SSE-88 was sintered on 2026-09-10 at 1100 C and showed zero grain-boundary cracking.'
          },
          {
            span_id: spanB.id,
            relationship_type: 'CONTRADICTS',
            verbatim_quote: 'Sample SSE-88 was sintered on 2026-09-18 at 1180 C and exhibited severe micro-cracking across grain boundaries.'
          }
        ]
      }
    });
    assert.equal(conflictRecRes.status, 201);
    const rec = conflictRecRes.body.record;
    assert.equal(rec.evidence_status, 'CONFLICTING');
    assert.equal(rec.has_conflict, 1);
    assert.equal(rec.conflict_resolution_policy, 'SHOW_BOTH_NO_AUTOMATIC_WINNER');
    assert.equal(rec.conflicting_passages.length, 2, 'Must expose both conflicting passages side-by-side');
    assert.equal(rec.conflicting_passages[0].recorded_date, '2026-09-10');
    assert.equal(rec.conflicting_passages[1].recorded_date, '2026-09-18');
  });

  await t.test('3. STALE state: evidence outdated relative to a newer dated source or explicit validity rule explains why', async () => {
    const staleSrcRes = await apiRequest(server, 'POST', '/api/projects/prj_solidstate_01/sources', {
      token: 'tok_researcher_01',
      body: {
        title: 'Glovebox Dew-Point Calibration History (Aug vs Oct 2026)',
        file_name: 'calibration_history.md',
        source_type: 'LAB_NOTE',
        visibility_level: 'PROJECT_SHARED',
        exclude_from_ai: false,
        raw_content: [
          '# August Calibration Log',
          'Experiment: EQ-GLOVEBOX-01 moisture sensor baseline offset measured at +0.2 ppm on 2026-08-05 (30-day calibration validity rule).',
          '# October Recalibration Log',
          'Result: Supersedes August calibration: EQ-GLOVEBOX-01 recalibrated on 2026-10-20 after sensor drift reached +1.9 ppm.'
        ].join('\n\n')
      }
    });
    assert.equal(staleSrcRes.status, 201);

    const reconRes = await apiRequest(server, 'POST', '/api/projects/prj_solidstate_01/reconstruct', {
      token: 'tok_researcher_01',
      body: {
        source_ids: [staleSrcRes.body.source.id]
      }
    });
    assert.equal(reconRes.status, 201);

    const augRecord = reconRes.body.created_records.find((r) => r.recorded_date === '2026-08-05');
    assert.ok(augRecord, 'Expected August calibration record');

    // Inspect the August record via Evidence Inspector endpoint
    const inspectRes = await apiRequest(
      server,
      'GET',
      `/api/projects/prj_solidstate_01/records/${augRecord.id}/inspect`,
      { token: 'tok_researcher_01' }
    );
    assert.equal(inspectRes.status, 200);
    const inspected = inspectRes.body.record;
    assert.equal(inspected.evidence_status, 'STALE');
    assert.equal(inspected.is_stale, 1);
    assert.ok(
      inspected.stale_reason && inspected.stale_reason.includes('2026-08-05') && inspected.stale_reason.includes('2026-10-20'),
      `Expected stale_reason to explain why 2026-08-05 is outdated relative to 2026-10-20, got: ${inspected.stale_reason}`
    );
  });

  await t.test('4. Deleted or corrupted span: marks citation invalid and automatically prevents/downgrades claim from SUPPORTED', async () => {
    const srcRes = await apiRequest(server, 'POST', '/api/projects/prj_solidstate_01/sources', {
      token: 'tok_researcher_01',
      body: {
        title: 'Span Integrity Test Notebook',
        file_name: 'integrity_test.md',
        source_type: 'LAB_NOTE',
        visibility_level: 'PROJECT_SHARED',
        exclude_from_ai: false,
        raw_content: [
          '# Section A: Corrupted Span Target',
          'Result: Critical current density reached 1.45 mA/cm2 at 25 C in symmetric cell CELL-41.',
          '# Section B: Deleted Span Target',
          'Result: Interfacial resistance dropped to 11.2 Ohm.cm2 after 5 MPa stack pressure hold in CELL-42.'
        ].join('\n\n')
      }
    });
    assert.equal(srcRes.status, 201);
    const [spanCorruptTarget, spanDeleteTarget] = srcRes.body.spans;

    // Create Record A as SUPPORTED linked to spanCorruptTarget
    const recARes = await apiRequest(server, 'POST', '/api/projects/prj_solidstate_01/records', {
      token: 'tok_researcher_01',
      body: {
        record_type: 'RESULT',
        title: 'CELL-41 Critical Current Density Claim',
        statement: 'Critical current density reached 1.45 mA/cm2 at 25 C in symmetric cell CELL-41.',
        evidence_status: 'SUPPORTED',
        evidence_links: [
          {
            span_id: spanCorruptTarget.id,
            relationship_type: 'SUPPORTS',
            verbatim_quote: 'Critical current density reached 1.45 mA/cm2 at 25 C in symmetric cell CELL-41.'
          }
        ]
      }
    });
    assert.equal(recARes.status, 201);
    assert.equal(recARes.body.record.evidence_status, 'SUPPORTED');

    // Corrupt spanCorruptTarget in the database
    db.prepare(`
      UPDATE source_spans
      SET is_corrupted = 1, content_text = '[CORRUPTED_UNREADABLE_STREAM]', corruption_reason = 'Checksum mismatch in underlying span payload'
      WHERE id = ?
    `).run(spanCorruptTarget.id);

    // Inspect Record A: citation must be marked CORRUPTED_SPAN (invalid) and record downgraded from SUPPORTED to UNSUPPORTED
    const inspectARes = await apiRequest(
      server,
      'GET',
      `/api/projects/prj_solidstate_01/records/${recARes.body.record.id}/inspect`,
      { token: 'tok_researcher_01' }
    );
    assert.equal(inspectARes.status, 200);
    assert.equal(inspectARes.body.record.evidence_links[0].citation_status, 'CORRUPTED_SPAN');
    assert.equal(inspectARes.body.record.evidence_links[0].is_valid_support, false);
    assert.equal(inspectARes.body.record.evidence_links[0].quote_verified, 0);
    assert.notEqual(inspectARes.body.record.evidence_status, 'SUPPORTED', 'Corrupted span citation must never leave claim SUPPORTED');
    assert.equal(inspectARes.body.record.evidence_status, 'UNSUPPORTED');

    // Create Record B as SUPPORTED linked to spanDeleteTarget
    const recBRes = await apiRequest(server, 'POST', '/api/projects/prj_solidstate_01/records', {
      token: 'tok_researcher_01',
      body: {
        record_type: 'RESULT',
        title: 'CELL-42 Interfacial Resistance Claim',
        statement: 'Interfacial resistance dropped to 11.2 Ohm.cm2 after 5 MPa stack pressure hold in CELL-42.',
        evidence_status: 'SUPPORTED',
        evidence_links: [
          {
            span_id: spanDeleteTarget.id,
            relationship_type: 'SUPPORTS',
            verbatim_quote: 'Interfacial resistance dropped to 11.2 Ohm.cm2 after 5 MPa stack pressure hold in CELL-42.'
          }
        ]
      }
    });
    assert.equal(recBRes.status, 201);
    assert.equal(recBRes.body.record.evidence_status, 'SUPPORTED');

    // Delete spanDeleteTarget row from source_spans
    db.prepare('DELETE FROM source_spans WHERE id = ?').run(spanDeleteTarget.id);

    // Inspect Record B: citation row is preserved via ON DELETE SET NULL + original_span_id, marked INVALID_UNRESOLVED, and record downgraded to UNSUPPORTED
    const inspectBRes = await apiRequest(
      server,
      'GET',
      `/api/projects/prj_solidstate_01/records/${recBRes.body.record.id}/inspect`,
      { token: 'tok_researcher_01' }
    );
    assert.equal(inspectBRes.status, 200);
    assert.equal(inspectBRes.body.record.evidence_links.length, 1);
    assert.equal(inspectBRes.body.record.evidence_links[0].original_span_id, spanDeleteTarget.id);
    assert.equal(inspectBRes.body.record.evidence_links[0].citation_status, 'INVALID_UNRESOLVED');
    assert.equal(inspectBRes.body.record.evidence_links[0].is_valid_support, false);
    assert.equal(inspectBRes.body.record.evidence_status, 'UNSUPPORTED');
  });

  await t.test('5. Cross-project evidence reference: rejected across all record/verification endpoints (422 CROSS_PROJECT_EVIDENCE_VIOLATION) and cannot appear as valid support', async () => {
    const otherProjRes = await apiRequest(server, 'POST', '/api/projects', {
      token: 'tok_pi_lead_01',
      body: {
        name: 'Foreign Battery Project',
        description: 'Isolated project to test cross-project citation blocking'
      }
    });
    assert.equal(otherProjRes.status, 201);
    const foreignProjectId = otherProjRes.body.project.id;

    const foreignSrcRes = await apiRequest(server, 'POST', `/api/projects/${foreignProjectId}/sources`, {
      token: 'tok_pi_lead_01',
      body: {
        title: 'Foreign Lab Note',
        file_name: 'foreign.md',
        source_type: 'LAB_NOTE',
        visibility_level: 'PROJECT_SHARED',
        exclude_from_ai: false,
        raw_content: '# Foreign Section\nResult: Foreign project measurement 4.2 V.'
      }
    });
    assert.equal(foreignSrcRes.status, 201);
    const foreignSpanId = foreignSrcRes.body.spans[0].id;

    // 5a. Attempt to create a record in prj_solidstate_01 citing foreignSpanId
    const crossCreateRes = await apiRequest(server, 'POST', '/api/projects/prj_solidstate_01/records', {
      token: 'tok_researcher_01',
      body: {
        record_type: 'RESULT',
        title: 'Cross-Project Citation Attempt',
        statement: 'Result: Foreign project measurement 4.2 V.',
        evidence_status: 'SUPPORTED',
        evidence_links: [
          {
            span_id: foreignSpanId,
            relationship_type: 'SUPPORTS',
            verbatim_quote: 'Result: Foreign project measurement 4.2 V.'
          }
        ]
      }
    });
    assert.equal(crossCreateRes.status, 422);
    assert.equal(crossCreateRes.body.error.code, 'CROSS_PROJECT_EVIDENCE_VIOLATION');

    // 5b. Attempt to verify an existing record in prj_solidstate_01 with foreignSpanId
    const crossVerifyRes = await apiRequest(
      server,
      'POST',
      '/api/projects/prj_solidstate_01/records/rec_seed_01/verify',
      {
        token: 'tok_reviewer_01',
        body: {
          evidence_status: 'SUPPORTED',
          evidence_links: [
            {
              span_id: foreignSpanId,
              relationship_type: 'SUPPORTS',
              verbatim_quote: 'Result: Foreign project measurement 4.2 V.'
            }
          ]
        }
      }
    );
    assert.equal(crossVerifyRes.status, 422);
    assert.equal(crossVerifyRes.body.error.code, 'CROSS_PROJECT_EVIDENCE_VIOLATION');
  });

  await t.test('6. Reviewer flagging an incorrect or irrelevant citation marks it invalid, logs version/audit history, and downgrades SUPPORTED claim without altering approval_status', async () => {
    const recRes = await apiRequest(server, 'POST', '/api/projects/prj_solidstate_01/records', {
      token: 'tok_researcher_01',
      body: {
        record_type: 'DECISION',
        title: 'Crucible Material Selection Claim',
        statement: 'Switched crucible setup from bare alumina to MgO crucibles with a generous mother-powder bed',
        stated_owner: 'Dr. Elena Vance',
        recorded_date: '2026-10-01',
        evidence_status: 'SUPPORTED',
        evidence_links: [
          {
            span_id: 'spn_pdf01_2',
            relationship_type: 'SUPPORTS',
            verbatim_quote: 'Switched crucible setup from bare alumina to MgO crucibles with a generous mother-powder bed'
          }
        ]
      }
    });
    assert.equal(recRes.status, 201);
    const recordId = recRes.body.record.id;
    const linkId = recRes.body.record.evidence_links[0].id;
    assert.equal(recRes.body.record.evidence_status, 'SUPPORTED');
    assert.equal(recRes.body.record.approval_status, 'DRAFT');

    // Reviewer flags the citation as IRRELEVANT_PASSAGE
    const flagRes = await apiRequest(
      server,
      'POST',
      `/api/projects/prj_solidstate_01/records/${recordId}/citations/${linkId}/flag`,
      {
        token: 'tok_reviewer_01',
        body: {
          flag_reason: 'IRRELEVANT_PASSAGE',
          notes: 'Cited passage applies to Batch B1 alumina test, not the doped Ta-LLZO protocol.'
        }
      }
    );
    assert.equal(flagRes.status, 200);
    assert.equal(flagRes.body.flagged_citation.citation_status, 'FLAGGED_IRRELEVANT');
    assert.equal(flagRes.body.flagged_citation.is_valid_support, false);
    assert.equal(flagRes.body.flagged_citation.quote_verified, 0);
    assert.equal(flagRes.body.record.evidence_status, 'UNSUPPORTED', 'Record must downgrade from SUPPORTED when its sole citation is flagged');
    assert.equal(flagRes.body.record.approval_status, 'DRAFT', 'Rule 1: flagging evidence must not alter approval_status');
  });
});
