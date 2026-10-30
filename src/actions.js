// The recovery action grammar. The model may only propose actions of these types,
// with parameters that satisfy these schemas. Every safety check is computed from the
// proposal's own parameters plus confirmed facts — never from labels written next to it.
import { trusted } from './facts.js';

const VERSION = { type: 'string', pattern: /^[\w.\-]{1,32}$/ };

export const ACTION_TYPES = {
  set_pool_size: {
    description: 'Set the database connection pool size per application replica.',
    mutating: true,
    params: { poolSize: { type: 'int', min: 1, max: 2000 } },
    facts: ['replicas', 'maxConnections', 'otherConnections'],
    title: (p) => `Set DB pool to ${p.poolSize} per replica`
  },
  scale_replicas: {
    description: 'Change the number of application replicas (each replica opens its own DB pool).',
    mutating: true,
    params: { replicas: { type: 'int', min: 1, max: 500 } },
    facts: ['poolSize', 'maxConnections', 'otherConnections'],
    title: (p) => `Scale service to ${p.replicas} replicas`
  },
  set_db_max_connections: {
    description: 'Change the database-wide max_connections limit.',
    mutating: true,
    params: { maxConnections: { type: 'int', min: 1, max: 100000 } },
    facts: ['dbCapacityVerified'],
    title: (p) => `Raise DB max_connections to ${p.maxConnections}`
  },
  retry_policy: {
    description: 'Change client retry attempts and backoff strategy.',
    mutating: true,
    params: { maxAttempts: { type: 'int', min: 0, max: 50 }, strategy: { type: 'enum', values: ['fixed', 'fixed_no_jitter', 'exponential', 'exponential_jitter'] } },
    facts: ['maxRetryAttempts'],
    title: (p) => `Retries: max ${p.maxAttempts}, ${String(p.strategy).replace(/_/g, ' ')}`
  },
  circuit_breaker: {
    description: 'Enable or disable the circuit breaker in front of an upstream dependency.',
    mutating: true,
    params: { state: { type: 'enum', values: ['enabled', 'disabled'] } },
    facts: ['upstreamHealthy'],
    title: (p) => `${p.state === 'enabled' ? 'Enable' : 'Disable'} circuit breaker`
  },
  rate_limit: {
    description: 'Apply an ingress rate limit to shed load (callers receive HTTP 429 above the limit).',
    mutating: true,
    params: { requestsPerSecond: { type: 'int', min: 1, max: 1000000 } },
    facts: [],
    title: (p) => `Rate-limit ingress to ${p.requestsPerSecond} req/s`
  },
  app_rollback: {
    description: 'Roll the application back to a previous release.',
    mutating: true,
    params: { targetVersion: VERSION },
    facts: ['compatibleReleases', 'currentSchemaVersion'],
    title: (p) => `Roll back application to ${p.targetVersion}`
  },
  forward_fix: {
    description: 'Deploy a forward-fix release.',
    mutating: true,
    params: { targetVersion: VERSION },
    facts: ['forwardFixAvailable', 'compatibleReleases', 'currentSchemaVersion'],
    title: (p) => `Deploy forward fix ${p.targetVersion}`
  },
  schema_change: {
    description: 'Mutate the database schema (restore/add/drop columns).',
    mutating: true,
    params: { description: { type: 'string', maxLength: 160 } },
    facts: [],
    title: () => 'Mutate database schema'
  },
  delete_logs: {
    description: 'Delete log files older than N days.',
    mutating: true,
    params: { olderThanDays: { type: 'int', min: 0, max: 3650 } },
    facts: ['requiredRetentionDays', 'legalHold'],
    title: (p) => (p.olderThanDays === 0 ? 'Delete all logs' : `Delete logs older than ${p.olderThanDays} days`)
  },
  cleanup_temp: {
    description: 'Delete temporary files matching a path pattern.',
    mutating: true,
    params: { pathPattern: { type: 'string', maxLength: 120 } },
    facts: [],
    title: (p) => `Clean temp files ${p.pathPattern}`
  },
  expand_volume: {
    description: 'Expand a storage volume.',
    mutating: true,
    params: { sizeGb: { type: 'int', min: 1, max: 100000 } },
    facts: ['storageQuotaVerified'],
    title: (p) => `Expand volume to ${p.sizeGb} GB`
  },
  restart_service: {
    description: 'Rolling-restart a service.',
    mutating: true,
    params: { service: { type: 'string', pattern: /^[\w.\-]{1,48}$/ } },
    facts: [],
    title: (p) => `Rolling restart ${p.service}`
  },
  verification_only: {
    description: 'Run a read-only verification step (tests, metric queries). Does not change state.',
    mutating: false,
    params: { description: { type: 'string', maxLength: 200 } },
    facts: [],
    title: (p) => `Verify: ${p.description}`
  }
};

