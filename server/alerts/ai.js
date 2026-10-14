import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAiOutput } from './decision.js';

const promptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ALERT_DECISION_PROMPT.md');
let promptCache;

export async function callAlertAi(contexts, config, fetchImpl = fetch) {
  if (!config.aiEnabled || !config.apiKey) return { decisions: [], modelOutput: null, status: 'disabled' };
  promptCache ||= readFile(promptPath, 'utf8');
  const system = await promptCache;
  const contents = JSON.stringify(contexts.map(context => ({
    worker: { id: context.worker.id, jobType: context.worker.jobType, workload: context.worker.workload, shiftStart: context.worker.shiftStart, shiftEnd: context.worker.shiftEnd, newWorker: context.worker.newWorker, channelPreference: context.worker.channelPreference, voiceFirst: context.worker.voiceFirst, ageGroup: context.worker.ageGroup, hasPersonalRiskFactor: Boolean(context.worker.hasPersonalRiskFactor) },
    state: context.state, site: context.site, weather: context.weather, rule: context.rule,
    limits: context.limits,
  })));
  let error;
  for (let attempt = 0; attempt <= config.retryCount; attempt++) {
    try {
      const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`, {
        method: 'POST', signal: AbortSignal.timeout(config.timeoutMs),
        headers: { 'x-goog-api-key': config.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: contents }] }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1600 } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Alert model HTTP ${response.status}`);
      const text = (body.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('').trim();
      const parsed = JSON.parse(text);
      return { decisions: validateAiOutput(parsed, contexts.map(context => context.worker.id)), modelOutput: parsed, status: 'ok', input: contents };
    } catch (cause) { error = cause; }
  }
  return { decisions: [], modelOutput: { error: String(error?.message || error).slice(0, 180) }, status: 'fallback', input: contents };
}
