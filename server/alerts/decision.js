import { createHash } from 'node:crypto';
import { ALERT_TEMPLATES } from './templates.js';

const ALERT_TYPES = new Set(Object.keys(ALERT_TEMPLATES));
const CHANNELS = new Set(['sms']);
const LEVELS = ['LOW', 'MODERATE', 'HIGH', 'EXTREME'];
const minutesOf = value => {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};
const clockMinutesAt = (date, timezone = 'UTC') => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
};
const inQuietHours = (date, hours, timezone = 'UTC') => {
  const start = minutesOf(hours?.start), end = minutesOf(hours?.end);
  if (start == null || end == null || start === end) return false;
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(part=>[part.type,part.value]));
  const current=Number(parts.hour)*60+Number(parts.minute);
  return start < end ? current >= start && current < end : current >= start || current < end;
};
const riskAt = (temperature, workload, config) => {
  const offsets = config.workloadOffsets || {};
  const trigger = config.baseHeatTriggerC - (Number(offsets[workload]) || 0);
  const delta = temperature - trigger;
  return { trigger, level: delta >= 7 ? 'EXTREME' : delta >= 4 ? 'HIGH' : delta >= 1 ? 'MODERATE' : 'LOW' };
};
const isLightning = weather => Boolean(weather.lightning || [95, 96, 99].includes(Number(weather.weatherCode)));

export function deterministicFloor(context, config) {
  const { worker, site, weather, now = new Date() } = context;
  const risk = riskAt(Number(weather.wbgtC ?? weather.apparentC ?? weather.temperatureC), worker.workload, config);
  const stored = String(worker.riskLevel || '').toUpperCase();
  const level = ['HIGH','EXTREME'].includes(stored) && LEVELS.indexOf(stored) > LEVELS.indexOf(risk.level) ? stored : risk.level;
  const currentCode = Number(weather.weatherCode);
  const alreadyRaining = Number(weather.currentPrecipitation) > 0 || [51, 53, 55, 61, 63, 65, 80, 81, 82].includes(currentCode);
  const fresh = Number(weather.dataAgeMinutes ?? 0) <= config.staleWeatherMinutes;
  const floor = [];
  if (level === 'HIGH' || level === 'EXTREME') floor.push({ action: 'send_now', alert_type: level === 'EXTREME' ? 'heat_nudge' : 'shade_break', channel: 'sms', reason: `Rule floor: ${level} heat risk (${weather.wbgtC == null ? 'apparent-temperature proxy' : 'WBGT'}).`, floor: true, level });
  if (fresh && !alreadyRaining && Number(weather.rainEtaMinutes) >= 0 && Number(weather.rainEtaMinutes) <= config.rainLeadMinutes && Number(weather.rainProbability) >= config.rainProbability) {
    const shiftEnd = minutesOf(worker.shiftEnd);
    const rainAt = new Date(now.getTime() + Number(weather.rainEtaMinutes) * 60000);
    if (shiftEnd == null || shiftEnd > clockMinutesAt(rainAt, weather.timezone)) floor.push({ action: 'send_now', alert_type: 'rain_2h', channel: 'sms', variables: { minutes: Math.round(Number(weather.rainEtaMinutes)) }, reason: 'Rule floor: rain is likely before the shift ends.', floor: true, level });
  }
  if (isLightning(weather)) floor.push({ action: 'send_now', alert_type: 'lightning', channel: 'sms', reason: 'Rule floor: lightning or thunderstorm conditions.', floor: true, level });
  const rules = floor.map(item => item.reason);
  return { riskLevel: level, heatTriggerC: risk.trigger, rules, floor };
}

export function validateAiOutput(value, allowedWorkerIds) {
  if (!value || typeof value !== 'object' || Object.keys(value).length!==1 || !Array.isArray(value.decisions) || value.decisions.length !== allowedWorkerIds.length) throw new Error('AI output must contain a bounded decisions array.');
  const seen = new Set();
  for (const item of value.decisions) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !allowedWorkerIds.includes(item.worker_id) || seen.has(item.worker_id)) throw new Error('AI output contains an unknown or duplicate worker.');
    const allowedKeys=new Set(['worker_id','action','send_at','channel','alert_type','template_id','variables','reason']);
    if(Object.keys(item).some(key=>!allowedKeys.has(key))||!['worker_id','action','channel','alert_type','template_id','reason'].every(key=>Object.hasOwn(item,key)))throw new Error('AI output does not match the strict decision schema.');
    seen.add(item.worker_id);
    if (!['send_now', 'schedule', 'merge', 'skip'].includes(item.action) || !CHANNELS.has(item.channel) || !ALERT_TYPES.has(item.alert_type) || !Object.hasOwn(ALERT_TEMPLATES, item.template_id) || item.alert_type!==item.template_id) throw new Error('AI output contains an invalid action, channel, alert type, or template.');
    if (item.action === 'schedule' && (typeof item.send_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(item.send_at)||!Number.isFinite(Date.parse(item.send_at))||Date.parse(item.send_at)<Date.now())) throw new Error('Scheduled alert needs a future ISO timestamp.');
    if(item.action!=='schedule'&&Object.hasOwn(item,'send_at'))throw new Error('Only scheduled decisions may include send_at.');
    if (typeof item.reason!=='string'||item.reason.length>180||/[\r\n]/.test(item.reason)) throw new Error('AI reason must be one short line.');
    if (item.variables != null && (typeof item.variables !== 'object' || Array.isArray(item.variables) || Object.keys(item.variables).some(key=>!['minutes','level'].includes(key))||Object.values(item.variables).some(value => !['string', 'number', 'boolean'].includes(typeof value))||(item.variables.minutes!=null&&(!Number.isInteger(Number(item.variables.minutes))||Number(item.variables.minutes)<0||Number(item.variables.minutes)>360))||(item.variables.level!=null&&!['LOW','MODERATE','HIGH','EXTREME'].includes(String(item.variables.level).toUpperCase())))) throw new Error('AI template variables are invalid.');
  }
  if(seen.size!==allowedWorkerIds.length)throw new Error('AI output must decide whether to alert every eligible worker.');
  return value.decisions.map(item => ({ ...item, reason: String(item.reason || 'AI selected a safety reminder.'), variables: item.variables || {} }));
}

