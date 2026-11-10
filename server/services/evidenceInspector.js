'use strict';

const crypto = require('node:crypto');
const { withTransaction } = require('../db/database');
const { logAuditEvent } = require('./auditService');

const CANONICAL_EVIDENCE_STATE_DEFINITIONS = {
  SUPPORTED: 'linked source passage directly supports the claim as written.',
  CONFLICTING: 'credible linked sources disagree on a material point. Show both; do not choose a winner automatically.',
  UNSUPPORTED: 'no valid supporting evidence was found.',
  STALE: 'evidence may be outdated relative to a newer dated source or explicit validity rule. Explain why.',
  'NEEDS REVIEW': 'evidence or interpretation is ambiguous/incomplete.',
  'NOT ESTABLISHED': 'sources do not establish the point; do not imply it is false.'
};

const EPISTEMIC_CITATION_NOTICE =
  'A citation shows where a claim came from; it does not prove the source itself is correct.';

function normalizeEvidenceStateInput(rawStatus) {
  if (typeof rawStatus !== 'string') return rawStatus;
  const trimmed = rawStatus.trim().toUpperCase();
  if (trimmed === 'NEEDS_REVIEW') return 'NEEDS REVIEW';
  if (trimmed === 'NOT_ESTABLISHED') return 'NOT ESTABLISHED';
  return trimmed;
}

function toCanonicalEvidenceState(status) {
  const norm = normalizeEvidenceStateInput(status);
  if (norm === 'SUPPORTED') return 'SUPPORTED';
  if (norm === 'CONFLICTING' || norm === 'CONTRADICTED') return 'CONFLICTING';
  if (norm === 'UNSUPPORTED' || norm === 'BROKEN_PROVENANCE') return 'UNSUPPORTED';
  if (norm === 'STALE') return 'STALE';
  if (norm === 'NEEDS REVIEW' || norm === 'WEAK' || norm === 'PARTIAL') return 'NEEDS REVIEW';
  if (norm === 'NOT ESTABLISHED' || norm === 'UNVERIFIED') return 'NOT ESTABLISHED';
  return 'NOT ESTABLISHED';
}

function extractIsoDateFromText(text) {
  if (!text) return null;
  const isoMatch = String(text).match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];
  const monthMatch = String(text).match(
    /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,?\s+\d{4})?)\b/i
  );
  return monthMatch ? monthMatch[1] : null;
}

/**
 * Inspects a record's citations, enforces Stage 06 rules (broken/deleted/corrupted/cross-project
 * citations cannot appear as valid support and downgrade SUPPORTED claims), builds conflicting
 * passages side-by-side without choosing a winner, and explains stale records.
 */
