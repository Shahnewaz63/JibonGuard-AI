import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBasisPoints, formatMoney, parseMoney, prorate } from './money.js';
import { calculateSmsSegments } from './smsSegments.js';
import { hasPermission, requirePermission } from './permissions.js';
import { decryptTotpSecret, encryptTotpSecret, newTotpSecret, totpCode, verifyTotp } from './totp.js';
import { redactAuditValue } from './audit.js';
import { FEATURE_KEYS, isKnownFeature } from './features.js';
import { calculateQuota } from './quota.js';
import { canTransitionSubscription, transitionSubscription } from './subscriptionState.js';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../db/migrations.js';
import { createMeteringService } from './metering.js';

test('money stays in integer minor units and validates decimal precision', () => {
  assert.equal(parseMoney('1234.50', 'BDT'), 123450);
  assert.equal(parseMoney('1234', 'JPY'), 1234);
  assert.equal(parseMoney('1.025', 'BHD'), 1025);
  assert.equal(applyBasisPoints(101, 1000), 10);
  assert.equal(prorate(10000, 15, 30), 5000);
  assert.match(formatMoney(123450, 'BDT'), /1,234|১,২৩৪/);
  assert.throws(() => parseMoney('1.001', 'BDT'), RangeError);
  assert.throws(() => parseMoney('1e3', 'BDT'), RangeError);
  assert.throws(() => prorate(10, 11, 10), RangeError);
});

test('SMS segments account for GSM extension symbols and Bangla UCS-2', () => {
  assert.deepEqual(calculateSmsSegments('hello'), { encoding: 'GSM-7', units: 5, segments: 1 });
  assert.equal(calculateSmsSegments('^'.repeat(81)).segments, 2);
  assert.deepEqual(calculateSmsSegments('ক'.repeat(70)), { encoding: 'UCS-2', units: 70, segments: 1 });
  assert.equal(calculateSmsSegments('ক'.repeat(71)).segments, 2);
  assert.equal(calculateSmsSegments('🙂').units, 2);
  assert.equal(calculateSmsSegments('').segments, 0);
});

test('permission matrix denies billing changes to support and all changes to viewer', () => {
  assert.equal(hasPermission('support', 'organizations_edit'), true);
  assert.equal(hasPermission('support', 'plans_write'), false);
  assert.equal(hasPermission('viewer', 'billing_read'), true);
  assert.equal(hasPermission('viewer', 'organizations_edit'), false);
  assert.throws(() => requirePermission('finance', 'organizations_hard_delete'), { status: 403 });
});

test('TOTP follows RFC 6238 time steps and encrypted secrets authenticate', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totpCode(secret, 59000), '287082');
  assert.equal(verifyTotp(secret, '287082', 59000, 0), true);
  assert.equal(verifyTotp(secret, '000000', 59000, 0), false);
  const generated = newTotpSecret(), key = 'a'.repeat(32), encrypted = encryptTotpSecret(generated, key);
  assert.equal(decryptTotpSecret(encrypted, key), generated);
  assert.throws(() => decryptTotpSecret(encrypted, 'b'.repeat(32)));
});

test('audit snapshots redact sensitive fields and feature registry is unique', () => {
  assert.deepEqual(redactAuditValue({ email: 'user@example.test', password_hash: 'hidden', nested: { apiKey: 'hidden' } }), { email: 'user@example.test', password_hash: '[redacted]', nested: { apiKey: '[redacted]' } });
  assert.equal(new Set(FEATURE_KEYS).size, FEATURE_KEYS.length);
  assert.equal(isKnownFeature('nowcasting'), true);
  assert.equal(isKnownFeature('invented'), false);
});

test('subscription transitions and safety quota exemption are enforced by pure rules', () => {
  assert.equal(canTransitionSubscription('active','past_due'), true);
  assert.equal(canTransitionSubscription('expired','cancelled'), false);
  assert.equal(transitionSubscription({ status: 'past_due' }, 'active', { now: 10 }).updated_at, 10);
  assert.throws(() => transitionSubscription({ status: 'active' }, 'trialing'));
  assert.equal(calculateQuota({ limit: 10, used: 11, policy: 'block' }).blocked, true);
  assert.equal(calculateQuota({ limit: 10, used: 11, policy: 'block', safetyAlert: true, safetyExempt: true }).blocked, false);
  assert.equal(calculateQuota({ unlimited: true, used: 100 }).overage, 0);
});

test('metering snapshots effective rates, is idempotent, redacts metadata, and fails open', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE organizations(id TEXT PRIMARY KEY); CREATE TABLE workers(id TEXT PRIMARY KEY); CREATE TABLE sites(id TEXT PRIMARY KEY);');
  runMigrations(db, { development: false, clock: () => 100 });
  db.prepare('INSERT INTO organizations(id) VALUES(?)').run('org-1');
  db.prepare('INSERT INTO cost_rates(id,event_type,provider,model,unit,unit_cost_minor,currency,effective_from,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('cost-1','sms_outbound','textbee','','segment',2,'BDT',1,1);
  db.prepare('INSERT INTO price_rates(id,event_type,feature,unit,unit_price_minor,currency,effective_from,created_at) VALUES(?,?,?,?,?,?,?,?)').run('price-1','sms_outbound','','segment',5,'BDT',1,1);
  const meter = createMeteringService(db, { clock: () => 50, logger: { error() {} } });
  const event = { idempotencyKey: 'sms-1', organizationId: 'org-1', eventType: 'sms_outbound', provider: 'textbee', quantity: 2, unit: 'segment', metadata: { status: 'queued', phone: '+8801700000000' } };
  assert.deepEqual(meter.recordUsage(event), { recorded: true, duplicate: false });
  assert.deepEqual(meter.recordUsage(event), { recorded: false, duplicate: true });
  const saved = db.prepare('SELECT unit_cost_minor,unit_price_minor,cost_minor,price_minor,metadata_json FROM usage_events').get();
  assert.equal(saved.cost_minor, 4);
  assert.equal(saved.price_minor, 10);
  assert.doesNotMatch(saved.metadata_json, /8801700000000/);
  assert.equal(createMeteringService({ prepare() { throw new Error('db'); } }, { logger: { error() {} } }).recordUsage(event).recorded, false);
  db.close();
});