export function enforceGuardrails(decisions, context, history, config, now = new Date(), { aiControlled = false } = {}) {
  const allowedFloor = aiControlled ? [] : context.rule.floor;
  const floorTypes = new Set(allowedFloor.map(item => item.alert_type));
  const timezone=context.weather.timezone||'UTC';
  const sentToday = Number(history.sentToday || 0);
  return decisions.flatMap(decision => {
    if(context.worker.consentStatus&&context.worker.consentStatus!=='consented')return [{...decision,action:'skip',final_status:'skipped',reason:'Worker SMS consent has not been recorded.',floor:false}];
    const floorMatch = allowedFloor.find(item => item.alert_type === decision.alert_type);
    const source = floorMatch ? { ...floorMatch, variables: floorMatch.variables || {} } : decision;
    const floor = Boolean(source.floor);
    let status = source.action, reason = source.reason;
    if (floorMatch) status = 'send_now';
    if (source.action === 'skip') return [{ ...source, action: 'skip', final_status: 'skipped', reason, floor }];
    if(source.alert_type==='rain_clear'&&(context.state.lastAlertLevel!=='rain_2h'||Number(context.weather.currentPrecipitation)>0||context.weather.forecast?.slice(0,2).some(item=>item.rainProbability>=config.rainProbability)))return [{...source,action:'skip',final_status:'skipped',reason:'No recent rain alert is clear to close.',floor}];
    const targetTime=source.action==='schedule'?new Date(source.send_at):now,shiftStart=minutesOf(context.worker.shiftStart),shiftEnd=minutesOf(context.worker.shiftEnd),guardrailLevel=aiControlled?String(source.variables?.level||'').toUpperCase():(source.level||context.rule.riskLevel);
    if(source.action==='schedule'&&source.alert_type==='rain_2h'&&Number.isFinite(Number(context.weather.rainEtaMinutes))&&(targetTime.getTime()-now.getTime())/60000>=Number(context.weather.rainEtaMinutes))return [{...source,action:'skip',final_status:'skipped',reason:'Scheduled rain alert would arrive after the forecast rain.',floor}];
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(targetTime).map(part=>[part.type,part.value]));
    const currentMinutes=Number(parts.hour)*60+Number(parts.minute),inShift=shiftStart==null||shiftEnd==null||(shiftStart<shiftEnd?currentMinutes>=shiftStart&&currentMinutes<shiftEnd:currentMinutes>=shiftStart||currentMinutes<shiftEnd);
    if (!inShift && guardrailLevel !== 'EXTREME' && source.alert_type !== 'lightning') return [{ ...source, action: 'skip', final_status: 'skipped', reason: 'Outside the worker shift.', floor }];
    if (inQuietHours(targetTime, config.quietHours, timezone) && guardrailLevel !== 'EXTREME' && source.alert_type !== 'lightning') return [{ ...source, action: 'skip', final_status: 'skipped', reason: 'Quiet hours are active.', floor }];
    if (!floor && sentToday >= config.dailyCap) return [{ ...source, action: 'skip', final_status: 'skipped', reason: 'Worker daily alert cap reached.', floor }];
    const lastSent = history.lastByType?.[source.alert_type];
    if (!floor && lastSent && now.getTime() - new Date(lastSent).getTime() < config.cooldownMinutes * 60000) return [{ ...source, action: 'skip', final_status: 'skipped', reason: 'Same-type alert cooldown is active.', floor }];
    if (floorTypes.has(source.alert_type)) status = 'send_now';
    return [{ ...source, action: status, final_status: status === 'skip' ? 'skipped' : status === 'schedule' ? 'scheduled' : 'approved', reason, floor }];
  });
}

export function inputHash(context) { return createHash('sha256').update(JSON.stringify(context)).digest('hex'); }

export function getDeterministicDecisions(context, config) {
  const rule = deterministicFloor(context, config);
  const candidates = [...rule.floor];
  const personalNudge = rule.riskLevel === 'MODERATE' || Number(context.worker.continuousHours || 0) >= 3;
  if (personalNudge && !rule.floor.some(item => ['shade_break', 'water'].includes(item.alert_type))) candidates.push({ action: 'send_now', alert_type: Number(context.worker.continuousHours || 0) >= 3 ? 'long_exposure' : context.worker.workload === 'Heavy' || context.worker.workload === 'Heavy' ? 'shade_break' : 'rising_risk', channel: 'sms', reason: Number(context.worker.continuousHours || 0) >= 3 ? 'Long continuous work without a recorded break.' : 'Heat conditions are approaching the workload trigger.', floor: false, level: rule.riskLevel });
  return { rule, candidates };
}
