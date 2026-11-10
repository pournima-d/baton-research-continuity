# BATON — Team Contributions (`CONTRIBUTIONS.md`)

**Project:** BATON — Research Continuity Platform (Round 2)  
**Team:** Team Kernel  
**Date:** 2026-11-11

This document records the actual contributions made during the BATON Round 1 design and Round 2 implementation phases.

---

## 1. Team Kernel (Project Author / Developer — Pournima)

- **Round 1 Problem Formulation & Workflow Design:**
  - Defined the core research continuity problem for academic research labs and student teams (preventing knowledge loss during member transitions).
  - Formulated the five-stage workflow architecture (**Connect → Reconstruct → Verify → Review → Handover**) and core governance principles (separating epistemic evidence status from human review approval, pre-AI restricted source filtering, and non-fabricated `UNKNOWN` ownership/deadline handling).
- **Round 2 Stage Orchestration, Specification & Verification:**
  - Directed the 12-stage Round 2 build sequence (Stages 00 through 11), supplying the stage specifications, reviewing each stage's architectural artifacts, database schema migrations, security controls, and test outputs, and validating stage-by-stage completion criteria.

---

## 2. AI Pair-Programming Assistant Disclosure (Google DeepMind Antigravity)

- Executed pair-programming implementation under user direction across the workspace (`c:\Users\Pournima\Desktop\codefronteir`):
  - **Architecture & Governance Specs (Stages 00–01):** Authored `AUDIT_REPORT.md`, `SYSTEM_ARCHITECTURE.md`, `DATA_MODEL.md`, `API_PLAN.md`, `ROLE_PERMISSION_MATRIX.md`, `IMPLEMENTATION_PLAN.md`, and `DISCLOSURE_DRAFT.md`.
  - **Backend & Relational SQLite Database (Stages 02, 04–09):** Implemented 7 SQLite migrations (`001`–`007` creating 19 relational tables), `server/app.js`, `server/middleware/authRbac.js`, `server/services/storageService.js`, `server/services/spanIndexer.js`, `server/services/aiReconstructor.js`, `server/services/evidenceInspector.js`, `server/services/handoverService.js`, `server/services/stepUpService.js`, and `server/services/auditService.js`.
  - **Frontend Workspace (Stage 03 & Stages 04–09 UI):** Implemented `public/index.html`, `public/styles.css`, and `public/app.js` across all 7 workspace views and the accessible Continuity Map table view.
  - **Automated Verification & Submission Artifacts (Stages 02–11):** Authored and executed the 9 automated test suites (`64/64` passing subtests), `TEST_REPORT.md`, `SECURITY_NOTES.md`, `DISCLOSURES.md`, `ROUND2_EVIDENCE.md`, and `BATON_ROUND2_SUBMISSION.pdf`.