function inspectAndEnrichRecord(db, record, callerRole) {
  const creator = db.prepare('SELECT full_name, email FROM users WHERE id = ?').get(record.created_by_user_id);
  const verifier = record.verified_by_user_id
    ? db.prepare('SELECT full_name, email FROM users WHERE id = ?').get(record.verified_by_user_id)
    : null;

  // Use LEFT JOIN so deleted spans (span_id = NULL or missing row) remain visible as invalid citations
  const rawLinks = db
    .prepare(`
      SELECT el.*,
             sp.id AS resolved_span_id,
             sp.project_id AS span_project_id,
             sp.source_id,
             sp.locator_type,
             sp.locator_label,
             sp.page_number,
             sp.section_heading,
             sp.line_start,
             sp.line_end,
             sp.row_index,
             sp.record_key,
             sp.content_text AS span_content_text,
             sp.is_corrupted AS span_is_corrupted,
             sp.corruption_reason AS span_corruption_reason,
             sp.is_deleted AS span_is_deleted,
             s.title AS source_title,
             s.file_name AS source_file_name,
             s.visibility_level,
             s.created_at AS source_uploaded_at,
             fu.full_name AS flagged_by_name
      FROM evidence_links el
      LEFT JOIN source_spans sp ON sp.id = el.span_id
      LEFT JOIN sources s ON s.id = sp.source_id
      LEFT JOIN users fu ON fu.id = el.flagged_by_user_id
      WHERE el.record_id = ?
      ORDER BY el.created_at ASC
    `)
    .all(record.id);

  let hasUnresolvedOrCorrupted = false;

  const inspectedLinks = rawLinks.map((el) => {
    const rememberedSpanId = el.span_id || el.original_span_id || null;
    let citationStatus = el.citation_status || 'RESOLVED';
    let quoteVerified = el.quote_verified;
    let isValidSupport = false;
    let resolutionError = null;

    if (!el.resolved_span_id || el.span_is_deleted === 1) {
      citationStatus = 'INVALID_UNRESOLVED';
      quoteVerified = 0;
      isValidSupport = false;
      hasUnresolvedOrCorrupted = true;
      resolutionError = `Citation cannot be resolved: referenced source span '${rememberedSpanId || 'UNKNOWN'}' was deleted or is missing.`;
    } else if (el.span_project_id !== record.project_id) {
      citationStatus = 'INVALID_CROSS_PROJECT';
      quoteVerified = 0;
      isValidSupport = false;
      hasUnresolvedOrCorrupted = true;
      resolutionError = `Cross-project citation violation: span '${el.resolved_span_id}' does not belong to project '${record.project_id}'.`;
    } else if (
      el.span_is_corrupted === 1 ||
      !el.span_content_text ||
      !el.verbatim_quote ||
      !el.span_content_text.includes(el.verbatim_quote)
    ) {
      citationStatus = 'CORRUPTED_SPAN';
      quoteVerified = 0;
      isValidSupport = false;
      hasUnresolvedOrCorrupted = true;
      resolutionError =
        el.span_corruption_reason ||
        `Citation cannot be resolved: span '${el.resolved_span_id}' content is corrupted or no longer matches verbatim excerpt.`;
    } else if (citationStatus === 'FLAGGED_INCORRECT' || citationStatus === 'FLAGGED_IRRELEVANT') {
      quoteVerified = 0;
      isValidSupport = false;
      resolutionError = `Flagged by reviewer (${el.flagged_reason || citationStatus}): ${el.flagged_notes || 'Marked invalid or irrelevant.'}`;
    } else {
      citationStatus = 'RESOLVED';
      quoteVerified = 1;
      isValidSupport = el.relationship_type === 'SUPPORTS';
    }

    // Persist updated citation resolution state if it changed
    if (citationStatus !== el.citation_status || quoteVerified !== el.quote_verified) {
      db.prepare(`
        UPDATE evidence_links
        SET citation_status = ?, quote_verified = ?
        WHERE id = ?
      `).run(citationStatus, quoteVerified, el.id);
    }

    const excerptDate = extractIsoDateFromText(el.span_content_text) || record.recorded_date || null;

    return {
      id: el.id,
      record_id: el.record_id,
      span_id: rememberedSpanId,
      original_span_id: el.original_span_id || rememberedSpanId,
      relationship_type: el.relationship_type,
      verbatim_quote: el.verbatim_quote,
      quote_verified: quoteVerified,
      citation_status: citationStatus,
      is_valid_support: isValidSupport,
      resolution_error: resolutionError,
      flagged_by_user_id: el.flagged_by_user_id || null,
      flagged_by_name: el.flagged_by_name || null,
      flagged_reason: el.flagged_reason || null,
      flagged_notes: el.flagged_notes || null,
      flagged_at: el.flagged_at || null,
      source_id: el.span_project_id === record.project_id ? el.source_id : null,
      source_title: el.span_project_id === record.project_id ? el.source_title || '[Deleted Source]' : '[Cross-Project Forbidden]',
      source_file_name: el.span_project_id === record.project_id ? el.source_file_name || null : null,
      locator_type: el.locator_type || null,
      locator_label: el.locator_label || (rememberedSpanId ? `Unresolved (${rememberedSpanId})` : 'Unresolved Locator'),
      page_number: el.page_number ?? null,
      section_heading: el.section_heading ?? null,
      line_start: el.line_start ?? null,
      line_end: el.line_end ?? null,
      row_index: el.row_index ?? null,
      record_key: el.record_key ?? null,
      excerpt_date: excerptDate,
      span_content_text:
        citationStatus === 'RESOLVED' || citationStatus === 'FLAGGED_INCORRECT' || citationStatus === 'FLAGGED_IRRELEVANT'
          ? el.span_content_text
          : null,
      visibility_level: el.visibility_level || 'PROJECT_SHARED',
      created_by_user_id: el.created_by_user_id,
      created_at: el.created_at
    };
  });

  const visibleLinks =
    callerRole === 'PI_LEAD'
      ? inspectedLinks
      : inspectedLinks.filter((l) => l.visibility_level === 'PROJECT_SHARED');

  const validSupportingLinks = visibleLinks.filter((l) => l.is_valid_support);

  // Rule 4: If a citation cannot be resolved, mark it invalid and do not call the claim SUPPORTED.
  let effectiveEvidenceStatus = record.evidence_status;
  let effectiveVerificationNotes = record.verification_notes || '';

  if (
    effectiveEvidenceStatus === 'SUPPORTED' &&
    (hasUnresolvedOrCorrupted || validSupportingLinks.length === 0)
  ) {
    effectiveEvidenceStatus = 'UNSUPPORTED';
    const reasonMsg = hasUnresolvedOrCorrupted
      ? 'Automatically downgraded from SUPPORTED to UNSUPPORTED: one or more citations could not be resolved or point to deleted/corrupted spans.'
      : 'Automatically downgraded from SUPPORTED to UNSUPPORTED: no valid supporting citations remain.';
    effectiveVerificationNotes = effectiveVerificationNotes
      ? `${effectiveVerificationNotes} | ${reasonMsg}`
      : reasonMsg;

    db.prepare(`
      UPDATE extracted_records
      SET evidence_status = 'UNSUPPORTED', verification_notes = ?
      WHERE id = ?
    `).run(effectiveVerificationNotes, record.id);
  }

  // Build transparent conflicting_passages (Rule 7 & CONFLICTING definition: show both; do not choose a winner automatically)
  let conflictingPassages = [];
  try {
    conflictingPassages = JSON.parse(record.conflicting_passages_json || '[]');
  } catch (_) {
    conflictingPassages = [];
  }

  const supportLinks = visibleLinks.filter((l) => l.relationship_type === 'SUPPORTS');
  const contradictLinks = visibleLinks.filter((l) => l.relationship_type === 'CONTRADICTS');
  if (conflictingPassages.length === 0 && supportLinks.length > 0 && contradictLinks.length > 0) {
    conflictingPassages = [
      ...supportLinks.map((l, idx) => ({
        passage_label: `Passage A${supportLinks.length > 1 ? idx + 1 : ''} (Supporting Source)`,
        record_id: record.id,
        span_id: l.span_id,
        source_title: l.source_title,
        locator_label: l.locator_label,
        recorded_date: l.excerpt_date,
        verbatim_quote: l.verbatim_quote,
        relationship_type: 'SUPPORTS'
      })),
      ...contradictLinks.map((l, idx) => ({
        passage_label: `Passage B${contradictLinks.length > 1 ? idx + 1 : ''} (Disagreeing Source)`,
        record_id: record.id,
        span_id: l.span_id,
        source_title: l.source_title,
        locator_label: l.locator_label,
        recorded_date: l.excerpt_date,
        verbatim_quote: l.verbatim_quote,
        relationship_type: 'CONTRADICTS'
      }))
    ];
  }

  // Also check CONFLICTS_WITH edges in record_edges if conflictingPassages is still empty
  if (
    conflictingPassages.length === 0 &&
    (record.has_conflict === 1 ||
      effectiveEvidenceStatus === 'CONFLICTING' ||
      effectiveEvidenceStatus === 'CONTRADICTED')
  ) {
    const conflictEdge = db
      .prepare(`
        SELECT * FROM record_edges
        WHERE project_id = ? AND relationship_type = 'CONFLICTS_WITH'
          AND (from_record_id = ? OR to_record_id = ?)
        LIMIT 1
      `)
      .get(record.project_id, record.id, record.id);

    if (conflictEdge) {
      const otherRecordId =
        conflictEdge.from_record_id === record.id ? conflictEdge.to_record_id : conflictEdge.from_record_id;
      const otherRecord = db.prepare('SELECT * FROM extracted_records WHERE id = ?').get(otherRecordId);
      const otherLink = db
        .prepare(`
          SELECT el.*, sp.locator_label, s.title AS source_title
          FROM evidence_links el
          LEFT JOIN source_spans sp ON sp.id = el.span_id
          LEFT JOIN sources s ON s.id = sp.source_id
          WHERE el.record_id = ?
          LIMIT 1
        `)
        .get(otherRecordId);

      const ownFirst = visibleLinks[0];
      if (ownFirst && otherRecord) {
        conflictingPassages = [
          {
            passage_label: 'Passage A (Source 1)',
            record_id: record.id,
            span_id: ownFirst.span_id,
            source_title: ownFirst.source_title,
            locator_label: ownFirst.locator_label,
            recorded_date: record.recorded_date || ownFirst.excerpt_date,
            verbatim_quote: ownFirst.verbatim_quote,
            relationship_type: ownFirst.relationship_type
          },
          {
            passage_label: 'Passage B (Source 2)',
            record_id: otherRecord.id,
            span_id: otherLink ? otherLink.span_id : null,
            source_title: otherLink ? otherLink.source_title : 'Peer Source',
            locator_label: otherLink ? otherLink.locator_label : 'Peer Locator',
            recorded_date: otherRecord.recorded_date || null,
            verbatim_quote: otherLink ? otherLink.verbatim_quote : otherRecord.statement,
            relationship_type: 'CONTRADICTS'
          }
        ];
      }
    }
  }

  // Evaluate Stale Detection (STALE definition: outdated relative to a newer dated source or explicit validity rule)
  let isStale = record.is_stale ? 1 : 0;
  let staleReason = record.stale_reason || null;

  if (effectiveEvidenceStatus === 'STALE' && !isStale) {
    isStale = 1;
  }

  if (!staleReason && isStale) {
    staleReason =
      effectiveVerificationNotes ||
      'Evidence is outdated relative to a newer dated source or explicit validity window.';
  }

  const canonicalState = toCanonicalEvidenceState(effectiveEvidenceStatus);

  return {
    ...record,
    evidence_status: effectiveEvidenceStatus,
    canonical_evidence_state: canonicalState,
    evidence_state_definition:
      CANONICAL_EVIDENCE_STATE_DEFINITIONS[canonicalState] ||
      CANONICAL_EVIDENCE_STATE_DEFINITIONS['NOT ESTABLISHED'],
    epistemic_notice: EPISTEMIC_CITATION_NOTICE,
    verification_notes: effectiveVerificationNotes,
    direct_source_statement: record.direct_source_statement || record.statement,
    ai_summary_or_inference: record.ai_summary_or_inference ?? null,
    stated_owner: record.stated_owner ?? null,
    recorded_date: record.recorded_date ?? null,
    due_date: record.due_date ?? null,
    is_stale: isStale,
    stale_reason: staleReason,
    validity_window_days: record.validity_window_days ?? null,
    has_conflict:
      record.has_conflict ||
      effectiveEvidenceStatus === 'CONFLICTING' ||
      effectiveEvidenceStatus === 'CONTRADICTED' ||
      conflictingPassages.length >= 2
        ? 1
        : 0,
    conflict_resolution_policy:
      conflictingPassages.length >= 2 || effectiveEvidenceStatus === 'CONFLICTING'
        ? 'SHOW_BOTH_NO_AUTOMATIC_WINNER'
        : null,
    conflicting_passages: conflictingPassages,
    structured_fields: JSON.parse(record.structured_fields_json || '{}'),
    missing_fields: JSON.parse(record.missing_fields_json || '[]'),
    disclosure: {
      provider: record.extractor_provider || 'baton-deterministic-extractor',
      model: record.extractor_model || 'baton-struct-schema-v2',
      version: record.extractor_version || '2.5.0',
      extracted_at: record.extracted_at || record.created_at
    },
    created_by_name: creator ? creator.full_name : record.created_by_user_id,
    created_by_email: creator ? creator.email : '',
    verified_by_name: verifier ? verifier.full_name : null,
    valid_supporting_citations_count: validSupportingLinks.length,
    unresolved_or_flagged_citations_count: visibleLinks.filter((l) => l.citation_status !== 'RESOLVED').length,
    evidence_links: visibleLinks
  };
}

