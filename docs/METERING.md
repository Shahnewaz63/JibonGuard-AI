# Usage metering (implementation in progress)

## What is recorded today

The central failure-safe meter is `server/billing/metering.js`. It snapshots cost and customer-rate values from the latest effective rate card when an event is inserted. `idempotency_key` prevents duplicate event rows. Provider operations continue if metering throws; the error is logged without payloads or credentials. Usage metadata is filtered to remove common PII and secret field names.

Current event coverage in `server.js`:

| Event | Provider boundary | Quantity / unit | Notes |
|---|---|---|---|
| `sms_outbound` | TextBee bulk send, alert queue, break reminders, registration messages, emergency replies | GSM-7 or UCS-2 segments | Each outbound message has a separate usage row; category is routine, safety, or emergency. Failed submissions are recorded as failed and not customer-priced. |
| `sms_inbound` | TextBee inbound sync and emergency poll | messages | Includes emergency-code messages; segment count is kept as metadata. Provider message ID is the de-duplication reference. |
| `ai_call` | Gemini alert decisions, chat, break suggestions, and speech | tokens | Uses Gemini `usageMetadata` when supplied; otherwise character-based estimates are labelled `estimated`. Model, feature, success/fallback, and latency are recorded. Token rates are per million input/output tokens. |
| `weather_api_call` | Open-Meteo forecast requests | calls | Only actual provider requests are recorded; cached dashboard results are not separate API calls. |
| `geocode_call` | Photon search and Nominatim reverse geocoding | calls | Search query and coordinates are not written to usage metadata. |
| `email_sent` | SMTP account email | emails | Development console output is marked `development_logged` and has zero provider cost. |

The configured voice gateway has no active call path in the existing app, so `voice_call` and `voice_seconds` are not emitted. Gemini Live currently meters token issuance only where server-visible; client-side live session consumption is not available in this app's server path. This must be addressed before selling voice usage as a metered feature.

## Configure provider costs and overage prices

In `/admin` → **Costs & rates**, add a new effective rate version. Costs and prices are entered as integer minor units in the current interface. Do not invent vendor rates: set values from current provider invoices/contracts. AI requires separate `input_1m_tokens` and `output_1m_tokens` records for each model. The database stores the rate divisor with each usage event so token costs remain exact in minor units.

Rate records are append-only from the current admin API. A price change affects future usage; prior events retain their rate and computed totals. The meter applies customer overage rates only when the active plan uses `charge_overage`; included usage is consumed before overage. `soft_warn` and `block` are stored plan policies, but API-side limit enforcement and customer warning banners are not yet complete.

## Rollups

The `usage_rollups` job rebuilds daily and monthly rollups from immutable usage events and captures worker/site/verified-user resource snapshots. It runs shortly after server start and then at `BILLING_ROLLUP_INTERVAL_MS` (default 24 hours). A rebuild covers the latest 400 days and is idempotent. Job status is stored in the existing job-run tables.

## Operational gaps

- No metering event or cost-rate seed is fabricated. Until the operator configures rates, recorded costs/prices are zero.
- TextBee gives aggregate batch results; delivery state can change later in its message history, while the usage row preserves the initial queued/failed status snapshot.
- Rate rows currently share one currency for cost and customer price in a usage event. Configure compatible currencies for each provider/overage pair.
- Limits are not yet enforced before all provider calls, and usage alerting/80%/100% customer notices are not wired.
- Voice gateway calls, incoming webhook callbacks, and provider delivery reconciliation are not implemented.
