# BATON — Round 2 Judge-Facing Evidence, Fact-Check Table & Demo Script (`ROUND2_EVIDENCE.md`)

**Project:** BATON — Research Continuity Platform  
**Team:** Team Kernel  
**Tested & Verified Date:** 2026-11-11  

---

## 1. Deployment & Repository Status (Honest Verification)

| Item | Status / Value | Verification Evidence |
|---|---|---|
| **Local Production Server URL** | `http://127.0.0.1:3000` (`GET /api/health` → `200 OK`, `migrations_applied: 7`) | Verified via live HTTP socket probes (`server/scripts/verifyLiveServerAndGenerateSubmission.js`) and 9 automated test suites (`64/64` subtests passing). |
| **External Public Cloud URL** | **NOT DEPLOYED (Local Sandbox Build Environment)** | In strict compliance with Stage 11 rules (*"Do not claim deployment until the public URL has been opened and tested from a clean browser session"*), no unverified external cloud URL is claimed. Turnkey deployment configs (`Dockerfile`, `render.yaml`) are included in the repository root. |
| **GitHub Repository URL** | `https://github.com/pournima-d/baton-research-continuity` | Contains all source code, 7 SQLite migrations, 9 test suites, documentation, SVG workspace captures (`docs/screenshots/`), and `BATON_ROUND2_SUBMISSION.pdf`. |
| **Tested Date** | `2026-11-11` | Executed via `.\.runtime\node.exe --test` (`duration_ms: ~810 ms`, `pass: 64`, `fail: 0`). |

---

## 2. What Changed Since Round 1 (Proposal → Working Round 2 Product)

In **Round 1**, BATON was a conceptual design proposal with zero executable backend, database, or frontend code (`AUDIT_REPORT.md` confirmed an empty greenfield workspace at Stage 00).  
In **Round 2**, BATON has been built from the ground up into a working, tested, database-backed application implementing all five stages (**Connect → Reconstruct → Verify → Review → Handover**):

### 2.1 Genuinely Shipped & Verified Round 2 Features
1. **Stage 1 — Connect (Document Ingestion & Provenance Indexing):**
   - Multi-format source upload (`PDF_DOCUMENT`, `LAB_NOTE` Markdown/Text, `CSV_DATASET`, `JSON_RECORDS`) with strict extension, MIME, size (`2 MB`), and path-traversal validation (`server/services/storageService.js`).
   - Exact provenance span indexing (`PDF_PAGE`, `NOTE_SECTION`, `CSV_ROW`, `JSON_RECORD`) with character offsets (`char_start`, `char_end`) and SHA-256 content deduplication (`409 DUPLICATE_SOURCE`) (`server/services/spanIndexer.js`).
   - Honest scanned/image-only PDF detection (`422 SCANNED_PDF_NEEDS_OCR`, persisted with `processing_status = 'NEEDS_OCR'`).
   - Untrusted prompt-injection pattern detection (`has_prompt_injection_pattern = 1`, logged as `UNTRUSTED_PROMPT_PATTERN_SANDBOXED`).
2. **Stage 2 — Reconstruct (Pre-Filtered Extraction & Continuity Map):**
   - Deterministic SQL pre-filtering (`visibility_level = 'PROJECT_SHARED' AND exclude_from_ai = 0`) before extraction (`server/services/aiReconstructor.js`).
   - Extraction of 11 structured continuity record types (`OBJECTIVE`, `DECISION`, `EXPERIMENT`, `RESULT`, `TASK`, `RISK`, `DEPENDENCY`, `QUESTION`, `CONTACT`, `GAP`, `RECURRING_PROBLEM`) with explicit separation of `direct_source_statement` vs. `ai_summary_or_inference`.
   - Non-fabrication of missing fields: unstated owners, dates, and rationale remain `null` (`UNKNOWN`), flagging `is_incomplete = 1`.
   - Evidence-backed Continuity Map edges (`CONFLICTS_WITH`, `EVIDENCE_CORROBORATES`, `ADDRESSES_GAP`, `DERIVED_FROM_SAME_SOURCE`) plus an accessible HTML table alternative (`#continuity-map-table-card`).
