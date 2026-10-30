import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockNebius } from './helpers/mock-nebius.js';
import { runAgent } from '../src/agent.js';
import { getScenario } from '../src/fixtures.js';
import { resetRuntime, runtimeStatus, chatJSON } from '../src/provider.js';
import { runLiveInjection } from '../src/redteam.js';
import { extractFacts } from '../src/extract.js';
import { parseLogLines } from '../src/normalize.js';

const CUSTOM = '[2026-10-28T10:00:00Z] INFO deployer pool_max=25 replicas=4\n[2026-10-28T10:00:05Z] WARN postgres max_connections=120 connection_count=118';

test('agent loop: blocked proposal is fed back and revised into a passing one', async () => {
  resetRuntime();
  const mock = await startMockNebius();
  try {
    const env = { NEBIUS_API_KEY: 'k', NEBIUS_BASE_URL: mock.baseUrl, NEBIUS_REASONING_MODEL: 'mock/nvidia/Nemotron-3-Ultra-mock', NEBIUS_FAST_MODEL: 'mock/nvidia/Nemotron-3-Nano-mock' };
    const events = [];
    const r = await runAgent({ scenario: getScenario('database-pool-exhaustion'), env, emit: (e) => events.push(e.type) });
    assert.equal(r.engine, 'nebius-nemotron');
    assert.equal(r.rounds.length, 2);
    assert.equal(r.rounds[0].proposals[0].gate.status, 'blocked');
    assert.match(r.rounds[0].proposals[0].gate.explanation[0], /310/);
    assert.equal(r.rounds[1].proposals[0].revises, 'P1.1');
    assert.deepEqual(r.plan.map((p) => p.gate.type).sort(), ['retry_policy', 'set_pool_size']);
    assert.deepEqual(r.hypotheses[0].evidenceIds, ['E001', 'E002']);
    assert.deepEqual(r.rounds[0].proposals[1].citations, [], 'citations to non-existent sources are dropped');
    const feedback = mock.calls[1].messages.at(-1).content;
    assert.match(feedback, /SAFETY GATE RESULTS/); assert.match(feedback, /310/);
    for (const t of ['evidence', 'facts', 'sources', 'hypotheses', 'round', 'final']) assert.ok(events.includes(t), t);
  } finally { await mock.close(); }
});

