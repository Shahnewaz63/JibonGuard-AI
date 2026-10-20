import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAiOutput } from './decision.js';
import { createGeminiClient } from '../ai/geminiClient.js';
import { checkUsageDispatch } from '../billing/entitlements.js';

const promptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ALERT_DECISION_PROMPT.md');
let promptCache;

export async function callAlertAi(contexts, config, fetchImpl = fetch) {
  if (!config.aiEnabled || !config.apiKey) return { decisions: [], modelOutput: null, status: 'disabled' };
  promptCache ||= readFile(promptPath, 'utf8');
  const system = await promptCache;
  const anonymousIds = contexts.map((_, index) => `subject_${index + 1}`);
  const contents = contexts.map((context, index) => ({
    worker: { id: anonymousIds[index], jobType: context.worker.jobType, workload: context.worker.workload, shiftStart: context.worker.shiftStart, shiftEnd: context.worker.shiftEnd, newWorker: context.worker.newWorker },
    state: context.state, site: context.site, weather: context.weather,
    limits: context.limits,
  }));
  const client = createGeminiClient({ apiKey: config.apiKey, model: config.model, db: config.db, meterUsage: config.meterUsage, usageGuard: config.db ? input => checkUsageDispatch(config.db, input) : null, fetchImpl, timeoutMs: config.timeoutMs, retries: config.retryCount });
  const response = await client({ feature: 'alert_decision', promptVersion: 'alert-decision-v2', system, payload: contents, organizationId: config.organizationId, maxOutputTokens: 8192, validate: parsed => {
    try { validateAiOutput(parsed, anonymousIds); return true; } catch { return false; }
  } });
  if (!response.ok) return { decisions: [], modelOutput: { error: response.error }, status: 'fallback', input: JSON.stringify(contents) };
  const decisions = validateAiOutput(response.value, anonymousIds).map(item => ({ ...item, worker_id: contexts[anonymousIds.indexOf(item.worker_id)].worker.id }));
  return { decisions, modelOutput: response.value, status: 'ok', input: JSON.stringify(contents) };
}
