import { randomUUID } from 'node:crypto';

function safeJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '{}';
  const forbidden = /phone|name|email|symptom|health|message|address|token|secret/i;
  const clean = Object.fromEntries(Object.entries(value).filter(([key]) => !forbidden.test(key)).slice(0, 40));
  return JSON.stringify(clean);
}

const scaledProduct = (left, right, divisor = 1) => {
  const denominator=BigInt(divisor);
  const value = (BigInt(left) * BigInt(right) + denominator / 2n) / denominator, number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError('Usage amount exceeds the safe integer range.');
  return number;
};

const INCLUDED_LIMITS = Object.freeze({sms_outbound:'sms_segments_month',ai_call:'ai_tokens_month',voice_seconds:'voice_minutes_month',weather_api_call:'weather_checks_month'});

function calculateOverage(db,event,createdAt,quantity){
  const limitKey=INCLUDED_LIMITS[event.eventType];if(!limitKey)return quantity;
  const subscription=db.prepare("SELECT * FROM subscriptions WHERE organization_id=? AND status IN ('active','trialing','past_due') ORDER BY created_at DESC LIMIT 1").get(event.organizationId);
  if(!subscription)return quantity;
  let overridden;
  try{overridden=JSON.parse(subscription.limits_override_json||'{}')[limitKey];}catch{overridden=undefined;}
  let allowance=null;
  if(overridden===-1||overridden?.unlimited===true)return 0;
  if(Number.isSafeInteger(overridden))allowance=overridden;
  else if(Number.isSafeInteger(overridden?.value))allowance=overridden.value;
  if(allowance===null){
    const row=db.prepare('SELECT value,unlimited FROM plan_limits WHERE plan_id=? AND limit_key=?').get(subscription.plan_id,limitKey);
    if(row?.unlimited)return 0;
    if(Number.isSafeInteger(row?.value))allowance=row.value;
  }
  if(allowance===null)return 0;
  const periodConsumed=Number(db.prepare("SELECT COALESCE(SUM(quantity),0) AS n FROM usage_events WHERE organization_id=? AND event_type=? AND status IN ('queued','sent','delivered','success') AND created_at>=? AND created_at<?").get(event.organizationId,event.eventType,subscription.current_period_start,subscription.current_period_end).n||0);
  const unitScale=event.eventType==='voice_seconds'?60:1,limit=allowance*unitScale,already=periodConsumed;
  const policy=db.prepare('SELECT policy FROM plan_overage_settings WHERE plan_id=?').get(subscription.plan_id)?.policy||'soft_warn';
  if(policy!=='charge_overage')return 0;
  return Math.max(0,already+quantity-limit)-Math.max(0,already-limit);
}

