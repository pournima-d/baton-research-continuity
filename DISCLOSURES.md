# BATON — Verified Technical & Resource Disclosures (`DISCLOSURES.md`)

**Project:** BATON — Research Continuity Platform (Round 2)  
**Team:** Team Kernel  
**Last Verified:** 2026-11-11

This document discloses all actual APIs, AI models/providers, libraries, UI templates, hosting configurations, databases, datasets, and AI coding tools used in BATON Round 2. No unverified tools are listed.

---

## 1. AI Models, Extraction Engine & External APIs

| Component | Provider / Implementation | Version / Identifier | How It Is Used in BATON | Verification & Fallback Status |
|---|---|---|---|---|
| **Deterministic Structured Span Reconstructor (Active Default)** | First-party (`server/services/aiReconstructor.js`) | `baton-local-deterministic` / `heuristic-span-reconstructor-v2` (`2.5.0`) | Parses pre-filtered (`PROJECT_SHARED`, `exclude_from_ai = 0`) source spans into structured continuity records (`OBJECTIVE`, `DECISION`, `EXPERIMENT`, `RESULT`, `TASK`, `RISK`, `DEPENDENCY`, `QUESTION`, `CONTACT`, `GAP`, `RECURRING_PROBLEM`), strips prompt-injection instructions, and computes continuity edges (`CONFLICTS_WITH`, `EVIDENCE_CORROBORATES`, `ADDRESSES_GAP`). | **Verified & Active in all 64 automated tests.** Runs 100% locally and offline with zero external API keys required. |
| **Google Gemini API (Optional Configurable Provider)** | Google AI Studio (`GEMINI_API_KEY` / `GEMINI_MODEL` in `server/config.js`) | `gemini-2.5-flash` | Optional environment configuration hook. In all cases, restricted sources are filtered out by SQL before context construction, and deterministic backend code validates every span citation, evidence status, and review state. | **Optional (Not required for local or offline operation).** |
| **Browser MediaDevices API (Stage 09 Optional Step-Up)** | Standard W3C Browser API (`navigator.mediaDevices.getUserMedia`) | Browser built-in | Used only if the user explicitly selects the optional camera-assisted step-up route in `public/app.js`. | **Honest Capability Disclosure:** Browser camera permission only means a local camera stream was made available. It does **NOT** perform facial recognition, verify identity, prove who is present, or prove liveness. The authenticated session + MFA/passkey code remain the security control. Zero images, video, or biometric data are recorded, uploaded, or stored (`media_stored = 0`). |

---

## 2. Runtime, Database & Libraries

| Layer | Technology | Version / License | Purpose |
|---|---|---|---|
| **Backend Runtime** | Node.js Standard Library (`node:http`, `node:sqlite`, `node:crypto`, `node:fs`, `node:path`, `node:url`, `node:events`, `node:test`, `node:assert/strict`, `node:vm`) | Node.js `v22.14.0` (MIT) | HTTP REST server, SQLite database driver, `scrypt` password hashing, SHA-256 content & token hashing, static asset serving, and automated test suite runner. |
| **Third-Party npm Packages** | **None (`0` external npm packages)** | N/A | BATON has zero third-party `node_modules` runtime dependencies, eliminating supply-chain dependency bloat and ensuring deterministic execution. |
| **Relational Database** | SQLite (`DatabaseSync` via `node:sqlite`) | SQLite 3.x (Public Domain) | Persistent relational storage (`data/baton.db`) with `PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL`, 7 SQL migrations, 19 tables, and immutable `BEFORE UPDATE`/`BEFORE DELETE` triggers on `audit_events`. |
| **Frontend Application** | Vanilla HTML5, CSS3, and ES6 JavaScript (`public/index.html`, `public/styles.css`, `public/app.js`) | First-party | 7-screen research continuity workspace with accessible Continuity Map table alternative and RBAC persona switcher. |

---

## 3. UI Templates, Styling & Fonts

- **UI Templates:** None. All HTML layouts and CSS rules (`public/index.html`, `public/styles.css`) were written from scratch for BATON Round 2. No Bootstrap, Tailwind, Material UI, or commercial themes were used.
- **Fonts:** Native OS system font stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` and monospace stack). No external Google Fonts or CDN requests are made.

---

## 4. Datasets & Demo Content

- **Synthetic Demo Dataset (`server/db/seed.js` & `tests/e2e_reliability_stage10.test.js`):** 100% synthetic research data modelling a solid-state lithium-garnet (`Ta-doped Li7La3Zr2O12`) electrolyte continuity workflow. Contains zero real, proprietary, confidential, or human-subject research data.

---

## 5. Hosting & Deployment Status

- **Local Production Server (`http://127.0.0.1:3000`):** Verified and tested end-to-end across all 11 workflow steps (`64/64` automated tests passing across 9 test suites).
- **Cloud Container & Blueprint Configuration (`Dockerfile`, `render.yaml`):** Included in repository root for single-service deployment with persistent disk storage (`/var/data`).
- **External Public Cloud URL:** **Not claimed / Not deployed from sandboxed build environment** (in compliance with Stage 11 rules: *"Do not claim deployment until the public URL has been opened and tested from a clean browser session"*).

---

## 6. Significant AI Tools Used During Development

- **Google DeepMind Antigravity (AI Pair-Programming Assistant):** Used inside the local workspace (`c:\Users\Pournima\Desktop\codefronteir`) to architect, implement, test, debug, and document BATON Stages 00 through 11 following the stage build instructions.
