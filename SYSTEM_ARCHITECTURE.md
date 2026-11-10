# BATON — System Architecture (`SYSTEM_ARCHITECTURE.md`)

## 1. Baseline & Stack Selection

Per [AUDIT_REPORT.md](file:///c:/Users/Pournima/Desktop/codefronteir/AUDIT_REPORT.md), the repository at `C:\Users\Pournima\Desktop\codefronteir` started with no existing application code (`0` source files). To deliver the smallest, most reliable end-to-end implementation of the BATON five-stage workflow (**Connect → Reconstruct → Verify → Review → Handover**) without unnecessary framework complexity or fragile build chains:

| Layer | Technology Choice | Rationale |
| :--- | :--- | :--- |
| **Frontend UI** | Single-Page Application (Semantic HTML5, CSS3, Modular Vanilla ES6 JS) served statically by the backend | Zero bundler fragility, deterministic state synchronization with backend APIs, direct side-by-side provenance inspection across all 5 stages. |
| **Backend API** | Node.js HTTP/REST JSON Server (`node:http` / Express-compatible routing) | Single-command startup, deterministic middleware pipeline for RBAC, pre-AI access filtering, provenance span validation, versioning, and audit logging. |
| **Relational Database** | SQLite (`node:sqlite` / `sqlite3` relational engine with `PRAGMA foreign_keys = ON`) | Zero external daemon required for local evaluation while providing strict relational integrity, foreign keys, ACID transactions, and SQL filtering across all 12 required entity tables. |
| **AI Proposal Layer** | Pluggable Structured Proposal Adapter (`Gemini API` via REST `fetch` + deterministic local structured parser fallback) | Strictly isolated behind a deterministic pre-filter and post-validation gate. Runs offline/locally with synthetic demo data when no API key is configured, or uses Gemini when `GEMINI_API_KEY` is provided. |

---

## 2. Component Architecture Diagram

```mermaid
flowchart TB
    subgraph Client["Browser Client (SPA)"]
        UI_Auth["Role & Session Switcher (Demo RBAC + Auth Token)"]
        UI_S1["Stage 1: Connect (Projects, Members, Sources, Spans)"]
        UI_S2["Stage 2: Reconstruct (Filtered AI Extraction & Span Linking)"]
        UI_S3["Stage 3: Verify (Deterministic Provenance Check & Evidence Status)"]
        UI_S4["Stage 4: Review (PI/Reviewer Decisions & Immutable Versions)"]
        UI_S5["Stage 5: Handover (Filtered Package Publish & Incoming Acknowledgement)"]
    end

    subgraph Server["BATON Deterministic Application Server"]
        MW_Auth["Auth & RBAC Enforcement Middleware"]
        Svc_Ingest["Source Ingestion & Provenance Span Indexer"]
        Gate_PreAI["Pre-AI Access & Sensitivity Filter Gate"]
        Svc_Verify["Deterministic Provenance & Evidence Validator"]
        Svc_Review["Review & Immutable Versioning Engine"]
        Svc_Handover["Handover Assembler & Export Filter"]
        Svc_Audit["Transactional Audit Logger"]
    end

    subgraph AILayer["Untrusted AI Proposal Boundary"]
        AI_Adapter["AI Structured Proposal Service (Gemini REST / Local Extractor)"]
    end

    subgraph DB["Relational Database (SQLite - PRAGMA foreign_keys = ON)"]
        T_Core[("users, roles, projects, memberships")]
        T_Source[("sources, source_spans")]
        T_Record[("extracted_records, evidence_links")]
        T_Gov[("reviews, record_versions, handovers, audit_events")]
    end

    Client -->|HTTPS / JSON REST + Bearer Token| MW_Auth
    MW_Auth --> Svc_Ingest
    MW_Auth --> Gate_PreAI
    MW_Auth --> Svc_Verify
    MW_Auth --> Svc_Review
    MW_Auth --> Svc_Handover

    Svc_Ingest --> T_Source
    Gate_PreAI -->|1. Query ONLY accessible & permitted spans| T_Source
    Gate_PreAI -->|2. Redacted/Permitted spans only| AI_Adapter
    AI_Adapter -->|3. Candidate JSON records + span IDs| Svc_Verify
    Svc_Verify -->|4. Verify span IDs & quotes exist in DB| T_Source
    Svc_Verify -->|5. Persist valid records & evidence_links| T_Record

    Svc_Review --> T_Record
    Svc_Review --> T_Gov
    Svc_Handover -->|Filter out RESTRICTED / unapproved items| T_Record
    Svc_Handover --> T_Gov

    Svc_Ingest --> Svc_Audit
    Gate_PreAI --> Svc_Audit
    Svc_Verify --> Svc_Audit
    Svc_Review --> Svc_Audit
    Svc_Handover --> Svc_Audit
    Svc_Audit --> T_Gov
```

---

## 3. Data-Flow & Pre-AI Restricted Data Filtering Diagram

A core architectural invariant of BATON is that **inaccessible or restricted data is filtered by deterministic SQL queries and application guards BEFORE retrieval, model prompting, summarisation, and handover generation**. The AI model never receives restricted spans in its context window.

```mermaid
sequenceDiagram
    autonumber
    actor User as Authenticated User
    participant API as RBAC & Route Handler
    participant Filter as Pre-AI Access & Sensitivity Filter
    participant DB as Relational DB (SQLite)
    participant AI as AI Proposal Adapter
    participant Val as Deterministic Provenance Validator
    participant Audit as Audit Event Logger

    User->>API: POST /api/projects/:id/reconstruct (or /handovers)
    API->>DB: Verify membership & role in project (memberships + roles)
    alt Not a project member or lacks permission
        API-->>User: 403 Forbidden (logged to audit_events)
    end

    API->>Filter: Request eligible source_spans for (user_id, role, target_scope)
    Note over Filter,DB: Deterministic SQL Filter BEFORE Retrieval:<br/>1. source.project_id = :project_id<br/>2. Exclude visibility_level = 'RESTRICTED_PI_ONLY'<br/>   unless role = 'PI_LEAD' AND scope != 'HANDOVER_SHARED'<br/>3. Exclude source.exclude_from_ai = 1
    Filter->>DB: SELECT Permitted Spans Only
    DB-->>Filter: Permitted source_spans[] + excluded_source_count
    Filter->>Audit: Log AI_CONTEXT_FILTERED (included_span_ids, excluded_count)

    Filter->>AI: Prompt with ONLY permitted source_spans (ID, provenance locators, text)
    AI-->>Val: Proposed structured records[] + candidate evidence_links[]

    Note over Val,DB: Deterministic Post-AI Validation:<br/>1. Verify every span_id belongs to permitted set<br/>2. Verify verbatim_quote is an exact substring of span text<br/>3. Reject hallucinated span IDs or qualitative probability claims<br/>4. Set initial evidence_status ('UNVERIFIED' / 'PARTIAL' / 'SUPPORTED')<br/>5. Set approval_status = 'DRAFT' (separate from evidence_status)
    Val->>DB: INSERT extracted_records, evidence_links, record_versions (v1)
    Val->>Audit: Log RECONSTRUCTION_COMPLETED
    Val-->>User: 201 Created (Structured records + provenance links)
```

---

## 4. Deterministic Application vs. AI Boundary

| Responsibility | Owner | Enforcement Mechanism |
| :--- | :--- | :--- |
| **Authentication & Role Authorization** | Deterministic Code | Server-side session/token verification against `users`, `memberships`, and `roles` tables on every endpoint. |
| **Restricted Data Filtering** | Deterministic Code | SQL `WHERE` predicate in `preAiFilter.js` strips `RESTRICTED_PI_ONLY` and `exclude_from_ai = 1` sources **before** spans are loaded into memory for AI prompting, summarisation, or handover generation. |
| **Candidate Record Extraction & Summarisation** | AI Proposal Layer | Proposes candidate `record_type`, `title`, `statement`, and references to `span_id`s from the pre-filtered context. Cannot write directly to the database. |
| **Provenance Reference Validation** | Deterministic Code | Checks that each cited `span_id` exists in the permitted span set for the project, verifies the locator (`page_number`, `section_heading`/`line_start`, or `row_index`/`record_key`), and checks that `verbatim_quote` matches the source span text. |
| **Evidence Status Classification** | Deterministic Code + Verifier | Categorical enum only (`UNVERIFIED`, `WEAK`, `PARTIAL`, `SUPPORTED`, `CONTRADICTED`, `BROKEN_PROVENANCE`). **Truth-probability percentages (e.g., "87% true") are strictly prohibited and rejected by validation.** |
| **Human Approval & Review** | Deterministic Code + Reviewer Role | Stored in `extracted_records.approval_status` (`DRAFT`, `PENDING_REVIEW`, `APPROVED`, `NEEDS_REVISION`, `REJECTED`) and `reviews`. **Modifying `approval_status` never mutates `evidence_status`.** |
| **Record Versioning** | Deterministic Code | Every create, edit, verification update, or review decision writes an immutable snapshot row in `record_versions`. |
| **Audit Trail** | Deterministic Code | Every state-changing operation and access denial writes an append-only row in `audit_events` within the same database transaction. |

---

## 5. End-to-End Five-Stage Workflow Architecture

1. **Stage 1 — Connect (`/connect`):**
   - Select or create a research project, inspect project memberships/roles, upload or load synthetic permissioned research sources (`PDF_DOCUMENT`, `LAB_NOTE`, `CSV_DATASET`, `JSON_RECORDS`), set source visibility (`PROJECT_SHARED` vs. `RESTRICTED_PI_ONLY`) and AI-eligibility (`exclude_from_ai`), and automatically index granular `source_spans` with exact provenance locators (PDF page number, Markdown note section & line range, CSV/JSON row index & record key).
2. **Stage 2 — Reconstruct (`/reconstruct`):**
   - Trigger structured reconstruction over selected project sources. The server runs the Pre-AI Filter Gate, records how many restricted sources/spans were excluded, prompts the AI proposal adapter (or deterministic extractor), validates all returned span citations, and creates `extracted_records` (`CLAIM`, `METHOD`, `PROTOCOL`, `DATASET_FINDING`, `OPEN_QUESTION`, `RISK_LIMITATION`), `evidence_links`, and initial `record_versions`.
3. **Stage 3 — Verify (`/verify`):**
   - Run deterministic provenance integrity checks (verifying span existence, quote match, and multi-source corroboration) and allow authorized researchers (`PI_LEAD`, `RESEARCHER`, `REVIEWER`) to inspect exact source spans side-by-side, add/remove `evidence_links`, and set the categorical `evidence_status` (`UNVERIFIED`, `WEAK`, `PARTIAL`, `SUPPORTED`, `CONTRADICTED`, `BROKEN_PROVENANCE`) with verification notes.
4. **Stage 4 — Review (`/review`):**
   - Formal review queue for `PI_LEAD` and `REVIEWER`. Reviewers examine each record's `evidence_status` alongside its exact provenance spans and submit a review decision (`APPROVE`, `REQUEST_CHANGES`, `FLAG_GAP`, `REJECT`). Approval updates `approval_status` (e.g., to `APPROVED`) and creates a new `record_versions` snapshot **without altering `evidence_status`** (e.g., an approved record documenting a known preliminary observation with `WEAK` evidence remains `evidence_status = 'WEAK'` and displays a clear warning badge).
5. **Stage 5 — Handover (`/handover`):**
   - Assemble a versioned Handover Package for an incoming team member (`INCOMING_MEMBER`). Deterministic filtering excludes any `RESTRICTED_PI_ONLY` sources/spans from the handover summary and package items. A `PI_LEAD` publishes the package (`PUBLISHED`), and the assigned `INCOMING_MEMBER` inspects each handover item, clicks through to its exact source provenance, and submits a formal **Acknowledgement** (`ACKNOWLEDGED`) recorded in `handovers` and `audit_events`.
