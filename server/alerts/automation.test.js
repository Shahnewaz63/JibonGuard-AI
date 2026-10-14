import test from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_CONFIG } from './config.js';
import { decideAlerts } from './index.js';
import { callAlertAi } from './ai.js';
import { dispatchAlertGroups } from './gateway.js';

const config = { ...ALERT_CONFIG, enabled: true, aiEnabled: false, baseHeatTriggerC: 34, workloadOffsets: { Light: 0, Standard: 2, Moderate: 2, Heavy: 4, 'Very Heavy': 6 }, rainLeadMinutes: 120, rainProbability: 60, cooldownMinutes: 40, dailyCap: 2, quietHours: { start: '20:00', end: '06:00' }, staleWeatherMinutes: 45 };
const context = (overrides = {}) => ({
  worker: { id: 'worker_1', workload: 'Light', riskLevel: '', consentStatus: 'consented', shiftStart: '07:00', shiftEnd: '17:00', continuousHours: 1, voiceFirst: false, ...overrides.worker },
  site: { id: 'site_1', shadeAvailable: true, waterAvailable: true, ...overrides.site },
  weather: { apparentC: 28, temperatureC: 28, dataAgeMinutes: 5, currentPrecipitation: 0, rainProbability: 0, rainEtaMinutes: null, lightning: false, ...overrides.weather },
  state: { alertsSentToday: 0, ...overrides.state }, now: overrides.now || new Date('2026-10-13T10:00:00Z'),
});

test('HIGH and EXTREME stored risk always creates floor alerts, even over daily cap', async () => {
  for (const riskLevel of ['HIGH', 'EXTREME']) {
    const result = await decideAlerts([context({ worker: { riskLevel } })], { config, aiClient: async () => ({ decisions: [], status: 'disabled' }), getHistory: () => ({ sentToday: 99 }) });
    assert.equal(result.decisions.some(item => item.floor && item.final_status === 'approved'), true);
  }
});

test('rain inside 120 minutes triggers once, while rain in 3 hours or already falling does not', async () => {
  const evaluate = weather => decideAlerts([context({ weather })], { config, aiClient: async () => ({ decisions: [], status: 'disabled' }) });
  assert.equal((await evaluate({ rainEtaMinutes: 90, rainProbability: 80 })).decisions.some(item => item.alert_type === 'rain_2h' && item.floor), true);
  assert.equal((await evaluate({ rainEtaMinutes: 180, rainProbability: 90 })).decisions.some(item => item.alert_type === 'rain_2h'), false);
  assert.equal((await evaluate({ rainEtaMinutes: 30, rainProbability: 90, currentPrecipitation: 1 })).decisions.some(item => item.alert_type === 'rain_2h'), false);
  assert.equal((await evaluate({ rainEtaMinutes: 90, rainProbability: 90, dataAgeMinutes: 60 })).decisions.some(item => item.alert_type === 'rain_2h'), false);
  assert.equal((await evaluate({ rainEtaMinutes: 90, rainProbability: 90, timezone: 'UTC' }).then(result => result.decisions.find(item => item.alert_type === 'rain_2h')?.message.includes('90'))), true);
  const afterShift=await decideAlerts([context({worker:{shiftEnd:'11:00'},weather:{rainEtaMinutes:90,rainProbability:90}})],{config,aiClient:async()=>({decisions:[],status:'disabled'})});
  assert.equal(afterShift.decisions.some(item=>item.alert_type==='rain_2h'&&item.floor),false);
});

test('lightning always creates a floor alert, even when the model is unavailable', async () => {
  const result = await decideAlerts([context({ weather: { lightning: true } })], { config: { ...config, aiEnabled: true }, aiClient: async () => ({ decisions: [], status: 'fallback', modelOutput: { error: 'timeout' } }) });
  assert.equal(result.decisions.some(item => item.alert_type === 'lightning' && item.floor), true);
});

test('heavier workloads reach the shade trigger before light workload', async () => {
  const contexts = [context({ worker: { id: 'heavy', workload: 'Heavy' }, weather: { apparentC: 31, temperatureC: 31 } }), context({ worker: { id: 'light', workload: 'Light' }, weather: { apparentC: 31, temperatureC: 31 } })];
  const result = await decideAlerts(contexts, { config, aiClient: async () => ({ decisions: [], status: 'disabled' }) });
  assert.equal(result.decisions.some(item => item.workerId === 'heavy' && item.alert_type === 'shade_break'), true);
  assert.equal(result.decisions.some(item => item.workerId === 'light' && item.alert_type === 'shade_break'), false);
});

