-- ============================================================================
-- BATON Stage 07 Migration: Review, Approval and Handover
-- Adds version-bound approval tracking, context/edit reason fields,
-- structured continuation plan storage, handover version numbering,
-- version-linked receipt acknowledgement, and immutable handover_versions history.
-- ============================================================================

ALTER TABLE extracted_records ADD COLUMN approved_version INTEGER NULL;
ALTER TABLE extracted_records ADD COLUMN approved_by_user_id TEXT NULL REFERENCES users(id);
ALTER TABLE extracted_records ADD COLUMN approved_at TEXT NULL;
ALTER TABLE extracted_records ADD COLUMN context_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE extracted_records ADD COLUMN last_edit_reason TEXT NULL;

ALTER TABLE handover_packages ADD COLUMN version_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE handover_packages ADD COLUMN continuation_plan_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE handover_acknowledgements ADD COLUMN handover_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE handover_acknowledgements ADD COLUMN acknowledgement_type TEXT NOT NULL DEFAULT 'RECEIPT_ONLY_NOT_AGREEMENT_OR_UNDERSTANDING';
ALTER TABLE handover_acknowledgements ADD COLUMN acknowledgement_disclaimer TEXT NOT NULL DEFAULT 'Acknowledgement records receipt of this handover version only; it does not imply agreement or proof of understanding.';

CREATE TABLE IF NOT EXISTS handover_versions (
    id TEXT PRIMARY KEY,
    handover_id TEXT NOT NULL REFERENCES handover_packages(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    lifecycle_event TEXT NOT NULL CHECK (
        lifecycle_event IN ('CREATED_DRAFT', 'PUBLISHED', 'ACKNOWLEDGED')
    ),
    snapshot_json TEXT NOT NULL,
    actor_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_handover_versions_handover ON handover_versions(handover_id, version_number);
CREATE INDEX IF NOT EXISTS idx_handover_packages_project_version ON handover_packages(project_id, version_number);
