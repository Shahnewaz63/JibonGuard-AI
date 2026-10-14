import { existsSync } from 'node:fs';
import path from 'node:path';

const migrations = [
  {
    version: 1,
    name: 'ai_features_foundation',
    sql: `
      CREATE TABLE IF NOT EXISTS ai_calls(id TEXT PRIMARY KEY,organization_id TEXT,feature TEXT NOT NULL,prompt_version TEXT NOT NULL,model TEXT NOT NULL,ok INTEGER NOT NULL,fallback INTEGER NOT NULL,latency_ms INTEGER NOT NULL,input_tokens INTEGER,output_tokens INTEGER,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ai_calls_org_feature_idx ON ai_calls(organization_id,feature,created_at DESC);
      CREATE TABLE IF NOT EXISTS job_runs(id TEXT PRIMARY KEY,job_key TEXT NOT NULL,organization_id TEXT,status TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,error_code TEXT,details_json TEXT NOT NULL DEFAULT '{}');
      CREATE INDEX IF NOT EXISTS job_runs_job_date_idx ON job_runs(job_key,started_at DESC);
      CREATE TABLE IF NOT EXISTS org_ai_features(organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,settings_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS feature_flags(flag_key TEXT PRIMARY KEY,env_name TEXT NOT NULL,default_enabled INTEGER NOT NULL DEFAULT 0,description TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bangla_templates(template_key TEXT PRIMARY KEY,text TEXT NOT NULL,review_status TEXT NOT NULL DEFAULT 'pending_native_review',updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS official_advisories(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,source TEXT NOT NULL,external_id TEXT,content_hash TEXT NOT NULL,hazard TEXT NOT NULL,severity TEXT NOT NULL,areas_json TEXT NOT NULL,issued_at INTEGER NOT NULL,valid_from INTEGER NOT NULL,valid_to INTEGER NOT NULL,headline TEXT NOT NULL,body TEXT NOT NULL,source_url TEXT NOT NULL,raw_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,created_by TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS advisory_external_dedupe_idx ON official_advisories(organization_id,source,external_id) WHERE external_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS advisory_active_idx ON official_advisories(organization_id,valid_from,valid_to);
      CREATE TABLE IF NOT EXISTS official_feed_status(feed_key TEXT PRIMARY KEY,last_success_at INTEGER,last_error TEXT NOT NULL DEFAULT '',items_fetched INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS advisory_crosschecks(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,advisory_id TEXT REFERENCES official_advisories(id) ON DELETE SET NULL,heat_category TEXT NOT NULL,agreement TEXT NOT NULL,checked_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS crosschecks_org_time_idx ON advisory_crosschecks(organization_id,checked_at DESC);
      CREATE TABLE IF NOT EXISTS nowcast_snapshots(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,observed_at INTEGER NOT NULL,features_json TEXT NOT NULL,forecast_json TEXT NOT NULL,model_version TEXT NOT NULL,fallback INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS nowcast_predictions(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,snapshot_id TEXT NOT NULL REFERENCES nowcast_snapshots(id) ON DELETE CASCADE,target_at INTEGER NOT NULL,horizon_minutes INTEGER NOT NULL,rain_probability REAL,apparent_c REAL,heat_crossing INTEGER,baseline_json TEXT NOT NULL DEFAULT '{}',actual_rain INTEGER,actual_apparent_c REAL,scored_at INTEGER,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS nowcast_predictions_site_target_idx ON nowcast_predictions(site_id,target_at);
      CREATE TABLE IF NOT EXISTS break_plans(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,version INTEGER NOT NULL,status TEXT NOT NULL,inputs_json TEXT NOT NULL,plan_json TEXT NOT NULL,explanation TEXT NOT NULL DEFAULT '',approved_by TEXT,created_at INTEGER NOT NULL,approved_at INTEGER);
      CREATE INDEX IF NOT EXISTS break_plans_org_site_date_idx ON break_plans(organization_id,site_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS break_acknowledgements(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,crew_key TEXT NOT NULL,ack_kind TEXT NOT NULL,received_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS break_ack_org_date_idx ON break_acknowledgements(organization_id,received_at DESC);
      CREATE TABLE IF NOT EXISTS triage_events(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,worker_id TEXT REFERENCES workers(id) ON DELETE SET NULL,symptom_text TEXT NOT NULL,severity TEXT NOT NULL,rule_hits_json TEXT NOT NULL,ai_used INTEGER NOT NULL DEFAULT 0,ai_fallback INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,checkin_due_at INTEGER,checkin_result TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS triage_org_date_idx ON triage_events(organization_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS safety_reports(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,period_kind TEXT NOT NULL,period_start TEXT NOT NULL,period_end TEXT NOT NULL,facts_json TEXT NOT NULL,findings_json TEXT NOT NULL,narrative_en TEXT NOT NULL,narrative_bn TEXT NOT NULL,ai_generated INTEGER NOT NULL DEFAULT 0,model TEXT NOT NULL DEFAULT '',prompt_version TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(organization_id,period_kind,period_start,period_end));
      CREATE INDEX IF NOT EXISTS safety_reports_org_period_idx ON safety_reports(organization_id,period_kind,period_start DESC);
      CREATE TABLE IF NOT EXISTS feature_job_state(job_key TEXT PRIMARY KEY,last_run_at INTEGER,last_status TEXT NOT NULL DEFAULT 'never',last_error TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL);
    `,
  },
];

export function runMigrations(db, { databasePath, development = true, clock = () => Math.floor(Date.now() / 1000) } = {}) {
  const hasMigrations = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get());
  const applied = new Set(hasMigrations ? db.prepare('SELECT version FROM schema_migrations').all().map(row => row.version) : []);
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    if (development && databasePath && existsSync(databasePath)) {
      const backupPath = `${databasePath}.pre-migration-v${migration.version}.bak`;
      if (!existsSync(backupPath)) db.exec(`VACUUM INTO '${path.resolve(backupPath).replaceAll("'", "''")}'`);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL)');
      for (const [table, column, declaration] of [
        ['sites', 'division', "TEXT NOT NULL DEFAULT ''"],
        ['sites', 'district', "TEXT NOT NULL DEFAULT ''"],
        ['sites', 'emergency_contact_phone', "TEXT NOT NULL DEFAULT ''"],
        ['workers', 'crew', "TEXT NOT NULL DEFAULT ''"],
        ['workers', 'consent_version', "TEXT NOT NULL DEFAULT ''"],
      ]) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
        if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
      }
      db.exec(migration.sql);
      db.prepare("INSERT OR IGNORE INTO feature_flags(flag_key,env_name,default_enabled,description) VALUES('nowcast','NOWCAST_ENABLED',0,'Short-horizon local weather nowcast'),('break_planner','SMART_BREAK_SCHEDULER_ENABLED',0,'Safety-constrained crew break planning'),('triage','AI_TRIAGE_ENABLED',0,'Optional AI assistance for unclassified symptom SMS'),('reports','AI_SAFETY_REPORTS_ENABLED',0,'Daily and weekly aggregated safety reports'),('official_advisories','OFFICIAL_ADVISORIES_ENABLED',1,'Official advisories and manual entries')").run();
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(migration.version, migration.name, clock());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
