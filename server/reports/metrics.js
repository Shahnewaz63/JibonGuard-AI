export function buildSafetyFacts({ alerts = [], breaks = [], acknowledgements = null, triage = [], nowcasts = [], heatReadings = [], period = {} } = {}) {
  const by = (items, key) => items.reduce((out, item) => { const value = String(item[key] || 'unknown'); out[value] = (out[value] || 0) + 1; return out; }, {});
  const sent = alerts.filter(item => item.status === 'sent').length;
  const knownDelivery = alerts.filter(item => ['sent', 'failed'].includes(item.status)).length;
  const maxApparent = heatReadings.map(item => Number(item.apparent_c)).filter(Number.isFinite);
  return {
    period,
    heat_hours_by_category: by(heatReadings, 'category'),
    max_apparent_temperature_c: maxApparent.length ? Math.max(...maxApparent) : null,
    alerts_by_type: by(alerts, 'alert_type'),
    delivery_success_rate: knownDelivery ? sent / knownDelivery : null,
    rain_lightning_events: alerts.filter(item => ['rain_2h', 'lightning', 'rain', 'storm'].includes(item.alert_type)).length,
    break_reminders_sent: breaks.length,
    break_acknowledgements: acknowledgements === null ? 'not available' : acknowledgements.length,
    nowcast: { evaluated: nowcasts.filter(item => item.actual_rain !== null || item.actual_apparent_c !== null).length },
    triage_counts_by_severity: by(triage, 'severity'),
    data_quality_notes: [],
  };
}

export function deterministicFindings(facts) {
  const findings = [];
  const highHours = Number(facts.heat_hours_by_category?.High || 0) + Number(facts.heat_hours_by_category?.Extreme || 0);
  if (highHours > 0) findings.push({ rule_id: 'HEAT_HOURS_PRESENT', priority: 1, evidence: { high_heat_hours: highHours }, text: 'High or extreme heat conditions were recorded during this period.' });
  if (facts.delivery_success_rate !== null && facts.delivery_success_rate < 0.9) findings.push({ rule_id: 'DELIVERY_BELOW_90', priority: 2, evidence: { delivery_success_rate: facts.delivery_success_rate }, text: 'Some worker safety messages were not confirmed as delivered.' });
  if (!findings.length) findings.push({ rule_id: 'NO_RULE_FINDINGS', priority: 99, evidence: {}, text: 'No rule-based finding was available for this period.' });
  return findings.sort((a, b) => a.priority - b.priority);
}

export function narrativeNumbersAreSupported(narrative, facts) {
  const allowed = new Set();
  const walk = value => { if (typeof value === 'number' && Number.isFinite(value)) allowed.add(String(value)); else if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') Object.values(value).forEach(walk); };
  walk(facts);
  const numbers = String(narrative || '').match(/\d+(?:\.\d+)?/g) || [];
  return numbers.every(number => allowed.has(number));
}
