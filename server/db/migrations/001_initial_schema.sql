-- BATON Migration 001: Complete Relational Schema
-- Enforces foreign keys, provenance locators, and strict separation of evidence_status vs approval_status.

CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    can_access_restricted INTEGER NOT NULL DEFAULT 0 CHECK (can_access_restricted IN (0, 1))
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    department TEXT NOT NULL,
    api_token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id),
    added_by_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    UNIQUE(project_id, user_id)
);

CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'text/plain',
    byte_size INTEGER NOT NULL DEFAULT 0,
    storage_key TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL CHECK (source_type IN ('PDF_DOCUMENT', 'LAB_NOTE', 'CSV_DATASET', 'JSON_RECORDS')),
    processing_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (processing_status IN ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'NEEDS_OCR')),
    processing_error TEXT NULL,
    visibility_level TEXT NOT NULL DEFAULT 'PROJECT_SHARED' CHECK (visibility_level IN ('PROJECT_SHARED', 'RESTRICTED_PI_ONLY')),
    exclude_from_ai INTEGER NOT NULL DEFAULT 0 CHECK (exclude_from_ai IN (0, 1)),
    content_hash TEXT NOT NULL,
    raw_content TEXT NOT NULL,
    uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_spans (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    span_index INTEGER NOT NULL,
    locator_type TEXT NOT NULL CHECK (locator_type IN ('PDF_PAGE', 'NOTE_SECTION_LINE', 'CSV_ROW', 'JSON_RECORD')),
    locator_label TEXT NOT NULL,
    page_number INTEGER NULL,
    section_heading TEXT NULL,
    line_start INTEGER NULL,
    line_end INTEGER NULL,
    row_index INTEGER NULL,
    record_key TEXT NULL,
    column_names_json TEXT NULL,
    content_text TEXT NOT NULL,
    char_start INTEGER NOT NULL DEFAULT 0,
    char_end INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS extracted_records (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    record_type TEXT NOT NULL CHECK (
        record_type IN (
            'OBJECTIVE', 'DECISION', 'EXPERIMENT', 'RESULT', 'TASK',
            'RISK', 'DEPENDENCY', 'QUESTION', 'CONTACT', 'GAP', 'RECURRING_PROBLEM',
            'CLAIM', 'METHOD', 'PROTOCOL', 'DATASET_FINDING', 'OPEN_QUESTION', 'RISK_LIMITATION'
        )
    ),
    title TEXT NOT NULL,
    statement TEXT NOT NULL,
    rationale TEXT NOT NULL DEFAULT '',
    origin_mode TEXT NOT NULL DEFAULT 'MANUAL_ENTRY' CHECK (origin_mode IN ('AI_PROPOSED', 'MANUAL_ENTRY')),
    evidence_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (
        evidence_status IN (
            'SUPPORTED', 'CONFLICTING', 'UNSUPPORTED', 'STALE',
            'NEEDS REVIEW', 'NEEDS_REVIEW', 'NOT ESTABLISHED', 'NOT_ESTABLISHED',
            'UNVERIFIED', 'WEAK', 'PARTIAL', 'CONTRADICTED', 'BROKEN_PROVENANCE'
        )
    ),
    verification_notes TEXT NOT NULL DEFAULT '',
    verified_by_user_id TEXT NULL REFERENCES users(id),
    verified_at TEXT NULL,
    approval_status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (
        approval_status IN ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'NEEDS_REVISION', 'REJECTED')
    ),
    current_version INTEGER NOT NULL DEFAULT 1,
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_links (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES extracted_records(id) ON DELETE CASCADE,
    span_id TEXT NULL REFERENCES source_spans(id) ON DELETE SET NULL,
    relationship_type TEXT NOT NULL DEFAULT 'SUPPORTS' CHECK (
        relationship_type IN ('SUPPORTS', 'PARTIALLY_SUPPORTS', 'CONTRADICTS', 'CONTEXT_ONLY')
    ),
    verbatim_quote TEXT NOT NULL,
    quote_verified INTEGER NOT NULL DEFAULT 0 CHECK (quote_verified IN (0, 1)),
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    record_id TEXT NOT NULL REFERENCES extracted_records(id) ON DELETE CASCADE,
    record_version INTEGER NOT NULL,
    reviewer_user_id TEXT NOT NULL REFERENCES users(id),
    decision TEXT NOT NULL CHECK (decision IN ('APPROVE', 'REQUEST_CHANGES', 'FLAG_GAP', 'REJECT')),
    evidence_status_at_review TEXT NOT NULL,
    comments TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS record_versions (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES extracted_records(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    change_reason TEXT NOT NULL CHECK (
        change_reason IN (
            'INITIAL_EXTRACTION', 'MANUAL_EDIT', 'EVIDENCE_VERIFICATION',
            'REVIEW_DECISION', 'CITATION_FLAGGED', 'SPAN_INTEGRITY_CHECK'
        )
    ),
    changes_json TEXT NOT NULL DEFAULT '{}',
    snapshot_json TEXT NOT NULL,
    changed_by_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    UNIQUE(record_id, version_number)
);

CREATE TABLE IF NOT EXISTS handover_packages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    executive_summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'ACKNOWLEDGED')),
    restricted_sources_excluded_count INTEGER NOT NULL DEFAULT 0,
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    published_by_user_id TEXT NULL REFERENCES users(id),
    published_at TEXT NULL,
    recipient_user_id TEXT NULL REFERENCES users(id),
    acknowledged_by_user_id TEXT NULL REFERENCES users(id),
    acknowledged_at TEXT NULL,
    acknowledgement_notes TEXT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handover_items (
    id TEXT PRIMARY KEY,
    handover_id TEXT NOT NULL REFERENCES handover_packages(id) ON DELETE CASCADE,
    record_id TEXT NOT NULL REFERENCES extracted_records(id),
    record_version INTEGER NOT NULL,
    evidence_status_snapshot TEXT NOT NULL,
    approval_status_snapshot TEXT NOT NULL,
    section_group TEXT NOT NULL CHECK (section_group IN ('CORE_FINDINGS', 'PROTOCOLS_METHODS', 'OPEN_RISKS_GAPS')),
    recipient_checked INTEGER NOT NULL DEFAULT 0 CHECK (recipient_checked IN (0, 1))
);

CREATE TABLE IF NOT EXISTS handover_acknowledgements (
    id TEXT PRIMARY KEY,
    handover_id TEXT NOT NULL REFERENCES handover_packages(id) ON DELETE CASCADE,
    recipient_user_id TEXT NOT NULL REFERENCES users(id),
    notes TEXT NOT NULL,
    checked_item_count INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NULL REFERENCES projects(id) ON DELETE SET NULL,
    actor_user_id TEXT NULL REFERENCES users(id),
    actor_role TEXT NULL,
    event_type TEXT NOT NULL,
    target_entity_type TEXT NOT NULL,
    target_entity_id TEXT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memberships_project_user ON memberships(project_id, user_id);
CREATE INDEX IF NOT EXISTS idx_sources_project ON sources(project_id, visibility_level);
CREATE INDEX IF NOT EXISTS idx_spans_source ON source_spans(source_id, span_index);
CREATE INDEX IF NOT EXISTS idx_spans_project ON source_spans(project_id);
CREATE INDEX IF NOT EXISTS idx_records_project ON extracted_records(project_id);
CREATE INDEX IF NOT EXISTS idx_evidence_record ON evidence_links(record_id);
CREATE INDEX IF NOT EXISTS idx_reviews_record ON reviews(record_id);
CREATE INDEX IF NOT EXISTS idx_versions_record ON record_versions(record_id, version_number);
CREATE INDEX IF NOT EXISTS idx_handovers_project ON handover_packages(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_events(project_id, created_at);
