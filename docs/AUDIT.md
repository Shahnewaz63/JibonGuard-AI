# JibonGuard AI repository audit

Audit performed 2026-10-14 against the current `feature/ai-suite` checkout. The database file was not opened for writing.

## Architecture

- React 19 with Vite 8 in `src/App.jsx`, `src/main.jsx`, and `src/app.css`.
- A single Express 5 API in `server.js`; it uses Node's built-in synchronous `node:sqlite` `DatabaseSync` and the `jibonguard.sqlite3` file.
- ES modules are enabled by `package.json`. Existing tests use Node's built-in `node:test` runner.
- Vite serves the UI on `127.0.0.1:5173` and proxies `/api` to Express on port 8000. `npm start` builds then starts the API.

## Database and migrations

The startup SQL in `server.js` creates `organizations`, `users`, `sessions`, `action_tokens`, `workers`, `sites`, `worker_consent_events`, `break_logs`, `sms_messages`, `sms_sync_state`, `alert_settings`, and `automated_alerts`. It adds indexes for session expiry, consent history, workers, breaks, SMS, and alert dispatch. Startup also performs ad hoc additive `ALTER TABLE` checks for worker, site, break, and SMS columns and backfills worker `site_id` values by creating missing sites.

There is no versioned migration framework. A live SQLite schema inspection was not completed during this audit; the table list above is from the startup schema declarations, not a verified inventory of every column in the current database file.

## Alert and SMS flow

- Alert logic is split among `server/alerts/config.js`, `index.js`, `decision.js`, `templates.js`, `gateway.js`, and `ai.js`.
- Organization alert settings are stored in `alert_settings` as JSON plus enabled flags. `automated_alerts` stores decisions and delivery state, including a decision input context and whether a deterministic floor applied.
- Deterministic rules are evaluated alongside optional Gemini decisions; validated Bangla templates are rendered and grouped for dispatch. Consent is checked before routine worker delivery. SMS dispatch uses TextBee; optional voice dispatch can fall back to SMS.
- Inbound SMS history is synchronized from TextBee by the authenticated `/api/sms` route and by a server polling loop. Incoming digit-only emergency messages are matched to worker phone/site and trigger the existing site emergency behavior. Emergency codes accept English and Bangla digits. The SMS polling and emergency parser live in `server.js`.
- Worker registration messages include emergency instructions. No acknowledgement/check-in keyword flow or symptom triage flow exists yet.

## Weather, AI, and scheduler

- Weather and geocoding integrations are implemented in `server.js` using Open-Meteo and Photon/Nominatim.
- Gemini use is currently split between dashboard chat/break suggestions in `server.js` and alert decisions in `server/alerts/ai.js`; there is no shared AI client or `ai_calls` audit table.
- Alert automation is controlled by environment configuration and organization settings. A periodic server timer evaluates sites, queues decisions, and dispatches due records. Alert tests cover decision and guardrail behavior in `server/alerts/automation.test.js`.
- There is no shared job runner, persistent job-run status, nowcast model/training pipeline, official advisory ingestion, medical triage, or generated safety report pipeline.

## Security and data scope

- Authentication uses server-side SQLite sessions and salted scrypt password hashes.
- Mutating API routes use the CSRF token plus request-origin middleware. Authenticated reads and writes generally scope queries to `req.user.organization_id`; new endpoints must follow this pattern and validate ownership of referenced site/worker IDs.
- A small in-memory IP-based rate limiter exists. New SMS-related endpoints and polling work need explicit abuse protection and loop prevention.
- `.env` is ignored. The current `.gitignore` does not ignore SQLite database/WAL/SHM files, which are currently modified/untracked in the working tree and must not be committed.

## UI, routes, and conventions

- The dashboard is a single hash-routed React component in `src/App.jsx`, with views for overview, workers, sites, breaks, alerts, automation, SMS, and a basic reports snapshot.
- API routes are declared directly in `server.js`. Components use local state and shared `api`/`post` helpers; styling is in one `src/app.css` file.
- Code style is compact ES module JavaScript, built-in Node modules where possible, inline Express handlers, and Node's built-in test runner. Avoid introducing another framework.

## Existing test setup

`npm test` runs `node --test server/alerts/*.test.js`. There is no frontend test runner, API integration harness, smoke command, training/evaluation command, or test database harness in the current scripts.

## Working tree note

At audit time, the pre-existing working tree had changes to `jibonguard.sqlite3-shm` and `jibonguard.sqlite3-wal`, plus untracked `Help.txt`. These were present before implementation and should be preserved; neither belongs in a feature commit.
