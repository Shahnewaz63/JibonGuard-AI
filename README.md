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
- React light/dark theme control and responsive organization dashboard.

## Configuration

The Node server reads `.env` from this folder. Keep `.env` and `jibonguard.sqlite3` private; do not commit or publish them.

Open-Meteo's public Forecast API is used by default for non-commercial development. For a commercial deployment, subscribe to Open-Meteo and set `OPEN_METEO_API_KEY`.

Set `GEMINI_API_KEY` to enable AI chat and weather-based break suggestions. The key stays server-side. Both features need internet access and a valid Gemini key/quota. AI suggestions are decision support, not emergency monitoring; follow official local alerts and site safety procedures.

To send account email, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. Development mode prints recovery links in the Node server terminal if email is not configured.

To send worker SMS, configure `TEXTBEE_API_KEY` and numeric `TEXTBEE_SIM_SUBSCRIPTION_ID`. Notifications are sent only to workers with recorded active consent.

## Production deployment

Build the frontend with `npm run build`, then set `APP_ENV=production`, a random `SESSION_SECRET` of at least 32 characters, the exact HTTPS `PUBLIC_ORIGIN`, and production SMTP settings before running `npm start` behind HTTPS. Production also needs durable protected backups, distributed rate limiting, operational alerting, a documented retention schedule, and security/legal review. Roles, OTP/2FA, payments, and incident workflows are not connected. Risk thresholds remain illustrative and require occupational-health validation before use.
