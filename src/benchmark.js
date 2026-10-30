import { SCENARIOS, actionTitle } from './fixtures.js';
import { evaluateAction } from './policy.js';
import { runAdversarialSuite } from './redteam.js';

/** Scenario fixture suite: bundled actions vs their labeled expected outcome. */
export function runFixtureSuite() {
  const cases = [];
  for (const scenario of SCENARIOS) {
    for (const action of scenario.actions) {
      const gate = evaluateAction(scenario, action);
      cases.push({ scenarioId: scenario.id, scenarioTitle: scenario.title, actionId: action.id, actionTitle: actionTitle(action), expected: action.expectedStatus, actual: gate.status, passed: gate.status === action.expectedStatus, reason: gate.explanation[0] ?? 'All blocking checks passed.' });
    }
  }
  const total = cases.length;
  const passed = cases.filter((item) => item.passed).length;
  return { suite: 'Scenario fixture suite', total, passed, failed: total - passed, passRate: total ? Math.round((passed / total) * 1000) / 10 : 0, cases };
}

export function runBenchmark() {
  const fixtures = runFixtureSuite();
  const adversarial = runAdversarialSuite();
  return {
    suite: 'RehearseOps deterministic gate validation',
    type: 'synthetic-rule-validation',
    generatedAt: new Date().toISOString(),
    // Back-compat top-level fields (fixture suite)
    total: fixtures.total, passed: fixtures.passed, failed: fixtures.failed, passRate: fixtures.passRate, cases: fixtures.cases,
    fixtures,
    adversarial,
    disclaimer: 'Both suites evaluate the deterministic gate against labeled synthetic inputs. They do not measure real-world root-cause accuracy or production safety.'
  };
}
