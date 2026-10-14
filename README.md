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
5. Create an organization account. Development password-reset links are printed in the Node server terminal.
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
- Per-site AI alert automation with deterministic safety floors, consent-aware SMS/optional voice dispatch, auditable decisions, and a dry-run simulator.
- React light/dark theme control and responsive organization dashboard.
- Additive feature-suite foundation: versioned database migration, organization feature switches, shared Gemini-call metadata auditing, system-health and manual official-advisory views, and tested pure modules for triage rules, nowcast fallback, CAP parsing, and deterministic report facts.

## Configuration

The Node server reads `.env` from this folder. Keep `.env` and `jibonguard.sqlite3` private; do not commit or publish them.

Open-Meteo's public Forecast API is used by default for non-commercial development. For a commercial deployment, subscribe to Open-Meteo and set `OPEN_METEO_API_KEY`.

Set `GEMINI_API_KEY` to enable AI chat and weather-based break suggestions. The key stays server-side. Both features need internet access and a valid Gemini key/quota. AI suggestions are decision support, not emergency monitoring; follow official local alerts and site safety procedures.

To send account email, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. Development mode prints recovery links in the Node server terminal if email is not configured.

To send worker SMS and sync SMS history, configure `TEXTBEE_API_KEY` and optionally numeric `TEXTBEE_SIM_SUBSCRIPTION_ID`. In TextBee, enable SMS receiving on the Android gateway. The server checks incoming SMS every 30 seconds, accepts emergency codes `০`–`৯` or `0`–`9`, replies in Bangla, and sends emergency alerts to workers at the sender's site. New workers receive a Bangla registration confirmation and emergency-code guide by SMS. Emergency messages go to every worker at that site; routine break notifications remain consent-aware.

### Automated alerts

Organizations can enable automation from **AI automation** in the dashboard. The scheduler checks configured worksites every 10-15 minutes, reads current weather and the next six hours of forecast, applies workload-adjusted rules, and queues fixed Bangla templates for consented workers. High/Extreme heat, rain within the configured lead time, and lightning are deterministic safety-floor alerts. AI is optional (`AI_ALERTS_ENABLED=true`) and can only select a validated template, timing, and channel; invalid output, timeout, or a missing key falls back to deterministic rules. The model prompt is in `server/alerts/ALERT_DECISION_PROMPT.md`; phone numbers, worker names, and free-text worker health data are never sent to it.

Configure the master switch and defaults with `ALERT_AUTOMATION_ENABLED`, `ALERT_HEAT_TRIGGER_C`, `ALERT_RAIN_LEAD_MINUTES`, `ALERT_RAIN_PROBABILITY`, `ALERT_COOLDOWN_MINUTES`, `ALERT_DAILY_CAP`, `ALERT_QUIET_START`, `ALERT_QUIET_END`, `ALERT_AUTOMATION_INTERVAL_MS`, and the `AI_ALERTS_*` variables in `.env`. Organization-level overrides are saved by the dashboard. Voice dispatch is adapter-based; configure an HTTPS `VOICE_GATEWAY_URL` and `VOICE_GATEWAY_API_KEY` to use a voice provider. Without it, voice-only messages fall back to SMS.

The automation settings page includes a simulator for temperature, rain ETA, and time-of-day scenarios. It does not enqueue or send. Run the rule and guardrail tests with `npm test`. Where this project has no WBGT measurement, apparent temperature is used as a labeled proxy; official heatwave feeds and worker acknowledgement tracking are not currently connected. All Bangla automation templates are marked for native-speaker review. Alert records support safety follow-up and must not be used to rank or punish workers for taking breaks.

### Feature-suite implementation status

The feature-suite work is in progress. The current branch adds an idempotent additive migration, safe-off environment switches, organization settings, manual advisory entry/listing, an authenticated system-health view, reusable AI/job helpers, and unit tests for core rules. It does **not** yet provide an operational nowcast training/evaluation pipeline, automatic prediction loop or evidence dashboard; the constrained break-plan optimizer and approval/SMS lifecycle; inbound triage, health-consent and check-in workflow; scheduled daily/weekly report generation; or automatic CAP polling and advisory alert dispatch. Do not enable these switches for production until those workflows, validation, and human reviews are complete. No nowcast evaluation score is claimed.

Use `docs/AUDIT.md` for the source audit, `docs/DECISIONS.md` for implementation choices, `docs/OFFICIAL_FEEDS.md` for source findings, and `docs/TRIAGE_SAFETY.md` for first-aid review notes. `.env.example` lists the proposed feature switches; blank/false defaults keep optional AI and incomplete scheduled workflows off.

## Production deployment

Build the frontend with `npm run build`, then set `APP_ENV=production`, a random `SESSION_SECRET` of at least 32 characters, the exact HTTPS `PUBLIC_ORIGIN`, and production SMTP settings before running `npm start` behind HTTPS. Production also needs durable protected backups, distributed rate limiting, operational alerting, a documented retention schedule, and security/legal review. Roles, OTP/2FA, payments, and incident workflows are not connected. Risk thresholds remain illustrative and require occupational-health validation before use.
