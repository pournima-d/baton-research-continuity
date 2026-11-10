# BATON — Third-Party & Resource Disclosure Draft (`DISCLOSURE_DRAFT.md`)

This document tracks all candidate external APIs, AI models, open-source libraries, UI templates, hosting environments, datasets, and credentials planned for BATON Round 2 so they can be verified before final submission.

---

## 1. External APIs & AI Models

| Resource / Service | Provider | Model / Endpoint | Role in BATON | Paid / Free Tier & Credential Status | Offline / Local Fallback |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Google Gemini API** (Optional Candidate) | Google DeepMind / Google AI Studio | `gemini-2.5-flash` via HTTPS REST (`generativelanguage.googleapis.com`) | Stage 2 (Reconstruct) structured candidate extraction and Stage 5 executive summary drafting over **pre-filtered, non-restricted** source spans. | Uses environment variable `GEMINI_API_KEY` (Free tier or paid API key via `.env`, never committed to Git). **Status: Optional / Verify if API key will be used in live demo.** | **Yes (Built-in):** Deterministic local structured extraction engine parses permitted spans and proposes candidate records with exact span IDs when `GEMINI_API_KEY` is unset. |

> **Governance Guarantee:** Whether using the Gemini REST API or the deterministic local extractor, restricted sources (`visibility_level = 'RESTRICTED_PI_ONLY'` or `exclude_from_ai = 1`) are filtered out by SQL **before** prompt construction, and deterministic application code validates all returned span references and enforces RBAC, reviews, versioning, and audit logging.

---

## 2. Runtime & Libraries

| Package / Module | Version / Source | License | Purpose | Verification Status |
| :--- | :--- | :--- | :--- | :--- |
| **Node.js Built-in Runtime Modules** (`node:http`, `node:sqlite`, `node:crypto`, `node:fs`, `node:path`, `node:test`) | Node.js v22+ Standard Library | MIT | HTTP/REST API server, relational SQLite database (`DatabaseSync`), SHA-256 content hashing, static asset serving, and automated integration test runner. Zero external npm dependencies required for core operation. | Verified (Standard open-source runtime) |
| **SQLite Engine** | Bundled in `node:sqlite` (SQLite 3.x) | Public Domain | Relational storage with `PRAGMA foreign_keys = ON` for all 12 BATON domain tables. | Verified |
| **Frontend UI (`public/`)** | Custom-written HTML5, CSS3, Vanilla ES6 JS | Project-authored | Single-Page Application implementing Connect → Reconstruct → Verify → Review → Handover. | Verified (100% first-party code) |

---

## 3. UI Templates, Design Assets & Fonts

| Asset Type | Details | License / Origin |
| :--- | :--- | :--- |
| **UI Layout & CSS** | Custom-authored responsive CSS (`public/styles.css`) built specifically for BATON Round 2. No third-party Bootstrap/Tailwind/commercial UI templates used. | First-party |
| **Typography** | System UI font stack (`system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace`) — zero external font CDN requests required. | OS built-in |
| **Icons / Badges** | Inline SVG icons and semantic CSS badges. | First-party |

---

## 4. Datasets & Demo Content

| Dataset | Origin | Confidentiality / Permission Status |
| :--- | :--- | :--- |
| **Solid-State Li-Garnet Electrolyte Continuity Dataset** (Seeded in `server/db/seed.js`) | 100% Synthetic research data authored specifically for the BATON Round 2 demonstration (synthetic PDF sintering report pages, synthetic glovebox Markdown lab notes, synthetic CSV conductivity rows, and a synthetic `RESTRICTED_PI_ONLY` pre-patent note). | **Synthetic / Non-Confidential.** Contains zero real/proprietary/confidential research group data or human-subject data. |

---

## 5. Hosting & Deployment Configuration

| Environment | Planned Setup | Paid Credentials Required? |
| :--- | :--- | :--- |
| **Primary Evaluation Target** | Local execution (`localhost:3000`) with local relational SQLite file (`data/baton.db`). | **No.** Runs completely locally without cloud accounts or paid credentials. |
| **Optional Cloud Hosting** | Can be deployed to Render / Railway / Fly.io as a single Node.js service with a persistent volume for `data/baton.db` if a hosted preview URL is desired. | None required for local evaluation; verify if team intends to attach a hosted URL for judging. |

---

## 6. Pre-Submission Verification Checklist

- [ ] Confirm whether `GEMINI_API_KEY` will be supplied in `.env` during live judging or if the deterministic local extraction mode will be used (both modes pass identical pre-AI filtering and post-AI provenance validation).
- [ ] Confirm no `.env` file or secret credential is tracked by Git (`.gitignore` excludes `.env` and `*.db`).
- [ ] Confirm no external private-system integrations (Slack, Discord, institutional SSO, live chat monitoring) are included.