export function grammarForPrompt() {
  return Object.fromEntries(Object.entries(ACTION_TYPES).map(([type, spec]) => [type, {
    description: spec.description,
    params: Object.fromEntries(Object.entries(spec.params).map(([name, p]) => [name, p.type === 'enum' ? `one of ${p.values.join('|')}` : p.type === 'int' ? `integer ${p.min}..${p.max}` : `string (max ${p.maxLength ?? 32} chars)`]))
  }]));
}

function safeText(value, n = 40) {
  if (typeof value === 'string') return value.slice(0, n);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `<${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}>`;
}

/** Strictly validate a proposal's type and params. Returns normalized params or errors. */
export function validateProposal(proposal) {
  const errors = [];
  if (!proposal || typeof proposal !== 'object') return { ok: false, errors: ['Proposal must be an object.'] };
  const type = typeof proposal.type === 'string' ? proposal.type : '';
  if (!Object.hasOwn(ACTION_TYPES, type)) return { ok: false, type: type || null, errors: [`Action type "${safeText(proposal.type)}" is not in the recovery action grammar.`] };
  const spec = ACTION_TYPES[type];
  const input = proposal.params && typeof proposal.params === 'object' && !Array.isArray(proposal.params) ? proposal.params : {};
  const params = {};
  for (const key of Object.keys(input)) if (!Object.hasOwn(spec.params, key)) errors.push(`Unexpected parameter "${String(key).slice(0, 40)}" for ${type}.`);
  for (const [name, p] of Object.entries(spec.params)) {
    const raw = Object.hasOwn(input, name) ? input[name] : undefined;
    if (raw === undefined || raw === null || raw === '') { errors.push(`Missing parameter "${name}".`); continue; }
    if (p.type === 'int') {
      if (typeof raw !== 'number' && !(typeof raw === 'string' && /^-?\d+$/.test(raw.trim()))) { errors.push(`${name} must be an integer.`); continue; }
      const value = Number(raw);
      if (!Number.isInteger(value) || value < p.min || value > p.max) { errors.push(`${name}=${safeText(raw, 20)} is outside ${p.min}..${p.max}.`); continue; }
      params[name] = value;
    } else if (p.type === 'enum') {
      if (typeof raw !== 'string' || !p.values.includes(raw)) { errors.push(`${name} must be one of ${p.values.join(', ')}.`); continue; }
      params[name] = raw;
    } else {
      if (typeof raw !== 'string' && typeof raw !== 'number') { errors.push(`${name} must be a string.`); continue; }
      const value = String(raw).trim();
      if (p.pattern && !p.pattern.test(value)) { errors.push(`${name} has an invalid format.`); continue; }
      if (value.length > (p.maxLength ?? 32)) { errors.push(`${name} is too long.`); continue; }
      params[name] = value;
    }
  }
  return errors.length ? { ok: false, type, errors } : { ok: true, type, params, spec };
}

// ---- Checks: computed from params + confirmed facts ----

function need(facts, keys) {
  const missing = keys.filter((key) => trusted(facts, key) === undefined);
  return missing;
}

function connectionBudget(replicas, pool, other, limit) {
  const total = replicas * pool + other;
  return { total, limit, headroom: limit - total, passed: total <= limit };
}

