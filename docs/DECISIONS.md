# Implementation decisions

## 2026-10-17 — Admin and billing audit baseline

- Work starts on `feature/admin-billing`, branched from the checked-out local `main`. The remote `feature/ai-suite` branch exists and differs substantially, including database-file changes and removals in `server.js`; do not merge it blindly. The current checkout already contains several feature-suite modules, so feature keys will be derived from actual code and later reconciled with that branch.
- Keep the existing SQLite WAL/SHM working-tree modifications out of commits. Treat `.env`, DB files, and backups as private local state.
- The project currently uses versioned, backup-aware migrations, but historical migration v2 drops tables/columns. Preserve historical migration behavior for installations that already applied it; new billing migrations must be additive and idempotent. Decide separately how an installation that has not yet applied v2 is protected before any production upgrade.
- Baseline `npm test` on the provided environment (Node v26.7.0) has 4 failures among 17 tests: two alert decision assertions, one Gemini fallback assertion, and the migration test expects version 2 while the runner applies 3 migrations. `npm run build` passes. These failures predate billing changes and must be resolved/understood before the phase is considered verified.
- The brief describes Node 24, while the provided environment runs Node 26.7.0. Validate supported runtime compatibility before release.

### Status

- Phase 0: `docs/ADMIN_AUDIT.md` added. It records current architecture, code-declared schema, major provider boundaries, auth model, scheduler, tests, working-tree protections, and a migration safety finding. Live DB schema was not queried because opening the active SQLite database could affect its pre-existing WAL/SHM state; a safe read-only schema inspection remains required.
- Verification: baseline `npm test` fails 4/17; baseline `npm run build` passes.

## 2026-10-17 — Phase 1 foundation

- Added additive migration v4 for separate admin identities/sessions/recovery codes, login attempt tracking, append-only admin audit rows, plan catalog and versioned prices, limits/features, rate cards, immutable usage events and rollups, subscriptions/events, invoices/lines, payments/refunds/credits, coupons, expenses, settings, notices, organization billing details, resource snapshots, and soft-delete metadata.
- Existing organizations receive a hidden zero-price Legacy subscription and generous unlimited limits. Basic, Pro, and ProMax are hidden editable sample plans with explicitly sample limits and zero sample prices. Public plans must be explicitly activated after operators configure real amounts and rates.
- Added money arithmetic, GSM-7/UCS-2 SMS segmentation, feature registry, permission matrix, encrypted TOTP primitives, audit redaction, quota/state helpers, and failure-safe idempotent metering. Added `/admin` UI with separate login, TOTP enrollment (secret/URI instructions), recovery-code display, overview, organization list, plans, audit, and session views. Plan create/update APIs preserve price versions and default to keeping existing subscriber prices.
- Added the `npm run admin:create` bootstrap command. It requires an interactive terminal, a strong password, and `ADMIN_ENCRYPTION_KEY`; then the first sign-in requires TOTP enrollment. This UI currently displays the secret/otpauth URI for manual authenticator setup; QR rendering is still outstanding.
- Historical migration v2 was destructive for databases that had not yet applied it. It has been made a no-op while retaining the version number; the migration runner still adds its compatibility columns and no longer deletes tables, columns, settings, or data. Databases that already applied v2 remain unchanged. This is deliberate to honor additive-only upgrades.
- Fixed two alert-path behaviors uncovered by the baseline suite: a successful AI skip can no longer suppress a deterministic floor alert, and AI tests now explicitly enable the AI decision layer. The empty AI result test now uses an empty eligible-worker set, matching strict output validation.
- Phase 1 verification on Node v26.7.0: `npm test` passes 25/25 including a temporary-database admin-auth integration test; `npm run build` passes. Runtime Node 24 compatibility is still unverified.

### Status

- Phase 0: audit documented; the active SQLite file was not opened. A truly read-only live schema inventory is still required.
- Phase 1: foundation delivered; remaining items include admin account management UI/API, QR enrollment, admin password reset, stronger re-auth action wiring, and security review.
- Phase 2 and later: provider metering is not yet wired into real SMS/AI/weather/geocoding/email/voice paths; rate editing, rollup jobs, entitlements, billing lifecycle, payments, customer pages, admin modules, deletion workflows, analytics, smoke/seed tools, and complete operating docs remain outstanding.

## 2026-10-14 — Initial audit and scope

- Preserve the existing emergency digit parser and its precedence. New SMS commands must never claim digit-only messages.
- Keep Open-Meteo historical forecast data distinct from reanalysis in nowcast training/evaluation; historical forecast coverage begins around 2021 and is the suitable source for issued-forecast baselines. Reanalysis alone cannot prove forecast skill.
- Thresholds and first-aid wording remain decision-support guidance and require occupational-health and native Bangla review before deployment.
- Existing `jibonguard.sqlite3-wal`, `jibonguard.sqlite3-shm`, and untracked `Help.txt` predate this work. Preserve them and exclude database artifacts from Git.

## Status

- Phase 0: repository audit documented in `docs/AUDIT.md`.
- Phase 1 remaining: the shared consent-aware SMS queue helper and ordered inbound SMS command router are not implemented. The job runner wraps the legacy alert tick but broader feature jobs are not registered.
- Phase 3: partial only. Feature engineering and inference fallback helpers exist. There is no resumable data collection/training/evaluation CLI, live observation loop, backfill/scoring job, site nowcast card, or model-evidence page. No performance metrics are claimed.
- Phases 4–7 and cross-feature UI integration remain unimplemented beyond the helper modules described above.
- Verification so far: `npm test` passed 18 tests and `npm run build` passed after the foundation and initial dashboard integration. These checks do not establish completion of the requested end-to-end workflows.
