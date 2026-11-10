-- ============================================================================
-- BATON Stage 06 Migration: Verify — Evidence Inspector and Gap States
-- Adds stale tracking, conflicting passages array, citation resolution & reviewer
-- flagging columns, and span corruption/deletion tracking.
-- ============================================================================

ALTER TABLE extracted_records ADD COLUMN is_stale INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0, 1));
ALTER TABLE extracted_records ADD COLUMN stale_reason TEXT NULL;
ALTER TABLE extracted_records ADD COLUMN validity_window_days INTEGER NULL;
ALTER TABLE extracted_records ADD COLUMN conflicting_passages_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE evidence_links ADD COLUMN original_span_id TEXT NULL;
ALTER TABLE evidence_links ADD COLUMN citation_status TEXT NOT NULL DEFAULT 'RESOLVED' CHECK (
    citation_status IN (
        'RESOLVED',
        'FLAGGED_INCORRECT',
        'FLAGGED_IRRELEVANT',
        'INVALID_UNRESOLVED',
        'CORRUPTED_SPAN',
        'INVALID_CROSS_PROJECT'
    )
);
ALTER TABLE evidence_links ADD COLUMN flagged_by_user_id TEXT NULL REFERENCES users(id);
ALTER TABLE evidence_links ADD COLUMN flagged_reason TEXT NULL;
ALTER TABLE evidence_links ADD COLUMN flagged_notes TEXT NULL;
ALTER TABLE evidence_links ADD COLUMN flagged_at TEXT NULL;

ALTER TABLE source_spans ADD COLUMN is_corrupted INTEGER NOT NULL DEFAULT 0 CHECK (is_corrupted IN (0, 1));
ALTER TABLE source_spans ADD COLUMN corruption_reason TEXT NULL;
ALTER TABLE source_spans ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_evidence_links_citation_status ON evidence_links(citation_status);
CREATE INDEX IF NOT EXISTS idx_records_is_stale ON extracted_records(project_id, is_stale);
