import { simulate, VERIFICATION_CHECKLISTS } from './actions.js';
import { evaluateProposal } from './policy.js';

const DISCLAIMER = 'Deterministic rehearsal computed from the proposal parameters and confirmed facts. It is not a production prediction. No production infrastructure or external system was changed.';

/** Re-gate on the server, then rehearse. Blocked proposals are never simulated. */
export function rehearseProposal(proposal, facts) {
  const gate = evaluateProposal(proposal, facts);
  if (gate.status !== 'approved-for-simulation') {
    return { ok: false, blocked: true, mode: 'not-simulated', gate, message: 'The safety gate blocked this action. The simulator did not run it.' };
  }
  const result = simulate(gate.type, gate.params, facts);
  return {
    ok: true,
    blocked: false,
    mode: 'simulated',
    gate,
    title: gate.title,
    ...result,
    disclaimer: DISCLAIMER,
    verificationChecklist: VERIFICATION_CHECKLISTS[gate.type] ?? ['Verify the change against live telemetry before and after a staged rollout.']
  };
}

/** Back-compat helper for bundled fixture actions. */
export function simulateAction(scenario, actionId, facts) {
  const action = scenario.actions.find((candidate) => candidate.id === actionId);
  if (!action) return { ok: false, error: 'Action not found for this scenario.' };
  return { actionId, ...rehearseProposal({ type: action.type, params: action.params }, facts) };
}
