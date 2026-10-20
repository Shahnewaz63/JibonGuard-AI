import { callAlertAi } from './ai.js';
import { ALERT_CONFIG } from './config.js';
import { enforceGuardrails, getDeterministicDecisions, inputHash } from './decision.js';
import { renderAlertTemplate } from './templates.js';

export async function decideAlerts(contexts, { config = ALERT_CONFIG, aiClient = callAlertAi, getHistory = () => ({}) } = {}) {
  const working = contexts.map(context => {
    const { rule, candidates } = getDeterministicDecisions(context, config);
    return { ...context, rule, candidates, hash: inputHash({ ...context, worker: { ...context.worker, phone: undefined, name: undefined } }) };
  });
  const fresh = working.filter(context => Number(context.weather.dataAgeMinutes ?? 0) <= config.staleWeatherMinutes);
  const eligibleForAi = fresh.filter(context=>!context.worker.consentStatus||context.worker.consentStatus==='consented');
  const ai = eligibleForAi.length ? await aiClient(eligibleForAi, config) : { decisions: [], modelOutput: null, status: fresh.length === 0 ? 'stale' : config.aiEnabled ? 'ok' : 'disabled' };
  const aiControlsAllAlerts = Boolean(config.aiEnabled && ai.status === 'ok');
  const byWorker = new Map(ai.decisions.map(decision => [decision.worker_id, decision]));
  const results = [];
  for (const context of working) {
    const weatherStale=Number(context.weather.dataAgeMinutes??0)>config.staleWeatherMinutes;
    const floor = context.rule.floor;
    const aiDecision = byWorker.get(context.worker.id);
    let chosen;
    if(context.worker.consentStatus&&context.worker.consentStatus!=='consented'){
      chosen=[{action:'skip',final_status:'skipped',alert_type:'heat_nudge',channel:'sms',reason:'Worker SMS consent has not been recorded.',floor:false}];
    } else if (aiControlsAllAlerts && !weatherStale) {
      // A successful AI cycle chooses whether each eligible worker receives an alert.
      const optional = aiDecision && aiDecision.action !== 'skip' && !floor.some(item => item.alert_type === aiDecision.alert_type) ? [aiDecision] : [];
      chosen = [...floor, ...optional];
    } else {
      // Deterministic rules remain the fallback when AI is off, unavailable, or weather is stale.
      chosen = [...floor];
      if (!weatherStale) chosen.push(...context.candidates.filter(item => !item.floor));
    }
    const history = getHistory(context.worker.id, context);
    const limited = enforceGuardrails(chosen, context, history, config, context.now || new Date(), { aiControlled: aiControlsAllAlerts && !weatherStale });
    if (!limited.length) limited.push({ action: 'skip', final_status: 'skipped', alert_type: 'heat_nudge', channel: 'sms', reason: weatherStale ? 'Weather data is delayed; optional alert suppressed.' : ai.status === 'fallback' ? 'AI unavailable; no deterministic rule triggered.' : 'No additional alert was warranted.', floor: false });
    for (const decision of limited) results.push({ workerId: context.worker.id, siteId: context.site.id, ...decision, templateId: decision.template_id || decision.alert_type, variables: { ...(decision.variables || {}), level: decision.level || context.rule.riskLevel }, message: renderAlertTemplate(decision.template_id || decision.alert_type, { ...(decision.variables || {}), minutes: Math.max(0, Math.round(Number(context.weather.rainEtaMinutes ?? decision.variables?.minutes ?? 0))), level: context.rule.riskLevel }), reason: decision.reason || 'Rule-based safety decision.', floor: Boolean(decision.floor), inputHash: context.hash, modelOutput: weatherStale ? null : ai.modelOutput, aiStatus: weatherStale ? 'stale' : ai.status, createdAt: (context.now || new Date()).toISOString() });
  }
  return { decisions: results, modelOutput: ai.modelOutput, aiStatus: ai.status };
}
