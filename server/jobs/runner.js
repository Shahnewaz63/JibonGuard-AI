import { randomUUID } from 'node:crypto';

export function createJobRunner({ db, random = Math.random, clock = () => Math.floor(Date.now() / 1000), logger = console } = {}) {
  const jobs = new Map(), locks = new Set();
  function register(key, run, { jitterMs = 30000 } = {}) { if (jobs.has(key)) throw new Error(`Job already registered: ${key}`); jobs.set(key, { run, jitterMs }); }
  async function execute(key, context = {}) {
    const job = jobs.get(key);
    if (!job) throw new Error(`Unknown job: ${key}`);
    if (locks.has(key)) return { skipped: true, reason: 'already_running' };
    locks.add(key);
    const started = clock(), id = randomUUID();
    db?.prepare('INSERT INTO job_runs(id,job_key,organization_id,status,started_at,details_json) VALUES(?,?,? ,?,?,?)').run(id, key, context.organizationId || null, 'running', started, '{}');
    try {
      const jitter = Math.floor(random() * Math.max(0, job.jitterMs));
      if (jitter) await new Promise(resolve => setTimeout(resolve, jitter));
      const value = await job.run(context);
      db?.prepare("UPDATE job_runs SET status='ok',finished_at=?,details_json=? WHERE id=?").run(clock(), JSON.stringify({ skipped: value?.skipped || 0 }), id);
      db?.prepare("INSERT INTO feature_job_state(job_key,last_run_at,last_status,last_error,updated_at) VALUES(?,?,'ok','',?) ON CONFLICT(job_key) DO UPDATE SET last_run_at=excluded.last_run_at,last_status='ok',last_error='',updated_at=excluded.updated_at").run(key, clock(), clock());
      return { skipped: false, value };
    } catch (error) {
      logger.error?.(`Job ${key} failed: ${error?.name || 'Error'}`);
      db?.prepare("UPDATE job_runs SET status='failed',finished_at=?,error_code=? WHERE id=?").run(clock(), String(error?.code || error?.name || 'error').slice(0, 80), id);
      db?.prepare("INSERT INTO feature_job_state(job_key,last_run_at,last_status,last_error,updated_at) VALUES(?,?,'failed',?,?) ON CONFLICT(job_key) DO UPDATE SET last_run_at=excluded.last_run_at,last_status='failed',last_error=excluded.last_error,updated_at=excluded.updated_at").run(key, clock(), String(error?.name || 'Error').slice(0, 80), clock());
      return { skipped: false, error: String(error?.name || 'Error') };
    } finally { locks.delete(key); }
  }
  async function runSites(key, sites, runner) {
    const results = [];
    for (const site of sites) {
      try { results.push(await runner(site)); }
      catch (error) { logger.error?.(`Job ${key} failed for a site: ${error?.name || 'Error'}`); results.push({ error: String(error?.name || 'Error') }); }
      await new Promise(resolve => setImmediate(resolve));
    }
    return results;
  }
  return { register, execute, runSites, isRunning: key => locks.has(key) };
}
