'use strict';

const crypto = require('node:crypto');

function logAuditEvent(db, {
  projectId = null,
  actorUserId = null,
  actorRole = null,
  eventType,
  targetEntityType,
  targetEntityId = null,
  metadata = {}
}) {
  const id = `aud_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const createdAt = new Date().toISOString();
  const metadataJson = JSON.stringify(metadata || {});

  db.prepare(`
    INSERT INTO audit_events (
      id, project_id, actor_user_id, actor_role,
      event_type, target_entity_type, target_entity_id,
      metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    actorUserId,
    actorRole,
    eventType,
    targetEntityType,
    targetEntityId,
    metadataJson,
    createdAt
  );

  return {
    id,
    project_id: projectId,
    actor_user_id: actorUserId,
    actor_role: actorRole,
    event_type: eventType,
    target_entity_type: targetEntityType,
    target_entity_id: targetEntityId,
    metadata,
    created_at: createdAt
  };
}

module.exports = { logAuditEvent };
