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
  {
    version: 2,
    name: 'remove_official_advisories_and_voice_calls',
    // The original v2 dropped tables, feature settings, and worker columns. Keep
    // the version number for installations that already applied it, but make
    // it non-destructive for databases encountering this migration for the first time.
    sql: `SELECT 1;`,
  },
  {
    version: 3,
    name: 'sms_history_deletion_markers',
    sql: `
      CREATE TABLE IF NOT EXISTS sms_deleted_messages(organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,id TEXT NOT NULL,deleted_at INTEGER NOT NULL,PRIMARY KEY(organization_id,id));
    `,
  },
  {
    version: 4,
    name: 'admin_billing_foundation',
    sql: `
      CREATE TABLE IF NOT EXISTS admin_users(id TEXT PRIMARY KEY,email TEXT NOT NULL COLLATE NOCASE UNIQUE,password_hash TEXT NOT NULL,password_salt TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('super_admin','finance','support','viewer')),totp_secret_encrypted TEXT,totp_enabled INTEGER NOT NULL DEFAULT 0,disabled_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_sessions(token_hash TEXT PRIMARY KEY,admin_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,ip TEXT NOT NULL DEFAULT '',user_agent TEXT NOT NULL DEFAULT '',reauth_at INTEGER);
      CREATE INDEX IF NOT EXISTS admin_sessions_admin_exp_idx ON admin_sessions(admin_id,expires_at);
      CREATE TABLE IF NOT EXISTS admin_login_attempts(id TEXT PRIMARY KEY,email TEXT NOT NULL,ip TEXT NOT NULL,success INTEGER NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS admin_login_attempts_lookup_idx ON admin_login_attempts(email,ip,created_at DESC);
      CREATE TABLE IF NOT EXISTS admin_recovery_codes(id TEXT PRIMARY KEY,admin_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,code_hash TEXT NOT NULL,used_at INTEGER,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_audit_log(id TEXT PRIMARY KEY,admin_id TEXT,admin_role TEXT NOT NULL DEFAULT '',action TEXT NOT NULL,target_type TEXT NOT NULL DEFAULT '',target_id TEXT NOT NULL DEFAULT '',ip TEXT NOT NULL DEFAULT '',user_agent TEXT NOT NULL DEFAULT '',before_json TEXT,after_json TEXT,reason TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS admin_audit_target_idx ON admin_audit_log(target_type,target_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,description TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','hidden','archived')),sort_order INTEGER NOT NULL DEFAULT 0,trial_days INTEGER NOT NULL DEFAULT 0,badge_text TEXT NOT NULL DEFAULT '',sample_values INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plan_prices(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES plans(id),billing_cycle TEXT NOT NULL CHECK(billing_cycle IN ('monthly','yearly')),amount_minor INTEGER NOT NULL CHECK(amount_minor>=0),currency TEXT NOT NULL,effective_from INTEGER NOT NULL,version INTEGER NOT NULL,created_by TEXT,created_at INTEGER NOT NULL,UNIQUE(plan_id,billing_cycle,version));
      CREATE INDEX IF NOT EXISTS plan_prices_current_idx ON plan_prices(plan_id,billing_cycle,effective_from DESC);
      CREATE TABLE IF NOT EXISTS plan_limits(plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,limit_key TEXT NOT NULL,value INTEGER,unlimited INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,PRIMARY KEY(plan_id,limit_key));
      CREATE TABLE IF NOT EXISTS plan_features(plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,feature_key TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,PRIMARY KEY(plan_id,feature_key));
      CREATE TABLE IF NOT EXISTS plan_overage_settings(plan_id TEXT PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE,policy TEXT NOT NULL DEFAULT 'soft_warn' CHECK(policy IN ('block','charge_overage','soft_warn')),warning_80 INTEGER NOT NULL DEFAULT 80,warning_100 INTEGER NOT NULL DEFAULT 100,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cost_rates(id TEXT PRIMARY KEY,event_type TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',unit TEXT NOT NULL,unit_cost_minor INTEGER NOT NULL CHECK(unit_cost_minor>=0),currency TEXT NOT NULL,effective_from INTEGER NOT NULL,created_by TEXT,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS cost_rates_effective_idx ON cost_rates(event_type,provider,model,effective_from DESC);
      CREATE TABLE IF NOT EXISTS price_rates(id TEXT PRIMARY KEY,event_type TEXT NOT NULL,feature TEXT NOT NULL DEFAULT '',unit TEXT NOT NULL,unit_price_minor INTEGER NOT NULL CHECK(unit_price_minor>=0),currency TEXT NOT NULL,effective_from INTEGER NOT NULL,created_by TEXT,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS price_rates_effective_idx ON price_rates(event_type,feature,effective_from DESC);
      CREATE TABLE IF NOT EXISTS usage_events(id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE,organization_id TEXT NOT NULL REFERENCES organizations(id),site_id TEXT,event_type TEXT NOT NULL,provider TEXT NOT NULL DEFAULT '',feature TEXT NOT NULL DEFAULT '',quantity INTEGER NOT NULL,unit TEXT NOT NULL,rate_divisor INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT '',tokens_input INTEGER,tokens_output INTEGER,tokens_total INTEGER,latency_ms INTEGER,estimated INTEGER NOT NULL DEFAULT 0,unit_cost_minor INTEGER NOT NULL DEFAULT 0,unit_price_minor INTEGER NOT NULL DEFAULT 0,cost_minor INTEGER NOT NULL DEFAULT 0,price_minor INTEGER NOT NULL DEFAULT 0,currency TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',ref_type TEXT NOT NULL DEFAULT '',ref_id TEXT NOT NULL DEFAULT '',metadata_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_events_org_date_idx ON usage_events(organization_id,created_at);
      CREATE INDEX IF NOT EXISTS usage_events_type_date_idx ON usage_events(event_type,created_at);
      CREATE TABLE IF NOT EXISTS usage_rollups_daily(organization_id TEXT NOT NULL REFERENCES organizations(id),day TEXT NOT NULL,event_type TEXT NOT NULL,feature TEXT NOT NULL DEFAULT '',quantity INTEGER NOT NULL,cost_minor INTEGER NOT NULL,price_minor INTEGER NOT NULL,currency TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(organization_id,day,event_type,feature,currency));
      CREATE TABLE IF NOT EXISTS usage_rollups_monthly(organization_id TEXT NOT NULL REFERENCES organizations(id),month TEXT NOT NULL,event_type TEXT NOT NULL,feature TEXT NOT NULL DEFAULT '',quantity INTEGER NOT NULL,cost_minor INTEGER NOT NULL,price_minor INTEGER NOT NULL,currency TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(organization_id,month,event_type,feature,currency));
      CREATE TABLE IF NOT EXISTS organization_resource_snapshots(organization_id TEXT NOT NULL REFERENCES organizations(id),day TEXT NOT NULL,workers INTEGER NOT NULL,sites INTEGER NOT NULL,active_users INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(organization_id,day));
      CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),plan_id TEXT NOT NULL REFERENCES plans(id),status TEXT NOT NULL CHECK(status IN ('trialing','active','past_due','suspended','cancelled','expired')),billing_cycle TEXT NOT NULL CHECK(billing_cycle IN ('monthly','yearly')),price_minor INTEGER NOT NULL,currency TEXT NOT NULL,current_period_start INTEGER NOT NULL,current_period_end INTEGER NOT NULL,trial_end INTEGER,cancel_at_period_end INTEGER NOT NULL DEFAULT 0,grace_end INTEGER,limits_override_json TEXT NOT NULL DEFAULT '{}',price_override_minor INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS subscriptions_org_status_idx ON subscriptions(organization_id,status);
      CREATE INDEX IF NOT EXISTS subscriptions_period_idx ON subscriptions(status,current_period_end);
      CREATE TABLE IF NOT EXISTS subscription_events(id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL REFERENCES subscriptions(id),organization_id TEXT NOT NULL REFERENCES organizations(id),event_type TEXT NOT NULL,from_status TEXT,to_status TEXT,details_json TEXT NOT NULL DEFAULT '{}',reason TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invoices(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),subscription_id TEXT,invoice_number TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('draft','open','paid','void','uncollectible')),currency TEXT NOT NULL,subtotal_minor INTEGER NOT NULL,tax_minor INTEGER NOT NULL,total_minor INTEGER NOT NULL,amount_paid_minor INTEGER NOT NULL DEFAULT 0,issued_at INTEGER NOT NULL,due_at INTEGER,paid_at INTEGER,billing_details_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS invoices_org_date_idx ON invoices(organization_id,issued_at DESC);
      CREATE TABLE IF NOT EXISTS invoice_lines(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL REFERENCES invoices(id),description TEXT NOT NULL,line_type TEXT NOT NULL,quantity INTEGER NOT NULL,unit_amount_minor INTEGER NOT NULL,amount_minor INTEGER NOT NULL,metadata_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL REFERENCES invoices(id),organization_id TEXT NOT NULL REFERENCES organizations(id),adapter TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','succeeded','rejected','failed','refunded')),amount_minor INTEGER NOT NULL,currency TEXT NOT NULL,transaction_ref TEXT NOT NULL DEFAULT '',proof_ref TEXT NOT NULL DEFAULT '',verified_by TEXT,verified_at INTEGER,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS payments_org_date_idx ON payments(organization_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS refunds(id TEXT PRIMARY KEY,payment_id TEXT NOT NULL REFERENCES payments(id),amount_minor INTEGER NOT NULL,currency TEXT NOT NULL,reason TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credit_notes(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL REFERENCES invoices(id),amount_minor INTEGER NOT NULL,currency TEXT NOT NULL,reason TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_settings(setting_key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_by TEXT,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS coupons(id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')),discount_value INTEGER NOT NULL,applies_to_json TEXT NOT NULL DEFAULT '[]',duration TEXT NOT NULL CHECK(duration IN ('once','repeating','forever')),duration_months INTEGER,valid_from INTEGER,valid_until INTEGER,max_redemptions INTEGER,redemption_count INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS coupon_redemptions(id TEXT PRIMARY KEY,coupon_id TEXT NOT NULL REFERENCES coupons(id),organization_id TEXT NOT NULL REFERENCES organizations(id),subscription_id TEXT NOT NULL REFERENCES subscriptions(id),created_at INTEGER NOT NULL,UNIQUE(coupon_id,organization_id));
      CREATE TABLE IF NOT EXISTS expenses(id TEXT PRIMARY KEY,category TEXT NOT NULL,description TEXT NOT NULL,amount_minor INTEGER NOT NULL,currency TEXT NOT NULL,expense_date TEXT NOT NULL,recurring INTEGER NOT NULL DEFAULT 0,notes TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_job_runs(id TEXT PRIMARY KEY,job_key TEXT NOT NULL,status TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,error_code TEXT NOT NULL DEFAULT '',details_json TEXT NOT NULL DEFAULT '{}');
      CREATE INDEX IF NOT EXISTS admin_job_runs_key_date_idx ON admin_job_runs(job_key,started_at DESC);
      CREATE TABLE IF NOT EXISTS announcements(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,target_json TEXT NOT NULL DEFAULT '{}',starts_at INTEGER NOT NULL,ends_at INTEGER,active INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_notes(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),admin_id TEXT NOT NULL REFERENCES admin_users(id),note TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_bootstrap_state(id INTEGER PRIMARY KEY CHECK(id=1),completed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS organization_billing_details(organization_id TEXT PRIMARY KEY REFERENCES organizations(id),legal_name TEXT NOT NULL DEFAULT '',address TEXT NOT NULL DEFAULT '',tax_id TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS soft_delete_records(id TEXT PRIMARY KEY,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,organization_id TEXT NOT NULL,deleted_by TEXT NOT NULL,reason TEXT NOT NULL,deleted_at INTEGER NOT NULL,UNIQUE(entity_type,entity_id));
      INSERT OR IGNORE INTO plans(id,name,slug,description,status,sort_order,trial_days,sample_values,created_at,updated_at) VALUES
        ('sample-basic','Basic','basic','Editable sample plan. Set your real prices and limits.','hidden',10,0,1,0,0),
        ('sample-pro','Pro','pro','Editable sample plan. Set your real prices and limits.','hidden',20,0,1,0,0),
        ('sample-promax','ProMax','promax','Editable sample plan. Set your real prices and limits.','hidden',30,0,1,0,0),
        ('legacy-default','Legacy','legacy','Hidden zero-price migration plan; review and replace per organization.','hidden',0,0,0,0,0);
      INSERT OR IGNORE INTO plan_prices(id,plan_id,billing_cycle,amount_minor,currency,effective_from,version,created_at) VALUES
        ('sample-basic-monthly','sample-basic','monthly',0,'BDT',0,1,0),('sample-basic-yearly','sample-basic','yearly',0,'BDT',0,1,0),
        ('sample-pro-monthly','sample-pro','monthly',0,'BDT',0,1,0),('sample-pro-yearly','sample-pro','yearly',0,'BDT',0,1,0),
        ('sample-promax-monthly','sample-promax','monthly',0,'BDT',0,1,0),('sample-promax-yearly','sample-promax','yearly',0,'BDT',0,1,0),
        ('legacy-monthly','legacy-default','monthly',0,'BDT',0,1,0),('legacy-yearly','legacy-default','yearly',0,'BDT',0,1,0);
      INSERT OR IGNORE INTO billing_settings(setting_key,value_json,updated_at) VALUES
        ('currency','"BDT"',0),('tax_rate_bps','0',0),('prices_include_tax','false',0),('invoice_prefix','"JG-"',0),('invoice_next_sequence','1',0),('grace_period_days','7',0),('safety_alerts_exempt_from_limits','true',0),('default_plan_id','"legacy-default"',0),('payment_instructions','"Configure manual payment instructions in admin settings."',0);
      INSERT OR IGNORE INTO plan_limits(plan_id,limit_key,value,unlimited,updated_at) VALUES
        ('legacy-default','workers',NULL,1,0),('legacy-default','sites',NULL,1,0),('legacy-default','users',NULL,1,0),('legacy-default','sms_segments_month',NULL,1,0),('legacy-default','ai_tokens_month',NULL,1,0),('legacy-default','voice_minutes_month',NULL,1,0),('legacy-default','weather_checks_month',NULL,1,0),('legacy-default','retention_days',NULL,1,0);
      INSERT OR IGNORE INTO plan_limits(plan_id,limit_key,value,unlimited,updated_at) VALUES
        ('sample-basic','workers',10,0,0),('sample-basic','sites',2,0,0),('sample-basic','users',2,0,0),('sample-basic','sms_segments_month',300,0,0),('sample-basic','ai_tokens_month',100000,0,0),('sample-basic','voice_minutes_month',0,0,0),('sample-basic','weather_checks_month',1000,0,0),('sample-basic','retention_days',30,0,0),
        ('sample-pro','workers',50,0,0),('sample-pro','sites',10,0,0),('sample-pro','users',5,0,0),('sample-pro','sms_segments_month',2000,0,0),('sample-pro','ai_tokens_month',1000000,0,0),('sample-pro','voice_minutes_month',120,0,0),('sample-pro','weather_checks_month',10000,0,0),('sample-pro','retention_days',90,0,0),
        ('sample-promax','workers',500,0,0),('sample-promax','sites',100,0,0),('sample-promax','users',50,0,0),('sample-promax','sms_segments_month',50000,0,0),('sample-promax','ai_tokens_month',25000000,0,0),('sample-promax','voice_minutes_month',10000,0,0),('sample-promax','weather_checks_month',250000,0,0),('sample-promax','retention_days',365,0,0);
      INSERT OR IGNORE INTO plan_features(plan_id,feature_key,enabled,updated_at)
        SELECT p.id,f.feature_key,0,0 FROM plans p CROSS JOIN (
          SELECT 'ai_chat' AS feature_key UNION ALL SELECT 'ai_alert_automation' UNION ALL SELECT 'simulator' UNION ALL SELECT 'voice_alerts' UNION ALL SELECT 'csv_import' UNION ALL SELECT 'data_export' UNION ALL SELECT 'break_planner' UNION ALL SELECT 'nowcasting' UNION ALL SELECT 'heat_triage' UNION ALL SELECT 'ai_reports' UNION ALL SELECT 'official_advisories' UNION ALL SELECT 'priority_support' UNION ALL SELECT 'api_access' UNION ALL SELECT 'custom_branding'
        ) f;
      INSERT OR IGNORE INTO plan_overage_settings(plan_id,policy,updated_at) SELECT id,'soft_warn',0 FROM plans;
      INSERT OR IGNORE INTO subscriptions(id,organization_id,plan_id,status,billing_cycle,price_minor,currency,current_period_start,current_period_end,created_at,updated_at)
        SELECT 'legacy-'||o.id,o.id,'legacy-default','active','monthly',0,'BDT',unixepoch(),253402300799,unixepoch(),unixepoch() FROM organizations o;
    `,
  },
  {
    version: 5,
    name: 'organization_entitlement_overrides',
    sql: `
      UPDATE plan_features SET enabled=1 WHERE plan_id='legacy-default' AND feature_key IN ('ai_chat','ai_alert_automation','simulator','csv_import','data_export','break_planner','nowcasting','heat_triage','ai_reports','official_advisories');
    `,
  },
  {
    version: 6,
    name: 'manual_payment_reference_idempotency',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS payments_manual_reference_unique_idx ON payments(transaction_ref) WHERE adapter='manual' AND transaction_ref<>'';`,
  },
  {
    version: 7,
    name: 'admin_totp_requirement',
    sql: `ALTER TABLE admin_users ADD COLUMN totp_required INTEGER NOT NULL DEFAULT 1;`,
  },
  {
    version: 8,
    name: 'disable_admin_two_factor_signin',
    sql: `UPDATE admin_users SET totp_required=0,totp_enabled=0,totp_secret_encrypted=NULL; DELETE FROM admin_recovery_codes;`,
  },
  {
    version: 9,
    name: 'operational_query_indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS workers_org_site_idx ON workers(organization_id,site_id);
      CREATE INDEX IF NOT EXISTS automated_alerts_worker_history_idx ON automated_alerts(organization_id,worker_id,status,created_at DESC);
      CREATE INDEX IF NOT EXISTS automated_alerts_site_pending_idx ON automated_alerts(organization_id,site_id,status,scheduled_at);
      CREATE INDEX IF NOT EXISTS sms_messages_org_direction_date_idx ON sms_messages(organization_id,direction,message_at DESC);
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
      if (migration.version === 2) {
        const workerColumns = db.prepare('PRAGMA table_info(workers)').all().map(row => row.name);
        if (!workerColumns.includes('channel_preference')) db.exec("ALTER TABLE workers ADD COLUMN channel_preference TEXT NOT NULL DEFAULT 'sms'");
        if (!workerColumns.includes('voice_first')) db.exec('ALTER TABLE workers ADD COLUMN voice_first INTEGER NOT NULL DEFAULT 0');
      }
      if (migration.version === 5) {
        const columns = db.prepare('PRAGMA table_info(subscriptions)').all().map(row => row.name);
        if (!columns.includes('features_override_json')) db.exec("ALTER TABLE subscriptions ADD COLUMN features_override_json TEXT NOT NULL DEFAULT '{}'");
      }
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
      if (migration.version === 9) {
        const hasColumns = (table, required) => {
          const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
          return required.every(column => columns.has(column));
        };
        for (const [table, columns, name, indexColumns] of [
          ['workers', ['organization_id', 'site_id'], 'workers_org_site_idx', 'organization_id,site_id'],
          ['automated_alerts', ['organization_id', 'worker_id', 'status', 'created_at'], 'automated_alerts_worker_history_idx', 'organization_id,worker_id,status,created_at DESC'],
          ['automated_alerts', ['organization_id', 'site_id', 'status', 'scheduled_at'], 'automated_alerts_site_pending_idx', 'organization_id,site_id,status,scheduled_at'],
          ['sms_messages', ['organization_id', 'direction', 'message_at'], 'sms_messages_org_direction_date_idx', 'organization_id,direction,message_at DESC'],
        ]) {
          if (!hasColumns(table, columns)) continue;
          db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${indexColumns})`);
        }
      } else db.exec(migration.sql);
      db.prepare("INSERT OR IGNORE INTO feature_flags(flag_key,env_name,default_enabled,description) VALUES('nowcast','NOWCAST_ENABLED',0,'Short-horizon local weather nowcast'),('break_planner','SMART_BREAK_SCHEDULER_ENABLED',0,'Safety-constrained crew break planning'),('triage','AI_TRIAGE_ENABLED',0,'Optional AI assistance for unclassified symptom SMS'),('reports','AI_SAFETY_REPORTS_ENABLED',0,'Daily and weekly aggregated safety reports')").run();
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(migration.version, migration.name, clock());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