3. **Stage 3 — Verify (Evidence Inspector & Canonical Gap States):**
   - Six canonical categorical evidence states (`SUPPORTED`, `CONFLICTING`, `UNSUPPORTED`, `STALE`, `NEEDS REVIEW`, `NOT ESTABLISHED`) with zero fabricated probability/truth percentages (`400 FABRICATED_PROBABILITY_REJECTED`) (`server/services/evidenceInspector.js`).
   - Side-by-side `CONFLICTING` passage display without automatically picking a winner; automatic `STALE` detection when a newer dated source supersedes an older calibration; automatic downgrade from `SUPPORTED` when a cited span is flagged, deleted, or corrupted.
4. **Stage 4 & 5 — Review, Approval & Role-Filtered Handover:**
   - Outgoing researcher record editing with field-level version diffs (`record_versions`), context notes, and uncertainty flags.
   - Strict separation of `evidence_status` and `approval_status`; approval binds to `approved_version === current_version`, and any post-approval edit automatically returns the record to `PENDING_REVIEW` and invalidates old approval (`server/app.js`).
   - Structured 6-section Continuation Plan generation (`server/services/handoverService.js`) from `APPROVED` records only, role-filtered recipient view excluding all `RESTRICTED_PI_ONLY` and `REJECTED` items, and versioned recipient receipt acknowledgement (`RECEIPT_ONLY_NOT_AGREEMENT_OR_UNDERSTANDING`).
5. **Security, Permissions, Append-Only Audit & Optional Step-Up:**
   - 5-role server-side RBAC (`PI_LEAD`, `RESEARCHER`, `REVIEWER`, `INCOMING_MEMBER`, `AUDITOR`), `scrypt` password hashing, `HttpOnly; SameSite=Strict; Secure` session cookies, CSRF validation (`X-CSRF-Token`), CORS allowlist, rate limiting, authorised private file endpoint (`GET /sources/:id/file`), and append-only `audit_events` enforced by HTTP `405` and SQLite triggers (`006_stage08_security_and_audit.sql`).
   - Optional risk-triggered step-up verification (`007_stage09_optional_step_up.sql`, `server/services/stepUpService.js`) with an equivalent non-camera MFA/passkey route, zero image/video/biometric storage (`CHECK (media_stored = 0)`), and explicit capability disclaimers.

### 2.2 Partial / Not Implemented Features (Explicitly Disclosed)
- **Optical Character Recognition (OCR) for Scanned PDFs:** Not implemented in Round 2; scanned/image-only PDFs are honestly flagged and persisted with `processing_status = 'NEEDS_OCR'` rather than silently treated as empty or `READY`.
- **External Cloud Hosting Deployment:** Configured (`Dockerfile`, `render.yaml`) and verified locally on `http://127.0.0.1:3000`, but not deployed to a public cloud URL from the offline sandbox environment.
- **Round 3 Commitments (Knowledge-Debt Radar, Cold-Start Handover Test, Sensitive-Content Detection & Redaction):** Scheduled as Round 3 commitments (Section 6 below); not claimed as shipped Round 2 features.

---

## 3. Architecture & Data Flow

```
[Raw Sources: PDF / Markdown / CSV / JSON]
       │
       ▼  Stage 1: Connect (storageService.js + spanIndexer.js)
[Private Blob Storage (/storage/private_uploads)] + [SQLite: sources, source_spans]
       │
       ▼  Deterministic Pre-AI SQL Filter (visibility_level = 'PROJECT_SHARED' AND exclude_from_ai = 0)
[Permitted Spans Only (RESTRICTED_PI_ONLY Excluded Before Context Construction)]
       │
       ▼  Stage 2: Reconstruct (aiReconstructor.js)
[Candidate Continuity Records (DRAFT) + Evidence Links + Continuity Map Edges]
       │
       ▼  Stage 3: Verify (evidenceInspector.js)
[Categorical Evidence States: SUPPORTED | CONFLICTING | UNSUPPORTED | STALE | NEEDS REVIEW | NOT ESTABLISHED]
       │
       ▼  Stage 4: Review (server/app.js -> reviews, record_versions)
[Human Governance Decision: APPROVE (bound to version) | REQUEST_CHANGES | FLAG_GAP | REJECT]
       │
       ▼  Stage 5: Handover (handoverService.js -> handover_packages, handover_versions, handover_acknowledgements)
[Role-Filtered Continuation Plan (PUBLISHED by PI_LEAD) ──► Receipt Acknowledged by INCOMING_MEMBER]
```

