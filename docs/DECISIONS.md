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
