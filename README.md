# JibonGuard AI

JibonGuard is a React frontend with a Node.js/Express API and SQLite account store. The server continues to use `jibonguard.sqlite3`, including its existing organizations, users, workers, sites, consent records, and break history.

## Run locally on Windows

1. Install Node.js 24 or newer.
2. In PowerShell, open this folder and install packages:

   ```powershell
   npm install
   ```

3. Start the API and React development server:

   ```powershell
   npm run dev
   ```

4. Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Vite serves React and proxies API requests to the Node server on port 8000.
5. Create an organization account. When SMTP is not configured in development, OTP codes and password-reset links are printed in the Node server terminal.
6. Stop both processes with `Ctrl+C`.

For the single-origin dashboard and API at port 8000, start the app with:

```powershell
npm start
```

`npm start` builds the React frontend and starts the Node server. Open [http://127.0.0.1:8000/dashboard.html#sites](http://127.0.0.1:8000/dashboard.html#sites). Keep that terminal open while using the app. Sign in first; the Sites view opens after authentication.

## Features

- Organization accounts with salted scrypt password hashes, server-side SQLite sessions, CSRF tokens, and origin checks.
- Signup, sign-in, password recovery, account export, and password-confirmed account deletion.
- Organization-scoped worker and worksite management, CSV imports, and worker-consent audit history.
- Break and alert logs with consent-aware TextBee SMS delivery.
- Current and two-hour worksite weather via Open-Meteo; worksite search and reverse geocoding via Photon and OpenStreetMap Nominatim.
- Gemini dashboard chat and weather-informed break scheduling when `GEMINI_API_KEY` is configured.
- Per-site AI alert automation with deterministic safety floors, consent-aware SMS dispatch, auditable decisions, and a dry-run simulator.
- React light/dark theme control and responsive organization dashboard.
- Additive feature-suite foundation: versioned database migration, organization feature switches, shared Gemini-call metadata auditing, system-health view, and tested pure modules for triage rules, nowcast fallback, and deterministic report facts.

## Current webapp workflow

JibonGuard is an organization-admin workspace. The current user journey and the work performed by the application are:

1. **Discover and create an account.** Visitors can review the landing page and privacy notice, then create an organization account with a contact name, organization details, phone number, email, password, and acceptance of the privacy notice and terms. Signup creates a pending organization and emails a six-digit OTP; the account is verified after code confirmation. Each login sends a new OTP after the password is accepted and creates a server-side session only after code confirmation; the optional “Remember this device” choice controls its lifetime. Password recovery uses a one-time reset link delivered by SMTP, or printed in the server terminal during development.
2. **Set up worksites.** In the dashboard, add each worksite with a name and coordinates. Search can find a place through Photon; selecting a result fills the location fields, and the map preview uses OpenStreetMap. Record whether shade, drinking water, and a rest area are available. Saved coordinates drive weather lookups for current conditions and the next two hours.
3. **Add workers and assign them.** Enter workers individually or import a CSV with `name`, `phone`, and `site` columns; `job_type` (or `role`) and `workload` are optional. Assign workers to a saved worksite and maintain their role/workload data. Each organization sees only its own worker and worksite records.
4. **Record and manage worker consent.** Worker notifications are gated by a recorded, explicit agreement to receive safety alerts. An administrator confirms consent in the Workers view; the app records the action, method, note, administrator, and timestamp. Consent can be withdrawn later, which removes the worker from consent-dependent routine notifications. Consent history remains auditable. Emergency SMS handling is a separate site-level route and may contact workers regardless of routine-alert consent.
5. **Coordinate breaks and safety actions.** The Break schedule view records a worksite, date/time, duration, and status for a break or alert. Entries can be reviewed and edited. An AI-assisted schedule request uses current worksite weather and Gemini when configured; treat its suggestions as decision support. Break and safety activity is available in the dashboard history and contributes to the organization snapshot.
6. **Review and communicate alerts.** The Alerts view combines automated alert decisions with recorded non-break safety actions. If TextBee is configured, worker SMS can be sent and sent/received history synchronized in SMS messages. The server periodically checks inbound TextBee SMS, links messages to workers in the organization by phone number, and processes supported numeric emergency codes. New worker registration confirmations and emergency-code instructions are sent when SMS delivery is available.
7. **Configure and preview automation.** An administrator can set organization-level heat, rain, cooldown, daily-cap, quiet-hour, workload-offset, and optional AI settings in AI automation. Server-side master switches must also be enabled. The scheduler periodically checks worksites and forecast conditions. Deterministic heat, rain, and lightning safety floors remain in effect; AI may choose only validated additional SMS templates and timing. Consent, quiet hours, cooldowns, and caps constrain routine dispatch. The simulator previews decisions for a selected site and scenario but does not enqueue or send messages. The Alerts view exposes automated decision records and reasons.
8. **Review account and operational records.** Reports shows counts for workers, active consent, sites, and safety actions. Feature opt-ins are effective only when the matching server master switch is enabled. System health shows recorded job runs and recent AI-call metadata. Account controls let the signed-in owner export organization data, sign out, or permanently delete the organization after confirming the password.

### What happens behind the screens

The React app calls the Express API on the same origin. In development, Vite serves the app on port 5173 and proxies API requests to Express on port 8000; in production, Express serves the built frontend and API on port 8000. The API checks the signed-in session for organization-scoped routes, applies CSRF and origin checks to state-changing requests, and stores application records in `jibonguard.sqlite3`. Database startup applies additive, versioned migrations. Weather, geocoding, Gemini, SMTP, and TextBee are server-side integrations and depend on their respective configuration and availability. `/api/health` is a basic service check; dashboard system health is a separate authenticated view.

The webapp includes UI and database foundations for more feature-suite work, but those foundations are not completed end-user workflows. Automated nowcast prediction/training/evaluation, optimized break-plan approval and acknowledgement, inbound symptom triage and health check-ins, and scheduled daily/weekly report generation are **not currently operational**. The feature switches, migration tables, health page, and pure rule/helper modules should not be described as those live workflows. Risk guidance is illustrative, not medical advice or emergency monitoring; follow official local warnings and workplace procedures. Alert records are for safety follow-up and must not be used to penalize workers for taking breaks.

## Configuration

The Node server reads `.env` from this folder. Keep `.env` and `jibonguard.sqlite3` private; do not commit or publish them.

Open-Meteo's public Forecast API is used by default for non-commercial development. For a commercial deployment, subscribe to Open-Meteo and set `OPEN_METEO_API_KEY`.

Set `GEMINI_API_KEY` to enable AI chat and weather-based break suggestions. The key stays server-side. Both features need internet access and a valid Gemini key/quota. AI suggestions are decision support, not emergency monitoring; follow official local alerts and site safety procedures.

## Admin foundation (in progress)

The separate admin interface is at `/admin`. Admin identities use a different cookie and session table from organization accounts. Existing organizations are assigned a hidden, zero-price **Legacy** subscription during the additive billing migration so their current dashboard access continues while real plans and prices are configured. Basic, Pro, and ProMax are hidden sample plans with zero sample prices; they are not customer offers until an operator configures and publishes them.

Before bootstrapping the first admin, set a private encryption key in `.env`. In PowerShell, generate one with:

```powershell
$adminKeyBytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Fill($adminKeyBytes)
[Convert]::ToBase64String($adminKeyBytes)
```

Copy the output into `ADMIN_ENCRYPTION_KEY` and keep it backed up outside the repository. Then run:

```powershell
npm run admin:create
```

The command prompts for the first super-admin email and a strong password. Open `/admin`, sign in, and finish authenticator-app enrollment before using admin features. Keep the displayed recovery codes securely. The enrollment page currently provides the secret and `otpauth://` URI for manual setup; QR rendering is not yet implemented. Optional `ADMIN_IP_ALLOWLIST` accepts comma-separated exact source IP addresses. `ADMIN_SESSION_LIFETIME_SECONDS` controls the separate admin session duration (bounded to 10 minutes through 8 hours).

Current implemented admin roles are `super_admin`, `finance`, `support`, and `viewer`; API authorization is role checked. Current admin screens cover an overview, organization list, plans, audit records, and the current admin's sessions. Plan create/update retains price history; applying new plan prices to existing subscriptions requires the explicit API flag. The wider billing and subscription workflow is not complete yet. Do not treat the current panel as a completed production billing system.

The billing migration creates editable sample plan values, but provider costs, customer overage prices, taxes, invoice settings, and real plan prices require operator configuration before launch. Active non-sample plans appear on `/pricing`; customers can select one at signup. Organization billing is available in the dashboard's **Subscription** section. Admin billing APIs support invoice creation, manual payment review, subscription assignment/status changes, and billing settings; a dedicated settings screen and automated renewal/dunning jobs remain pending. Only the manual payment path exists; no online gateway is connected. See `docs/ADMIN_AUDIT.md` and `docs/DECISIONS.md` for current limitations.

To send account email, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. With SMTP configured, sign-up and each successful password check send a six-digit OTP valid for 10 minutes. In development without SMTP, OTPs are printed in the Node server terminal.

To send worker SMS and sync SMS history, configure `TEXTBEE_API_KEY` and optionally numeric `TEXTBEE_SIM_SUBSCRIPTION_ID`. In TextBee, enable SMS receiving on the Android gateway. The server checks incoming SMS every 30 seconds, accepts emergency codes `০`–`৯` or `0`–`9`, replies in Bangla, and sends emergency alerts to workers at the sender's site. New workers receive a Bangla registration confirmation and emergency-code guide by SMS. Emergency messages go to every worker at that site; routine break notifications remain consent-aware.

### Automated alerts

Organizations can enable automation from **AI automation** in the dashboard. The scheduler checks configured worksites every 15 minutes, reads current weather and the next six hours of forecast, and queues fixed Bangla templates for consented workers. When AI is disabled, deterministic rules select alerts. AI is optional (`AI_ALERTS_ENABLED=true`). When enabled by the organization, AI decides whether and which consented workers receive alerts on each fixed 15-minute cycle. Decisions use validated templates, and the application enforces consent, quiet hours, cooldowns, daily caps, and duplicate prevention. If AI output is unavailable or invalid, deterministic rules provide the fallback. The model prompt is in `server/alerts/ALERT_DECISION_PROMPT.md`; phone numbers, worker names, and free-text worker health data are never sent to it.

Configure the master switch and defaults with `ALERT_AUTOMATION_ENABLED`, `ALERT_HEAT_TRIGGER_C`, `ALERT_RAIN_LEAD_MINUTES`, `ALERT_RAIN_PROBABILITY`, `ALERT_COOLDOWN_MINUTES`, `ALERT_DAILY_CAP`, `ALERT_QUIET_START`, `ALERT_QUIET_END`, `ALERT_AUTOMATION_INTERVAL_MS`, and the `AI_ALERTS_*` variables in `.env`. Organization-level overrides are saved by the dashboard.

The automation settings page includes a simulator for temperature, rain ETA, and time-of-day scenarios. It does not enqueue or send. Run the rule and guardrail tests with `npm test`. Where this project has no WBGT measurement, apparent temperature is used as a labeled proxy; worker acknowledgement tracking is not currently connected. All Bangla automation templates are marked for native-speaker review. Alert records support safety follow-up and must not be used to rank or punish workers for taking breaks.

### Feature-suite implementation status

The feature-suite work is in progress. The current branch adds an idempotent additive migration, safe-off environment switches, organization settings, an authenticated system-health view, reusable AI/job helpers, and unit tests for core rules. It does **not** yet provide an operational nowcast training/evaluation pipeline, automatic prediction loop or evidence dashboard; the constrained break-plan optimizer and approval/SMS lifecycle; inbound triage, health-consent and check-in workflow; scheduled daily/weekly report generation; . Do not enable these switches for production until those workflows, validation, and human reviews are complete. No nowcast evaluation score is claimed.

Use `docs/AUDIT.md` for the feature-suite source audit, `docs/ADMIN_AUDIT.md` for the admin/billing audit, `docs/DECISIONS.md` for implementation choices, `docs/METERING.md` for metered provider events and rates, and `docs/TRIAGE_SAFETY.md` for first-aid review notes. `.env.example` lists the proposed feature switches; blank/false defaults keep optional AI and incomplete scheduled workflows off.

## Production deployment

Build the frontend with `npm run build`, then set `APP_ENV=production`, a random `SESSION_SECRET` of at least 32 characters, the exact HTTPS `PUBLIC_ORIGIN`, and production SMTP settings before running `npm start` behind HTTPS. Production also needs durable protected backups, distributed rate limiting, operational alerting, a documented retention schedule, and security/legal review. Admin user management, recurring billing jobs, online payments, refunds, deletion workflows, and incident workflows are not connected. Risk thresholds remain illustrative and require occupational-health validation before use.