---

## 4. Submission Outline & Fact-Check Table (Mapping Every Claim to Evidence)

### 4.1 Round 2 PDF Outline
- **Page 1 — Executive Summary, Evolution Since Round 1 & System Architecture:**
  - Transition from Round 1 conceptual design to Round 2 full-stack SQLite-backed implementation.
  - Verified deployment & repository status (`http://127.0.0.1:3000` verified; external cloud URL honestly marked not deployed).
  - End-to-end architecture and pre-AI restricted data filtering flow.
- **Page 2 — Shipped Round 2 Workflow (Connect → Reconstruct → Verify → Review → Handover) & Product Captures:**
  - Detailed walkthrough of the 5 stages and embedded visual workspace captures from the live application (`docs/screenshots/`).
- **Page 3 — Disclosures, Security & Audit Verification (`64/64` Tests), Camera Step-Up Honesty & Limitations:**
  - Full disclosure of runtime, database, models, and AI tools (`DISCLOSURES.md`).
  - Summary of the 9 automated test suites (`64/64` PASS) and 9-point Security Test Matrix (`TEST_REPORT.md`).
  - Honest Stage 09 camera step-up status and architectural limitations (`SECURITY_NOTES.md`).
- **Page 4 — Three Round 3 Commitments, Team Contributions & 3-Minute Judge Demo Script:**
  - Commitments A (Knowledge-Debt Radar), B (Cold-Start Handover Test), and C (Sensitive-Content Detection & Redaction).
  - Actual team contributions (`CONTRIBUTIONS.md`) and 3-minute live demo script.

### 4.2 Fact-Check Table (Every Claim Mapped to Concrete Repository Evidence)

| Factual Claim in Submission | Verified Value | Concrete Repository & Test Evidence |
|---|---|---|
| **Database Schema & Migrations** | 7 SQL migrations creating 19 relational tables with foreign keys and audit immutability triggers | `server/db/migrations/001`–`007`; verified in `tests/backend.test.js` Subtest 1 (`newlyApplied.length === 7`, `tables.length === 19`). |
| **Automated Test Pass Rate** | `64 / 64` subtests passing (`0` failures) across 9 test suites | Executed via `.\.runtime\node.exe --test`; documented in `TEST_REPORT.md` Section 1. |
| **Multi-Format Ingestion & Provenance** | Supports PDF (`PDF_PAGE`), Markdown/Text (`NOTE_SECTION`), CSV (`CSV_ROW`), and JSON (`JSON_RECORD`), plus `409 DUPLICATE_SOURCE` and `422 SCANNED_PDF_NEEDS_OCR` | `server/services/storageService.js`, `server/services/spanIndexer.js`; verified in `tests/connect_ingestion.test.js` Subtests 1–5. |
| **Pre-AI Restricted Source Filtering** | `RESTRICTED_PI_ONLY` and `exclude_from_ai = 1` sources are excluded by SQL before extraction and handover generation | `server/services/aiReconstructor.js` (`getPermittedSpansForReconstruction`); verified in `tests/security_audit_stage08.test.js` Subtest 4 (`restricted_or_excluded_sources_filtered: 2`). |
| **Missing Owners & Dates Never Invented** | Unstated owners, dates, and rationale remain `null` in DB and render as `UNKNOWN` in the Continuation Plan | `server/services/aiReconstructor.js`, `server/services/handoverService.js`; verified in `tests/reconstruct_stage05.test.js` Subtest 2 and `tests/e2e_reliability_stage10.test.js` Subtest 1. |
| **Six Canonical Evidence States & No Probability Scores** | Enforces `SUPPORTED`, `CONFLICTING`, `UNSUPPORTED`, `STALE`, `NEEDS REVIEW`, `NOT ESTABLISHED`; rejects numeric truth percentages with `400 FABRICATED_PROBABILITY_REJECTED` | `server/services/evidenceInspector.js`; verified in `tests/verify_stage06.test.js` Subtests 1–6. |
| **Approval Bound to Version & Invalidated on Edit** | Editing an `APPROVED` record increments `current_version`, resets `approval_status` to `'PENDING_REVIEW'`, clears `approved_version`, and logs `approval_invalidated: true` | `server/app.js` lines 1510–1585; verified in `tests/review_handover_stage07.test.js` Subtest 6. |
| **Recipient Acknowledgement Disclaimer** | Records `RECEIPT_ONLY_NOT_AGREEMENT_OR_UNDERSTANDING` linked to `handover_version` | `server/services/handoverService.js`, `server/app.js`; verified in `tests/review_handover_stage07.test.js` Subtest 8. |
| **Append-Only Audit Trail & RBAC Security** | Blocks API mutations (`405 AUDIT_LOG_IMMUTABLE`) and SQL `UPDATE`/`DELETE` via triggers (`trg_audit_events_prevent_update`/`delete`) | `006_stage08_security_and_audit.sql`, `server/app.js`; verified in `tests/security_audit_stage08.test.js` Subtest 9. |
| **Optional Camera Step-Up Honesty** | Camera is optional, has an equivalent `NON_CAMERA_MFA_PASSKEY` route, stores zero media (`CHECK (media_stored = 0)`), and makes no facial recognition/identity/liveness claims | `007_stage09_optional_step_up.sql`, `server/services/stepUpService.js`; verified in `tests/camera_step_up_stage09.test.js` Subtests 1–6. |

