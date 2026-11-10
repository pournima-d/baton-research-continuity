# BATON — REST API Specification (`API_PLAN.md`)

## 1. Authentication, Headers & Standard Error Envelope

### 1.1 Authentication Mechanism
Every protected endpoint requires an HTTP header:
- `Authorization: Bearer <api_token>` (or `X-Baton-Token: <api_token>`)
- Deterministic middleware resolves the `users` row and, for `/api/projects/:projectId/*` routes, joins `memberships` and `roles` to attach `req.auth = { user, membership, role }`.

### 1.2 Standard Error Response Shape
All error responses return a consistent JSON envelope and log authorization failures (`401`/`403`) to `audit_events`:
```json
{
  "error": {
    "code": "FORBIDDEN_ROLE",
    "message": "Role 'INCOMING_MEMBER' is not permitted to upload sources.",
    "details": { "required_roles": ["PI_LEAD", "RESEARCHER"], "actual_role": "INCOMING_MEMBER" }
  }
}
```

| HTTP Status | Error Code | Trigger Condition |
| :--- | :--- | :--- |
| `400 Bad Request` | `INVALID_PAYLOAD` | Missing required fields or malformed JSON |
| `401 Unauthorized` | `UNAUTHENTICATED` | Missing or invalid bearer token |
| `403 Forbidden` | `FORBIDDEN_ROLE` / `RESTRICTED_RESOURCE` | User is not a project member, lacks required role, or attempts to access `RESTRICTED_PI_ONLY` source without `PI_LEAD` role |
| `404 Not Found` | `RESOURCE_NOT_FOUND` | Requested project, source, span, record, or handover does not exist |
| `409 Conflict` | `INVALID_STATE_TRANSITION` | E.g., attempting to acknowledge a handover that is still `DRAFT` |
| `422 Unprocessable Entity` | `PROVENANCE_VALIDATION_FAILED` / `INVALID_EVIDENCE_STATUS` | Cited `span_id` does not exist, quote does not match source span, or payload attempts to pass numerical truth-probability percentages |

---

## 2. Endpoints by Workflow Stage

### 2.1 Identity, Demo Personas & Projects

#### `GET /api/auth/session`
- **Auth:** Any valid token (also supports `GET /api/auth/demo-users` for switching demo personas in the UI evaluation bar).
- **Response `200 OK`:**
```json
{
  "user": { "id": "usr_pi_01", "email": "pi@baton-lab.edu", "full_name": "Dr. Elena Vance", "department": "Solid-State Energy Lab" },
  "memberships": [
    { "project_id": "prj_solidstate_01", "role_id": "PI_LEAD", "role_name": "Principal Investigator / Lead" }
  ]
}
```

#### `GET /api/projects`
- **Auth:** Authenticated user. Returns only projects where the user has a `memberships` row.
- **Response `200 OK`:** `{ "projects": [ { "id": "prj_solidstate_01", "name": "...", "role_id": "PI_LEAD", "counts": { "sources": 4, "records": 6, "handovers": 1 } } ] }`

#### `POST /api/projects/:projectId/memberships`
- **Auth:** `PI_LEAD` only.
- **Request:** `{ "user_id": "usr_inc_01", "role_id": "INCOMING_MEMBER" }`
- **Response `201 Created`:** `{ "membership": { "id": "mem_05", "project_id": "prj_solidstate_01", "user_id": "usr_inc_01", "role_id": "INCOMING_MEMBER" } }`
- **Errors:** `403` if caller is not `PI_LEAD`; `400` if `role_id` invalid.

---

### 2.2 Stage 1: Connect — Sources & Provenance Span Indexing

#### `GET /api/projects/:projectId/sources`
- **Auth:** Any project member (`PI_LEAD`, `RESEARCHER`, `REVIEWER`, `INCOMING_MEMBER`, `AUDITOR`).
- **Deterministic Filtering Behavior:**
  - If caller's role is `PI_LEAD`, returns all sources including `visibility_level = 'RESTRICTED_PI_ONLY'`.
  - For all other roles, SQL query filters `WHERE visibility_level = 'PROJECT_SHARED'` and returns a metadata count `restricted_hidden_count` so non-PI users cannot read restricted content or spans.
- **Response `200 OK`:**
```json
{
  "sources": [
    {
      "id": "src_pdf_01",
      "title": "Li-Garnet Pellet Sintering & Cycling Report",
      "file_name": "llzo_sintering_report.pdf",
      "source_type": "PDF_DOCUMENT",
      "visibility_level": "PROJECT_SHARED",
      "exclude_from_ai": 0,
      "span_count": 4,
      "uploaded_by": "Dr. Elena Vance",
      "created_at": "2026-11-10T10:00:00Z"
    }
  ],
  "restricted_hidden_count": 1
}
```

