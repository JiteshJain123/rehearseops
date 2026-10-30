import test from 'node:test';
import assert from 'node:assert/strict';
import { getScenario, SCENARIOS } from '../src/fixtures.js';
import { evaluateAction, evaluateProposal } from '../src/policy.js';
import { simulateAction, rehearseProposal } from '../src/simulator.js';
import { runBenchmark } from '../src/benchmark.js';
import { factsFromFixture, factsFromOperator } from '../src/facts.js';

const dbFacts = () => { const s = getScenario('database-pool-exhaustion'); return factsFromFixture(s.facts, s.factEvidence); };
const get = (scenarioId, actionId) => { const scenario = getScenario(scenarioId); const action = scenario.actions.find((a) => a.id === actionId); assert.ok(action); return { scenario, action }; };

test('all scenarios have unique IDs, evidence and typed actions', () => {
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length);
  for (const s of SCENARIOS) {
    assert.ok(s.events.length > 0);
    assert.ok(s.actions.length >= 3);
    for (const a of s.actions) assert.ok(a.type && a.params, `${a.id} must be typed`);
    assert.ok(!s.actions.some((a) => 'checks' in a), 'checks must be derived, not hand-written');
  }
});

test('connection budget is computed from the proposal parameter at the autoscaler ceiling', () => {
  for (const [pool, expected] of [[50, 'blocked'], [30, 'blocked'], [16, 'blocked'], [15, 'approved-for-simulation'], [10, 'approved-for-simulation']]) {
    assert.equal(evaluateProposal({ type: 'set_pool_size', params: { poolSize: pool } }, dbFacts()).status, expected, `pool ${pool}`);
  }
});

test('pool 30 fits current replicas but is blocked because the autoscaler can reach 6', () => {
  const gate = evaluateProposal({ type: 'set_pool_size', params: { poolSize: 30 } }, dbFacts());
  assert.equal(gate.status, 'blocked');
  assert.match(gate.explanation[0], /autoscaler max 6/);
  assert.match(gate.explanation[0], /190/);
});

test('without an autoscaler fact the budget uses current replicas and warns', () => {
  const { facts } = factsFromOperator({ replicas: 3, maxConnections: 100, otherConnections: 10 });
  const gate = evaluateProposal({ type: 'set_pool_size', params: { poolSize: 30 } }, facts);
  assert.equal(gate.status, 'approved-for-simulation');
  assert.ok(gate.checks.some((c) => c.id === 'autoscaler_unknown' && c.severity === 'warning'));
});

test('manual scaling is checked at the autoscaler ceiling too', () => {
  assert.equal(evaluateProposal({ type: 'scale_replicas', params: { replicas: 5 } }, dbFacts()).status, 'blocked');
  assert.equal(evaluateProposal({ type: 'scale_replicas', params: { replicas: 2 } }, dbFacts()).status, 'blocked');
  const { facts } = factsFromOperator({ poolSize: 20, maxConnections: 100, otherConnections: 10, maxReplicas: 4 });
  assert.equal(evaluateProposal({ type: 'scale_replicas', params: { replicas: 4 } }, facts).status, 'approved-for-simulation');
});

test('change window is a warning, not a pass to production', () => {
  const gate = evaluateProposal({ type: 'set_pool_size', params: { poolSize: 15 } }, dbFacts());
  assert.ok(gate.checks.some((c) => c.id === 'change_window' && !c.passed && c.severity === 'warning'));
});

test('retry, breaker, schema and retention rules', () => {
  assert.equal(evaluateAction(...Object.values(get('retry-storm', 'raise-retries'))).status, 'blocked');
  assert.equal(evaluateAction(...Object.values(get('retry-storm', 'bounded-backoff'))).status, 'approved-for-simulation');
  assert.equal(evaluateAction(...Object.values(get('retry-storm', 'disable-circuit-breaker'))).status, 'blocked');
  const rb = evaluateAction(...Object.values(get('migration-rollback-risk', 'rollback-v41')));
  assert.equal(rb.status, 'blocked'); assert.match(rb.explanation.join(' '), /INCOMPATIBLE/);
  assert.equal(evaluateAction(...Object.values(get('disk-retention-risk', 'delete-all-logs'))).status, 'blocked');
  const d14 = evaluateAction(...Object.values(get('disk-retention-risk', 'delete-logs-14d')));
  assert.equal(d14.status, 'approved-for-simulation');
  assert.match(d14.checks.find((c) => c.id === 'retention').detail, /older than 14 days/);
});

test('unknown types, extra params and missing facts default to deny', () => {
  assert.equal(evaluateProposal({ type: 'shell_exec', params: { cmd: 'ls' } }, dbFacts()).status, 'blocked');
  assert.equal(evaluateProposal({ type: 'set_pool_size', params: { poolSize: 20, force: true } }, dbFacts()).status, 'blocked');
  const g = evaluateProposal({ type: 'set_pool_size', params: { poolSize: 5 } }, {});
  assert.equal(g.status, 'blocked'); assert.match(g.explanation[0], /not confirmed/);
});

test('operator facts are validated and become trusted', () => {
  const { facts, rejected } = factsFromOperator({ replicas: '4', maxConnections: 150, otherConnections: 20, bogus: 1, poolSize: -3 });
  assert.deepEqual(Object.keys(facts).sort(), ['maxConnections', 'otherConnections', 'replicas']);
  assert.equal(rejected.length, 2);
  assert.equal(evaluateProposal({ type: 'set_pool_size', params: { poolSize: 32 } }, facts).status, 'approved-for-simulation');
  assert.equal(evaluateProposal({ type: 'set_pool_size', params: { poolSize: 33 } }, facts).status, 'blocked');
});

test('rehearsal refuses blocked actions and computes budget from params', () => {
  const blocked = simulateAction(getScenario('database-pool-exhaustion'), 'increase-pool-50', dbFacts());
  assert.equal(blocked.ok, false); assert.equal(blocked.mode, 'not-simulated');
  const ok = rehearseProposal({ type: 'set_pool_size', params: { poolSize: 15 } }, dbFacts());
  assert.equal(ok.ok, true);
  assert.equal(ok.metrics.find((m) => m.label.startsWith('Worst-case connections')).value, '250 → 100');
  assert.equal(ok.metrics.find((m) => m.label === 'Headroom').value, '0');
  assert.deepEqual(ok.chart, { kind: 'budget', before: 250, after: 100, limit: 100 });
  assert.match(ok.disclaimer, /No production infrastructure/);
});

test('fixture suite and adversarial suite both pass with zero false approvals', () => {
  const report = runBenchmark();
  assert.equal(report.fixtures.failed, 0, JSON.stringify(report.fixtures.cases.filter((c) => !c.passed)));
  assert.equal(report.adversarial.falseApprovals, 0, JSON.stringify(report.adversarial.cases.filter((c) => !c.passed)));
  assert.equal(report.adversarial.falseBlocks, 0);
  assert.ok(report.adversarial.unsafeTotal >= 25);
});