---

## 5. Product Workspace Screenshots (`docs/screenshots/`)

Generated directly from live HTTP API state of the running BATON server (`server/scripts/verifyLiveServerAndGenerateSubmission.js`):
1. `docs/screenshots/01_overview_and_connect.svg` — **Stage 00 Overview & Stage 01 Connect:** Project metrics, 5-stage progress strip, uploaded sources (`PROJECT_SHARED` vs. `RESTRICTED_PI_ONLY`), and indexed provenance spans.
2. `docs/screenshots/02_continuity_map_and_verify.svg` — **Stage 02 Continuity Map & Stage 03 Evidence Inspector:** Extracted continuity nodes, `CONFLICTS_WITH` / `EVIDENCE_CORROBORATES` edges, side-by-side conflicting passages, `STALE` calibration notice, and exact verbatim span citations.
3. `docs/screenshots/03_review_handover_and_audit.svg` — **Stage 04 Review Queue, Stage 05 Role-Filtered Handover & Append-Only Audit Log:** Versioned review approval (`v2`), 6-section Continuation Plan with `UNKNOWN` owner/deadline badges, recipient receipt acknowledgement, and immutable `audit_events`.

---

## 6. Three Round 3 Commitments (Not Claimed as Shipped in Round 2)

For **Round 3**, Team Kernel commits to implementing and verifying the following three improvements:

1. **Commitment A — Knowledge-Debt Radar:**
   - Identify critical project knowledge concentrated in a single outgoing member (`stated_owner` concentration) or weakly documented (`UNSUPPORTED`, `NEEDS REVIEW`, `STALE`, or missing rationale/owner), surfacing a prioritised gap list before a researcher departs.
2. **Commitment B — Cold-Start Handover Test:**
   - Provide practical newcomer diagnostic questions generated from the project's domain and tasks to test whether the approved handover package actually contains the evidence-backed answers — reporting **record and documentation gaps** in the handover package, never scoring or judging a person's competence.
3. **Commitment C — Sensitive-Content Detection and Redaction:**
   - Automatically scan uploaded sources and candidate records prior to sharing to detect likely email addresses, API keys/tokens, and personal identifiers, presenting suggested redactions for explicit human confirmation before inclusion in shared records or handover packages.