#### `POST /api/projects/:projectId/sources`
- **Auth:** `PI_LEAD`, `RESEARCHER`. (`RESTRICTED_PI_ONLY` visibility can only be set by `PI_LEAD` or `RESEARCHER`, and only `PI_LEAD` can read it thereafter).
- **Request:**
```json
{
  "title": "Lab Notebook: Glovebox Moisture Excursion Log",
  "file_name": "glovebox_notes_oct.md",
  "source_type": "LAB_NOTE",
  "visibility_level": "PROJECT_SHARED",
  "exclude_from_ai": false,
  "raw_content": "# Section 1: Argon Purge Protocol\nLine 2: Maintain H2O below 0.5 ppm...\n# Section 2: Anomaly on Oct 14\nLine 5: Sensor drift observed after valve replacement."
}
```
- **Deterministic Processing:**
  - Validates file size (`<= 2 MB`), allowed `source_type`, and non-empty `raw_content`.
  - Computes SHA-256 `content_hash`.
  - Parses `raw_content` into granular `source_spans` with exact provenance:
    - `PDF_DOCUMENT`: splits by `[PAGE N]` markers / paragraphs with `page_number`, `char_start`, `char_end`.
    - `LAB_NOTE`: splits by Markdown/text section headers with `section_heading`, `line_start`, `line_end`.
    - `CSV_DATASET` / `JSON_RECORDS`: splits by row/record with `row_index`, `record_key`, `column_names_json`.
  - Writes `SOURCE_UPLOADED` to `audit_events`.
- **Response `201 Created`:** `{ "source": { ... }, "spans": [ ... ] }`
- **Errors:** `400` invalid `source_type` or empty content; `403` if caller is `REVIEWER`, `INCOMING_MEMBER`, or `AUDITOR`.

#### `GET /api/projects/:projectId/sources/:sourceId/spans`
- **Auth:** Any project member, **except** if `source.visibility_level === 'RESTRICTED_PI_ONLY'` and `role !== 'PI_LEAD'` → returns `403 RESTRICTED_RESOURCE` and logs `ACCESS_DENIED`.
- **Response `200 OK`:**
```json
{
  "source": { "id": "src_pdf_01", "title": "...", "source_type": "PDF_DOCUMENT", "visibility_level": "PROJECT_SHARED" },
  "spans": [
    {
      "id": "spn_pdf01_p2_1",
      "span_index": 2,
      "locator_type": "PDF_PAGE",
      "locator_label": "Page 2, Span 1",
      "page_number": 2,
      "section_heading": null,
      "line_start": null,
      "line_end": null,
      "row_index": null,
      "record_key": null,
      "content_text": "Pellets sintered at 1150C for 6 hours in mother powder achieved 94.2% relative density and ionic conductivity of 0.68 mS/cm at 25C."
    }
  ]
}
```

---

### 2.3 Stage 2: Reconstruct — Pre-Filtered AI Extraction & Manual Record Creation

#### `POST /api/projects/:projectId/reconstruct`
- **Auth:** `PI_LEAD`, `RESEARCHER`.
- **Request:**
```json
{
  "source_ids": ["src_pdf_01", "src_note_01", "src_csv_01", "src_restricted_01"],
  "extraction_focus": "Extract key protocols, experimental claims, dataset findings, and unresolved risks for researcher handover."
}
```
- **Deterministic Pre-AI Filtering & Post-AI Validation:**
  1. Queries `sources` and `source_spans` for `project_id`, **deterministically excluding** any source where `visibility_level = 'RESTRICTED_PI_ONLY'` or `exclude_from_ai = 1`.
  2. Logs `AI_CONTEXT_FILTERED` in `audit_events` with `{ included_source_ids, excluded_restricted_source_ids, permitted_span_count }`.
  3. Sends **only** permitted spans to the AI Proposal Service (`Gemini` or deterministic structured extractor).
  4. Validates each proposed record: every `evidence_links[].span_id` must belong to the permitted span set, and `verbatim_quote` is checked against `source_spans.content_text`.
  5. Initializes `approval_status = 'DRAFT'` and assigns categorical `evidence_status` (`'UNVERIFIED'` or `'PARTIAL'` based on deterministic quote verification).
  6. Creates `record_versions` (`version_number = 1`, `change_reason = 'INITIAL_EXTRACTION'`).
