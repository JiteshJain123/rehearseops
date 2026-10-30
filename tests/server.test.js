import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withServer(fn) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('health returns provider status without secrets', async () => {
  await withServer(async (base) => {
    const p = await (await fetch(`${base}/api/health`)).json();
    assert.equal(p.status, 'ok'); assert.equal(p.productionActionsEnabled, false);
    assert.equal('apiKey' in p, false); assert.ok(p.actionTypes >= 10);
  });
});

test('static UI is served with security headers', async () => {
  await withServer(async (base) => {
    const r = await fetch(base);
    assert.equal(r.status, 200); assert.match(await r.text(), /RehearseOps/);
    assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
  });
});

test('agent endpoint streams NDJSON events ending with a final result', async () => {
  await withServer(async (base) => {
    const r = await post(`${base}/api/agent`, { scenarioId: 'retry-storm' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /ndjson/);
    const events = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(events[0].type, events.find((e) => e.type === 'notice') ? 'notice' : 'evidence');
    const final = events.at(-1);
    assert.equal(final.type, 'final');
    assert.ok(final.result.rounds.length >= 1);
  });
});

test('rehearse re-gates on the server: blocked proposals return 409', async () => {
  await withServer(async (base) => {
    const blocked = await post(`${base}/api/rehearse`, { scenarioId: 'database-pool-exhaustion', proposal: { type: 'set_pool_size', params: { poolSize: 50 } } });
    assert.equal(blocked.status, 409);
    const ok = await post(`${base}/api/rehearse`, { scenarioId: 'database-pool-exhaustion', proposal: { type: 'set_pool_size', params: { poolSize: 15 } } });
    assert.equal(ok.status, 200);
    // Client cannot smuggle facts into a fixture scenario.
    const spoof = await post(`${base}/api/rehearse`, { scenarioId: 'database-pool-exhaustion', proposal: { type: 'set_pool_size', params: { poolSize: 50 } }, facts: { maxConnections: 1000 } });
    assert.equal(spoof.status, 409);
    const legacy = await post(`${base}/api/simulate`, { scenarioId: 'database-pool-exhaustion', actionId: 'unknown-action' });
    assert.equal(legacy.status, 400);
  });
});

test('invalid scenario rejected; extract works without a key; probe needs a key', async () => {
  await withServer(async (base) => {
    assert.equal((await post(`${base}/api/analyze`, { scenarioId: 'nope' })).status, 400);
    const ex = await (await post(`${base}/api/extract`, { rawLogs: '[10:00:00] INFO x pool_max=25 replicas=4' })).json();
    assert.equal(ex.candidates.poolSize.value, 25);
    assert.equal((await post(`${base}/api/probe`, {})).status, process.env.NEBIUS_API_KEY ? 200 : 424);
  });
});

test('server starts from a folder whose path contains a space (Windows/space regression)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rehearse ops '));
  try {
    for (const item of ['server.mjs', 'package.json', 'src', 'public', 'node_modules']) await cp(path.join(ROOT, item), path.join(dir, item), { recursive: true });
    const child = spawn(process.execPath, [path.join(dir, 'server.mjs')], { env: { ...process.env, PORT: '0', NODE_ENV: 'development', NEBIUS_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = await new Promise((resolve) => {
      let out = '';
      const timer = setTimeout(() => resolve(out), 4000);
      child.stdout.on('data', (d) => { out += d; if (out.includes('running on')) { clearTimeout(timer); resolve(out); } });
      child.on('exit', () => { clearTimeout(timer); resolve(out); });
    });
    child.kill();
    assert.match(output, /running on/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
