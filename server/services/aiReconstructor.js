'use strict';

const crypto = require('node:crypto');
const { withTransaction } = require('../db/database');
const { getPermittedSpansForReconstruction } = require('./preAiFilter');
const { logAuditEvent } = require('./auditService');

const VALID_RECORD_TYPES = new Set([
  'OBJECTIVE',
  'DECISION',
  'EXPERIMENT',
  'RESULT',
  'TASK',
  'RISK',
  'DEPENDENCY',
  'QUESTION',
  'CONTACT',
  'GAP',
  'RECURRING_PROBLEM',
  'CLAIM',
  'METHOD',
  'PROTOCOL',
  'DATASET_FINDING',
  'OPEN_QUESTION',
  'RISK_LIMITATION'
]);

const VALID_EVIDENCE_STATUSES = new Set([
  'SUPPORTED',
  'CONFLICTING',
  'UNSUPPORTED',
  'STALE',
  'NEEDS REVIEW',
  'NEEDS_REVIEW',
  'NOT ESTABLISHED',
  'NOT_ESTABLISHED',
  'UNVERIFIED',
  'WEAK',
  'PARTIAL',
  'CONTRADICTED',
  'BROKEN_PROVENANCE'
]);

const VALID_APPROVAL_STATUSES = new Set([
  'DRAFT',
  'PENDING_REVIEW',
  'APPROVED',
  'NEEDS_REVISION',
  'REJECTED'
]);

const DISCLOSURE_DEFAULTS = {
  provider: 'baton-deterministic-extractor',
  model: 'baton-struct-schema-v2',
  version: '2.5.0'
};

/**
 * Strips embedded prompt-injection lines so instructions inside untrusted source text
 * never fabricate owners, dates, or approval states.
 */