test('consent, cooldown, daily cap and quiet hours constrain AI decisions', async () => {
  const request = worker_id => ({ worker_id, action: 'send_now', channel: 'sms', alert_type: 'water', template_id: 'water', variables: {}, reason: 'A reminder may help.' });
  const aiClient = async contexts => ({ status: 'ok', decisions: contexts.map(item => request(item.worker.id)) });
  const contexts = [context({ worker: { id: 'no-consent', consentStatus: 'pending', consentAt: null } }), context({ worker: { id: 'cooldown' } }), context({ worker: { id: 'capped' } }), context({ worker: { id: 'quiet', shiftStart: '00:00', shiftEnd: '23:59' }, now: new Date('2026-10-13T23:00:00Z') })];
  const results = await decideAlerts(contexts, { config, aiClient, getHistory: id => id === 'cooldown' ? { lastByType: { water: '2026-10-13T09:50:00Z' } } : id === 'capped' ? { sentToday: 2 } : {} });
  assert.match(results.decisions.find(item => item.workerId === 'no-consent').reason, /consent/i);
  assert.match(results.decisions.find(item => item.workerId === 'cooldown').reason, /cooldown/i);
  assert.match(results.decisions.find(item => item.workerId === 'capped').reason, /cap/i);
  assert.match(results.decisions.find(item => item.workerId === 'quiet').reason, /Quiet hours/i);
});

test('AI failure and empty output are rule-only and never throw', async () => {
  const floor = context({ worker: { riskLevel: 'HIGH' } });
  const failed = await decideAlerts([floor], { config: { ...config, aiEnabled: true }, aiClient: async () => ({ decisions: [], status: 'fallback', modelOutput: { error: 'timeout' } }) });
  const empty = await decideAlerts([floor], { config, aiClient: async () => ({ decisions: [], status: 'ok' }) });
  assert.ok(failed.decisions.some(item => item.floor));
  assert.ok(empty.decisions.some(item => item.floor));
});

test('stale weather suppresses optional AI decisions but still preserves a deterministic floor',async()=>{
  let aiCalled=false;
  const stale=context({weather:{apparentC:31,dataAgeMinutes:60}});
  const result=await decideAlerts([stale],{config:{...config,aiEnabled:true},aiClient:async()=>{aiCalled=true;return {decisions:[],status:'ok'};}});
  assert.equal(aiCalled,false);
  assert.equal(result.decisions.some(item=>item.reason.includes('Weather data is delayed')),true);
  const staleFloor=await decideAlerts([context({worker:{riskLevel:'HIGH'},weather:{dataAgeMinutes:60}})],{config,aiClient:async()=>({decisions:[],status:'disabled'})});
  assert.equal(staleFloor.decisions.some(item=>item.floor),true);
});

test('AI cannot skip an existing floor alert, and the prompt omits names and phone numbers', async () => {
  let sentPrompt='';
  const protectedContext=context({worker:{riskLevel:'HIGH',name:'Private Name',phone:'+8801700000000'}});
  const result=await decideAlerts([protectedContext],{config:{...config,aiEnabled:true},aiClient:async contexts=>{
    sentPrompt=JSON.stringify(contexts.map(item=>({worker:{id:item.worker.id,workload:item.worker.workload},rule:item.rule})));
    return {status:'ok',decisions:[{worker_id:contexts[0].worker.id,action:'skip',channel:'sms',alert_type:'shade_break',template_id:'shade_break',reason:'Avoid this prompt.'}]};
  }});
  assert.ok(result.decisions.some(item=>item.floor&&item.final_status==='approved'));
  const configWithAi={...config,aiEnabled:true,apiKey:'test-key',model:'test-model',retryCount:0,timeoutMs:1000};
  await callAlertAi([protectedContext],configWithAi,async(_url,options)=>{sentPrompt=options.body;return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:'{"decisions":[]}'}]}}]})};});
  assert.doesNotMatch(sentPrompt,/Private Name|\+8801700000000/);
  assert.doesNotMatch(sentPrompt,/worker_1/);
});

test('identical team SMS is grouped; an unavailable voice-only channel falls back to SMS',async()=>{
  let smsCalls=0;
  const result=await dispatchAlertGroups([{id:'one',phone:'+8801700000001',message:'Same message',channel:'sms'},{id:'two',phone:'+8801700000002',message:'Same message',channel:'sms'},{id:'three',phone:'+8801700000003',message:'Urgent',channel:'voice'}],{smsSender:async recipients=>{smsCalls++;return {accepted:recipients.length>0};},voiceSender:async()=>({accepted:false})});
  assert.equal(result.length,2);
  assert.equal(result[0].recipients.length,2);
  assert.equal(result[1].smsFallback,true);
  assert.equal(smsCalls,2);
});

test('invalid, empty and timed-out model responses fall back without throwing', async () => {
  const configWithAi={...config,aiEnabled:true,apiKey:'test-key',model:'test-model',retryCount:0,timeoutMs:1000};
  const contextOne=context({worker:{id:'worker_one'}});
  const invalid=await callAlertAi([contextOne],configWithAi,async()=>({ok:true,json:async()=>({candidates:[{content:{parts:[{text:'not json'}]}}]})}));
  const empty=await callAlertAi([contextOne],configWithAi,async()=>({ok:true,json:async()=>({candidates:[{content:{parts:[{text:'{"decisions":[]}'}]}}]})}));
  const timedOut=await callAlertAi([contextOne],{...configWithAi,timeoutMs:10},async(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('timeout')),{once:true})));
  assert.equal(invalid.status,'fallback');
  assert.equal(empty.status,'ok');
  assert.deepEqual(empty.decisions,[]);
  assert.equal(timedOut.status,'fallback');
});
