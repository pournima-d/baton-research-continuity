'use strict';

const { logAuditEvent } = require('./auditService');

/**
 * Deterministically filters out RESTRICTED_PI_ONLY and exclude_from_ai=1 sources
 * BEFORE any spans are retrieved for AI prompting, summarisation, or handover generation.
 */
function getPermittedSpansForReconstruction(db, { projectId, requestedSourceIds = null, actorUserId, actorRole }) {
  const allProjectSources = db
    .prepare('SELECT id, title, source_type, visibility_level, exclude_from_ai, processing_status FROM sources WHERE project_id = ?')
    .all(projectId);

  const candidateSources = Array.isArray(requestedSourceIds) && requestedSourceIds.length > 0
    ? allProjectSources.filter((s) => requestedSourceIds.includes(s.id))
    : allProjectSources;

  const permittedSources = [];
  const excludedSources = [];

  for (const src of candidateSources) {
    if (src.visibility_level === 'RESTRICTED_PI_ONLY' || Number(src.exclude_from_ai) === 1 || src.processing_status !== 'READY') {
      excludedSources.push({
        id: src.id,
        reason:
          src.visibility_level === 'RESTRICTED_PI_ONLY'
            ? 'RESTRICTED_PI_ONLY'
            : Number(src.exclude_from_ai) === 1
              ? 'EXCLUDED_FROM_AI'
              : 'NOT_READY'
      });
    } else {
      permittedSources.push(src);
    }
  }

  let permittedSpans = [];
  if (permittedSources.length > 0) {
    const placeholders = permittedSources.map(() => '?').join(', ');
    permittedSpans = db
      .prepare(`
        SELECT sp.*, s.title AS source_title, s.source_type, s.visibility_level
        FROM source_spans sp
        JOIN sources s ON s.id = sp.source_id
        WHERE sp.project_id = ?
          AND s.visibility_level = 'PROJECT_SHARED'
          AND s.exclude_from_ai = 0
          AND s.processing_status = 'READY'
          AND sp.source_id IN (${placeholders})
        ORDER BY sp.source_id, sp.span_index ASC
      `)
      .all(projectId, ...permittedSources.map((s) => s.id));
  }

  logAuditEvent(db, {
    projectId,
    actorUserId,
    actorRole,
    eventType: 'AI_CONTEXT_FILTERED',
    targetEntityType: 'PROJECT',
    targetEntityId: projectId,
    metadata: {
      requested_sources_count: candidateSources.length,
      permitted_sources_count: permittedSources.length,
      restricted_or_excluded_sources_filtered: excludedSources.length,
      excluded_source_ids: excludedSources.map((e) => e.id),
      permitted_span_count: permittedSpans.length
    }
  });

  return {
    requestedSourcesCount: candidateSources.length,
    permittedSources,
    excludedSources,
    permittedSpans
  };
}

module.exports = { getPermittedSpansForReconstruction };
