# BATON — Research Continuity Platform (Round 2)

BATON is a research continuity platform for research groups and student teams implementing the five-stage source-to-handover workflow:
**Connect → Reconstruct → Verify → Review → Handover**.

---

## 1. Prerequisites

- **Runtime:** Node.js `>= 22.5.0` (built-in `node:sqlite`, `node:http`, `node:crypto`, `node:test`, `node:vm`).
  - A portable Node.js `v22.14.0` binary is bundled in `.runtime\node.exe` on Windows, or use a system `node` (`>= 22.5.0`) installation.
- **External npm Dependencies:** None (`0` external npm packages required; 100% standard library + first-party code).

---

## 2. Environment Variables (`.env.example`)

Copy `.env.example` to `.env` for local overrides. Never commit `.env` or secret keys.

| Environment Variable | Default Value | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP server listening port |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker/cloud) | Bind address for the HTTP server |
| `DB_PATH` | `./data/baton.db` | Relational SQLite database file path |
| `PRIVATE_STORAGE_DIR` | `./storage/private_uploads` | Private source upload storage directory (outside `public/`) |
| `MAX_UPLOAD_BYTES` | `2097152` (`2 MB`) | Maximum allowed byte size per source upload |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Comma-separated list of permitted CORS origins |
| `AUTO_SEED_IF_EMPTY` | `true` | Automatically seeds synthetic demo dataset if `users` table is empty on boot |
| `GEMINI_API_KEY` | *(empty — uses deterministic local extractor)* | Optional Gemini API key (`gemini-2.5-flash`) |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Configured model identifier when `GEMINI_API_KEY` is provided |

---

## 3. Local Setup, Migrations, Seed Data & Running the Server

### 3.1 Clean Database Migration (7 Migrations → 19 Relational Tables)
```powershell
.\.runtime\node.exe server/db/migrate.js --clean
```
Applies migrations in order:
1. `001_initial_schema.sql`
2. `002_stage04_connect_ingestion.sql`
3. `003_stage05_reconstruct_continuity_map.sql`
4. `004_stage06_verify_evidence_inspector.sql`
5. `005_stage07_review_and_handover.sql`
6. `006_stage08_security_and_audit.sql`
7. `007_stage09_optional_step_up.sql`

### 3.2 Seed Synthetic Permissioned Demo Data
```powershell
.\.runtime\node.exe server/db/seed.js
```
Seeds project `prj_solidstate_01` (*Solid-State Li-Garnet (LLZO) Electrolyte Interface Continuity*), 5 project roles, 6 demo users, 3 `PROJECT_SHARED` sources (`src_pdf_01`, `src_note_01`, `src_csv_01`), 1 `RESTRICTED_PI_ONLY` source (`src_restricted_01`), and initial continuity records.

### 3.3 Run All 9 Automated Test Suites (`64/64` Tests)
```powershell
.\.runtime\node.exe --test tests/backend.test.js tests/frontend.test.js tests/connect_ingestion.test.js tests/reconstruct_stage05.test.js tests/verify_stage06.test.js tests/review_handover_stage07.test.js tests/security_audit_stage08.test.js tests/camera_step_up_stage09.test.js tests/e2e_reliability_stage10.test.js
```

### 3.4 Start the Application Server
```powershell
.\.runtime\node.exe server/index.js
```
- **Workspace UI:** `http://127.0.0.1:3000/`
- **Health Check:** `http://127.0.0.1:3000/api/health`

---

## 4. Safe Demo Evaluation Access (RBAC Personas)

The workspace header includes an interactive **Active Role / Session** switcher for local judging and evaluation. No real/privileged credentials exist in the repository.

