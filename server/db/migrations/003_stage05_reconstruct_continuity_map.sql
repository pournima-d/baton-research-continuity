-- BATON Migration 003: Stage 05 Reconstruct & Continuity Map
-- Separates direct_source_statement from ai_summary_or_inference, tracks nullable stated_owner/dates
-- (never guessed when absent), stores model disclosure metadata, and adds evidence-backed record_edges.

ALTER TABLE extracted_records ADD COLUMN direct_source_statement TEXT NOT NULL DEFAULT '';
ALTER TABLE extracted_records ADD COLUMN ai_summary_or_inference TEXT NULL;
ALTER TABLE extracted_records ADD COLUMN stated_owner TEXT NULL;
ALTER TABLE extracted_records ADD COLUMN recorded_date TEXT NULL;
ALTER TABLE extracted_records ADD COLUMN due_date TEXT NULL;
ALTER TABLE extracted_records ADD COLUMN structured_fields_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE extracted_records ADD COLUMN has_conflict INTEGER NOT NULL DEFAULT 0 CHECK (has_conflict IN (0, 1));
ALTER TABLE extracted_records ADD COLUMN conflict_summary TEXT NULL;
ALTER TABLE extracted_records ADD COLUMN is_incomplete INTEGER NOT NULL DEFAULT 0 CHECK (is_incomplete IN (0, 1));
ALTER TABLE extracted_records ADD COLUMN missing_fields_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE extracted_records ADD COLUMN extractor_provider TEXT NOT NULL DEFAULT 'baton-deterministic';
ALTER TABLE extracted_records ADD COLUMN extractor_model TEXT NOT NULL DEFAULT 'baton-struct-v2';
ALTER TABLE extracted_records ADD COLUMN extractor_version TEXT NOT NULL DEFAULT '2.0.0';
ALTER TABLE extracted_records ADD COLUMN extracted_at TEXT NULL;

CREATE TABLE IF NOT EXISTS record_edges (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_record_id TEXT NOT NULL REFERENCES extracted_records(id) ON DELETE CASCADE,
    to_record_id TEXT NOT NULL REFERENCES extracted_records(id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL CHECK (
        relationship_type IN (
            'EVIDENCE_CORROBORATES',
            'DERIVED_FROM_SAME_SOURCE',
            'CONFLICTS_WITH',
            'DEPENDS_ON',
            'ADDRESSES_GAP'
        )
    ),
    evidence_rationale TEXT NOT NULL,
    supporting_span_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_record_edges_project ON record_edges(project_id);