- **Response `201 Created`:**
```json
{
  "filter_summary": {
    "requested_sources_count": 4,
    "permitted_sources_count": 3,
    "restricted_or_excluded_sources_filtered": 1,
    "permitted_spans_sent_to_ai": 9
  },
  "created_records": [
    {
      "id": "rec_01",
      "record_type": "PROTOCOL",
      "title": "LLZO Pellet Sintering at 1150°C with Mother Powder Bed",
      "statement": "Sinter Li-garnet pellets at 1150°C for 6 hours covered in mother powder to prevent Li loss and achieve >94% relative density.",
      "origin_mode": "AI_PROPOSED",
      "evidence_status": "PARTIAL",
      "approval_status": "DRAFT",
      "current_version": 1,
      "evidence_links": [
        {
          "id": "evl_01",
          "span_id": "spn_pdf01_p2_1",
          "locator_label": "Page 2, Span 1",
          "relationship_type": "SUPPORTS",
          "verbatim_quote": "Pellets sintered at 1150C for 6 hours in mother powder achieved 94.2% relative density",
          "quote_verified": 1
        }
      ]
    }
  ]
}
```

#### `GET /api/projects/:projectId/records`
- **Auth:** Any project member. (Any evidence link pointing to a restricted source is hidden for non-PI users, though restricted sources are blocked from entering shared records by default).
- **Response `200 OK`:** `{ "records": [ ... ] }`

#### `POST /api/projects/:projectId/records` & `PATCH /api/projects/:projectId/records/:recordId`
- **Auth:** `PI_LEAD`, `RESEARCHER`.
- **Purpose:** Create or edit a continuity record's `title`, `statement`, `rationale`, `record_type`, or submit for review (`approval_status = 'PENDING_REVIEW'`).
- **Deterministic Rules:**
  - Increments `current_version` and writes a new `record_versions` snapshot (`change_reason = 'MANUAL_EDIT'`).
  - Cannot directly set `approval_status = 'APPROVED'` via edit (must go through Stage 4 Review endpoint).
- **Errors:** `403` if caller is `REVIEWER`, `INCOMING_MEMBER`, or `AUDITOR`; `422` if cited `span_id` is invalid or restricted.

---

### 2.4 Stage 3: Verify — Deterministic Provenance Verification & Evidence Classification

#### `POST /api/projects/:projectId/records/:recordId/verify`
- **Auth:** `PI_LEAD`, `RESEARCHER`, `REVIEWER`.
- **Request:**
```json
{
  "evidence_status": "SUPPORTED",
  "verification_notes": "Cross-checked PDF Page 2 sintering parameters against CSV Row #4 (sample_id=SSE-04) showing 0.68 mS/cm conductivity.",
  "evidence_links": [
    {
      "span_id": "spn_pdf01_p2_1",
      "relationship_type": "SUPPORTS",
      "verbatim_quote": "Pellets sintered at 1150C for 6 hours in mother powder achieved 94.2% relative density"
    },
    {
      "span_id": "spn_csv01_r4",
      "relationship_type": "SUPPORTS",
      "verbatim_quote": "sample_id=SSE-04 | temp_C=1150 | duration_h=6 | rel_density_pct=94.2 | cond_mS_cm=0.68"
    }
  ]
}
```
- **Deterministic Rules:**
  - Rejects any `evidence_status` not in `['UNVERIFIED', 'WEAK', 'PARTIAL', 'SUPPORTED', 'CONTRADICTED', 'BROKEN_PROVENANCE']`.
  - Rejects any payload containing percentage confidence/truth scores (`422 INVALID_EVIDENCE_STATUS`).
  - Deterministically checks each `evidence_links` item against `source_spans`. If a cited span is missing or `verbatim_quote` is not found in `source_spans.content_text` and caller attempts to mark `SUPPORTED`, returns `422 PROVENANCE_VALIDATION_FAILED` (or forces `'BROKEN_PROVENANCE'`).
  - Does **not** alter `approval_status`.
  - Bumps `current_version` and writes a `record_versions` row (`change_reason = 'EVIDENCE_VERIFICATION'`) and `audit_events` (`RECORD_VERIFIED`).
- **Response `200 OK`:** `{ "record": { ... }, "deterministic_checks": { "all_spans_exist": true, "all_quotes_exact": true } }`

---

### 2.5 Stage 4: Review — Human Governance & Versioned Decisions