export function createMeteringService(db, { logger = console, clock = () => Math.floor(Date.now() / 1000), defaultCurrency = 'BDT' } = {}) {
  function recordUsage(event) {
    try {
      if (!event?.organizationId || !event?.eventType || !Number.isSafeInteger(event.quantity) || event.quantity < 0) return { recorded: false, reason: 'invalid_event' };
      const createdAt = event.createdAt ?? clock(), model = String(event.model || '').slice(0, 100), provider = String(event.provider || '').slice(0, 80);
      const costRate = db.prepare('SELECT unit_cost_minor,currency FROM cost_rates WHERE event_type=? AND provider=? AND model IN (?,\'\') AND effective_from<=? ORDER BY CASE WHEN model=? THEN 0 ELSE 1 END,effective_from DESC LIMIT 1').get(event.eventType, provider, model, createdAt, model);
      const priceRate = db.prepare('SELECT unit_price_minor,currency FROM price_rates WHERE event_type=? AND feature IN (?,\'\') AND effective_from<=? ORDER BY CASE WHEN feature=? THEN 0 ELSE 1 END,effective_from DESC LIMIT 1').get(event.eventType, String(event.feature || ''), createdAt, String(event.feature || ''));
      const inputCostRate=event.eventType==='ai_call'&&Number.isSafeInteger(event.tokensInput)?db.prepare("SELECT unit_cost_minor,currency FROM cost_rates WHERE event_type='ai_call' AND provider=? AND model IN (?, '') AND unit='input_1m_tokens' AND effective_from<=? ORDER BY CASE WHEN model=? THEN 0 ELSE 1 END,effective_from DESC LIMIT 1").get(provider,model,createdAt,model):null;
      const outputCostRate=event.eventType==='ai_call'&&Number.isSafeInteger(event.tokensOutput)?db.prepare("SELECT unit_cost_minor,currency FROM cost_rates WHERE event_type='ai_call' AND provider=? AND model IN (?, '') AND unit='output_1m_tokens' AND effective_from<=? ORDER BY CASE WHEN model=? THEN 0 ELSE 1 END,effective_from DESC LIMIT 1").get(provider,model,createdAt,model):null;
      const inputPriceRate=event.eventType==='ai_call'&&Number.isSafeInteger(event.tokensInput)?db.prepare("SELECT unit_price_minor,currency FROM price_rates WHERE event_type='ai_call' AND feature IN (?, '') AND unit='input_1m_tokens' AND effective_from<=? ORDER BY CASE WHEN feature=? THEN 0 ELSE 1 END,effective_from DESC LIMIT 1").get(String(event.feature||''),createdAt,String(event.feature||'')):null;
      const outputPriceRate=event.eventType==='ai_call'&&Number.isSafeInteger(event.tokensOutput)?db.prepare("SELECT unit_price_minor,currency FROM price_rates WHERE event_type='ai_call' AND feature IN (?, '') AND unit='output_1m_tokens' AND effective_from<=? ORDER BY CASE WHEN feature=? THEN 0 ELSE 1 END,effective_from DESC LIMIT 1").get(String(event.feature||''),createdAt,String(event.feature||'')):null;
      const currency = String(event.currency || costRate?.currency || inputCostRate?.currency || outputCostRate?.currency || priceRate?.currency || defaultCurrency).toUpperCase();
      let unitCost = Number.isSafeInteger(event.unitCostMinor) ? event.unitCostMinor : Number(costRate?.unit_cost_minor || 0);
      let computedCost=scaledProduct(unitCost,event.quantity,event.rateDivisor||1);
      if(event.eventType==='ai_call'&&Number.isSafeInteger(event.tokensInput)&&Number.isSafeInteger(event.tokensOutput)){
        const inputRate=Number(inputCostRate?.unit_cost_minor||0),outputRate=Number(outputCostRate?.unit_cost_minor||0);
        computedCost=scaledProduct(inputRate,event.tokensInput,1000000)+scaledProduct(outputRate,event.tokensOutput,1000000);
        unitCost=event.quantity?Math.round((inputRate*event.tokensInput+outputRate*event.tokensOutput)/event.quantity):0;
      }
      let unitPrice = Number.isSafeInteger(event.unitPriceMinor) ? event.unitPriceMinor : Number(priceRate?.unit_price_minor || 0);
      if(event.eventType==='ai_call'&&Number.isSafeInteger(event.tokensInput)&&Number.isSafeInteger(event.tokensOutput))unitPrice=event.quantity?Math.round((Number(inputPriceRate?.unit_price_minor||0)*event.tokensInput+Number(outputPriceRate?.unit_price_minor||0)*event.tokensOutput)/event.quantity):0;
      if (unitCost < 0 || unitPrice < 0) return { recorded: false, reason: 'invalid_rate' };
      const billableQuantity=calculateOverage(db,event,createdAt,event.quantity);
      const overagePrice=event.eventType==='ai_call'&&Number.isSafeInteger(event.tokensInput)&&Number.isSafeInteger(event.tokensOutput)
        ?scaledProduct(event.quantity?Math.round((Number(inputPriceRate?.unit_price_minor||0)*event.tokensInput+Number(outputPriceRate?.unit_price_minor||0)*event.tokensOutput)/event.quantity):0,billableQuantity,1000000)
        :scaledProduct(unitPrice,billableQuantity,event.rateDivisor||1);
      const tokensInput = Number.isSafeInteger(event.tokensInput) ? event.tokensInput : null, tokensOutput = Number.isSafeInteger(event.tokensOutput) ? event.tokensOutput : null;
      const result = db.prepare(`INSERT OR IGNORE INTO usage_events(id,idempotency_key,organization_id,site_id,event_type,provider,feature,quantity,unit,rate_divisor,status,category,tokens_input,tokens_output,tokens_total,latency_ms,estimated,unit_cost_minor,unit_price_minor,cost_minor,price_minor,currency,model,ref_type,ref_id,metadata_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(), event.idempotencyKey || null, event.organizationId, event.siteId || null, String(event.eventType).slice(0, 80), provider,
        String(event.feature || '').slice(0, 80), event.quantity, String(event.unit || 'unit').slice(0, 40), Number.isSafeInteger(event.rateDivisor)&&event.rateDivisor>0?event.rateDivisor:1, String(event.status || '').slice(0, 40), String(event.category || '').slice(0,40),
        tokensInput, tokensOutput, tokensInput == null || tokensOutput == null ? null : tokensInput + tokensOutput,
        Number.isSafeInteger(event.latencyMs) ? event.latencyMs : null, event.estimated ? 1 : 0, unitCost, unitPrice,
        computedCost, overagePrice, currency, model,
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
