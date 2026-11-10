'use strict';

const { inspectAndEnrichRecord } = require('./evidenceInspector');

const RECEIPT_DISCLAIMER =
  'Acknowledgement means receipt, not agreement or proof of understanding. It records receipt of this handover version only.';

function formatContinuationEntry(rec) {
  const sf = rec.structured_fields || {};
  // Filter out any restricted spans server-side before building continuation plan
  const sharedCitations = (rec.evidence_links || [])
    .filter((l) => l.visibility_level !== 'RESTRICTED_PI_ONLY')
    .map((l) => ({
      link_id: l.id,
      span_id: l.span_id,
      source_id: l.source_id,
      source_title: l.source_title,
      locator_label: l.locator_label,
      verbatim_quote: l.verbatim_quote,
      citation_status: l.citation_status || 'RESOLVED'
    }));

  return {
    record_id: rec.id,
    record_version: rec.current_version,
    approved_version: rec.approved_version ?? rec.current_version,
    record_type: rec.record_type,
    title: rec.title,
    statement: rec.direct_source_statement || rec.statement,
    ai_summary_or_inference: rec.ai_summary_or_inference || null,
    context_notes: rec.context_notes || '',
    rationale: rec.rationale || null,
    rationale_label: rec.rationale ? rec.rationale : 'UNKNOWN (Not stated in source)',
    owner: rec.stated_owner ?? null,
    stated_owner: rec.stated_owner ? rec.stated_owner : 'UNKNOWN (Not stated in source)',
    owner_label: rec.stated_owner ? rec.stated_owner : 'UNKNOWN (Not stated in source)',
    owner_is_unknown: !rec.stated_owner,
    recorded_date: rec.recorded_date ?? null,
    date_label: rec.recorded_date ? rec.recorded_date : 'UNKNOWN',
    due_date: rec.due_date ?? null,
    deadline: rec.due_date ? rec.due_date : 'UNKNOWN (No deadline stated in source)',
    deadline_label: rec.due_date ? rec.due_date : 'UNKNOWN (No deadline stated in source)',
    deadline_is_unknown: !rec.due_date,
    next_action: sf.next_action || (rec.record_type === 'TASK' ? rec.statement : null),
    evidence_status: rec.evidence_status,
    approval_status: rec.approval_status,
    source_evidence: sharedCitations
  };
}

/**
 * Generates a structured continuation plan from approved, non-restricted records only.
 * Never fabricates unknown owners or deadlines — explicitly labels them UNKNOWN.
 */
function buildContinuationPlan(enrichedApprovedRecords, project, restrictedSourcesExcludedCount = 0) {
  const entries = enrichedApprovedRecords.map((r) => formatContinuationEntry(r));

  const approvedDecisions = entries.filter((e) => e.record_type === 'DECISION');
  const completedWorkAndResults = entries.filter((e) =>
    ['OBJECTIVE', 'EXPERIMENT', 'RESULT', 'PROTOCOL', 'METHOD', 'CLAIM', 'DATASET_FINDING'].includes(e.record_type)
  );
  const openTasksAndNextActions = entries.filter((e) => e.record_type === 'TASK');
  const blockersAndRisks = entries.filter((e) =>
    ['RISK', 'GAP', 'RECURRING_PROBLEM', 'RISK_LIMITATION'].includes(e.record_type)
  );
  const dependenciesAndContacts = entries.filter((e) =>
    ['DEPENDENCY', 'CONTACT'].includes(e.record_type)
  );
  const unresolvedQuestions = entries.filter((e) =>
    ['QUESTION', 'OPEN_QUESTION'].includes(e.record_type)
  );

  return {
    current_status: {
      project_id: project ? project.id : null,
      project_name: project ? project.name : '',
      project_status: project ? project.status : 'ACTIVE',
      approved_records_count: entries.length,
      restricted_sources_excluded_count: restrictedSourcesExcludedCount,
      decisions_count: approvedDecisions.length,
      completed_work_count: completedWorkAndResults.length,
      open_tasks_count: openTasksAndNextActions.length,
      blockers_risks_count: blockersAndRisks.length,
      dependencies_count: dependenciesAndContacts.length,
      unresolved_questions_count: unresolvedQuestions.length,
      summary: `Continuation plan generated from ${entries.length} approved record(s) (${approvedDecisions.length} decision(s), ${completedWorkAndResults.length} completed work/result item(s), ${openTasksAndNextActions.length} open task(s), ${blockersAndRisks.length} blocker/risk(s), ${dependenciesAndContacts.length} dependency/contact(s), ${unresolvedQuestions.length} unresolved question(s)). Unknown owners and deadlines are labelled UNKNOWN and never fabricated.`
    },
    approved_decisions: approvedDecisions,
    completed_work_and_results: completedWorkAndResults,
    open_tasks_and_next_actions: openTasksAndNextActions,
    blockers_and_risks: blockersAndRisks,
    dependencies_and_contacts: dependenciesAndContacts,
    unresolved_questions: unresolvedQuestions
  };
}

