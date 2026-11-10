-- BATON Migration 002: Stage 04 Connect Document Ingestion Metadata
-- Adds page_count, row_count, file_extension, and untrusted prompt-injection detection flag to sources.

ALTER TABLE sources ADD COLUMN file_extension TEXT NOT NULL DEFAULT '';
ALTER TABLE sources ADD COLUMN page_count INTEGER NULL;
ALTER TABLE sources ADD COLUMN row_count INTEGER NULL;
ALTER TABLE sources ADD COLUMN has_prompt_injection_pattern INTEGER NOT NULL DEFAULT 0 CHECK (has_prompt_injection_pattern IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_sources_project_hash ON sources(project_id, content_hash);
