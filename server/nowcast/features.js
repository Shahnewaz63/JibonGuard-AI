export function makeNowcastFeatures(observations, forecast, date = new Date()) {
  const at = (key, ago = 0) => Number(observations?.[key]?.[Math.max(0, observations[key].length - 1 - ago)]);
  const current = at('apparent_temperature');
  return {
    apparent_now: current,
    apparent_change_1h: current - at('apparent_temperature', 1),
    apparent_change_3h: current - at('apparent_temperature', 3),
    temperature_change_1h: at('temperature_2m') - at('temperature_2m', 1),
    humidity: at('relative_humidity_2m'), pressure: at('pressure_msl'),
    pressure_change_3h: at('pressure_msl') - at('pressure_msl', 3),
    cloud_cover: at('cloud_cover'), wind_speed: at('wind_speed_10m'),
    rain_last_hour: at('precipitation'), forecast_rain_probability: Number(forecast?.precipitation_probability?.[0]),
    forecast_apparent_30m: Number(forecast?.apparent_temperature?.[0]),
    forecast_apparent_60m: Number(forecast?.apparent_temperature?.[1]),
    hour: date.getUTCHours(), month: date.getUTCMonth() + 1,
  };
}

export function inferNowcast(features, artifact, { heatTriggerC = 34, maxAgeDays = 120, now = Date.now() } = {}) {
  const valid = artifact && artifact.version && Number.isFinite(Date.parse(artifact.trained_at)) && (now - Date.parse(artifact.trained_at)) <= maxAgeDays * 86400000 && artifact.models;
  const fallback = !valid;
  const rawRain = Number(features.forecast_rain_probability);
  const model = fallback ? null : artifact.models;
  const rainProbability = fallback ? (Number.isFinite(rawRain) ? rawRain / 100 : null) : scoreLogistic(model.rain, features);
  const temp30 = fallback ? Number(features.forecast_apparent_30m) : scoreRidge(model.temperature_30m, features);
  const temp60 = fallback ? Number(features.forecast_apparent_60m) : scoreRidge(model.temperature_60m, features);
  return { model_version: fallback ? 'forecast-fallback' : artifact.version, fallback, rain_probability: finiteOrNull(rainProbability), rain_within_60m: rainProbability != null && rainProbability >= (artifact?.thresholds?.rain ?? 0.35), apparent_30m_c: finiteOrNull(temp30), apparent_60m_c: finiteOrNull(temp60), heat_crossing_30m: Number.isFinite(temp30) && temp30 >= heatTriggerC, heat_crossing_60m: Number.isFinite(temp60) && temp60 >= heatTriggerC };
}

function dot(model, features) { return (model?.intercept || 0) + Object.entries(model?.weights || {}).reduce((sum, [key, weight]) => sum + (Number(features[key]) || 0) * Number(weight), 0); }
function scoreRidge(model, features) { return dot(model, features); }
function scoreLogistic(model, features) { const value = dot(model, features); return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value)))); }
function finiteOrNull(value) { return Number.isFinite(value) ? value : null; }
