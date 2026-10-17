import React,{useEffect,useMemo,useState} from 'react';

function money(minor,currency){
  const formatter=new Intl.NumberFormat(undefined,{style:'currency',currency});
  const digits=formatter.resolvedOptions().maximumFractionDigits;
  return formatter.format(minor/(10**digits));
}

const LIMIT_LABELS={workers:'Workers',sites:'Worksites',users:'Team members',sms_segments_month:'SMS segments / month',ai_tokens_month:'AI tokens / month',weather_checks_month:'Weather checks / month',retention_days:'Data retention (days)'};
const FEATURE_LABELS={ai_chat:'AI safety assistant',ai_alert_automation:'Automated safety alerts',simulator:'Alert simulator',voice_alerts:'AI speech and live voice tools',csv_import:'CSV worker import',data_export:'Account data export',break_planner:'AI break planner',nowcasting:'Weather nowcasting',heat_triage:'Heat risk triage',ai_reports:'AI safety reports',official_advisories:'Official advisories',priority_support:'Priority support',api_access:'API access',custom_branding:'Custom branding'};
const formatLimit=(key,limit)=>{
  if(limit.unlimited)return 'Unlimited';
  if(key==='ai_tokens_month')return new Intl.NumberFormat().format(limit.value);
  if(key==='voice_minutes_month')return limit.value===0?'Not included':null;
  return new Intl.NumberFormat().format(limit.value);
};

function usePricingPlans(){
  const [plans,setPlans]=useState([]),[cycle,setCycle]=useState('monthly'),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  useEffect(()=>{let live=true;fetch('/api/pricing').then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error||'Plans could not be loaded.');if(live)setPlans(data.plans||[]);}).catch(reason=>{if(live)setError(reason.message);}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[]);
  const features=useMemo(()=>[...new Set(plans.flatMap(plan=>Object.keys(plan.features||{}).filter(key=>plan.features[key])))],[plans]);
  return {plans,cycle,setCycle,error,loading,features};
}

function CycleToggle({cycle,setCycle}){
  return <div className="cycle-toggle" role="group" aria-label="Billing cycle"><button type="button" className={cycle==='monthly'?'selected':''} onClick={()=>setCycle('monthly')}>Monthly</button><button type="button" className={cycle==='yearly'?'selected':''} onClick={()=>setCycle('yearly')}>Yearly <small>2 months free</small></button></div>;
}

function PlanCards({plans,cycle,features,error,loading}){
  if(loading)return <p className="pricing-state">Loading current plans…</p>;
  if(error)return <p className="pricing-state error">{error}</p>;
  if(!plans.length)return <section className="pricing-empty"><h2>Plans are being prepared</h2><p>Contact our team for current plan availability.</p><a className="button primary" href="mailto:hello@jibonguard.org">Contact us</a></section>;
  return <section className="pricing-grid">{plans.map(plan=>{
    const price=plan.prices.find(item=>item.billing_cycle===cycle),isEnterprise=plan.slug==='legacy';
    const listedLimits=Object.entries(plan.limits||{}).filter(([key])=>LIMIT_LABELS[key]);
    return <article className="pricing-card" key={plan.id}>
      {plan.badge_text&&<span className="plan-badge">{plan.badge_text}</span>}
      <h2>{plan.name}</h2><p>{plan.description}</p>
      <p className="plan-price">{isEnterprise?'Custom pricing':price?money(price.amount_minor,price.currency):'Contact us'}<small>{!isEnterprise&&price?` / ${cycle==='monthly'?'month':'year'}`:''}</small></p>
      <ul>{listedLimits.map(([key,limit])=>{const value=formatLimit(key,limit);return value===null?null:<li key={key}>{LIMIT_LABELS[key]}: {value}</li>;})}{features.filter(key=>plan.features?.[key]).map(key=><li key={key}>{FEATURE_LABELS[key]||key.replaceAll('_',' ')}</li>)}</ul>
      {isEnterprise?<a className="button primary" href="mailto:hello@jibonguard.org?subject=JibonGuard%20Legacy%20enterprise%20plan">Contact sales</a>:<a className="button primary" href={`/signup.html?plan=${encodeURIComponent(plan.slug)}&cycle=${cycle}`}>Choose {plan.name}</a>}
    </article>;
  })}</section>;
}

export function PricingSection(){
  const data=usePricingPlans();
  return <section className="home-section soft pricing-home-section" id="pricing"><div className="wrap"><div className="pricing-intro"><p className="eyebrow">Plans and pricing</p><h2>Safety tools that fit your team</h2><p>Every plan includes SMS safety messaging. Monthly AI token allowances and team limits scale with your plan.</p><CycleToggle cycle={data.cycle} setCycle={data.setCycle}/></div><PlanCards {...data}/><footer className="pricing-footer"><p>Pro includes AI speech and browser live-voice tools. Phone-call delivery requires a telephony provider and is not currently available.</p></footer></div></section>;
}

export default function PricingPage(){
  const data=usePricingPlans();
  return <main className="pricing-page">
    <header className="pricing-header"><a href="/" className="brand">JibonGuard AI</a><a href="/login.html" className="button secondary">Sign in</a></header>
    <section className="pricing-intro"><p className="eyebrow">Plans and pricing</p><h1>Safety tools that fit your team</h1><p>Every plan includes SMS safety messaging. Monthly AI token allowances and team limits scale with your plan.</p><CycleToggle cycle={data.cycle} setCycle={data.setCycle}/></section>
    <PlanCards {...data}/>
    <footer className="pricing-footer"><p>Pro includes AI speech and browser live-voice tools. Phone-call delivery requires a telephony provider and is not currently available. SMS and AI usage depend on provider service and plan allowances.</p><a href="/">Back to JibonGuard</a></footer>
  </main>;
}