| Role | Demo User | Email | Demo Bearer Token | Capabilities |
|---|---|---|---|---|
| `PI_LEAD` | Dr. Elena Vance (PI) | `elena.vance@baton-lab.edu` | `tok_pi_lead_01` | Full project governance, restricted source access, record approval, handover publication |
| `RESEARCHER` | Marcus Chen | `marcus.chen@baton-lab.edu` | `tok_researcher_01` | Upload shared sources, run reconstruction, edit candidate records, assemble draft handovers |
| `REVIEWER` | Dr. Priya Nair | `priya.nair@baton-lab.edu` | `tok_reviewer_01` | Verify evidence citations, flag citation errors, submit review decisions (`APPROVE`, `REJECT`, `REQUEST_CHANGES`, `FLAG_GAP`) |
| `INCOMING_MEMBER` | Aria Patel | `aria.patel@baton-lab.edu` | `tok_incoming_01` | Inspect published role-filtered handovers, check off provenance items, acknowledge handover receipt |
| `AUDITOR` | Jordan Lee | `jordan.lee@baton-lab.edu` | `tok_auditor_01` | Read-only inspection of shared records, version history, step-up events, and append-only `audit_events` |
| `NON_MEMBER` | Alex Rivera | `alex.rivera@external.org` | `tok_outsider_01` | Blocked across all project endpoints (`403 FORBIDDEN_ROLE`) |

*(For `POST /api/auth/login` session cookie testing, the seeded demo password is `BatonDemoPass!2026`; for Stage 09 step-up verification, the demo MFA code is `654321`.)*

---

## 5. Architecture Overview

- **Frontend (`public/index.html`, `public/styles.css`, `public/app.js`):** 7-screen institutional research continuity workspace (`Overview`, `Sources`, `Continuity Map`, `Records & Evidence`, `Review Queue`, `Handover`, `Activity / Audit`) plus an accessible table alternative for the Continuity Map and an optional Stage 09 Step-Up Verification panel.
- **Backend (`server/app.js`, `server/middleware/authRbac.js`, `server/services/`):**
  - `storageService.js` & `spanIndexer.js` (Stage 04 Connect): Validates uploads, stores private blobs outside `public/`, detects scanned PDFs (`NEEDS_OCR`) and duplicates (`409 DUPLICATE_SOURCE`), flags prompt-injection strings, and indexes exact `PDF_PAGE`, `NOTE_SECTION`, `CSV_ROW`, and `JSON_RECORD` provenance spans.
  - `aiReconstructor.js` (Stage 05 Reconstruct): Enforces **SQL pre-filtering** (`visibility_level = 'PROJECT_SHARED' AND exclude_from_ai = 0`) before extraction, separates `direct_source_statement` from `ai_summary_or_inference`, preserves `null` (`UNKNOWN`) for missing owners/dates/rationale, and builds evidence-backed continuity edges (`CONFLICTS_WITH`, `EVIDENCE_CORROBORATES`, `ADDRESSES_GAP`).
  - `evidenceInspector.js` (Stage 06 Verify): Evaluates the 6 canonical evidence states (`SUPPORTED`, `CONFLICTING`, `UNSUPPORTED`, `STALE`, `NEEDS REVIEW`, `NOT ESTABLISHED`), enforces exact verbatim quote resolution, and automatically downgrades claims if citations are flagged or corrupted.
  - `handoverService.js` (Stage 07 Review & Handover): Enforces that only `APPROVED` records bound to `approved_version === current_version` can enter a handover package, invalidates approval upon post-approval edits, generates the 6-section Continuation Plan with `UNKNOWN` labels, filters restricted items server-side, and records versioned recipient receipt acknowledgements.
  - `stepUpService.js` (Stage 09 Optional Step-Up): Risk-triggered step-up verification with an equivalent non-camera MFA/passkey route, zero image/video/biometric storage (`CHECK (media_stored = 0)`), and honest capability disclaimers.

---

## 6. Deployment Configuration (`Dockerfile` & `render.yaml`)

- **Container Deployment (`Dockerfile`):** Uses `node:22-alpine`, mounts `/var/data` for persistent SQLite (`DB_PATH=/var/data/db/baton.db`) and private uploads (`PRIVATE_STORAGE_DIR=/var/data/private_uploads`), runs migrations and auto-seeding on startup, and exposes `/api/health`.
- **Render Blueprint (`render.yaml`):** Configures a single Node.js web service with a 1 GB persistent disk at `/var/data`, `/api/health` readiness check, and environment variables (`ALLOWED_ORIGINS`, `GEMINI_API_KEY` as secret).
