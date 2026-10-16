import { FEATURE_KEYS } from './features.js';

const USAGE_LIMITS=Object.freeze({sms_outbound:'sms_segments_month',ai_call:'ai_tokens_month',voice_seconds:'voice_minutes_month',weather_api_call:'weather_checks_month'});

export function getOrganizationEntitlements(db,organizationId){
  const subscription=db.prepare("SELECT * FROM subscriptions WHERE organization_id=? AND status IN ('trialing','active','past_due','suspended') ORDER BY created_at DESC LIMIT 1").get(organizationId);
  const features=Object.fromEntries(FEATURE_KEYS.map(key=>[key,false])),limits={};
  if(!subscription)return {subscription:null,features,limits};
  for(const row of db.prepare('SELECT feature_key,enabled FROM plan_features WHERE plan_id=?').all(subscription.plan_id))if(Object.hasOwn(features,row.feature_key))features[row.feature_key]=Boolean(row.enabled);
  for(const row of db.prepare('SELECT limit_key,value,unlimited FROM plan_limits WHERE plan_id=?').all(subscription.plan_id))limits[row.limit_key]=row.unlimited?{unlimited:true,value:null}:{unlimited:false,value:row.value};
  try{for(const [key,value] of Object.entries(JSON.parse(subscription.features_override_json||'{}')))if(Object.hasOwn(features,key)&&typeof value==='boolean')features[key]=value;}catch{}
  try{for(const [key,value] of Object.entries(JSON.parse(subscription.limits_override_json||'{}'))){if(value===-1||value?.unlimited===true)limits[key]={unlimited:true,value:null};else if(Number.isSafeInteger(value))limits[key]={unlimited:false,value};else if(Number.isSafeInteger(value?.value))limits[key]={unlimited:false,value:value.value};}}catch{}
  if(subscription.status==='suspended'||subscription.status==='cancelled'||subscription.status==='expired')for(const key of FEATURE_KEYS)features[key]=false;
  return {subscription,features,limits};
}

export function checkFeatureAccess(db,organizationId,featureKey){
  const entitlements=getOrganizationEntitlements(db,organizationId);
  return {allowed:Boolean(entitlements.subscription&&entitlements.features[featureKey]&&['trialing','active','past_due'].includes(entitlements.subscription.status)),feature:featureKey,planId:entitlements.subscription?.plan_id||null,status:entitlements.subscription?.status||'unassigned'};
}

export function checkResourceLimit(db,organizationId,limitKey,currentCount,adding=1){
  const {subscription,limits}=getOrganizationEntitlements(db,organizationId),limit=limits[limitKey];
  if(!subscription||!['trialing','active','past_due'].includes(subscription.status))return {allowed:false,limit:0,current:currentCount,requested:adding};
  if(!limit||limit.unlimited)return {allowed:true,unlimited:true,current:currentCount,requested:adding};
  return {allowed:currentCount+adding<=limit.value,unlimited:false,limit:limit.value,current:currentCount,requested:adding};
}

export function checkUsageDispatch(db,{organizationId,eventType,quantity,category='routine',now=Math.floor(Date.now()/1000)}){
  const {subscription,limits}=getOrganizationEntitlements(db,organizationId);
  if(!subscription)return {allowed:false,reason:'unassigned',used:0,limit:0};
  if(subscription.status==='suspended'||subscription.status==='cancelled'||subscription.status==='expired'){
    const exempt=db.prepare("SELECT value_json FROM billing_settings WHERE setting_key='safety_alerts_exempt_from_limits'").get()?.value_json!=='false';
    if(exempt&&['safety','emergency'].includes(category))return {allowed:true,safetyExemptApplied:true};
    return {allowed:false,reason:subscription.status,used:0,limit:0};
  }
  const limitKey=USAGE_LIMITS[eventType],limit=limitKey?limits[limitKey]:null;
  if(!limit||limit.unlimited)return {allowed:true,unlimited:true};
  const policy=db.prepare('SELECT policy FROM plan_overage_settings WHERE plan_id=?').get(subscription.plan_id)?.policy||'soft_warn';
  const periodStart=subscription.current_period_start,periodEnd=subscription.current_period_end;
  const used=Number(db.prepare('SELECT COALESCE(SUM(quantity),0) AS n FROM usage_events WHERE organization_id=? AND event_type=? AND created_at>=? AND created_at<?').get(organizationId,eventType,periodStart,periodEnd).n||0);
  const scaledLimit=limitKey==='voice_minutes_month'?limit.value*60:limit.value;
  const safetyExempt=db.prepare("SELECT value_json FROM billing_settings WHERE setting_key='safety_alerts_exempt_from_limits'").get()?.value_json!=='false';
  if(safetyExempt&&['safety','emergency'].includes(category))return {allowed:true,safetyExemptApplied:true,used,limit:scaledLimit,policy};
  const within=used+quantity<=scaledLimit;
  return {allowed:within||policy!=='block',blocked:!within&&policy==='block',used,limit:scaledLimit,policy,overage:Math.max(0,used+quantity-scaledLimit),remaining:Math.max(0,scaledLimit-used),now};
}