export function deriveChecks(type, params, facts) {
  const checks = [];
  const add = (id, passed, label, detail, severity = 'block', factsUsed = []) => checks.push({ id, passed, label, detail, severity, factsUsed });
  const unknown = (keys, label) => add('unknown_facts', false, label, `Required fact(s) not confirmed: ${keys.join(', ')}. Unknown facts default to deny.`, 'block', keys);

  switch (type) {
    case 'set_pool_size': {
      const missing = need(facts, ['replicas', 'maxConnections', 'otherConnections']);
      if (missing.length) { unknown(missing, 'Connection budget'); break; }
      const r = trusted(facts, 'replicas'); const m = trusted(facts, 'maxConnections'); const o = trusted(facts, 'otherConnections');
      const hpa = trusted(facts, 'maxReplicas');
      const worst = Math.max(r, hpa ?? 0);
      const b = connectionBudget(worst, params.poolSize, o, m);
      const at = hpa !== undefined && hpa > r ? `at autoscaler max ${hpa} replicas (currently ${r})` : `${r} replicas`;
      add('pool_budget', b.passed, 'Connection budget', `${at}: ${worst} × ${params.poolSize} pool + ${o} other = ${b.total}; database limit ${m} (${b.passed ? `${b.headroom} headroom` : `${-b.headroom} over`}).`, 'block', ['replicas', 'maxReplicas', 'maxConnections', 'otherConnections']);
      if (hpa === undefined) add('autoscaler_unknown', false, 'Autoscaler ceiling', 'Autoscaler max replicas is not confirmed; the budget assumes the replica count stays fixed.', 'warning', ['maxReplicas']);
      break;
    }
    case 'scale_replicas': {
      const missing = need(facts, ['poolSize', 'maxConnections', 'otherConnections']);
      if (missing.length) { unknown(missing, 'Connection budget after scaling'); break; }
      const p = trusted(facts, 'poolSize'); const m = trusted(facts, 'maxConnections'); const o = trusted(facts, 'otherConnections');
      const hpa = trusted(facts, 'maxReplicas');
      const worst = Math.max(params.replicas, hpa ?? 0);
      const b = connectionBudget(worst, p, o, m);
      const note = hpa !== undefined && hpa > params.replicas ? ` Manual scaling doesn't stop the autoscaler, which can still reach ${hpa}.` : ' Each new replica opens its own pool.';
      add('pool_budget', b.passed, 'Connection budget after scaling', `${worst} replicas × ${p} pool + ${o} other = ${b.total}; database limit ${m}.${note}`, 'block', ['poolSize', 'maxReplicas', 'maxConnections', 'otherConnections']);
      break;
    }
    case 'set_db_max_connections': {
      const verified = trusted(facts, 'dbCapacityVerified') === true;
      add('db_capacity', verified, 'Database capacity', verified ? 'Operator confirmed DB memory/CPU headroom for the higher limit.' : 'Raising max_connections increases DB memory use; capacity headroom is not confirmed. Manual review required.', 'block', ['dbCapacityVerified']);
      break;
    }
    case 'retry_policy': {
      const budget = trusted(facts, 'maxRetryAttempts');
      if (budget === undefined) unknown(['maxRetryAttempts'], 'Retry budget');
      else add('retry_budget', params.maxAttempts <= budget, 'Retry budget', `Proposed ${params.maxAttempts} attempts; policy budget ${budget}.`, 'block', ['maxRetryAttempts']);
      const jitter = params.strategy === 'exponential_jitter';
      add('retry_jitter', jitter, 'Retry synchronization', jitter ? 'Exponential backoff with jitter desynchronizes retries.' : `Strategy "${params.strategy}" can synchronize retries and amplify load; exponential_jitter required.`, 'block');
      break;
    }
    case 'circuit_breaker': {
      if (params.state === 'enabled') { add('dependency_protection', true, 'Dependency protection', 'Enabling a breaker sheds load from a failing dependency. Validate fallback behaviour.', 'block'); break; }
      const healthy = trusted(facts, 'upstreamHealthy');
      add('dependency_protection', healthy === true, 'Dependency protection', healthy === true ? 'Upstream confirmed healthy; disabling protection does not conflict with recorded state.' : `Upstream health is ${healthy === false ? 'degraded' : 'unconfirmed'}; removing protection is blocked.`, 'block', ['upstreamHealthy']);
      break;
    }
    case 'rate_limit':
      add('load_shedding', true, 'Load shedding', `Requests above ${params.requestsPerSecond} req/s receive HTTP 429. Confirm clients back off on 429.`, 'block');
      add('user_impact', false, 'User-visible impact', 'Rate limiting rejects real user requests; confirm product owner sign-off.', 'warning');
      break;
    case 'app_rollback':
    case 'forward_fix': {
      if (type === 'forward_fix') {
        const available = trusted(facts, 'forwardFixAvailable');
        add('forward_fix_available', available === true, 'Forward fix availability', available === true ? 'A forward-fix release is recorded as available.' : 'No forward-fix release is confirmed.', 'block', ['forwardFixAvailable']);
      }
      const compatible = trusted(facts, 'compatibleReleases');
      const incompatible = trusted(facts, 'incompatibleReleases') ?? [];
      const schema = trusted(facts, 'currentSchemaVersion') ?? 'current';
      if (compatible === undefined) { unknown(['compatibleReleases'], 'Release/schema compatibility'); break; }
      const ok = compatible.includes(params.targetVersion) && !incompatible.includes(params.targetVersion);
      add('schema_compatibility', ok, 'Release/schema compatibility', ok ? `${params.targetVersion} is verified compatible with schema ${schema}.` : `${params.targetVersion} is ${incompatible.includes(params.targetVersion) ? 'known INCOMPATIBLE' : 'not verified compatible'} with schema ${schema}. Default deny.`, 'block', ['compatibleReleases', 'incompatibleReleases', 'currentSchemaVersion']);
      break;
    }
    case 'schema_change':
      add('manual_review', false, 'Manual review required', 'Schema mutations need a reviewed forward migration and data-safety plan.', 'block');
      break;
    case 'delete_logs': {
      const required = trusted(facts, 'requiredRetentionDays');
      if (required === undefined) unknown(['requiredRetentionDays'], 'Log retention');
      else add('retention', params.olderThanDays >= required, 'Log retention', `Deletes logs older than ${params.olderThanDays} days; retention requires ${required} days.`, 'block', ['requiredRetentionDays']);
      const hold = trusted(facts, 'legalHold');
      if (hold === true) add('legal_hold', false, 'Legal hold', 'A legal hold is recorded; no log deletion is permitted.', 'block', ['legalHold']);
      else add('legal_hold', hold === false, 'Legal hold', hold === false ? 'No legal hold recorded.' : 'Legal-hold status is unconfirmed; verify before deletion.', 'warning', ['legalHold']);
      break;
    }
    case 'cleanup_temp':
      add('manual_review', false, 'File-level review required', 'The gate will not infer that a path is safe to delete from its name; inventory ownership and active use first.', 'block');
      break;
    case 'expand_volume': {
      const quota = trusted(facts, 'storageQuotaVerified') === true;
      add('quota', quota, 'Storage quota', quota ? 'Storage quota confirmed.' : 'Quota and filesystem expansion procedure are not confirmed.', 'block', ['storageQuotaVerified']);
      break;
    }
    case 'restart_service':
      add('restart', true, 'Rolling restart', 'Rolling restart keeps capacity if replicas > 1; in-flight requests may be dropped.', 'block');
      break;
    case 'verification_only':
      add('read_only', true, 'Read-only verification', 'Does not mutate service or database state.', 'block');
      break;
    default:
      add('unknown_type', false, 'Unknown action type', 'Not in the action grammar; default deny.', 'block');
  }

  if (ACTION_TYPES[type]?.mutating) {
    const window = trusted(facts, 'changeWindowConfirmed') === true;
    add('change_window', window, 'Change approval', window ? 'An approved change window is recorded.' : 'No approved change window is recorded; production execution would still need approval.', 'warning', ['changeWindowConfirmed']);
  }
  return checks;
}

