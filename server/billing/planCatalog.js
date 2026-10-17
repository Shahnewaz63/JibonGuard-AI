const PLAN_CATALOG_VERSION = 9;
const PLAN_FEATURES = {
  basic: ['ai_chat','ai_alert_automation','simulator','csv_import','data_export'],
  pro: ['ai_chat','ai_alert_automation','simulator','voice_alerts','csv_import','data_export'],
  legacy: ['ai_chat','ai_alert_automation','simulator','voice_alerts','csv_import','data_export'],
};

const PLANS = [
  { id:'sample-basic', name:'Basic', slug:'basic', description:'SMS safety alerts, AI safety tools, CSV imports, and core weather insights for small teams.', status:'active', sort:10, badge:'', monthly:99900, yearly:999000, limits:{workers:10,sites:2,users:2,sms_segments_month:300,ai_tokens_month:100000,voice_minutes_month:0,weather_checks_month:1000,retention_days:30}, features:PLAN_FEATURES.basic },
  { id:'sample-pro', name:'Pro', slug:'pro', description:'Everything in Basic, plus AI speech and live browser voice tools with larger team, SMS, and token allowances.', status:'active', sort:20, badge:'Popular', monthly:249900, yearly:2499000, limits:{workers:50,sites:10,users:5,sms_segments_month:2000,ai_tokens_month:1000000,voice_minutes_month:120,weather_checks_month:10000,retention_days:90}, features:PLAN_FEATURES.pro },
  { id:'sample-promax', name:'Legacy', slug:'legacy', description:'High-capacity enterprise plan with expanded team limits and 25 million AI tokens per month. Contact us for custom pricing.', status:'active', sort:30, badge:'Enterprise', monthly:0, yearly:0, limits:{workers:5000,sites:500,users:100,sms_segments_month:100000,ai_tokens_month:25000000,voice_minutes_month:10000,weather_checks_month:1000000,retention_days:730}, features:PLAN_FEATURES.legacy },
];

export function applyPlanCatalogMigration(db, { now = () => Math.floor(Date.now()/1000) } = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL)');
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(PLAN_CATALOG_VERSION)) return false;

  db.exec('BEGIN');
  try {
    // Move every existing organization onto the public Basic plan, then remove
    // the obsolete compatibility plan and its non-cascading price rows.
    const stamp = now();
    const basicCatalog=PLANS.find(plan=>plan.id==='sample-basic');
    const basicPrice=db.prepare("SELECT amount_minor,currency FROM plan_prices WHERE plan_id='sample-basic' AND billing_cycle='monthly' ORDER BY effective_from DESC,version DESC LIMIT 1").get();
    const price=basicPrice&&basicPrice.amount_minor>0?basicPrice:{amount_minor:basicCatalog.monthly,currency:'BDT'};
    db.prepare("UPDATE subscriptions SET plan_id='sample-basic',billing_cycle='monthly',price_minor=?,currency=?,current_period_start=?,current_period_end=?,trial_end=NULL,updated_at=?").run(price.amount_minor,price.currency,stamp,stamp+30*86400,stamp);
    // Older admin expense forms accepted whole taka but persisted the value in
    // the paisa column unchanged, making every historic BDT expense 100x small.
    db.prepare("UPDATE expenses SET amount_minor=amount_minor*100,updated_at=? WHERE currency='BDT' AND amount_minor<=90071992547409").run(stamp);
    db.prepare("DELETE FROM plan_prices WHERE plan_id='legacy-default'").run();
    db.prepare("DELETE FROM plans WHERE id='legacy-default'").run();
    for (const plan of PLANS) {
      db.prepare('UPDATE plans SET name=?,slug=?,description=?,status=?,sort_order=?,trial_days=0,badge_text=?,sample_values=0,updated_at=? WHERE id=?')
        .run(plan.name,plan.slug,plan.description,plan.status,plan.sort,plan.badge,stamp,plan.id);
      for (const [cycle,amount] of [['monthly',plan.monthly],['yearly',plan.yearly]]) {
        const version = Number(db.prepare('SELECT COALESCE(MAX(version),0)+1 AS n FROM plan_prices WHERE plan_id=? AND billing_cycle=?').get(plan.id,cycle).n);
        db.prepare('INSERT INTO plan_prices(id,plan_id,billing_cycle,amount_minor,currency,effective_from,version,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(`catalog-v${PLAN_CATALOG_VERSION}-${plan.id}-${cycle}`,plan.id,cycle,amount,'BDT',stamp,version,null,stamp);
      }
      for (const [key,value] of Object.entries(plan.limits)) {
        db.prepare('INSERT INTO plan_limits(plan_id,limit_key,value,unlimited,updated_at) VALUES(?,?,?,0,?) ON CONFLICT(plan_id,limit_key) DO UPDATE SET value=excluded.value,unlimited=0,updated_at=excluded.updated_at')
          .run(plan.id,key,value,stamp);
      }
      for (const key of ['ai_chat','ai_alert_automation','simulator','voice_alerts','csv_import','data_export','break_planner','nowcasting','heat_triage','ai_reports','official_advisories','priority_support','api_access','custom_branding']) {
        db.prepare('INSERT INTO plan_features(plan_id,feature_key,enabled,updated_at) VALUES(?,?,?,?) ON CONFLICT(plan_id,feature_key) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at')
          .run(plan.id,key,plan.features.includes(key)?1:0,stamp);
      }
    }
    db.prepare("UPDATE billing_settings SET value_json='\"sample-basic\"',updated_at=? WHERE setting_key='default_plan_id'").run(stamp);
    db.prepare('INSERT INTO billing_settings(setting_key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(setting_key) DO NOTHING').run('default_plan_id','"sample-basic"',stamp);
    db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(PLAN_CATALOG_VERSION,'public_basic_pro_legacy_plans',stamp);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
