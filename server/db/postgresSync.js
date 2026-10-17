import { Worker } from 'node:worker_threads';

const BUFFER_BYTES = 32 * 1024 * 1024;
const HEADER_BYTES = 8;

function rewriteSql(input) {
  let sql = String(input).trim();
  if (/^PRAGMA\b/i.test(sql)) return '';
  sql = sql.replace(/\bBEGIN\s+IMMEDIATE\b/gi, 'BEGIN');
  sql = sql.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO');
  sql = sql.replace(/\b([A-Za-z_][\w.]*)\s*=\s*(\?)\s+COLLATE\s+NOCASE\b/gi, 'LOWER($1)=LOWER($2)');
  sql = sql.replace(/\bCOLLATE\s+NOCASE\b/gi, '');
  sql = sql.replace(/\b([A-Za-z_][\w.]*)\.rowid\b/gi, '$1.id').replace(/\browid\b/gi, 'id');
  sql = sql.replace(/\bdate\(([^,()]+),\s*'unixepoch'\)/gi, "to_char(to_timestamp($1) AT TIME ZONE 'UTC', 'YYYY-MM-DD')");
  sql = sql.replace(/datetime\(([^,]+),\s*'unixepoch'\)/gi, "to_char(to_timestamp($1) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
  sql = sql.replace(/\bLIKE\b/gi, 'ILIKE');

  let index = 0;
  let quote = '';
  let bound = '';
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (quote) {
      bound += char;
      if (char === quote && sql[i + 1] === quote) bound += sql[++i];
      else if (char === quote) quote = '';
    } else if (char === "'" || char === '"') {
      quote = char;
      bound += char;
    } else if (char === '?') {
      bound += `$${++index}`;
    } else bound += char;
  }

  return bound;
}

export class PostgresSyncDatabase {
  #worker;
  #state;
  #bytes;

  constructor(connectionString) {
    const shared = new SharedArrayBuffer(HEADER_BYTES + BUFFER_BYTES);
    this.#state = new Int32Array(shared, 0, 2);
    this.#bytes = new Uint8Array(shared, HEADER_BYTES);
    this.#worker = new Worker(new URL('./postgresSyncWorker.js', import.meta.url), {
      workerData: { shared, connectionString, bufferBytes: BUFFER_BYTES },
    });
    this.#worker.unref();
    const deadline = Date.now() + 30000;
    while (Atomics.load(this.#state, 0) === 0 && Date.now() < deadline) Atomics.wait(this.#state, 0, 0, 1000);
    if (Atomics.load(this.#state, 0) !== 2) {
      const response = this.#readResponse();
      this.#worker.terminate();
      const failure = response?.error;
      if (failure) {
        const details = [failure.code, failure.message].filter(Boolean).join(': ');
        throw new Error(`Could not connect to PostgreSQL${details ? ` (${details})` : ''}.`);
      }
      throw new Error('Could not connect to PostgreSQL: the database worker did not become ready within 30 seconds.');
    }
  }

  #write(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (bytes.length > this.#bytes.length) throw new Error('PostgreSQL database response exceeded the configured IPC limit.');
    this.#bytes.set(bytes);
    Atomics.store(this.#state, 1, bytes.length);
  }

  #readResponse() {
    const length = Atomics.load(this.#state, 1);
    if (!length) return null;
    return JSON.parse(new TextDecoder().decode(this.#bytes.subarray(0, length)));
  }

  #call(payload) {
    if (Atomics.load(this.#state, 0) !== 2) throw new Error('PostgreSQL connection is not ready.');
    this.#write(payload);
    Atomics.store(this.#state, 0, 1);
    Atomics.notify(this.#state, 0);
    const deadline = Date.now() + 120000;
    while (Atomics.load(this.#state, 0) === 1 && Date.now() < deadline) Atomics.wait(this.#state, 0, 1, 1000);
    if (Atomics.load(this.#state, 0) === 1) throw new Error('PostgreSQL query timed out after 120 seconds.');
    const response = this.#readResponse();
    if (!response || response.error) {
      const error = new Error(response?.error?.message || 'PostgreSQL query failed.');
      error.code = response?.error?.code === '23505' ? 'SQLITE_CONSTRAINT_UNIQUE' : response?.error?.code;
      throw error;
    }
    return response.result;
  }

  prepare(source) {
    const sql = rewriteSql(source);
    return {
      run: (...params) => {
        if (!sql) return { changes: 0 };
        const result = this.#call({ sql: rewriteIgnore(source, sql), params });
        return { changes: result.rowCount || 0 };
      },
      get: (...params) => sql ? this.#call({ sql, params }).rows[0] : undefined,
      all: (...params) => sql ? this.#call({ sql, params }).rows : [],
    };
  }

  exec(source) {
    const sql = rewriteSql(source);
    if (sql) this.#call({ sql, params: [] });
  }
}

function rewriteIgnore(source, sql) {
  if (!/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(String(source))) return sql;
  const withoutTerminator = sql.replace(/;\s*$/, '');
  return `${withoutTerminator} ON CONFLICT DO NOTHING`;
}
