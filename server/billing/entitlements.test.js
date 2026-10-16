import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../db/migrations.js';
import { checkFeatureAccess, checkResourceLimit, checkUsageDispatch } from './entitlements.js';

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE organizations(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES('org-1'); CREATE TABLE workers(id TEXT PRIMARY KEY); CREATE TABLE sites(id TEXT PRIMARY KEY);");
  runMigrations(db,{development:false,clock:()=>100});
  return db;
}

test('legacy organizations retain current features and unlimited resources',()=>{
  const db=fixture();
  assert.equal(checkFeatureAccess(db,'org-1','csv_import').allowed,true);
  assert.equal(checkFeatureAccess(db,'org-1','ai_chat').allowed,true);
  assert.equal(checkResourceLimit(db,'org-1','workers',250,1).allowed,true);
  db.close();
});

test('resource limits and feature overrides apply to an organization subscription',()=>{
  const db=fixture();
  db.prepare("UPDATE plan_limits SET value=5,unlimited=0 WHERE plan_id='legacy-default' AND limit_key='workers'").run();
  db.prepare('UPDATE subscriptions SET limits_override_json=?,features_override_json=? WHERE organization_id=?').run('{"workers":3}','{"ai_chat":false}','org-1');
  assert.equal(checkResourceLimit(db,'org-1','workers',2,1).allowed,true);
  assert.equal(checkResourceLimit(db,'org-1','workers',3,1).allowed,false);
  assert.equal(checkFeatureAccess(db,'org-1','ai_chat').allowed,false);
  db.close();
});

test('usage dispatch respects block policy and safety exemption',()=>{
  const db=fixture();
  db.prepare("UPDATE plan_limits SET value=1,unlimited=0 WHERE plan_id='legacy-default' AND limit_key='sms_segments_month'").run();
  db.prepare("UPDATE plan_overage_settings SET policy='block' WHERE plan_id='legacy-default'").run();
  const subscription=db.prepare("SELECT current_period_start,current_period_end FROM subscriptions WHERE organization_id='org-1'").get();
  db.prepare("INSERT INTO usage_events(id,organization_id,event_type,quantity,unit,status,currency,created_at) VALUES('u1','org-1','sms_outbound',1,'segment','queued','BDT',?)").run(subscription.current_period_start+1);
  db.prepare("INSERT INTO usage_events(id,organization_id,event_type,quantity,unit,status,currency,created_at) VALUES('u2','org-1','sms_outbound',20,'segment','failed','BDT',?)").run(subscription.current_period_start+2);
  assert.equal(checkUsageDispatch(db,{organizationId:'org-1',eventType:'sms_outbound',quantity:1}).allowed,false);
  assert.equal(checkUsageDispatch(db,{organizationId:'org-1',eventType:'sms_outbound',quantity:10,category:'emergency'}).safetyExemptApplied,true);
  db.close();
});
