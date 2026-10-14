# Official heat and weather advisories

## Sources checked (2026-10-14)

- Bangladesh Meteorological Department (BMD) operates a public [CAP Alerts page](https://cap.bmd.gov.bd/bmd-cap-alerts/). The visible page lists active and past CAP alerts, with hazard, affected locations, issue time, and severity. The landing page references the WMO CAP composer.
- The browser-accessible page did not document a stable feed URL, API contract, terms for automated ingestion, or robots policy. This project therefore does not scrape its HTML or assume an undocumented feed endpoint. Recheck BMD's terms and robots rules before enabling a feed adapter.
- BMD's conventional heat-wave bulletins may be available separately, but a machine-readable URL was not verified in this audit.
- Always-available path: an authorized organization admin records the source, source URL, affected area, severity, and validity interval manually. Treat this as an unverified operator entry and retain its provenance.

## Feed adapter policy

Any configured CAP/RSS/JSON URL must be explicitly supplied by the operator, use HTTPS, and be reviewed for source terms and robots policy before production polling. Parse CAP 1.2 defensively, deduplicate by external identifier and payload hash, retain the original provenance, and expire advisories at `valid_to`. Feed failures must not disable deterministic local alerts. Do not scrape BMD pages or infer an active warning from page text.

## Open-Meteo data sources for nowcast work

Open-Meteo documents `/v1/archive` for hourly historical observations/reanalysis and a separate Historical Forecast API. The latter is a continuous hourly series from successive model runs and is the relevant source for forecast-error features; historical weather/reanalysis must not be represented as an issued forecast. The docs say historical forecast coverage starts around 2021 and that retrospective single-run data offers better run fidelity for some evaluations. Bangladesh 15-minute products may be interpolated from hourly model output, so the system must not claim true sub-hourly measurements.

References: [Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api), [Historical Forecast API](https://open-meteo.com/en/docs/historical-forecast-api), [BMD CAP Alerts](https://cap.bmd.gov.bd/bmd-cap-alerts/).
