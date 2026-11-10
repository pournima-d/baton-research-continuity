# BATON — Role & Permission Matrix (`ROLE_PERMISSION_MATRIX.md`)

## 1. Canonical Project Roles

Every operation on a project in BATON requires an authenticated user with an active `memberships` row for that `project_id`. Authorization is enforced **deterministically on the backend server** before any database read/write or AI prompt assembly; UI visibility controls are strictly convenience mirrors of backend enforcement.

| Role ID | Role Title | Persona & Purpose | Restricted Data (`RESTRICTED_PI_ONLY`) Access |
| :--- | :--- | :--- | :--- |
| `PI_LEAD` | Principal Investigator / Lab Lead | Owns the project, manages memberships, views/uploads restricted sources, approves records, and publishes handovers. | **YES** (Direct view only; still excluded from shared AI handover extraction unless explicitly private) |
| `RESEARCHER` | Outgoing / Active Researcher | Uploads shared sources, runs AI/manual reconstruction, edits continuity records, verifies evidence, and drafts handover packages. | **NO** (Filtered out by SQL before retrieval/AI prompting) |
| `REVIEWER` | Senior Peer / Method Reviewer | Verifies evidence links against provenance spans and submits formal review decisions (`APPROVE`, `REQUEST_CHANGES`, `FLAG_GAP`, `REJECT`). | **NO** |
| `INCOMING_MEMBER` | Incoming Researcher / Student | Inspects published handover packages, verifies linked source spans, checks off onboarding items, and formally acknowledges handover receipt. | **NO** |
| `AUDITOR` | Research Integrity / Compliance Auditor | Read-only access to shared project artifacts, record version history, reviews, and the full `audit_events` log. Cannot modify any state. | **NO** |

---

## 2. Operation & Resource Permission Matrix

Legend:
- **ALLOW** — Permitted by backend RBAC middleware.
- **DENY (`403`)** — Blocked by backend RBAC middleware and logged as `ACCESS_DENIED` in `audit_events`.

| Protected Resource & Operation | Action Category | `PI_LEAD` | `RESEARCHER` | `REVIEWER` | `INCOMING_MEMBER` | `AUDITOR` | Non-Member / Unauthenticated |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Project Overview & Memberships** (`GET /api/projects/:id`) | **View** | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW | DENY (`403`/`401`) |
| **Manage Project Memberships** (`POST /api/projects/:id/memberships`) | **Edit / Admin** | ALLOW | DENY (`403`) | DENY (`403`) | DENY (`403`) | DENY (`403`) | DENY (`403`/`401`) |
| **Shared Sources & Spans** (`visibility_level = 'PROJECT_SHARED'`) | **View** | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW | DENY (`403`/`401`) |
| **Restricted Sources & Spans** (`visibility_level = 'RESTRICTED_PI_ONLY'`) | **View** | ALLOW | DENY (`403`) | DENY (`403`) | DENY (`403`) | DENY (`403`) | DENY (`403`/`401`) |
| **Upload / Ingest New Source** (`POST /api/projects/:id/sources`) | **Upload** | ALLOW | ALLOW | DENY (`403`) | DENY (`403`) | DENY (`403`) | DENY (`403`/`401`) |
| **Trigger AI / Structured Reconstruction** (`POST /api/projects/:id/reconstruct`) | **Create / Edit** | ALLOW | ALLOW | DENY (`403`) | DENY (`403`) | DENY (`403`) | DENY (`403`/`401`) |
| **Extracted Continuity Records & Versions** (`GET /api/projects/:id/records`) | **View** | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW | DENY (`403`/`401`) |
| **Create / Edit Extracted Record or Submit for Review** (`POST`/`PATCH .../records`) | **Edit** | ALLOW | ALLOW | DENY (`403`) | DENY (`403`) | DENY (`403`) | DENY (`403`/`401`) |
| **Verify Evidence Links & Set `evidence_status`** (`POST .../records/:rid/verify`) | **Verify / Edit** | ALLOW | ALLOW | ALLOW | DENY (`403`) | DENY (`403`) | DENY (`403`/`401`) |
| **Approve / Reject / Review Record (`approval_status`)** (`POST .../records/:rid/reviews`) | **Approve** | ALLOW | DENY (`403`) | ALLOW | DENY (`403`) | DENY (`403`) | DENY (`403`/`401`) |
| **View Handover Packages & Items** (`GET /api/projects/:id/handovers`) | **View** | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW | DENY (`403`/`401`) |
| **Create Draft Handover Package** (`POST /api/projects/:id/handovers`) | **Create / Edit** | ALLOW | ALLOW | DENY (`403`) | DENY (`403`) | DENY (`403`) | DENY (`403`/`401`) |
| **Publish Handover Package (`DRAFT` → `PUBLISHED`)** (`POST .../handovers/:hid/publish`) | **Publish** | ALLOW | DENY (`403`) | DENY (`403`) | DENY (`403`) | DENY (`403`) | DENY (`403`/`401`) |
| **Check Off Handover Item Provenance** (`POST .../handovers/:hid/items/:iid/check`) | **Acknowledge Prep** | ALLOW | DENY (`403`) | DENY (`403`) | ALLOW | DENY (`403`) | DENY (`403`/`401`) |
| **Acknowledge Published Handover (`PUBLISHED` → `ACKNOWLEDGED`)** (`POST .../acknowledge`) | **Acknowledge** | DENY (`403`)* | DENY (`403`) | DENY (`403`) | ALLOW | DENY (`403`) | DENY (`403`/`401`) |
| **View Security & Workflow Audit Log** (`GET /api/projects/:id/audit-events`) | **View Audit** | ALLOW | DENY (`403`) | DENY (`403`) | DENY (`403`) | ALLOW | DENY (`403`/`401`) |

*\*Note on Handover Acknowledgement:* Only the designated `INCOMING_MEMBER` recipient may formally acknowledge receipt of a published handover package so that a Principal Investigator or outgoing researcher cannot self-acknowledge on behalf of the incoming team member.

---

## 3. Data-Filtering & Governance Rules Tied to Permissions

1. **Pre-AI & Pre-Handover Restricted Filtering:**
   - Sources marked `visibility_level = 'RESTRICTED_PI_ONLY'` or `exclude_from_ai = 1` are **deterministically excluded at the SQL query layer** before `POST /api/projects/:id/reconstruct` or `POST /api/projects/:id/handovers` passes any text to the AI adapter or summary generator—even when invoked by a `PI_LEAD`. This guarantees restricted data never leaks into shared continuity records or handover packages.
2. **Separation of Verification (`evidence_status`) and Approval (`approval_status`):**
   - `RESEARCHER`, `REVIEWER`, and `PI_LEAD` may verify provenance links and update `evidence_status` (`UNVERIFIED`, `WEAK`, `PARTIAL`, `SUPPORTED`, `CONTRADICTED`, `BROKEN_PROVENANCE`).
   - Only `REVIEWER` and `PI_LEAD` may submit review decisions that transition `approval_status` (`APPROVED`, `NEEDS_REVISION`, `REJECTED`).
   - An `APPROVE` decision **never upgrades or modifies** `evidence_status`. If a record has `evidence_status = 'WEAK'` and is approved (e.g., to document an unconfirmed anomaly for the incoming student to watch out for), it remains `evidence_status = 'WEAK'` and `approval_status = 'APPROVED'`.
3. **Audit Logging on Every Denial:**
   - Any attempt by an unauthorized role to invoke a restricted endpoint or read a `RESTRICTED_PI_ONLY` source span writes an `ACCESS_DENIED` event into `audit_events` with the actor's `user_id`, `role_id`, target route, and timestamp.