/**
 * Flags a citation on a record as incorrect or irrelevant (Rule 6),
 * marks it invalid for support, and downgrades the parent record if no valid support remains.
 */
function flagCitationLink(db, {
  projectId,
  recordId,
  linkId,
  flagReason,
  notes,
  actorUserId,
  actorRole
}) {
  const existingRecord = db
    .prepare('SELECT * FROM extracted_records WHERE id = ? AND project_id = ?')
    .get(recordId, projectId);
  if (!existingRecord) {
    throw Object.assign(new Error(`Record '${recordId}' not found in project.`), {
      statusCode: 404,
      errorCode: 'RESOURCE_NOT_FOUND'
    });
  }

  const existingLink = db
    .prepare('SELECT * FROM evidence_links WHERE id = ? AND record_id = ?')
    .get(linkId, recordId);
  if (!existingLink) {
    throw Object.assign(new Error(`Citation link '${linkId}' not found on record '${recordId}'.`), {
      statusCode: 404,
      errorCode: 'RESOURCE_NOT_FOUND'
    });
  }

  const normalizedReason = String(flagReason || 'INCORRECT_EXCERPT').trim().toUpperCase();
  const citationStatus =
    normalizedReason.includes('IRRELEVANT') ? 'FLAGGED_IRRELEVANT' : 'FLAGGED_INCORRECT';
  const cleanNotes = typeof notes === 'string' && notes.trim() ? notes.trim() : `Flagged as ${normalizedReason}`;
  const now = new Date().toISOString();

  return withTransaction(db, () => {
    db.prepare(`
      UPDATE evidence_links
      SET citation_status = ?,
          quote_verified = 0,
          flagged_by_user_id = ?,
          flagged_reason = ?,
          flagged_notes = ?,
          flagged_at = ?
      WHERE id = ?
    `).run(citationStatus, actorUserId, normalizedReason, cleanNotes, now, linkId);

    // Check remaining valid supporting links
    const remainingValid = db
      .prepare(`
        SELECT COUNT(*) AS c
        FROM evidence_links el
        JOIN source_spans sp ON sp.id = el.span_id
        WHERE el.record_id = ?
          AND el.citation_status = 'RESOLVED'
          AND el.quote_verified = 1
          AND el.relationship_type = 'SUPPORTS'
          AND sp.is_deleted = 0
          AND sp.is_corrupted = 0
          AND sp.project_id = ?
      `)
      .get(recordId, projectId).c;

    let newEvidenceStatus = existingRecord.evidence_status;
    let newNotes = existingRecord.verification_notes || '';

    if (remainingValid === 0 && existingRecord.evidence_status === 'SUPPORTED') {
      newEvidenceStatus = 'UNSUPPORTED';
      const flagMsg = `Citation '${linkId}' flagged as ${normalizedReason} (${cleanNotes}); no valid supporting citations remain.`;
      newNotes = newNotes ? `${newNotes} | ${flagMsg}` : flagMsg;
    } else if (remainingValid > 0) {
      const flagMsg = `Citation '${linkId}' flagged as ${normalizedReason} (${cleanNotes}).`;
      newNotes = newNotes ? `${newNotes} | ${flagMsg}` : flagMsg;
    }

    const nextVersion = existingRecord.current_version + 1;
    db.prepare(`
      UPDATE extracted_records
      SET evidence_status = ?, verification_notes = ?, current_version = ?, updated_at = ?
      WHERE id = ?
    `).run(newEvidenceStatus, newNotes, nextVersion, now, recordId);

    const updatedRec = inspectAndEnrichRecord(
      db,
      db.prepare('SELECT * FROM extracted_records WHERE id = ?').get(recordId),
      actorRole
    );

    db.prepare(`
      INSERT INTO record_versions (
        id, record_id, version_number, change_reason,
        changes_json, snapshot_json, changed_by_user_id, created_at
      ) VALUES (?, ?, ?, 'CITATION_FLAGGED', ?, ?, ?, ?)
    `).run(
      `ver_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      recordId,
      nextVersion,
      JSON.stringify({
        flagged_link_id: linkId,
        citation_status: citationStatus,
        flagged_reason: normalizedReason,
        previous_evidence_status: existingRecord.evidence_status,
        new_evidence_status: updatedRec.evidence_status
      }),
      JSON.stringify(updatedRec),
      actorUserId,
      now
    );

    logAuditEvent(db, {
      projectId,
      actorUserId,
      actorRole,
      eventType: 'CITATION_FLAGGED',
      targetEntityType: 'EVIDENCE_LINK',
      targetEntityId: linkId,
      metadata: {
        record_id: recordId,
        citation_status: citationStatus,
        flagged_reason: normalizedReason,
        new_evidence_status: updatedRec.evidence_status
      }
    });

    const flaggedCitation = updatedRec.evidence_links.find((l) => l.id === linkId);
    return { record: updatedRec, flagged_citation: flaggedCitation };
  });
}

module.exports = {
  CANONICAL_EVIDENCE_STATE_DEFINITIONS,
  EPISTEMIC_CITATION_NOTICE,
  normalizeEvidenceStateInput,
  toCanonicalEvidenceState,
  extractIsoDateFromText,
  inspectAndEnrichRecord,
  flagCitationLink
};
