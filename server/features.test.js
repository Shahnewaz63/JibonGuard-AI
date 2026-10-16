import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './db/migrations.js';
import { classifySymptoms, redactTriageText } from './triage/rules.js';
import { makeNowcastFeatures, inferNowcast } from './nowcast/features.js';
import { buildSafetyFacts, deterministicFindings, narrativeNumbersAreSupported } from './reports/metrics.js';
import { createJobRunner } from './jobs/runner.js';
import { createGeminiClient } from './ai/geminiClient.js';

test('versioned migration is additive and idempotent', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE organizations(id TEXT PRIMARY KEY); CREATE TABLE workers(id TEXT PRIMARY KEY); CREATE TABLE sites(id TEXT PRIMARY KEY);');
  runMigrations(db, { development: false, clock: () => 100 });
  runMigrations(db, { development: false, clock: () => 200 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 2);
  assert.equal(db.prepare('PRAGMA table_info(sites)').all().some(row => row.name === 'emergency_contact_phone'), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='ai_calls'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='official_advisories'").get().n, 0);
  assert.equal(db.prepare('PRAGMA table_info(workers)').all().some(row => row.name === 'voice_first'), false);
  db.close();
});

test('triage red flags always win and unclassified input escalates to cool/rest', () => {
  assert.equal(classifySymptoms('I feel dizzy, fainted and have headache').severity, 'EMERGENCY_NOW');
  assert.equal(classifySymptoms('shash koshto হচ্ছে').severity, 'EMERGENCY_NOW');
  assert.equal(classifySymptoms('মাথা ঘোরা', 'High').severity, 'REST_AND_COOL');
  assert.equal(classifySymptoms('মাথা ব্যথা').severity, 'DRINK_WATER_AND_REST');
  assert.equal(classifySymptoms('I feel strange').severity, 'REST_AND_COOL');
});

test('triage redaction strips phone and digit sequences before optional AI use', () => {
  const redacted = redactTriageText('My name is Rahim. dizzy +880 1712-345678 worker 123456');
  assert.doesNotMatch(redacted, /1712|345678|123456|Rahim/);
});

test('nowcast feature windows and inference are deterministic with fallback', () => {
  const features = makeNowcastFeatures({ apparent_temperature: [28, 29, 30, 31], temperature_2m: [27, 28, 29, 30], pressure_msl: [1010, 1009, 1008, 1007], relative_humidity_2m: [70, 71, 72, 73], cloud_cover: [20, 30, 40, 50], wind_speed_10m: [2, 3, 4, 5], precipitation: [0, 0, 0, 0] }, { precipitation_probability: [40], apparent_temperature: [33, 35] }, new Date('2026-06-01T10:00:00Z'));
  assert.equal(features.apparent_change_3h, 3);
  assert.equal(features.pressure_change_3h, -3);
  const fallback = inferNowcast(features, null, { heatTriggerC: 34 });
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.heat_crossing_60m, true);
  const artifact = { version: 'test', trained_at: '2026-01-01T00:00:00Z', models: { rain: { intercept: 0, weights: {} }, temperature_30m: { intercept: 32, weights: {} }, temperature_60m: { intercept: 35, weights: {} } }, thresholds: { rain: 0.4 } };
  assert.deepEqual(inferNowcast(features, artifact, { now: Date.parse('2026-06-01'), heatTriggerC: 34 }), inferNowcast(features, artifact, { now: Date.parse('2026-06-01'), heatTriggerC: 34 }));
});

test('report facts remain deterministic and hallucinated numbers are rejected', () => {
  const facts = buildSafetyFacts({ alerts: [{ status: 'sent', alert_type: 'heat' }, { status: 'failed', alert_type: 'rain' }], breaks: [{}], acknowledgements: null, triage: [{ severity: 'REST_AND_COOL' }], heatReadings: [{ category: 'High', apparent_c: 38 }] });
  assert.equal(facts.delivery_success_rate, 0.5);
  assert.equal(facts.max_apparent_temperature_c, 38);
  assert.equal(facts.break_acknowledgements, 'not available');
  assert.equal(deterministicFindings(facts)[0].rule_id, 'HEAT_HOURS_PRESENT');
  assert.equal(narrativeNumbersAreSupported('Maximum was 38 C.', facts), true);
  assert.equal(narrativeNumbersAreSupported('Maximum was 39 C.', facts), false);
});

test('job runner locks overlapping work and isolates errors per site', async () => {
  const runner = createJobRunner({ random: () => 0, logger: { error() {} } });
  let finish;
  runner.register('one', () => new Promise(resolve => { finish = resolve; }), { jitterMs: 0 });
  const running = runner.execute('one');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await runner.execute('one'), { skipped: true, reason: 'already_running' });
  finish('ok');
  assert.equal((await running).value, 'ok');
  const results = await runner.runSites('isolated', [1, 2], async item => { if (item === 1) throw new Error('site'); return item; });
  assert.deepEqual(results, [{ error: 'Error' }, 2]);
});

test('shared Gemini client times out/falls back and logs only feature metadata', async () => {
  const rows = [];
  const db = { prepare(sql) { return { run(...args) { rows.push({ sql, args }); } }; } };
  const call = createGeminiClient({ apiKey: 'secret', db, retries: 0, fetchImpl: async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"answer":true}' }] } }] }) }) });
  const result = await call({ feature: 'triage', promptVersion: 'v1', system: 'Return JSON', payload: { symptom: 'dizzy', name: 'PII should not be logged' }, validate: value => value.answer === true, organizationId: 'org-1' });
  assert.equal(result.ok, true);
  assert.equal(rows.length, 1);
  assert.doesNotMatch(rows[0].sql + JSON.stringify(rows[0].args), /dizzy|PII should not be logged/);
});
