# JibonGuard AI model card

## Intended use

Optional short-horizon weather decision support for Bangladesh worksites. Outputs can add precautionary notice; they must never suppress deterministic heat, rain, lightning, official-advisory, or emergency-code actions.

## Data and evaluation

The training design uses hourly Open-Meteo historical forecast data for issued-model context and historical weather/reanalysis for observation features, with a chronological split and city/site coordinates. Reanalysis is not an issued forecast. Evaluation must compare against persistence, interpolated raw forecast, and hour-of-day climatology and report calibration and false alarms. No measured evaluation result is claimed in this repository until a reproducible training/evaluation run writes it.

## Limitations and failure modes

Grid weather is not a worksite sensor; apparent temperature is only a heat proxy and not WBGT. Tropical convective rain can change quickly. Coverage, model versions, missing observations, and forecast lead time affect accuracy. Missing/stale model artifacts must use plain forecast behavior and identify that fallback.

## Safety and human review

AI is optional and may only add earlier/extra precautions. Thresholds are illustrative and require occupational-health validation. Native Bangla template review and privacy/security review are required before deployment. This is not emergency monitoring.