// ---- Deterministic simulation (rehearsal) computed from the same params + facts ----

export function simulate(type, params, facts) {
  const notExecuted = { label: 'Production action', value: 'Not executed' };
  switch (type) {
    case 'set_pool_size':
    case 'scale_replicas': {
      const current = trusted(facts, 'replicas');
      const hpa = trusted(facts, 'maxReplicas');
      const r = type === 'scale_replicas' ? params.replicas : current;
      const worst = Math.max(r ?? 0, hpa ?? 0);
      const p = type === 'set_pool_size' ? params.poolSize : trusted(facts, 'poolSize');
      const o = trusted(facts, 'otherConnections'); const m = trusted(facts, 'maxConnections');
      const b = connectionBudget(worst, p, o, m);
      const oldPool = trusted(facts, 'poolSize');
      const before = oldPool !== undefined && worst ? worst * oldPool + o : null;
      const scope = hpa !== undefined && hpa > (r ?? 0) ? `at the autoscaler ceiling of ${hpa} replicas` : `at ${worst} replicas`;
      return {
        headline: 'Worst-case connection demand fits the database limit',
        detail: `${scope}: ${worst} × ${p} + ${o} = ${b.total} potential connections against a limit of ${m}.${before !== null ? ` With the old pool it was ${before}.` : ''} Arithmetic only; it does not model connection churn or unrecorded consumers.`,
        metrics: [{ label: `Worst-case connections (${worst} replicas)`, value: `${before !== null ? `${before} → ` : ''}${b.total}` }, { label: 'Database limit', value: String(m) }, { label: 'Headroom', value: String(b.headroom) }, notExecuted],
        chart: { kind: 'budget', before, after: b.total, limit: m }
      };
    }
    case 'retry_policy': {
      const old = trusted(facts, 'currentRetryAttempts');
      const metrics = [{ label: 'Max attempts', value: String(params.maxAttempts) }, { label: 'Backoff', value: params.strategy.replace(/_/g, ' ') }, notExecuted];
      if (old !== undefined) {
        const reduction = Math.max(0, (1 - (params.maxAttempts + 1) / (old + 1)) * 100);
        metrics.unshift({ label: 'Worst-case calls per request', value: `${old + 1} → ${params.maxAttempts + 1}` }, { label: 'Worst-case amplification cut', value: `${reduction.toFixed(0)}%` });
      }
      return { headline: 'Retry amplification bounded', detail: `Worst-case calls per failing request drop to ${params.maxAttempts + 1}${old !== undefined ? ` from ${old + 1}` : ''}. Real load also depends on traffic and backoff timing.`, metrics };
    }
    case 'delete_logs': {
      const required = trusted(facts, 'requiredRetentionDays'); const oldest = trusted(facts, 'oldLogAgeDays');
      return { headline: 'Retention-safe deletion threshold', detail: `Only logs older than ${params.olderThanDays} days are candidates (retention ${required} days${oldest !== undefined ? `, oldest ${oldest} days` : ''}). File count, size and active use still need inventory.`, metrics: [{ label: 'Retention', value: `${required} days` }, { label: 'Threshold', value: `${params.olderThanDays} days` }, { label: 'Eligible files exist', value: oldest !== undefined ? (oldest > params.olderThanDays ? 'Yes (by age)' : 'None by age') : 'Unknown' }, notExecuted] };
    }
    case 'circuit_breaker':
      return { headline: 'Dependency protected by circuit breaker', detail: 'Requests fail fast while the upstream is unhealthy, removing retry pressure. Check user-visible fallback behaviour.', metrics: [{ label: 'Breaker', value: params.state }, { label: 'Upstream', value: trusted(facts, 'upstreamHealthy') === false ? 'Degraded' : 'Unconfirmed' }, notExecuted] };
    case 'app_rollback':
    case 'forward_fix':
      return { headline: 'Release passes the schema compatibility check', detail: `${params.targetVersion} is in the verified-compatible list for schema ${trusted(facts, 'currentSchemaVersion') ?? 'current'}. Still requires contract tests and a canary.`, metrics: [{ label: 'Target', value: params.targetVersion }, { label: 'Schema', value: String(trusted(facts, 'currentSchemaVersion') ?? 'unknown') }, notExecuted] };
    case 'rate_limit':
      return { headline: 'Ingress load capped', detail: `Traffic above ${params.requestsPerSecond} req/s is shed with HTTP 429.`, metrics: [{ label: 'Limit', value: `${params.requestsPerSecond} req/s` }, notExecuted] };
    case 'verification_only':
      return { headline: 'Read-only verification step', detail: params.description, metrics: [{ label: 'Mutation', value: 'None' }, notExecuted] };
    default:
      return { headline: 'Action rehearsed', detail: 'Evaluated against confirmed facts.', metrics: [notExecuted] };
  }
}