---

## 7. Judge-Facing Three-Minute Demo Script (Verified Working Features Only)

**Pre-Demo Setup:** Start server (`.\.runtime\node.exe server/index.js`) and open `http://127.0.0.1:3000`.

### Minute 0:00 – 0:45 | Stage 1 (Connect) & Role-Based Visibility
1. **Show Overview & Active Role (`RESEARCHER — Marcus Chen`):** Point out the live API-backed project metrics for *Solid-State Li-Garnet (LLZO) Electrolyte Interface Continuity* (`prj_solidstate_01`).
2. **Switch to `01 Sources`:** Show the 3 shared sources (`llzo_sintering_report.pdf`, `glovebox_notes_oct.md`, `eis_conductivity_runs.csv`). Switch the **Active Role** dropdown to `PI_LEAD (Dr. Elena Vance)` to reveal the 4th source: `RESTRICTED: Pre-Patent Dual-Halide Interlayer Disclosure Draft` (`RESTRICTED_PI_ONLY`, `exclude_from_ai = 1`).
3. **Inspect Provenance Spans:** Click **Inspect Spans** on `llzo_sintering_report.pdf` to show exact `PDF_PAGE` locators (`Page 1, Paragraph 1`, character offsets `0–203`).

### Minute 0:45 – 1:45 | Stage 2 (Reconstruct) & Stage 3 (Verify Evidence & Gaps)
4. **Run Pre-Filtered Reconstruction (`02 Continuity Map`):** Switch back to `RESEARCHER`, select all sources, and click **Run Pre-Filtered Reconstruction**. Point out the banner confirming `Restricted/AI-Excluded Sources Filtered Out: 1` — the `RESTRICTED_PI_ONLY` patent draft never entered the extraction context.
5. **Inspect the Continuity Map & Accessible Table View:** Show extracted nodes grouped into *Objectives & Decisions*, *Experiments & Results*, *Open Work, Risks & Gaps*, and *Dependencies & Contacts*, plus the **Evidence-Supported Continuity Map Edges** table. Click **Table View (Accessible)** to show the keyboard/screen-reader table alternative.
6. **Verify Evidence & Gap States (`03 Records & Evidence`):** Select a record to show:
   - Exact separation between **Direct Source Statement** and **AI Summary / Proposed Inference**, plus model disclosure metadata.
   - Categorical evidence statuses (`SUPPORTED`, `CONFLICTING`, `UNSUPPORTED`, `STALE`, `NEEDS REVIEW`, `NOT ESTABLISHED`) with zero fabricated confidence percentages.
   - Click **Flag Incorrect Citation** on a supporting span to show how flagging a citation immediately downgrades `SUPPORTED` to `NEEDS REVIEW` without altering `approval_status`.

### Minute 1:45 – 3:00 | Stage 4 (Review), Stage 5 (Handover) & Immutable Audit Trail
7. **Governance Review (`04 Review Queue`):** Switch role to `REVIEWER (Dr. Priya Nair)`. Approve a candidate record (`APPROVE`), binding approval to its specific version number while preserving its honest `evidence_status`.
8. **Assemble, Publish & Acknowledge Handover (`05 Handover`):**
   - Switch to `PI_LEAD`, create/select the handover package, and show the Optional Step-Up Verification card (demonstrating the **Standard Non-Camera Route (MFA / Passkey Only)** alongside the honest capability disclaimer).
   - Click **Publish Handover Package (`PI_LEAD`)**.
   - Switch role to `INCOMING_MEMBER (Aria Patel)`: confirm that `RESTRICTED_PI_ONLY` content and unapproved/rejected records are completely absent, check off the provenance checklist items, and click **Acknowledge Receipt** (recording receipt linked to `v1`, with the notice that acknowledgement means receipt, not agreement or proof of understanding).
9. **Inspect Append-Only Audit Log (`06 Activity / Audit`):** Switch to `AUDITOR (Jordan Lee)` to display the chronological, immutable `audit_events` log covering uploads, pre-AI filtering, verifications, reviews, publication, receipt acknowledgement, and access denials.