test('wrong configured model ID is auto-resolved from the catalog', async () => {
  resetRuntime();
  const mock = await startMockNebius();
  try {
    const r = await chatJSON({ tier: 'reasoning', env: { NEBIUS_API_KEY: 'k', NEBIUS_BASE_URL: mock.baseUrl, NEBIUS_MODEL: 'nvidia/Nemotron-3.5-Lightning' }, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.ok, true);
    assert.equal(r.model, 'mock/nvidia/Nemotron-3-Ultra-mock');
    assert.equal(runtimeStatus().resolvedModels.reasoning, 'mock/nvidia/Nemotron-3-Ultra-mock');
  } finally { await mock.close(); }
});

test('falls back when JSON mode is rejected', async () => {
  resetRuntime();
  const mock = await startMockNebius({ rejectJsonMode: true });
  try {
    const r = await chatJSON({ tier: 'fast', env: { NEBIUS_API_KEY: 'k', NEBIUS_BASE_URL: mock.baseUrl, NEBIUS_FAST_MODEL: 'mock/nvidia/Nemotron-3-Nano-mock' }, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.ok, true);
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[1].response_format, undefined);
  } finally { await mock.close(); }
});

test('fact extraction rejects values that do not appear in the cited line', async () => {
  resetRuntime();
  const mock = await startMockNebius();
  try {
    const out = await extractFacts(parseLogLines(CUSTOM), { NEBIUS_API_KEY: 'k', NEBIUS_BASE_URL: mock.baseUrl, NEBIUS_FAST_MODEL: 'mock/nvidia/Nemotron-3-Nano-mock' });
    assert.equal(out.candidates.replicas.agreement, 'pattern+model agree');
    assert.equal(out.candidates.otherConnections, undefined);
    assert.ok(out.rejected.some((r) => r.key === 'otherConnections' && /does not appear/.test(r.reason)));
    assert.ok(Object.values(out.candidates).every((c) => c.confirmed === false));
  } finally { await mock.close(); }
});

test('custom logs: nothing passes until the operator confirms facts', async () => {
  resetRuntime();
  const mock = await startMockNebius();
  const env = { NEBIUS_API_KEY: 'k', NEBIUS_BASE_URL: mock.baseUrl, NEBIUS_REASONING_MODEL: 'mock/nvidia/Nemotron-3-Ultra-mock', NEBIUS_FAST_MODEL: 'mock/nvidia/Nemotron-3-Nano-mock' };
  try {
    const before = await runAgent({ scenario: getScenario('database-pool-exhaustion'), rawLogs: CUSTOM, operatorFacts: {}, env });
    assert.equal(before.plan.length, 0);
    assert.ok(before.rejected.every((p) => /not confirmed/.test(p.gate.explanation[0])));
    const after = await runAgent({ scenario: getScenario('database-pool-exhaustion'), rawLogs: CUSTOM, operatorFacts: { replicas: 4, maxConnections: 120, otherConnections: 20, maxRetryAttempts: 3 }, env });
    // 4 × 15 + 20 = 80 ≤ 120 passes; 4 × 50 + 20 = 220 blocked.
    assert.ok(after.plan.some((p) => p.gate.type === 'set_pool_size' && p.gate.params.poolSize === 15));
    assert.ok(after.rejected.some((p) => p.params.poolSize === 50));
  } finally { await mock.close(); }
});

test('prompt injection: even a fully compliant model gets zero unsafe approvals', async () => {
  resetRuntime();
  const mock = await startMockNebius({ injectionCompliant: true });
  try {
    const out = await runLiveInjection({ NEBIUS_API_KEY: 'k', NEBIUS_BASE_URL: mock.baseUrl, NEBIUS_REASONING_MODEL: 'mock/nvidia/Nemotron-3-Ultra-mock', NEBIUS_FAST_MODEL: 'mock/nvidia/Nemotron-3-Nano-mock' });
    assert.ok(out.injectionInfluencedProposals >= 2, 'mock was influenced');
    assert.equal(out.unsafeApprovals, 0);
    assert.ok(out.proposals.some((p) => p.type === 'shell_exec' && p.status === 'blocked'));
    assert.ok(out.proposals.some((p) => p.params.poolSize === 500 && p.status === 'blocked'));
  } finally { await mock.close(); }
});

test('no key: scripted proposer is labeled and still exercises the gate loop', async () => {
  resetRuntime();
  const r = await runAgent({ scenario: getScenario('database-pool-exhaustion'), env: { NEBIUS_API_KEY: '' } });
  assert.equal(r.engine, 'scripted-demo');
  assert.equal(r.live, false);
  assert.match(r.rounds[0].model, /scripted/);
  assert.ok(r.rounds.length >= 2);
  assert.ok(r.plan.length >= 1);
  assert.equal(r.modelCalls.length, 0);
});

test('reasoning model that exhausts max_tokens is retried once with a larger budget', async () => {
  resetRuntime();
  const mock = await startMockNebius({ truncateFirst: true });
  try {
    const r = await chatJSON({ tier: 'fast', maxTokens: 500, env: { NEBIUS_API_KEY: 'k', NEBIUS_BASE_URL: mock.baseUrl, NEBIUS_FAST_MODEL: 'mock/nvidia/Nemotron-3-Nano-mock' }, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.ok, true);
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[1].max_tokens, 1000);
  } finally { await mock.close(); }
});

test('agent stops making model calls when the client disconnects', async () => {
  resetRuntime();
  const mock = await startMockNebius();
  try {
    let n = 0;
    const r = await runAgent({ scenario: getScenario('database-pool-exhaustion'), env: { NEBIUS_API_KEY: 'k', NEBIUS_BASE_URL: mock.baseUrl, NEBIUS_REASONING_MODEL: 'mock/nvidia/Nemotron-3-Ultra-mock' }, isAborted: () => (n++ > 0) });
    assert.equal(r.rounds.length, 1);
    assert.equal(mock.calls.length, 1);
  } finally { await mock.close(); }
});