export const VERIFICATION_CHECKLISTS = {
  set_pool_size: ['Confirm active connections and pool wait time on the real database.', 'Watch error rate and p95 latency after a staged change.', 'Verify retry volume returns to baseline.', 'Keep a tested rollback path.'],
  scale_replicas: ['Confirm the DB connection budget with live pg_stat_activity counts.', 'Scale gradually and watch pool wait time.', 'Verify autoscaler limits match the budget.'],
  retry_policy: ['Check upstream p95/p99 latency and timeout rate.', 'Confirm retry attempts stay within budget in client metrics.', 'Monitor queue depth and consumer lag.'],
  circuit_breaker: ['Verify fallback responses are acceptable to users.', 'Watch breaker open/half-open transitions.', 'Confirm upstream recovers before closing.'],
  app_rollback: ['Run schema-contract tests against the target.', 'Canary before full rollout.', 'Check error rate before increasing traffic.'],
  forward_fix: ['Run schema-contract and API regression tests.', 'Canary before full rollout.', 'Check error rate before increasing traffic.'],
  delete_logs: ['Confirm exact file ages, ownership and legal holds.', 'Preserve logs inside retention.', 'Check free space and write failures after cleanup.'],
  rate_limit: ['Confirm clients back off on HTTP 429.', 'Watch rejected-request rate by route.', 'Remove the limit once the dependency recovers.'],
  restart_service: ['Confirm more than one healthy replica before restarting.', 'Watch readiness probes during the roll.'],
  verification_only: ['Record the verification output in the incident log.']
};
