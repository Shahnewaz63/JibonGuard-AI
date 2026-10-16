# Administration and billing implementation audit

Audit date: 2026-10-17 (Asia/Dhaka)

## Scope and repository state

The target repository is `JibonGuard-AI`. This checkout is on `feature/admin-billing`, created from the local `main` branch. A remote `feature/ai-suite` exists; it was not checked out or merged. The working tree already contained modifications to `jibonguard.sqlite3-shm` and `jibonguard.sqlite3-wal` before this task. Preserve these files and do not stage or commit them. `.env` and the SQLite database are sensitive local data and must not be read into reports or committed.

## Architecture and routing

- React 19 and Vite 8 frontend: `src/App.jsx`, `src/main.jsx`, `src/app.css`.
- Express 5 API and static serving: `server.js`; Node ES modules, built-in `node:sqlite` synchronous database.
- Vite proxies `/api` to the API on port 8000. Development uses Vite on 5173. `npm start` builds then starts the server.
- API endpoints are declared inline in `server.js`; the UI is a single hash-routed app. Existing React routes are configured in `vite.config.js`.
- Current dashboard workflows cover organizations' own workers, sites, breaks, alert automation/history, SMS history, and reports. No admin route or admin UI exists in the inspected route list.

## Authentication and authorization

Organization users have the `organization_owner` role. Passwords use salted scrypt; session tokens are stored as hashes in SQLite. Login uses email OTP challenges; reset/verification use action tokens. Mutations use CSRF and origin checks, and authenticated handlers generally scope records by `req.user.organization_id`. The current model has no separate admin identity, admin session, permission matrix, TOTP, or admin audit trail. Organization sessions must not be accepted by any future `/api/admin/*` route.

## Existing database

Startup schema declarations in `server.js` include: `organizations`, `users`, `sessions`, `action_tokens`, `auth_otp_challenges`, `workers`, `sites`, `worker_consent_events`, `break_logs`, `scheduled_break_sms`, `sms_messages`, `sms_sync_state`, `alert_settings`, `automated_alerts`, and feature-suite tables. The database also has additive schema migrations in `server/db/migrations.js`, including `schema_migrations`, feature flags, AI-call/job records, nowcast, break planner, triage, report, and SMS deletion-marker tables. This is a code-declaration inventory, not a live `sqlite_master` inspection; the local DB was not opened for this audit. The migration runner backs up an existing DB in development before each migration.

Important migration finding: migration v2 originally dropped advisory tables, settings, and worker columns. In this implementation it has been changed to a no-op for databases that encounter it for the first time, while retaining the version number and the old additive compatibility-column additions. Already-migrated databases are unaffected. This avoids repeating the destructive path on a new upgrade; installations that already lost data from v2 cannot recover that data through this migration.

## External service and metering locations

Search identified the following integration families; a line-by-line call-site inventory still needs completion before instrumenting them:

- TextBee outbound and inbound polling, SMS sync, emergency replies, worker registration, break reminders, and automated alerts: `server.js`, `server/alerts/gateway.js`, and alert dispatch in `server/alerts/`.
- Gemini dashboard chat and break suggestions: `server.js`; alert decision helper: `server/alerts/ai.js`; shared client: `server/ai/geminiClient.js`.
- Open-Meteo weather and Photon/Nominatim geocoding: `server.js`; automated alert jobs also request weather through server helpers.
- SMTP email for authentication and account messages: `server.js` using Nodemailer.
- Optional voice adapter is configured via environment variables; inspect exact active call sites and whether voice is operational before metering.

The metering implementation must cover each actual provider boundary, capture provider response usage/status where available, and fail open so recording errors do not interrupt safety actions. SMS retries need stable idempotency keys. Usage metadata must exclude PII.

## Scheduler and job execution

Alert automation uses periodic timers in `server.js`. `server/jobs/runner.js` and job-run tables provide a feature-suite foundation. Inbound TextBee polling is periodic. Billing jobs, distributed/DB locking review, per-organization isolation, run-status coverage, and idempotent renewal behavior are not present as a complete billing scheduler.

## Existing tests and scripts

`package.json` defines `npm test` as Node's built-in test runner over `server/alerts/*.test.js` and `server/features.test.js`; `npm run build` invokes Vite. There is no admin/billing test harness, smoke script, seed script, or admin CLI. Existing alert tests cover deterministic rules and safety guardrails. The brief's requested new money, segmentation, auth, RBAC, quota, billing, payment, audit, and deletion tests remain to be implemented.

## Current limitations relevant to the brief

- No separate admin authentication, roles, 2FA, audit log, organization management panel, or customer billing pages.
- No plans, subscriptions, invoices, payments, rate cards, usage ledger/rollups, expense ledger, or revenue analytics.
- Existing DB migration runner is versioned and backup-aware, but one historical migration is destructive.
- `.gitignore` now ignores the full `*.sqlite3*` family. Existing tracked SQLite artifacts remain tracked by Git until explicitly removed from repository history; do not stage them as part of this implementation.
- The feature-suite remote branch exists. This checkout already contains feature-suite code and docs, but its history/integration state should be reviewed before selecting any merge/cherry-pick strategy.

## Safety and data handling

Safety messaging includes deterministic guardrails, consent-aware routine dispatch, emergency-code handling, and alert automation. Billing/entitlements must not suppress emergency-code handling or safety alerts when the configured safety exemption is enabled. Admin data views should mask worker phone numbers and health-related free text by default; reveal actions must be reasoned and audited. Preserve `.env`, database files, WAL/SHM files, and existing user changes.

## Phase 1 implementation map (2026-10-17)

- Additive schema v4 is in `server/db/migrations.js`; it creates admin, audit, pricing, metering, subscription, payment, expense, and retention tables. It gives every existing organization a hidden zero-price Legacy subscription with unlimited compatibility limits and creates hidden, clearly marked sample plan records.
- Admin routes are in `server.js` under `/api/admin/*`; admin sessions and CSRF use separate cookie names. `server/billing/permissions.js` contains the server-side permission map; `server/billing/totp.js` implements RFC 6238 and AES-GCM secret protection; `server/billing/audit.js` redacts sensitive snapshot fields.
- The admin interface is `/admin` using `src/AdminApp.jsx` and `src/admin.css`. Current views are overview, organizations, plans, audit, and own active sessions. The setup screen shows a secret and otpauth URI for manual TOTP enrollment but does not yet render a QR code.
- `scripts/createAdmin.js` backs `npm run admin:create` and only permits the initial bootstrap. It does not use a default password.
- Pure billing helpers live under `server/billing/`; integration coverage is in `server/billing/adminAuth.integration.test.js`. `server/billing/metering.js` is wired to the existing SMS, Gemini, Open-Meteo, Photon/Nominatim, and SMTP boundaries. `server/billing/rollups.js` is registered in the job runner; the optional voice adapter still has no active call path. See `docs/METERING.md` for rate units and gaps.
