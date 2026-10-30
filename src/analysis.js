// Non-streaming entry point kept for API compatibility (/api/analyze).
import { runAgent } from './agent.js';

export async function analyzeIncident(scenario, rawLogs, env = process.env, options = {}) {
  return runAgent({ scenario, rawLogs, env, operatorFacts: options.operatorFacts, maxRounds: options.maxRounds ?? 3 });
}