/**
 * Produces a server-side role-filtered handover view ensuring restricted records
 * and restricted spans are completely absent before response generation.
 */
function buildRoleFilteredHandoverResponse(db, handoverRow, viewerRole) {
  const project = db.prepare('SELECT id, name, status FROM projects WHERE id = ?').get(handoverRow.project_id);

  const rawItems = db
    .prepare('SELECT * FROM handover_items WHERE handover_id = ? ORDER BY id ASC')
    .all(handoverRow.id);

  // Exclude any record that has a restricted span attached, and pass PROJECT_SHARED filter
  const effectiveRoleForHandover = viewerRole === 'PI_LEAD' ? 'RESEARCHER' : viewerRole;
  const filteredItems = [];
  const enrichedApprovedForPlan = [];

  for (const it of rawItems) {
    const rec = db.prepare('SELECT * FROM extracted_records WHERE id = ?').get(it.record_id);
    if (!rec) continue;

    const restrictedSpanCount = db
      .prepare(`
        SELECT COUNT(*) AS c
        FROM evidence_links el
        JOIN source_spans sp ON sp.id = el.span_id
        JOIN sources s ON s.id = sp.source_id
        WHERE el.record_id = ? AND (s.visibility_level = 'RESTRICTED_PI_ONLY' OR s.exclude_from_ai = 1)
      `)
      .get(rec.id).c;

    if (restrictedSpanCount > 0) {
      // Server-side exclusion: restricted records/spans never enter handover responses
      continue;
    }

    const enrichedRec = inspectAndEnrichRecord(db, rec, effectiveRoleForHandover);
    // Double-ensure zero restricted links in record.evidence_links
    enrichedRec.evidence_links = (enrichedRec.evidence_links || []).filter(
      (l) => l.visibility_level !== 'RESTRICTED_PI_ONLY'
    );

    enrichedApprovedForPlan.push(enrichedRec);
    filteredItems.push({
      ...it,
      owner_label: enrichedRec.stated_owner ? enrichedRec.stated_owner : 'UNKNOWN (Not stated in source)',
      deadline_label: enrichedRec.due_date ? enrichedRec.due_date : 'UNKNOWN (No deadline stated in source)',
      record: enrichedRec
    });
  }

  let continuationPlan;
  try {
    const storedPlan = JSON.parse(handoverRow.continuation_plan_json || '{}');
    if (storedPlan && storedPlan.current_status) {
      continuationPlan = storedPlan;
    } else {
      continuationPlan = buildContinuationPlan(
        enrichedApprovedForPlan,
        project,
        handoverRow.restricted_sources_excluded_count
      );
    }
  } catch (_) {
    continuationPlan = buildContinuationPlan(
      enrichedApprovedForPlan,
      project,
      handoverRow.restricted_sources_excluded_count
    );
  }

  const acknowledgements = db
    .prepare(`
      SELECT ha.*, u.full_name AS recipient_name
      FROM handover_acknowledgements ha
      JOIN users u ON u.id = ha.recipient_user_id
      WHERE ha.handover_id = ?
      ORDER BY ha.created_at ASC
    `)
    .all(handoverRow.id);

  const versions = db
    .prepare(`
      SELECT hv.id, hv.handover_id, hv.project_id, hv.version_number,
             hv.lifecycle_event, hv.actor_user_id, u.full_name AS actor_name, hv.created_at
      FROM handover_versions hv
      JOIN users u ON u.id = hv.actor_user_id
      WHERE hv.handover_id = ?
      ORDER BY hv.created_at ASC
    `)
    .all(handoverRow.id);

  return {
    handover: {
      ...handoverRow,
      continuation_plan: continuationPlan,
      role_filtered_view: {
        viewer_role: viewerRole,
        can_view_restricted_sources: false,
        restricted_records_redacted: 0,
        restricted_records_excluded_server_side: true,
        restricted_spans_excluded_server_side: true,
        restricted_sources_excluded_count: handoverRow.restricted_sources_excluded_count
      }
    },
    continuation_plan: continuationPlan,
    items: filteredItems,
    acknowledgements,
    versions
  };
}

module.exports = {
  RECEIPT_DISCLAIMER,
  formatContinuationEntry,
  buildContinuationPlan,
  buildRoleFilteredHandoverResponse
};
