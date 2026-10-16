import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../db/migrations.js';
import { processBillingLifecycle } from './lifecycle.js';

function fixture(){
  const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE organizations(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES('org-1'); CREATE TABLE workers(id TEXT PRIMARY KEY); CREATE TABLE sites(id TEXT PRIMARY KEY);");runMigrations(db,{development:false,clock:()=>100});return db;
}
const idFactory=(()=>{let n=0;return()=>`event-${++n}`;})();

test('billing lifecycle creates one renewal invoice, then suspends after grace',()=>{
  const db=fixture(),sub=db.prepare("SELECT * FROM subscriptions WHERE organization_id='org-1'").get();
  db.prepare("UPDATE plan_prices SET amount_minor=500 WHERE plan_id='legacy-default' AND billing_cycle='monthly'").run();
  db.prepare("UPDATE subscriptions SET status='active',current_period_start=100,current_period_end=200 WHERE id=?").run(sub.id);
  let invoices=0;const options={now:200,gracePeriodDays:3,idFactory,createInvoice:()=>`invoice-${++invoices}`};
  assert.equal(processBillingLifecycle(db,options).results[0].action,'invoice_created');
  assert.equal(db.prepare('SELECT status FROM subscriptions WHERE id=?').get(sub.id).status,'past_due');
  assert.equal(processBillingLifecycle(db,options).processed,0);
  assert.equal(invoices,1);
  const graceEnd=db.prepare('SELECT grace_end FROM subscriptions WHERE id=?').get(sub.id).grace_end;
  assert.equal(processBillingLifecycle(db,{...options,now:graceEnd}).results[0].action,'suspended');
  db.close();
});

test('billing lifecycle renews a zero-price plan and honors period-end cancellation',()=>{
  const db=fixture(),sub=db.prepare("SELECT * FROM subscriptions WHERE organization_id='org-1'").get();
  db.prepare("UPDATE subscriptions SET current_period_start=100,current_period_end=200 WHERE id=?").run(sub.id);
  const result=processBillingLifecycle(db,{now:200,gracePeriodDays:7,idFactory,createInvoice(){throw new Error('free plan should not invoice');}});
  assert.equal(result.results[0].action,'renewed_free');
  db.prepare('UPDATE subscriptions SET cancel_at_period_end=1,current_period_end=300 WHERE id=?').run(sub.id);
  assert.equal(processBillingLifecycle(db,{now:300,gracePeriodDays:7,idFactory,createInvoice(){}}).results[0].action,'cancelled');
  db.close();
});
