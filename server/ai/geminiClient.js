import { randomUUID } from 'node:crypto';
import { estimateGeminiTokens } from '../billing/metering.js';

const boundedJson = value => JSON.stringify(value, (_key, item) => typeof item === 'string' ? item.slice(0, 4000) : item);

export function createGeminiClient({ apiKey = '', model = 'gemini-3.5-flash-lite', db = null, meterUsage = null, usageGuard = null, fetchImpl = fetch, timeoutMs = 8000, retries = 1, clock = () => Date.now() } = {}) {
  return async function callGemini({ feature, promptVersion, system, payload, validate, organizationId = null, maxOutputTokens = 512 }) {
    const started = clock(), inputText = `${String(system||'')}\n${boundedJson(payload)}`;
    let result = null, failure = 'disabled',quotaDenied=false;
    let usage=null;
    if (apiKey) {
      const estimate=estimateGeminiTokens(inputText,'');
      const quota=usageGuard&&organizationId?usageGuard({organizationId,eventType:'ai_call',quantity:estimate.inputTokens+maxOutputTokens}):{allowed:true};
      if(!quota.allowed){failure='plan_limit';quotaDenied=true;}
      for (let attempt = 0; quota.allowed&&attempt <= Math.min(1, Math.max(0, retries)); attempt++) {
        try {
          const generationConfig={responseMimeType:'application/json',maxOutputTokens};
          if(model.startsWith('gemini-3'))generationConfig.thinkingConfig={thinkingLevel:'minimal'};
          const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST', signal: AbortSignal.timeout(timeoutMs),
            headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: boundedJson(payload) }] }], generationConfig }),
          });
          if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
          const body = await response.json();
          const raw = (body.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('');
          const meta=body.usageMetadata||{};
          const estimate=estimateGeminiTokens(inputText,raw);
          usage={inputTokens:Number.isSafeInteger(meta.promptTokenCount)?meta.promptTokenCount:estimate.inputTokens,outputTokens:Number.isSafeInteger(meta.candidatesTokenCount)?meta.candidatesTokenCount:estimate.outputTokens,estimated:!Number.isSafeInteger(meta.promptTokenCount)||!Number.isSafeInteger(meta.candidatesTokenCount)};
          const parsed = JSON.parse(raw);
          if (!validate(parsed)) throw new Error('Gemini response failed schema validation');
          result = parsed;
          failure = '';
          break;
        } catch (error) { failure = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : String(error?.message || 'model error').slice(0, 80); }
      }
    }
    const latency = Math.max(0, clock() - started), ok = result !== null;
    usage ||= quotaDenied?{inputTokens:0,outputTokens:0,estimated:true}:{...estimateGeminiTokens(inputText,''),outputTokens:0};
    if(!quotaDenied)try{meterUsage?.({organizationId,eventType:'ai_call',provider:'gemini',feature,quantity:usage.inputTokens+usage.outputTokens,unit:'token',rateDivisor:1000000,tokensInput:usage.inputTokens,tokensOutput:usage.outputTokens,estimated:usage.estimated,status:ok?'success':'failed',model,latencyMs:latency,metadata:{estimated:usage.estimated,fallback:!ok},idempotencyKey:`gemini:${randomUUID()}`});}catch{}
    if (db) {
      try {
        db.prepare('INSERT INTO ai_calls(id,organization_id,feature,prompt_version,model,ok,fallback,latency_ms,input_tokens,output_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(randomUUID(), organizationId, String(feature).slice(0, 50), String(promptVersion).slice(0, 80), model.slice(0, 100), ok ? 1 : 0, ok ? 0 : 1, latency, usage.inputTokens, usage.outputTokens, Math.floor(clock() / 1000));
      } catch { /* observability failures must not break a safety decision */ }
    }
    return { ok, fallback: !ok, value: result, error: failure || null, latencyMs: latency, model, promptVersion, usage };
  };
}

export const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