#### `POST /api/projects/:projectId/records/:recordId/reviews`
- **Auth:** `PI_LEAD`, `REVIEWER`.
- **Request:**
```json
{
  "decision": "APPROVE",
  "comments": "Verified against lab notebook and CSV dataset. Ready for inclusion in incoming researcher handover package."
}
```
- **Deterministic Rules (Critical Invariant):**
  - Maps `decision` to `extracted_records.approval_status`:
    - `'APPROVE'` → `'APPROVED'`
    - `'REQUEST_CHANGES'` → `'NEEDS_REVISION'`
    - `'FLAG_GAP'` → `'NEEDS_REVISION'`
    - `'REJECT'` → `'REJECTED'`
  - **NEVER modifies `extracted_records.evidence_status`**. For example, if a record has `evidence_status = 'WEAK'` (such as a documented failure mode or tentative hypothesis) and the PI approves it for handover visibility, `approval_status` becomes `'APPROVED'` while `evidence_status` remains `'WEAK'`, and `reviews.evidence_status_at_review` records `'WEAK'`.
  - Increments `current_version`, creates a `record_versions` snapshot (`change_reason = 'REVIEW_DECISION'`), inserts the `reviews` row, and logs `REVIEW_SUBMITTED` to `audit_events`.
- **Response `201 Created`:** `{ "review": { ... }, "record": { "id": "rec_01", "evidence_status": "SUPPORTED", "approval_status": "APPROVED", "current_version": 3 } }`

#### `GET /api/projects/:projectId/records/:recordId/versions`
- **Auth:** Any project member.
- **Response `200 OK`:** Returns full chronological `record_versions[]` and `reviews[]` history for the record.

---

### 2.6 Stage 5: Handover — Filtered Package Generation, Publish & Acknowledgement

#### `POST /api/projects/:projectId/handovers`
- **Auth:** `PI_LEAD`, `RESEARCHER`.
- **Request:**
```json
{
  "title": "Solid-State Electrolyte Continuity Package — Q4 Handover",
  "recipient_user_id": "usr_inc_01",
  "record_ids": ["rec_01", "rec_02", "rec_03"]
}
```
- **Deterministic Rules:**
  - Verifies all `record_ids` belong to `projectId` and have `approval_status = 'APPROVED'` (returns `422` if any selected record is unapproved/rejected).
  - Runs the Pre-Handover Access Filter: verifies no included record or evidence link exposes a `RESTRICTED_PI_ONLY` source (`restricted_sources_excluded_count` recorded).
  - Generates the `executive_summary` strictly from the approved, non-restricted records, preserving each item's `evidence_status_snapshot` (`SUPPORTED`, `PARTIAL`, `WEAK`) without inflating weak evidence.
  - Creates `handover_packages` (`status = 'DRAFT'`) and `handover_items`.
- **Response `201 Created`:** `{ "handover": { ... }, "items": [ ... ] }`

#### `POST /api/projects/:projectId/handovers/:handoverId/publish`
- **Auth:** `PI_LEAD` only.
- **Request:** `{}`
- **Deterministic Rules:** Transitions `status` from `'DRAFT'` to `'PUBLISHED'`, sets `published_by_user_id` and `published_at`, logs `HANDOVER_PUBLISHED` in `audit_events`.
- **Response `200 OK`:** `{ "handover": { "id": "hnd_01", "status": "PUBLISHED", ... } }`

#### `POST /api/projects/:projectId/handovers/:handoverId/items/:itemId/check`
- **Auth:** `INCOMING_MEMBER` (assigned recipient) or `PI_LEAD`.
- **Request:** `{ "recipient_checked": true }`
- **Purpose:** Incoming team member checks off each continuity item after inspecting its exact source provenance spans.

#### `POST /api/projects/:projectId/handovers/:handoverId/acknowledge`
- **Auth:** `INCOMING_MEMBER` (must match `recipient_user_id` or hold `INCOMING_MEMBER` role in project).
- **Request:**
```json
{
  "acknowledgement_notes": "Reviewed all approved protocols, dataset findings, and open risks with their source spans. Ready to begin replication runs."
}
```
- **Deterministic Rules:**
  - Requires `handover.status === 'PUBLISHED'` (else `409 INVALID_STATE_TRANSITION`).
  - Requires all `handover_items` in the package to have `recipient_checked = 1` (else `422 UNCHECKED_HANDOVER_ITEMS`).
  - Transitions `status` to `'ACKNOWLEDGED'`, sets `acknowledged_by_user_id` and `acknowledged_at`, and logs `HANDOVER_ACKNOWLEDGED` in `audit_events`.
- **Response `200 OK`:** `{ "handover": { "id": "hnd_01", "status": "ACKNOWLEDGED", ... } }`

---

### 2.7 Governance & Audit Trail

#### `GET /api/projects/:projectId/audit-events`
- **Auth:** `PI_LEAD`, `AUDITOR`. (Returns `403 FORBIDDEN_ROLE` for `RESEARCHER`, `REVIEWER`, `INCOMING_MEMBER`).
- **Response `200 OK`:** `{ "audit_events": [ ... ] }`
