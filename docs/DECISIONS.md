# Implementation decisions

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