function stripEmbeddedPromptInstructions(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const cleanedLines = lines.filter((line) => {
    if (/ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i.test(line)) return false;
    if (/disregard\s+(all\s+)?(previous|prior|above)\s+instructions/i.test(line)) return false;
    if (/system\s+prompt\s*:/i.test(line)) return false;
    if (/you\s+are\s+now\s+(a|an)\s+/i.test(line)) return false;
    if (/(?:call|invoke|trigger|execute)\s+tool\s*[:(]/i.test(line)) return false;
    if (/override\s+system\s+instructions/i.test(line)) return false;
    if (/set\s+approval_status\s*=\s*['"]?APPROVED/i.test(line)) return false;
    return true;
  });
  return cleanedLines.join('\n').trim() || '[SANDBOXED_UNTRUSTED_LITERAL_TEXT]';
}

/**
 * Extracts explicit owner, dates, rationale, and type-specific structured fields
 * WITHOUT guessing. Any field not explicitly stated in the text remains null.
 */
function extractExplicitFieldsFromText(cleanedText) {
  // 1. Explicit owner detection (never guess if absent)
  let statedOwner = null;
  const ownerPatterns = [
    /(?:decision\s+owner|owner|assigned\s+to|lead|prepared\s+by|calibrated_by|contact)\s*[:=]\s*([A-Z][a-zA-Z.\s-]{2,40}?)(?=[,;.\n|]|$)/i,
    /contact\s+(?:facility\s+technician\s+|engineer\s+|researcher\s+)?([A-Z][a-z]+\s+[A-Z][a-z]+)/
  ];
  for (const rx of ownerPatterns) {
    const m = cleanedText.match(rx);
    if (m && m[1]) {
      const candidate = m[1].trim();
      if (candidate && !/^(unknown|none|null|tbd|n\/a)$/i.test(candidate)) {
        statedOwner = candidate;
        break;
      }
    }
  }

  // 2. Explicit recorded date detection
  let recordedDate = null;
  const datePatterns = [
    /(?:date|recorded_date|on)\s*[:=]?\s*(\d{4}-\d{2}-\d{2})/i,
    /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,?\s+\d{4})?)\b/i,
    /\b(20\d{2}-\d{2}-\d{2})\b/
  ];
  for (const rx of datePatterns) {
    const m = cleanedText.match(rx);
    if (m && m[1]) {
      recordedDate = m[1].trim();
      break;
    }
  }

  // 3. Explicit due date detection
  let dueDate = null;
  const duePatterns = [
    /(?:due\s+date|due|calibration_due|deadline)\s*[:=]\s*([0-9A-Za-z\s-]{4,20}?)(?=[,;.\n|]|$)/i
  ];
  for (const rx of duePatterns) {
    const m = cleanedText.match(rx);
    if (m && m[1]) {
      dueDate = m[1].trim();
      break;
    }
  }

  // 4. Explicit rationale detection (null if not stated)
  let explicitRationale = null;
  const ratPatterns = [
    /rationale\s*[:=]\s*([^.\n]+(?:\.[^.\n]+)?)/i,
    /\b(after\s+observing\s+[^.\n]+)/i,
    /\b(to\s+prevent\s+[^.\n]+)/i,
    /\b(because\s+[^.\n]+)/i
  ];
  for (const rx of ratPatterns) {
    const m = cleanedText.match(rx);
    if (m && m[1]) {
      explicitRationale = m[1].trim();
      break;
    }
  }

  // 5. Units / measurement context
  let unitsContext = null;
  const unitsMatches = cleanedText.match(/\b(\d+(?:\.\d+)?\s*(?:mS\/cm|mA\/cm2|MPa|ppm|°C|C|hours|h|%))\b/g);
  if (unitsMatches && unitsMatches.length > 0) {
    unitsContext = Array.from(new Set(unitsMatches)).join(', ');
  }

  return {
    statedOwner,
    recordedDate,
    dueDate,
    explicitRationale,
    unitsContext
  };
}

function classifySpanToRecordProposal(span) {
  const rawText = span.content_text;
  const cleanedText = stripEmbeddedPromptInstructions(rawText);
  const lower = cleanedText.toLowerCase();
  const extracted = extractExplicitFieldsFromText(cleanedText);

  let recordType = 'RESULT';
  let title = `${span.source_title} — ${span.locator_label}`;
  let structuredFields = {};
  const missingFields = [];

  if (lower.includes('objective:') || lower.includes('research question:') || lower.startsWith('objective')) {
    recordType = 'OBJECTIVE';
    title = `Research Objective (${span.locator_label})`;
    structuredFields = {
      objective_or_question: cleanedText,
      target_metrics: extracted.unitsContext
    };
  } else if (lower.includes('decision:') || lower.includes('switched') || lower.includes('decided')) {
    recordType = 'DECISION';
    title = `Project Decision (${span.locator_label})`;
    structuredFields = {
      decision: cleanedText,
      rationale: extracted.explicitRationale,
      date: extracted.recordedDate,
      decision_owner: extracted.statedOwner
    };
    if (!extracted.statedOwner) missingFields.push('stated_owner');
    if (!extracted.recordedDate) missingFields.push('recorded_date');
    if (!extracted.explicitRationale) missingFields.push('rationale');
  } else if (lower.includes('experiment:') || lower.includes('sintered at') || lower.includes('protocol')) {
    recordType = 'EXPERIMENT';
    title = `Experiment / Method (${span.locator_label})`;
    const tempMatch = cleanedText.match(/\b(\d{3,4}\s*°?C)\b/i);
    const durMatch = cleanedText.match(/\b(\d+\s*(?:hours|h))\b/i);
    structuredFields = {
      method: cleanedText,
      variables: tempMatch ? `Temperature (${tempMatch[1]})` : null,
      conditions: durMatch ? `Duration (${durMatch[1]})` : extracted.unitsContext,
      status: lower.includes('unverified') || lower.includes('pending') ? 'IN_PROGRESS' : 'COMPLETED'
    };
    if (!extracted.statedOwner) missingFields.push('stated_owner');
  } else if (lower.includes('task:') || lower.includes('next action:') || span.locator_type === 'CSV_ROW' && lower.includes('task_id=')) {
    recordType = 'TASK';
    title = `Task / Next Action (${span.locator_label})`;
    structuredFields = {
      task_next_action: cleanedText,
      owner: extracted.statedOwner,
      due_date: extracted.dueDate,
      status: lower.includes('completed') ? 'COMPLETED' : 'OPEN'
    };
    if (!extracted.statedOwner) missingFields.push('stated_owner');
    if (!extracted.dueDate) missingFields.push('due_date');
  } else if (lower.includes('risk:') || lower.includes('blocker:') || lower.includes('drifted') || lower.includes('passivation')) {
    recordType = 'RISK';
    title = `Risk / Blocker (${span.locator_label})`;
    structuredFields = {
      risk_or_blocker: cleanedText,
      mitigation: extracted.explicitRationale,
      owner: extracted.statedOwner
    };
  } else if (lower.includes('dependency:') || lower.includes('calibration_due') || lower.includes('equip_id')) {
    recordType = 'DEPENDENCY';
    title = `Dependency (${span.locator_label})`;
    structuredFields = {
      dependency: cleanedText,
      due_date: extracted.dueDate,
      contact: extracted.statedOwner
    };
  } else if (lower.includes('unresolved question:') || lower.includes('question:') || cleanedText.trim().endsWith('?')) {
    recordType = 'QUESTION';
    title = `Unresolved Question (${span.locator_label})`;
    structuredFields = {
      unresolved_question: cleanedText,
      owner: extracted.statedOwner
    };
  } else if (lower.includes('contact:') || lower.includes('@') && lower.includes('technician')) {
    recordType = 'CONTACT';
    title = `Contact / Responsibility (${span.locator_label})`;
    const emailMatch = cleanedText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    structuredFields = {
      contact_person: extracted.statedOwner,
      email: emailMatch ? emailMatch[0] : null,
      responsibility: cleanedText
    };
  } else if (lower.includes('gap:') || lower.includes('remains unverified') || lower.includes('missing')) {
    recordType = 'GAP';
    title = `Continuity Gap (${span.locator_label})`;
    structuredFields = {
      gap_description: cleanedText,
      owner: extracted.statedOwner
    };
    if (!extracted.statedOwner) missingFields.push('stated_owner');
  } else {
    recordType = 'RESULT';
    title = `Experimental Result / Observation (${span.locator_label})`;
    structuredFields = {
      observation: cleanedText,
      units_context: extracted.unitsContext,
      date: extracted.recordedDate
    };
    if (!extracted.recordedDate) missingFields.push('recorded_date');
  }

  const verbatimQuote = rawText.slice(0, Math.min(rawText.length, 200));

  return {
    record_type: recordType,
    title,
    direct_source_statement: cleanedText,
    ai_summary_or_inference: `Structured ${recordType} extracted from ${span.source_title} (${span.locator_label}).`,
    rationale: extracted.explicitRationale,
    stated_owner: extracted.statedOwner,
    recorded_date: extracted.recordedDate,
    due_date: extracted.dueDate,
    structured_fields: structuredFields,
    missing_fields: missingFields,
    evidence_links: [
      {
        span_id: span.id,
        source_id: span.source_id,
        locator: span.locator_label,
        relationship_type: 'SUPPORTS',
        verbatim_quote: verbatimQuote
      }
    ]
  };
}

/**
 * Detects recurring problems ONLY when repeated evidence (>= 2 distinct spans) supports the pattern.
 */
function detectRecurringProblemProposals(permittedSpans) {
  const issueBuckets = [
    {
      key: 'voiding_or_pressure',
      title: 'Recurring Problem: Interfacial Voiding & Stack Pressure Instability',
      regex: /\b(voiding|stack\s+pressure|5\s*MPa|interfacial)\b/i
    },
    {
      key: 'moisture_or_drift',
      title: 'Recurring Problem: Glovebox Moisture / Analyzer Drift Excursion',
      regex: /\b(moisture|H2O|drift|ppm|passivation)\b/i
    }
  ];

  const proposals = [];
  for (const bucket of issueBuckets) {
    const matchingSpans = permittedSpans.filter((sp) => bucket.regex.test(sp.content_text));
    if (matchingSpans.length >= 2) {
      const directStatements = matchingSpans
        .map((sp) => `[${sp.locator_label}] ${stripEmbeddedPromptInstructions(sp.content_text)}`)
        .join(' | ');
      proposals.push({
        record_type: 'RECURRING_PROBLEM',
        title: bucket.title,
        direct_source_statement: directStatements,
        ai_summary_or_inference: `Recurring problem corroborated across ${matchingSpans.length} distinct source spans.`,
        rationale: null,
        stated_owner: null,
        recorded_date: null,
        due_date: null,
        structured_fields: {
          problem_pattern: bucket.title,
          supporting_span_count: matchingSpans.length
        },
        missing_fields: ['stated_owner'],
        evidence_links: matchingSpans.map((sp) => ({
          span_id: sp.id,
          source_id: sp.source_id,
          locator: sp.locator_label,
          relationship_type: 'SUPPORTS',
          verbatim_quote: sp.content_text.slice(0, Math.min(sp.content_text.length, 160))
        }))
      });
    }
  }
  return proposals;
}

/**
 * Validates structured model output against BATON's Stage 05 schema.
 * Rejects malformed output, cross-project/unknown span IDs, unmatched quotes,
 * or RECURRING_PROBLEM proposals with < 2 evidence spans.
 */
function validateCandidateProposalSchema(prop, permittedSpanMap, projectId, db) {
  if (!prop || typeof prop !== 'object' || Array.isArray(prop)) {
    throw Object.assign(new Error('Malformed model output: candidate record must be a JSON object.'), {
      statusCode: 422,
      errorCode: 'INVALID_MODEL_OUTPUT_SCHEMA'
    });
  }

  if (typeof prop.record_type !== 'string' || !VALID_RECORD_TYPES.has(prop.record_type)) {
    throw Object.assign(
      new Error(`Invalid or missing record_type '${prop.record_type}' in structured extraction output.`),
      { statusCode: 422, errorCode: 'INVALID_MODEL_OUTPUT_SCHEMA' }
    );
  }

  if (typeof prop.title !== 'string' || !prop.title.trim()) {
    throw Object.assign(new Error('Structured extraction output is missing a non-empty title.'), {
      statusCode: 422,
      errorCode: 'INVALID_MODEL_OUTPUT_SCHEMA'
    });
  }

  const directStmt =
    typeof prop.direct_source_statement === 'string' && prop.direct_source_statement.trim()
      ? prop.direct_source_statement.trim()
      : typeof prop.statement === 'string' && prop.statement.trim()
        ? prop.statement.trim()
        : '';

  if (!directStmt) {
    throw Object.assign(
      new Error(`Record '${prop.title}' is missing required direct_source_statement.`),
      { statusCode: 422, errorCode: 'INVALID_MODEL_OUTPUT_SCHEMA' }
    );
  }

  if (!Array.isArray(prop.evidence_links) || prop.evidence_links.length === 0) {
    throw Object.assign(
      new Error(`Record '${prop.title}' has zero evidence_links. Every extracted record must link to stored source evidence.`),
      { statusCode: 422, errorCode: 'INVALID_MODEL_OUTPUT_SCHEMA' }
    );
  }

  const uniqueSpanIds = new Set(prop.evidence_links.map((l) => l && l.span_id).filter(Boolean));
  if (prop.record_type === 'RECURRING_PROBLEM' && uniqueSpanIds.size < 2) {
    throw Object.assign(
      new Error(
        `Record '${prop.title}' has record_type='RECURRING_PROBLEM' but only ${uniqueSpanIds.size} evidence span(s). Recurring problems require >= 2 repeated evidence spans.`
      ),
      { statusCode: 422, errorCode: 'INSUFFICIENT_RECURRING_EVIDENCE' }
    );
  }

  const validatedLinks = [];
  for (const link of prop.evidence_links) {
    if (!link || typeof link.span_id !== 'string' || !link.span_id.trim()) {
      throw Object.assign(new Error('Evidence link is missing span_id.'), {
        statusCode: 422,
        errorCode: 'INVALID_MODEL_OUTPUT_SCHEMA'
      });
    }

    let span = permittedSpanMap.get(link.span_id);
    if (!span) {
      // Check if span belongs to another project or is restricted
      const dbSpan = db.prepare('SELECT id, project_id FROM source_spans WHERE id = ?').get(link.span_id);
      if (dbSpan && dbSpan.project_id !== projectId) {
        logAuditEvent(db, {
          projectId,
          actorUserId: null,
          actorRole: null,
          eventType: 'ACCESS_DENIED',
          targetEntityType: 'SOURCE_SPAN',
          targetEntityId: link.span_id,
          metadata: { reason: 'CROSS_PROJECT_EVIDENCE_VIOLATION', span_project_id: dbSpan.project_id }
        });
        throw Object.assign(
          new Error(`Cross-project evidence violation: span_id '${link.span_id}' belongs to project '${dbSpan.project_id}', not '${projectId}'.`),
          { statusCode: 422, errorCode: 'CROSS_PROJECT_EVIDENCE_VIOLATION' }
        );
      }
      throw Object.assign(
        new Error(`Evidence validation failed: span_id '${link.span_id}' does not exist in permitted project sources.`),
        { statusCode: 422, errorCode: 'PROVENANCE_VALIDATION_FAILED' }
      );
    }

    const quote = typeof link.verbatim_quote === 'string' ? link.verbatim_quote.trim() : '';
    if (!quote || !span.content_text.includes(quote)) {
      throw Object.assign(
        new Error(
          `Unsupported statement rejected: verbatim_quote "${quote.slice(0, 60)}" was not found in span '${span.id}' (${span.locator_label}).`
        ),
        { statusCode: 422, errorCode: 'UNSUPPORTED_STATEMENT_REJECTED' }
      );
    }

    validatedLinks.push({
      id: `evl_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      span_id: span.id,
      source_id: span.source_id,
      locator_label: span.locator_label,
      locator_type: span.locator_type,
      relationship_type: link.relationship_type || 'SUPPORTS',
      verbatim_quote: quote,
      quote_verified: 1
    });
  }

  return {
    record_type: prop.record_type,
    title: prop.title.trim(),
    direct_source_statement: directStmt,
    ai_summary_or_inference:
      typeof prop.ai_summary_or_inference === 'string' && prop.ai_summary_or_inference.trim()
        ? prop.ai_summary_or_inference.trim()
        : null,
    rationale:
      typeof prop.rationale === 'string' && prop.rationale.trim() ? prop.rationale.trim() : null,
    stated_owner:
      typeof prop.stated_owner === 'string' && prop.stated_owner.trim() ? prop.stated_owner.trim() : null,
    recorded_date:
      typeof prop.recorded_date === 'string' && prop.recorded_date.trim() ? prop.recorded_date.trim() : null,
    due_date:
      typeof prop.due_date === 'string' && prop.due_date.trim() ? prop.due_date.trim() : null,
    structured_fields:
      prop.structured_fields && typeof prop.structured_fields === 'object' ? prop.structured_fields : {},
    missing_fields: Array.isArray(prop.missing_fields) ? prop.missing_fields : [],
    validatedLinks
  };
}

/**
 * Rebuilds evidence-supported Continuity Map edges (record_edges) and detects
 * contradictory dates or conflicting values across project records.
 */
function rebuildProjectContinuityEdges(db, projectId) {
  db.prepare('DELETE FROM record_edges WHERE project_id = ?').run(projectId);

  const records = db
    .prepare('SELECT * FROM extracted_records WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId);

  const linksByRecord = new Map();
  for (const r of records) {
    const links = db
      .prepare(`
        SELECT el.*, sp.source_id, sp.locator_label, sp.record_key
        FROM evidence_links el
        JOIN source_spans sp ON sp.id = el.span_id
        WHERE el.record_id = ?
      `)
      .all(r.id);
    linksByRecord.set(r.id, links);
  }

  const now = new Date().toISOString();
  const insertEdge = db.prepare(`
    INSERT INTO record_edges (
      id, project_id, from_record_id, to_record_id,
      relationship_type, evidence_rationale, supporting_span_ids_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const edges = [];
  const sampleRegex = /\b(SSE-\d+|Batch\s+[A-Z0-9]+|CELL-\d+|TSK-\d+|EQ-[A-Z0-9-]+|Valve\s+Replacement|Analyzer\s+Drift)\b/gi;

  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const rA = records[i];
      const rB = records[j];
      const linksA = linksByRecord.get(rA.id) || [];
      const linksB = linksByRecord.get(rB.id) || [];
      if (linksA.length === 0 || linksB.length === 0) continue;

      const spanIdsA = linksA.map((l) => l.span_id);
      const spanIdsB = linksB.map((l) => l.span_id);
      const combinedSpans = Array.from(new Set([...spanIdsA, ...spanIdsB]));

      const textA = `${rA.title} ${rA.direct_source_statement || rA.statement}`;
      const textB = `${rB.title} ${rB.direct_source_statement || rB.statement}`;
      const tokensA = new Set((textA.match(sampleRegex) || []).map((t) => t.toUpperCase()));
      const tokensB = new Set((textB.match(sampleRegex) || []).map((t) => t.toUpperCase()));
      const sharedEntities = Array.from(tokensA).filter((t) => tokensB.has(t));

      const sharedSpans = spanIdsA.filter((id) => spanIdsB.includes(id));
      const sameSource = linksA.some((la) => linksB.some((lb) => la.source_id === lb.source_id));

      // 1a. Check if one dated source explicitly supersedes/recalibrates an older dated record (STALE)
      const isSupersession =
        rA.recorded_date &&
        rB.recorded_date &&
        rA.recorded_date !== rB.recorded_date &&
        sharedEntities.length > 0 &&
        /\b(?:supersede\w*|recalibrat\w*|outdated|replaced\s+by|newer\s+calibration|updated\s+calibration)/i.test(`${textA} ${textB}`);

      if (isSupersession) {
        const olderRec = rA.recorded_date < rB.recorded_date ? rA : rB;
        const newerRec = rA.recorded_date < rB.recorded_date ? rB : rA;
        const staleMsg = `Evidence dated ${olderRec.recorded_date} on ${sharedEntities.join(', ')} is outdated relative to newer dated source (${newerRec.recorded_date}: "${newerRec.title}").`;
        db.prepare(`
          UPDATE extracted_records
          SET is_stale = 1, stale_reason = ?, evidence_status = 'STALE'
          WHERE id = ?
        `).run(staleMsg, olderRec.id);
      }

      // 1b. Check for contradictory dates or values on the same shared entity or topic
      const hasDateConflict =
        !isSupersession &&
        rA.recorded_date &&
        rB.recorded_date &&
        rA.recorded_date !== rB.recorded_date &&
        (sharedEntities.length > 0 || (rA.record_type === rB.record_type && sameSource));

      const hasExplicitContradictionLink =
        linksA.some((l) => l.relationship_type === 'CONTRADICTS') ||
        linksB.some((l) => l.relationship_type === 'CONTRADICTS');

      if (hasDateConflict || (hasExplicitContradictionLink && sharedEntities.length > 0)) {
        const conflictMsg = hasDateConflict
          ? `Contradictory recorded_date values (${rA.recorded_date} vs ${rB.recorded_date}) on shared subject (${sharedEntities.join(', ') || 'same source'}).`
          : `Conflicting evidence statements on shared subject (${sharedEntities.join(', ')}).`;

        const passagesPair = JSON.stringify([
          {
            passage_label: 'Passage A (Source 1)',
            record_id: rA.id,
            span_id: spanIdsA[0] || null,
            recorded_date: rA.recorded_date || null,
            verbatim_quote: rA.direct_source_statement || rA.statement
          },
          {
            passage_label: 'Passage B (Source 2)',
            record_id: rB.id,
            span_id: spanIdsB[0] || null,
            recorded_date: rB.recorded_date || null,
            verbatim_quote: rB.direct_source_statement || rB.statement
          }
        ]);

        db.prepare(`
          UPDATE extracted_records
          SET has_conflict = 1, conflict_summary = ?, conflicting_passages_json = ?, evidence_status = 'CONTRADICTED'
          WHERE id IN (?, ?)
        `).run(conflictMsg, passagesPair, rA.id, rB.id);

        const edgeId = `edg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        insertEdge.run(
          edgeId,
          projectId,
          rA.id,
          rB.id,
          'CONFLICTS_WITH',
          conflictMsg,
          JSON.stringify(combinedSpans),
          now
        );
        edges.push({
          id: edgeId,
          from_record_id: rA.id,
          to_record_id: rB.id,
          relationship_type: 'CONFLICTS_WITH',
          evidence_rationale: conflictMsg,
          supporting_span_ids: combinedSpans
        });
        continue;
      }

      // 2. Evidence corroboration across shared entities or shared spans
      if (sharedEntities.length > 0 || sharedSpans.length > 0) {
        const rationale =
          sharedEntities.length > 0
            ? `Linked by shared evidence reference to ${sharedEntities.join(', ')}.`
            : `Linked by shared source provenance span (${sharedSpans.join(', ')}).`;
        const edgeId = `edg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        insertEdge.run(
          edgeId,
          projectId,
          rA.id,
          rB.id,
          'EVIDENCE_CORROBORATES',
          rationale,
          JSON.stringify(combinedSpans),
          now
        );
        edges.push({
          id: edgeId,
          from_record_id: rA.id,
          to_record_id: rB.id,
          relationship_type: 'EVIDENCE_CORROBORATES',
          evidence_rationale: rationale,
          supporting_span_ids: combinedSpans
        });
      } else if (
        sameSource &&
        ((['OBJECTIVE'].includes(rA.record_type) && ['DECISION', 'EXPERIMENT', 'RESULT', 'GAP'].includes(rB.record_type)) ||
          (['OBJECTIVE'].includes(rB.record_type) && ['DECISION', 'EXPERIMENT', 'RESULT', 'GAP'].includes(rA.record_type)) ||
          (['RISK', 'GAP', 'QUESTION'].includes(rA.record_type) &&
            ['EXPERIMENT', 'RESULT', 'TASK', 'CONTACT', 'DEPENDENCY'].includes(rB.record_type)) ||
          (['RISK', 'GAP', 'QUESTION'].includes(rB.record_type) &&
            ['EXPERIMENT', 'RESULT', 'TASK', 'CONTACT', 'DEPENDENCY'].includes(rA.record_type)))
      ) {
        const relType =
          ['RISK', 'GAP'].includes(rA.record_type) || ['RISK', 'GAP'].includes(rB.record_type)
            ? 'ADDRESSES_GAP'
            : 'DERIVED_FROM_SAME_SOURCE';
        const rationale = `Evidence spans belong to the same source document linking ${rA.record_type} to ${rB.record_type}.`;
        const edgeId = `edg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        insertEdge.run(
          edgeId,
          projectId,
          rA.id,
          rB.id,
          relType,
          rationale,
          JSON.stringify(combinedSpans),
          now
        );
        edges.push({
          id: edgeId,
          from_record_id: rA.id,
          to_record_id: rB.id,
          relationship_type: relType,
          evidence_rationale: rationale,
          supporting_span_ids: combinedSpans
        });
      }
    }
  }

  return edges;
}

function runReconstruction(db, {
  projectId,
  sourceIds = null,
  extractionFocus = '',
  candidateProposals = null,
  simulateModelTimeout = false,
  simulateExtractorFailure = false,
  actorUserId,
  actorRole
}) {
  if (simulateModelTimeout) {
    logAuditEvent(db, {
      projectId,
      actorUserId,
      actorRole,
      eventType: 'RECONSTRUCTION_FAILED',
      targetEntityType: 'PROJECT',
      targetEntityId: projectId,
      metadata: { reason: 'MODEL_EXTRACTION_TIMEOUT', retryable: true }
    });
    throw Object.assign(
      new Error('Model extraction timed out before completing. Zero partial records were written; safe to retry.'),
      { statusCode: 504, errorCode: 'MODEL_EXTRACTION_TIMEOUT' }
    );
  }

  if (simulateExtractorFailure) {
    logAuditEvent(db, {
      projectId,
      actorUserId,
      actorRole,
      eventType: 'RECONSTRUCTION_FAILED',
      targetEntityType: 'PROJECT',
      targetEntityId: projectId,
      metadata: { reason: 'UPSTREAM_EXTRACTOR_FAILURE', retryable: true }
    });
    throw Object.assign(
      new Error('Upstream extraction service returned an error. Zero partial records were written; safe to retry.'),
      { statusCode: 502, errorCode: 'UPSTREAM_EXTRACTOR_FAILURE' }
    );
  }

  const filterResult = getPermittedSpansForReconstruction(db, {
    projectId,
    requestedSourceIds: sourceIds,
    actorUserId,
    actorRole
  });

  if (filterResult.permittedSpans.length === 0) {
    throw Object.assign(
      new Error('No permitted, non-restricted source spans available for reconstruction.'),
      { statusCode: 422, errorCode: 'NO_PERMITTED_SPANS' }
    );
  }

  const permittedSpanMap = new Map(filterResult.permittedSpans.map((sp) => [sp.id, sp]));

  // Either validate caller-supplied candidateProposals (for schema/adversarial testing)
  // or generate proposals deterministically from permitted spans
  let rawProposals;
  if (candidateProposals !== null && candidateProposals !== undefined) {
    if (!Array.isArray(candidateProposals) || candidateProposals.length === 0) {
      throw Object.assign(
        new Error('Malformed model output: candidate_proposals must be a non-empty array.'),
        { statusCode: 422, errorCode: 'INVALID_MODEL_OUTPUT_SCHEMA' }
      );
    }
    rawProposals = candidateProposals;
  } else {
    const spanProposals = filterResult.permittedSpans.slice(0, 20).map((sp) => classifySpanToRecordProposal(sp));
    const recurringProposals = detectRecurringProblemProposals(filterResult.permittedSpans);
    rawProposals = [...spanProposals, ...recurringProposals];
  }

  const processedAt = new Date().toISOString();
  const disclosureMetadata = {
    provider: DISCLOSURE_DEFAULTS.provider,
    model: DISCLOSURE_DEFAULTS.model,
    version: DISCLOSURE_DEFAULTS.version,
    processed_at: processedAt
  };

  const result = withTransaction(db, () => {
    const out = [];

    for (const rawProp of rawProposals) {
      const vProp = validateCandidateProposalSchema(rawProp, permittedSpanMap, projectId, db);
      const isIncomplete = vProp.missing_fields.length > 0 ? 1 : 0;
      const initialEvidenceStatus = vProp.validatedLinks.length >= 2 ? 'SUPPORTED' : 'PARTIAL';

      const recordId = `rec_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      db.prepare(`
        INSERT INTO extracted_records (
          id, project_id, record_type, title, statement,
          direct_source_statement, ai_summary_or_inference,
          rationale, stated_owner, recorded_date, due_date,
          structured_fields_json, is_incomplete, missing_fields_json,
          origin_mode, evidence_status, verification_notes,
          approval_status, current_version,
          extractor_provider, extractor_model, extractor_version, extracted_at,
          created_by_user_id, updated_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AI_PROPOSED', ?, ?, 'DRAFT', 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        projectId,
        vProp.record_type,
        vProp.title,
        vProp.direct_source_statement,
        vProp.direct_source_statement,
        vProp.ai_summary_or_inference,
        vProp.rationale || '',
        vProp.stated_owner,
        vProp.recorded_date,
        vProp.due_date,
        JSON.stringify(vProp.structured_fields),
        isIncomplete,
        JSON.stringify(vProp.missing_fields),
        initialEvidenceStatus,
        'Validated against structured schema and source provenance spans.',
        disclosureMetadata.provider,
        disclosureMetadata.model,
        disclosureMetadata.version,
        processedAt,
        actorUserId,
        processedAt,
        processedAt
      );

      for (const vl of vProp.validatedLinks) {
        db.prepare(`
          INSERT INTO evidence_links (
            id, record_id, span_id, original_span_id, relationship_type,
            verbatim_quote, quote_verified, created_by_user_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          vl.id,
          recordId,
          vl.span_id,
          vl.span_id,
          vl.relationship_type,
          vl.verbatim_quote,
          vl.quote_verified,
          actorUserId,
          processedAt
        );
      }

      const snapshot = {
        id: recordId,
        project_id: projectId,
        record_type: vProp.record_type,
        title: vProp.title,
        direct_source_statement: vProp.direct_source_statement,
        ai_summary_or_inference: vProp.ai_summary_or_inference,
        stated_owner: vProp.stated_owner,
        recorded_date: vProp.recorded_date,
        due_date: vProp.due_date,
        structured_fields: vProp.structured_fields,
        evidence_status: initialEvidenceStatus,
        approval_status: 'DRAFT',
        span_ids: vProp.validatedLinks.map((l) => l.span_id),
        disclosure: disclosureMetadata
      };

      db.prepare(`
        INSERT INTO record_versions (
          id, record_id, version_number, change_reason,
          changes_json, snapshot_json, changed_by_user_id, created_at
        ) VALUES (?, ?, 1, 'INITIAL_EXTRACTION', ?, ?, ?, ?)
      `).run(
        `ver_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
        recordId,
        JSON.stringify({ created: true, origin_mode: 'AI_PROPOSED', disclosure: disclosureMetadata }),
        JSON.stringify(snapshot),
        actorUserId,
        processedAt
      );

      out.push(recordId);
    }

    const edges = rebuildProjectContinuityEdges(db, projectId);

    const hydratedRecords = out.map((id) => {
      const rec = db.prepare('SELECT * FROM extracted_records WHERE id = ?').get(id);
      const links = db
        .prepare(`
          SELECT el.*, sp.source_id, sp.locator_type, sp.locator_label
          FROM evidence_links el
          JOIN source_spans sp ON sp.id = el.span_id
          WHERE el.record_id = ?
        `)
        .all(id);
      return {
        ...rec,
        structured_fields: JSON.parse(rec.structured_fields_json || '{}'),
        missing_fields: JSON.parse(rec.missing_fields_json || '[]'),
        evidence_links: links
      };
    });

    logAuditEvent(db, {
      projectId,
      actorUserId,
      actorRole,
      eventType: 'RECONSTRUCTION_COMPLETED',
      targetEntityType: 'PROJECT',
      targetEntityId: projectId,
      metadata: {
        created_record_count: hydratedRecords.length,
        edges_count: edges.length,
        restricted_filtered_count: filterResult.excludedSources.length,
        disclosure: disclosureMetadata
      }
    });

    return { hydratedRecords, edges };
  });

  return {
    disclosure_metadata: disclosureMetadata,
    filter_summary: {
      requested_sources_count: filterResult.requestedSourcesCount,
      permitted_sources_count: filterResult.permittedSources.length,
      restricted_or_excluded_sources_filtered: filterResult.excludedSources.length,
      permitted_spans_sent_to_ai: filterResult.permittedSpans.length
    },
    created_records: result.hydratedRecords,
    continuity_edges: result.edges
  };
}

module.exports = {
  VALID_RECORD_TYPES,
  VALID_EVIDENCE_STATUSES,
  VALID_APPROVAL_STATUSES,
  stripEmbeddedPromptInstructions,
  rebuildProjectContinuityEdges,
  runReconstruction
};
