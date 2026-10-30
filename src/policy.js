import { ACTION_TYPES, deriveChecks, validateProposal } from './actions.js';
import { factsFromFixture } from './facts.js';

/**
 * The deterministic safety gate. Input: a proposal {type, params} from anywhere
 * (model, fixture, operator) and a fact map with provenance. Output: a verdict.
 * The model's opinion of its own proposal is never an input.
 */
export function evaluateProposal(proposal, facts) {
  const validation = validateProposal(proposal);
  if (!validation.ok) {
    const checks = validation.errors.map((detail) => ({ id: 'schema', passed: false, label: 'Action grammar', detail, severity: 'block', factsUsed: [] }));
    return { status: 'blocked', label: 'Blocked', type: validation.type ?? null, params: null, checks, blockerCount: checks.length, explanation: validation.errors };
  }
  const checks = deriveChecks(validation.type, validation.params, facts);
  if (!checks.length) checks.push({ id: 'no_contract', passed: false, label: 'No safety contract', detail: 'No checks derived; default deny.', severity: 'block', factsUsed: [] });
  const blockers = checks.filter((check) => !check.passed && check.severity === 'block');
  return {
    status: blockers.length ? 'blocked' : 'approved-for-simulation',
    label: blockers.length ? 'Blocked' : 'Approved for simulation',
    type: validation.type,
    params: validation.params,
    title: ACTION_TYPES[validation.type].title(validation.params),
    mutating: ACTION_TYPES[validation.type].mutating,
    checks,
    blockerCount: blockers.length,
    explanation: blockers.map((check) => `${check.label}: ${check.detail}`)
  };
}

/** Gate a bundled fixture action against that scenario's fixture facts. */
export function evaluateAction(scenario, action) {
  const gate = evaluateProposal({ type: action.type, params: action.params }, factsFromFixture(scenario.facts, scenario.factEvidence));
  return { actionId: action.id, ...gate };
}

export function evaluateScenarioActions(scenario) {
  return scenario.actions.map((action) => ({ action, gate: evaluateAction(scenario, action) }));
}
