const number = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

export function loadAlertConfig(env = process.env) {
  return {
    enabled: env.ALERT_AUTOMATION_ENABLED !== 'false',
    aiEnabled: env.AI_ALERTS_ENABLED === 'true',
    model: env.AI_ALERTS_MODEL || env.GEMINI_MODEL || 'gemini-2.5-flash',
    apiKey: (env.GEMINI_API_KEY || '').trim(),
    timeoutMs: number(env.AI_ALERTS_TIMEOUT_MS, 8000, 1000, 30000),
    retryCount: number(env.AI_ALERTS_RETRIES, 1, 0, 3),
    intervalMs: number(env.ALERT_AUTOMATION_INTERVAL_MS, 12 * 60 * 1000, 10 * 60 * 1000, 15 * 60 * 1000),
    baseHeatTriggerC: number(env.ALERT_HEAT_TRIGGER_C, 34, 28, 42),
    workloadOffsets: { Light: 0, Standard: 2, Moderate: 2, Heavy: 4, 'Very Heavy': 6 },
    rainLeadMinutes: number(env.ALERT_RAIN_LEAD_MINUTES, 120, 15, 360),
    rainProbability: number(env.ALERT_RAIN_PROBABILITY, 60, 1, 100),
    cooldownMinutes: number(env.ALERT_COOLDOWN_MINUTES, 40, 1, 1440),
    dailyCap: number(env.ALERT_DAILY_CAP, 4, 1, 100),
    quietHours: { start: env.ALERT_QUIET_START || '20:00', end: env.ALERT_QUIET_END || '06:00' },
    staleWeatherMinutes: 45,
  };
}

export const ALERT_CONFIG = loadAlertConfig();
