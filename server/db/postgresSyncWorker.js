import pg from 'pg';
import { parentPort, workerData } from 'node:worker_threads';

const { shared, connectionString, bufferBytes } = workerData;
const state = new Int32Array(shared, 0, 2);
const bytes = new Uint8Array(shared, 8);
pg.types.setTypeParser(20, value => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Database integer is outside JavaScript's safe range: ${value}`);
  return parsed;
});

function write(value, status = 2) {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  if (encoded.length > bufferBytes) throw new Error('PostgreSQL response exceeded the IPC limit.');
  bytes.set(encoded);
  Atomics.store(state, 1, encoded.length);
  Atomics.store(state, 0, status);
  Atomics.notify(state, 0);
}

const client = new pg.Client({ connectionString, connectionTimeoutMillis: 15000 });
try {
  await client.connect();
  write({ ready: true });
} catch (error) {
  write({ error: { message: error.message, code: error.code } }, 3);
  parentPort?.close();
}

while (Atomics.load(state, 0) !== 3) {
  Atomics.wait(state, 0, 2);
  if (Atomics.load(state, 0) !== 1) continue;
  const length = Atomics.load(state, 1);
  const request = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
  try {
    const result = await client.query(request.sql, request.params);
    write({ result });
  } catch (error) {
    write({ error: { message: error.message, code: error.code } });
  }
}

await client.end().catch(() => {});
