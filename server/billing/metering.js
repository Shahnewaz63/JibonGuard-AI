import { randomUUID } from 'node:crypto';

function safeJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '{}';
  const forbidden = /phone|name|email|symptom|health|message|address|token|secret/i;
  const clean = Object.fromEntries(Object.entries(value).filter(([key]) => !forbidden.test(key)).slice(0, 40));
  return JSON.stringify(clean);
}

const product = (left, right) => {
  const value = BigInt(left) * BigInt(right), number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError('Usage amount exceeds the safe integer range.');
  return number;
};

export function createMeteringService(db, { logger = console, clock = () => Math.floor(Date.now() / 1000), defaultCurrency = 'BDT' } = {}) {
  function recordUsage(event) {
    try {
      if (!event?.organizationId || !event?.eventType || !Number.isSafeInteger(event.quantity) || event.quantity < 0) return { recorded: false, reason: 'invalid_event' };
      const createdAt = event.createdAt ?? clock(), model = String(event.model || '').slice(0, 100), provider = String(event.provider || '').slice(0, 80);
      const costRate = db.prepare('SELECT unit_cost_minor,currency FROM cost_rates WHERE event_type=? AND provider=? AND model IN (?,\'\') AND effective_from<=? ORDER BY CASE WHEN model=? THEN 0 ELSE 1 END,effective_from DESC LIMIT 1').get(event.eventType, provider, model, createdAt, model);
      const priceRate = db.prepare('SELECT unit_price_minor,currency FROM price_rates WHERE event_type=? AND feature IN (?,\'\') AND effective_from<=? ORDER BY CASE WHEN feature=? THEN 0 ELSE 1 END,effective_from DESC LIMIT 1').get(event.eventType, String(event.feature || ''), createdAt, String(event.feature || ''));
      const currency = String(event.currency || costRate?.currency || priceRate?.currency || defaultCurrency).toUpperCase();
      const unitCost = Number.isSafeInteger(event.unitCostMinor) ? event.unitCostMinor : Number(costRate?.unit_cost_minor || 0);
      const unitPrice = Number.isSafeInteger(event.unitPriceMinor) ? event.unitPriceMinor : Number(priceRate?.unit_price_minor || 0);
      if (unitCost < 0 || unitPrice < 0) return { recorded: false, reason: 'invalid_rate' };
      const tokensInput = Number.isSafeInteger(event.tokensInput) ? event.tokensInput : null, tokensOutput = Number.isSafeInteger(event.tokensOutput) ? event.tokensOutput : null;
      const result = db.prepare(`INSERT OR IGNORE INTO usage_events(id,idempotency_key,organization_id,site_id,event_type,provider,feature,quantity,unit,status,category,tokens_input,tokens_output,tokens_total,latency_ms,estimated,unit_cost_minor,unit_price_minor,cost_minor,price_minor,currency,model,ref_type,ref_id,metadata_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(), event.idempotencyKey || null, event.organizationId, event.siteId || null, String(event.eventType).slice(0, 80), provider,
        String(event.feature || '').slice(0, 80), event.quantity, String(event.unit || 'unit').slice(0, 40), String(event.status || '').slice(0, 40), String(event.category || '').slice(0,40),
        tokensInput, tokensOutput, tokensInput == null || tokensOutput == null ? null : tokensInput + tokensOutput,
        Number.isSafeInteger(event.latencyMs) ? event.latencyMs : null, event.estimated ? 1 : 0, unitCost, unitPrice,
        product(unitCost, event.quantity), product(unitPrice, event.quantity), currency, model,
        String(event.refType || '').slice(0, 80), String(event.refId || '').slice(0, 120), safeJson(event.metadata), createdAt);
      return { recorded: result.changes === 1, duplicate: result.changes === 0 };
    } catch (error) {
      try { logger.error?.(`Usage metering failed (${error?.name || 'Error'}).`); } catch { /* logging must also fail open */ }
      return { recorded: false, reason: 'metering_error' };
    }
  }
  return { recordUsage };
}

export const estimateGeminiTokens = (inputText, outputText) => ({
  inputTokens: Math.ceil(String(inputText || '').length / 4),
  outputTokens: Math.ceil(String(outputText || '').length / 4),
  estimated: true,
});
