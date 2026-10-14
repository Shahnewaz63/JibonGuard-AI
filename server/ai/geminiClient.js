import { randomUUID } from 'node:crypto';

const boundedJson = value => JSON.stringify(value, (_key, item) => typeof item === 'string' ? item.slice(0, 4000) : item);

export function createGeminiClient({ apiKey = '', model = 'gemini-3.5-flash-lite', db = null, fetchImpl = fetch, timeoutMs = 8000, retries = 1, clock = () => Date.now() } = {}) {
  return async function callGemini({ feature, promptVersion, system, payload, validate, organizationId = null, maxOutputTokens = 512 }) {
    const started = clock();
    let result = null, failure = 'disabled';
    if (apiKey) {
      for (let attempt = 0; attempt <= Math.min(1, Math.max(0, retries)); attempt++) {
        try {
          const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST', signal: AbortSignal.timeout(timeoutMs),
            headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: boundedJson(payload) }] }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens } }),
          });
          if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
          const body = await response.json();
          const raw = (body.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('');
          const parsed = JSON.parse(raw);
          if (!validate(parsed)) throw new Error('Gemini response failed schema validation');
          result = parsed;
          failure = '';
          break;
        } catch (error) { failure = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : String(error?.message || 'model error').slice(0, 80); }
      }
    }
    const latency = Math.max(0, clock() - started), ok = result !== null;
    if (db) {
      try {
        db.prepare('INSERT INTO ai_calls(id,organization_id,feature,prompt_version,model,ok,fallback,latency_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(randomUUID(), organizationId, String(feature).slice(0, 50), String(promptVersion).slice(0, 80), model.slice(0, 100), ok ? 1 : 0, ok ? 0 : 1, latency, Math.floor(clock() / 1000));
      } catch { /* observability failures must not break a safety decision */ }
    }
    return { ok, fallback: !ok, value: result, error: failure || null, latencyMs: latency, model, promptVersion };
  };
}

export const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
