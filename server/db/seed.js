'use strict';

const { openDatabase, closeDatabase, runMigrations, withTransaction } = require('./database');
const { storePrivateUpload } = require('../services/storageService');
const { indexSourceSpans } = require('../services/spanIndexer');
const { rebuildProjectContinuityEdges } = require('../services/aiReconstructor');
const { logAuditEvent } = require('../services/auditService');
const { hashPasswordScrypt, sha256Hex } = require('../middleware/authRbac');

function seedDatabase(customDb = null) {
  const db = customDb || openDatabase();
  runMigrations(db);

  return withTransaction(db, () => {
    const now = '2026-11-10T10:00:00.000Z';

    // Clear existing rows in reverse FK order for idempotent re-seeding
    db.exec(`
      DELETE FROM step_up_events;
      DELETE FROM record_edges;
      DELETE FROM handover_versions;
      DELETE FROM handover_acknowledgements;
      DELETE FROM handover_items;
      DELETE FROM handover_packages;
      DELETE FROM reviews;
      DELETE FROM record_versions;
      DELETE FROM evidence_links;
      DELETE FROM extracted_records;
      DELETE FROM source_spans;
      DELETE FROM sources;
      DELETE FROM memberships;
      DELETE FROM auth_sessions;
      DELETE FROM audit_events;
      DELETE FROM projects;
      DELETE FROM users;
      DELETE FROM roles;
    `);

    const roles = [
      ['PI_LEAD', 'Principal Investigator / Lab Lead', 'Owns project, manages memberships, views restricted sources, approves records, publishes handovers.', 1],
      ['RESEARCHER', 'Outgoing / Active Researcher', 'Uploads shared sources, reconstructs & edits records, verifies evidence, drafts handovers.', 0],
      ['REVIEWER', 'Senior Peer / Method Reviewer', 'Verifies evidence links and submits review decisions (APPROVE, REQUEST_CHANGES, FLAG_GAP, REJECT).', 0],
      ['INCOMING_MEMBER', 'Incoming Researcher / Student', 'Inspects published handovers, verifies provenance spans, and acknowledges handover receipt.', 0],
      ['AUDITOR', 'Research Integrity Auditor', 'Read-only access to shared project artifacts, versions, reviews, and audit logs.', 0]
    ];
    const insertRole = db.prepare('INSERT INTO roles (id, name, description, can_access_restricted) VALUES (?, ?, ?, ?)');
    for (const r of roles) insertRole.run(...r);

    const defaultPasswordHash = hashPasswordScrypt('BatonDemoPass!2026', 'baton_fixed_salt_01');
    const users = [
      ['usr_pi_01', 'elena.vance@baton-lab.edu', 'Dr. Elena Vance (PI)', 'Solid-State Energy Lab', 'tok_pi_lead_01', defaultPasswordHash, sha256Hex('tok_pi_lead_01'), now],
      ['usr_res_01', 'marcus.chen@baton-lab.edu', 'Marcus Chen (Outgoing PhD)', 'Solid-State Energy Lab', 'tok_researcher_01', defaultPasswordHash, sha256Hex('tok_researcher_01'), now],
      ['usr_rev_01', 'priya.nair@baton-lab.edu', 'Dr. Priya Nair (Senior Reviewer)', 'Materials Characterization Core', 'tok_reviewer_01', defaultPasswordHash, sha256Hex('tok_reviewer_01'), now],
      ['usr_inc_01', 'aria.patel@baton-lab.edu', 'Aria Patel (Incoming MS Researcher)', 'Solid-State Energy Lab', 'tok_incoming_01', defaultPasswordHash, sha256Hex('tok_incoming_01'), now],
      ['usr_aud_01', 'audit@baton-lab.edu', 'jordan.lee@baton-lab.edu (Compliance Auditor)', 'Research Governance Office', 'tok_auditor_01', defaultPasswordHash, sha256Hex('tok_auditor_01'), now],
      ['usr_out_01', 'outsider@other-lab.edu', 'Alex Rivera (Non-Member)', 'External Group', 'tok_outsider_01', defaultPasswordHash, sha256Hex('tok_outsider_01'), now]
    ];
    const insertUser = db.prepare('INSERT INTO users (id, email, full_name, department, api_token, password_hash, token_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const u of users) insertUser.run(...u);

    const projectId = 'prj_solidstate_01';
    db.prepare(`
      INSERT INTO projects (id, slug, name, description, owner_user_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)
    `).run(
      projectId,
      'solid-state-llzo-continuity',
      'Solid-State Li-Garnet (LLZO) Electrolyte Interface Continuity',
      'Research continuity workflow for Ta-doped Li7La3Zr2O12 pellet sintering, glovebox handling protocols, and impedance datasets.',
      'usr_pi_01',
      now
    );

    const memberships = [
      ['mem_01', projectId, 'usr_pi_01', 'PI_LEAD', 'usr_pi_01', now],
      ['mem_02', projectId, 'usr_res_01', 'RESEARCHER', 'usr_pi_01', now],
      ['mem_03', projectId, 'usr_rev_01', 'REVIEWER', 'usr_pi_01', now],
      ['mem_04', projectId, 'usr_inc_01', 'INCOMING_MEMBER', 'usr_pi_01', now],
      ['mem_05', projectId, 'usr_aud_01', 'AUDITOR', 'usr_pi_01', now]
    ];
    const insertMem = db.prepare('INSERT INTO memberships (id, project_id, user_id, role_id, added_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const m of memberships) insertMem.run(...m);

    const rawSources = [
      {
        id: 'src_pdf_01',
        title: 'Li-Garnet Pellet Sintering & Cycling Report (Q3)',
        fileName: 'llzo_sintering_report.pdf',
        sourceType: 'PDF_DOCUMENT',
        visibilityLevel: 'PROJECT_SHARED',
        excludeFromAi: 0,
        uploadedBy: 'usr_res_01',
        spanPrefix: 'spn_pdf01',
        rawContent: [
          '[PAGE 1]',
          'Objective: Achieve >93% relative density and >0.60 mS/cm room-temperature ionic conductivity in Ta-doped Li7La3Zr2O12 (LLZO) solid electrolyte pellets without aluminum crucible contamination.',
          'Decision: Switched crucible setup from bare alumina to MgO crucibles with a generous mother-powder bed after observing Al-diffusion grain boundary blocking in Batch B1.',
          '[PAGE 2]',
          'Experiment: Pellets sintered at 1150C for 6 hours in mother powder achieved 94.2% relative density and ionic conductivity of 0.68 mS/cm at 25C (see Sample SSE-04).',
          'Gap: High-current cycling (>0.8 mA/cm2) still exhibits interfacial voiding after 40 cycles; stack pressure fixture calibration at 5 MPa remains unverified.'
        ].join('\n\n')
      },
      {
        id: 'src_note_01',
        title: 'Lab Notebook: Glovebox Argon Purge & Sensor Drift Log',
        fileName: 'glovebox_notes_oct.md',
        sourceType: 'LAB_NOTE',
        visibilityLevel: 'PROJECT_SHARED',
        excludeFromAi: 0,
        uploadedBy: 'usr_res_01',
        spanPrefix: 'spn_note01',
        rawContent: [
          '# Argon Purge & Surface Polishing Protocol',
          'Maintain glovebox H2O and O2 below 0.5 ppm before dry-polishing sintered LLZO pellets with 400-to-1200 grit SiC paper. Exposure above 2 ppm forms Li2CO3 passivation within 10 minutes.',
          '# Moisture Sensor Drift Risk & Contact',
          'Risk: On Oct 14, the primary H2O analyzer drifted by +1.8 ppm following circulation valve replacement. Contact facility technician Samira Ortiz (samira.ortiz@baton-lab.edu) for analyzer zero-calibration before new lithium symmetric cell assembly.'
        ].join('\n')
      },
      {
        id: 'src_csv_01',
        title: 'EIS Conductivity & Sintering Dataset (Samples SSE-01 to SSE-04)',
        fileName: 'eis_conductivity_runs.csv',
        sourceType: 'CSV_DATASET',
        visibilityLevel: 'PROJECT_SHARED',
        excludeFromAi: 0,
        uploadedBy: 'usr_res_01',
        spanPrefix: 'spn_csv01',
        rawContent: [
          'sample_id,sinter_temp_C,duration_h,crucible_type,rel_density_pct,conductivity_mS_cm',
          'SSE-01,1100,4,Alumina_Bare,88.4,0.21',
          'SSE-02,1125,6,Alumina_Bare,90.1,0.34',
          'SSE-03,1150,4,MgO_MotherPowder,92.8,0.55',
          'SSE-04,1150,6,MgO_MotherPowder,94.2,0.68'
        ].join('\n')
      },
      {
        id: 'src_restricted_01',
        title: 'RESTRICTED: Pre-Patent Dual-Halide Interlayer Disclosure Draft',
        fileName: 'restricted_patent_interlayer.md',
        sourceType: 'LAB_NOTE',
        visibilityLevel: 'RESTRICTED_PI_ONLY',
        excludeFromAi: 1,
        uploadedBy: 'usr_pi_01',
        spanPrefix: 'spn_rest01',
        rawContent: [
          '# Confidential Pre-Filing Formulation',
          'Proprietary 3-nm Li3InCl6 / Au co-sputtered interlayer formulation under IP embargo until provisional filing #LP-2026-991 is completed. Do not include in student handover or external AI prompts.'
        ].join('\n')
      }
    ];

    const insertSource = db.prepare(`
      INSERT INTO sources (
        id, project_id, title, file_name, file_extension, mime_type, byte_size, storage_key,
        source_type, processing_status, processing_error,
        visibility_level, exclude_from_ai, content_hash, raw_content,
        has_prompt_injection_pattern, uploaded_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'READY', NULL, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const s of rawSources) {
      const stored = storePrivateUpload({
        fileName: s.fileName,
        sourceType: s.sourceType,
        rawContent: s.rawContent
      });

      insertSource.run(
        s.id,
        projectId,
        s.title,
        stored.safeFileName,
        stored.fileExtension,
        stored.mimeType,
        stored.byteSize,
        stored.storageKey,
        s.sourceType,
        s.visibilityLevel,
        s.excludeFromAi,
        stored.contentHash,
        s.rawContent,
        stored.hasPromptInjectionPattern,
        s.uploadedBy,
        now
      );

      indexSourceSpans(db, {
        sourceId: s.id,
        projectId,
        sourceType: s.sourceType,
        rawContent: s.rawContent,
        idPrefix: s.spanPrefix
      });
    }

    // Seed 3 initial extracted records demonstrating different stages & evidence statuses
    const seedRecords = [
      {
        id: 'rec_seed_01',
        recordType: 'EXPERIMENT',
        title: 'LLZO Sintering at 1150C for 6h in MgO Crucible with Mother Powder',
        statement: 'Pellets sintered at 1150C for 6 hours in mother powder achieved 94.2% relative density and ionic conductivity of 0.68 mS/cm at 25C (see Sample SSE-04).',
        aiSummary: 'Baseline sintering experiment corroborated across PDF report Page 2 and EIS CSV Row #4 (SSE-04).',
        rationale: 'Core baseline fabrication recipe for incoming researcher replication.',
        statedOwner: null, // Not explicitly stated in PDF/CSV text — preserved as null (UNKNOWN)
        recordedDate: null,
        dueDate: null,
        structuredFields: {
          method: 'Mother-powder bed sintering in MgO crucible',
          variables: 'Temperature (1150C), Duration (6h)',
          conditions: '94.2% relative density, 0.68 mS/cm at 25C',
          status: 'COMPLETED'
        },
        isIncomplete: 1,
        missingFields: ['stated_owner', 'recorded_date'],
        originMode: 'AI_PROPOSED',
        evidenceStatus: 'SUPPORTED',
        verificationNotes: 'Corroborated across PDF Page 2 report and CSV Row #4 (sample_id=SSE-04).',
        verifiedBy: 'usr_res_01',
        verifiedAt: now,
        approvalStatus: 'APPROVED',
        createdBy: 'usr_res_01',
        links: [
          {
            id: 'evl_seed_01',
            spanId: 'spn_pdf01_3',
            relationshipType: 'SUPPORTS',
            verbatimQuote: 'Pellets sintered at 1150C for 6 hours in mother powder achieved 94.2% relative density and ionic conductivity of 0.68 mS/cm at 25C'
          },
          {
            id: 'evl_seed_02',
            spanId: 'spn_csv01_4',
            relationshipType: 'SUPPORTS',
            verbatimQuote: 'sample_id=SSE-04 | sinter_temp_C=1150 | duration_h=6 | crucible_type=MgO_MotherPowder | rel_density_pct=94.2 | conductivity_mS_cm=0.68'
          }
        ]
      },
      {
        id: 'rec_seed_02',
        recordType: 'RISK',
        title: 'Glovebox H2O Analyzer Drift & Surface Passivation Risk',
        statement: 'Risk: On Oct 14, the primary H2O analyzer drifted by +1.8 ppm following circulation valve replacement. Contact facility technician Samira Ortiz (samira.ortiz@baton-lab.edu) for analyzer zero-calibration before new lithium symmetric cell assembly.',
        aiSummary: 'Operational moisture sensor drift risk identified in Oct 14 notebook entry; requires zero-calibration with Samira Ortiz.',
        rationale: 'Prevents silent Li2CO3 surface contamination during cell assembly.',
        statedOwner: 'Samira Ortiz',
        recordedDate: 'Oct 14',
        dueDate: null,
        structuredFields: {
          risk_or_blocker: 'Primary H2O analyzer drifted by +1.8 ppm following circulation valve replacement',
          contact: 'Samira Ortiz (samira.ortiz@baton-lab.edu)'
        },
        isIncomplete: 0,
        missingFields: [],
        originMode: 'AI_PROPOSED',
        evidenceStatus: 'SUPPORTED',
        verificationNotes: 'Verified against Lab Notebook Section 1 and Section 2.',
        verifiedBy: 'usr_res_01',
        verifiedAt: now,
        approvalStatus: 'APPROVED',
        createdBy: 'usr_res_01',
        links: [
          {
            id: 'evl_seed_03',
            spanId: 'spn_note01_2',
            relationshipType: 'SUPPORTS',
            verbatimQuote: 'On Oct 14, the primary H2O analyzer drifted by +1.8 ppm following circulation valve replacement.'
          }
        ]
      },
      {
        id: 'rec_seed_03',
        recordType: 'GAP',
        title: 'Unverified 5 MPa Stack Pressure Calibration Under High-Current Cycling',
        statement: 'Gap: High-current cycling (>0.8 mA/cm2) still exhibits interfacial voiding after 40 cycles; stack pressure fixture calibration at 5 MPa remains unverified.',
        aiSummary: 'Unresolved calibration gap affecting high-current cycling (>0.8 mA/cm2) after 40 cycles.',
        rationale: null, // Not explicitly stated in source
        statedOwner: null, // Unknown owner in source
        recordedDate: null,
        dueDate: null,
        structuredFields: {
          gap_description: 'Stack pressure fixture calibration at 5 MPa remains unverified; interfacial voiding after 40 cycles at >0.8 mA/cm2',
          owner: null
        },
        isIncomplete: 1,
        missingFields: ['stated_owner', 'recorded_date'],
        originMode: 'MANUAL_ENTRY',
        evidenceStatus: 'WEAK',
        verificationNotes: 'Single preliminary observation in Q3 report Page 2; torque-to-MPa load cell logs not yet uploaded.',
        verifiedBy: 'usr_res_01',
        verifiedAt: now,
        approvalStatus: 'PENDING_REVIEW',
        createdBy: 'usr_res_01',
        links: [
          {
            id: 'evl_seed_04',
            spanId: 'spn_pdf01_4',
            relationshipType: 'PARTIALLY_SUPPORTS',
            verbatimQuote: 'stack pressure fixture calibration at 5 MPa remains unverified.'
          }
        ]
      }
    ];

    for (const r of seedRecords) {
      const isSeedApproved = r.approvalStatus === 'APPROVED';
      db.prepare(`
        INSERT INTO extracted_records (
          id, project_id, record_type, title, statement,
          direct_source_statement, ai_summary_or_inference,
          rationale, stated_owner, recorded_date, due_date,
          structured_fields_json, is_incomplete, missing_fields_json,
          origin_mode, evidence_status, verification_notes,
          verified_by_user_id, verified_at, approval_status,
          approved_version, approved_by_user_id, approved_at,
          current_version, extractor_provider, extractor_model, extractor_version, extracted_at,
          created_by_user_id, updated_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'baton-deterministic-extractor', 'baton-struct-schema-v2', '2.5.0', ?, ?, ?, ?)
      `).run(
        r.id,
        projectId,
        r.recordType,
        r.title,
        r.statement,
        r.statement,
        r.aiSummary,
        r.rationale || '',
        r.statedOwner,
        r.recordedDate,
        r.dueDate,
        JSON.stringify(r.structuredFields),
        r.isIncomplete,
        JSON.stringify(r.missingFields),
        r.originMode,
        r.evidenceStatus,
        r.verificationNotes,
        r.verifiedBy,
        r.verifiedAt,
        r.approvalStatus,
        isSeedApproved ? 1 : null,
        isSeedApproved ? 'usr_pi_01' : null,
        isSeedApproved ? now : null,
        now,
        r.createdBy,
        now,
        now
      );

      for (const l of r.links) {
        db.prepare(`
          INSERT INTO evidence_links (
            id, record_id, span_id, original_span_id, relationship_type,
            verbatim_quote, quote_verified, created_by_user_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(l.id, r.id, l.spanId, l.spanId, l.relationshipType, l.verbatimQuote, r.createdBy, now);
      }

      db.prepare(`
        INSERT INTO record_versions (
          id, record_id, version_number, change_reason,
          changes_json, snapshot_json, changed_by_user_id, created_at
        ) VALUES (?, ?, 1, 'INITIAL_EXTRACTION', ?, ?, ?, ?)
      `).run(
        `ver_${r.id}_v1`,
        r.id,
        JSON.stringify({ seeded: true }),
        JSON.stringify({
          id: r.id,
          title: r.title,
          statement: r.statement,
          evidence_status: r.evidenceStatus,
          approval_status: r.approvalStatus,
          span_ids: r.links.map((x) => x.spanId)
        }),
        r.createdBy,
        now
      );
    }

    rebuildProjectContinuityEdges(db, projectId);

    logAuditEvent(db, {
      projectId,
      actorUserId: 'usr_pi_01',
      actorRole: 'PI_LEAD',
      eventType: 'DEMO_PROJECT_SEEDED',
      targetEntityType: 'PROJECT',
      targetEntityId: projectId,
      metadata: { sources_seeded: rawSources.length, records_seeded: seedRecords.length }
    });

    return {
      projectId,
      usersCount: users.length,
      sourcesCount: rawSources.length,
      recordsCount: seedRecords.length
    };
  });
}

if (require.main === module) {
  try {
    const summary = seedDatabase();
    console.log('[BATON Seed] Synthetic demo data seeded successfully:', JSON.stringify(summary));
    closeDatabase();
  } catch (err) {
    console.error('[BATON Seed] Failed:', err.message);
    process.exit(1);
  }
}

module.exports = { seedDatabase };
