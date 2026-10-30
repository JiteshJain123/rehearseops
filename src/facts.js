// Operational facts with provenance. The safety gate only trusts facts that are
// confirmed: either bundled synthetic fixture facts or values an operator confirmed.
// Model-extracted facts are candidates until an operator confirms them.

export const FACT_VOCABULARY = {
  replicas: { type: 'int', min: 0, max: 10000, label: 'Service replicas (current)', unit: '' },
  maxReplicas: { type: 'int', min: 0, max: 10000, label: 'Autoscaler max replicas', unit: '' },
  poolSize: { type: 'int', min: 0, max: 100000, label: 'DB pool size per replica (current)', unit: 'connections' },
  maxConnections: { type: 'int', min: 1, max: 1000000, label: 'Database max_connections', unit: 'connections' },
  otherConnections: { type: 'int', min: 0, max: 1000000, label: 'Connections used by other consumers', unit: 'connections' },
  dbCapacityVerified: { type: 'bool', label: 'DB memory/CPU headroom verified for a higher limit' },
  currentRetryAttempts: { type: 'int', min: 0, max: 1000, label: 'Current client retry attempts' },
  maxRetryAttempts: { type: 'int', min: 0, max: 100, label: 'Retry budget (max attempts allowed by policy)' },
  retryStrategy: { type: 'enum', values: ['fixed', 'fixed_no_jitter', 'exponential', 'exponential_jitter'], label: 'Current retry strategy' },
  upstreamHealthy: { type: 'bool', label: 'Upstream dependency healthy' },
  currentSchemaVersion: { type: 'string', label: 'Current database schema version' },
  compatibleReleases: { type: 'list', label: 'Releases verified compatible with current schema' },
  incompatibleReleases: { type: 'list', label: 'Releases known incompatible with current schema' },
  forwardFixAvailable: { type: 'bool', label: 'Forward fix release available' },
  requiredRetentionDays: { type: 'int', min: 0, max: 36500, label: 'Required log retention', unit: 'days' },
  oldLogAgeDays: { type: 'int', min: 0, max: 36500, label: 'Oldest log age', unit: 'days' },
  recentLogAgeDays: { type: 'int', min: 0, max: 36500, label: 'Most recent retained-log age', unit: 'days' },
  legalHold: { type: 'bool', label: 'Legal hold on logs' },
  diskUsedPercent: { type: 'number', min: 0, max: 100, label: 'Disk used', unit: '%' },
  storageQuotaVerified: { type: 'bool', label: 'Storage quota for expansion verified' },
  changeWindowConfirmed: { type: 'bool', label: 'Approved change window' }
};

export function coerceFactValue(key, raw) {
  const spec = FACT_VOCABULARY[key];
  if (!spec) return { ok: false, error: `Unknown fact "${key}".` };
  switch (spec.type) {
    case 'int':
    case 'number': {
      if (typeof raw === 'boolean' || raw === null || raw === '' || Array.isArray(raw)) return { ok: false, error: `${key} must be a number.` };
      const value = Number(raw);
      if (!Number.isFinite(value)) return { ok: false, error: `${key} must be a finite number.` };
      if (spec.type === 'int' && !Number.isInteger(value)) return { ok: false, error: `${key} must be an integer.` };
      if (spec.min !== undefined && value < spec.min) return { ok: false, error: `${key} must be ≥ ${spec.min}.` };
      if (spec.max !== undefined && value > spec.max) return { ok: false, error: `${key} must be ≤ ${spec.max}.` };
      return { ok: true, value };
    }
    case 'bool': {
      if (raw === true || raw === 'true') return { ok: true, value: true };
      if (raw === false || raw === 'false') return { ok: true, value: false };
      return { ok: false, error: `${key} must be true or false.` };
    }
    case 'enum':
      return spec.values.includes(raw) ? { ok: true, value: raw } : { ok: false, error: `${key} must be one of ${spec.values.join(', ')}.` };
    case 'string': {
      const value = String(raw ?? '').trim();
      return /^[\w.:\-]{1,48}$/.test(value) ? { ok: true, value } : { ok: false, error: `${key} must be a short identifier.` };
    }
    case 'list': {
      const items = (Array.isArray(raw) ? raw : String(raw ?? '').split(',')).map((item) => String(item).trim()).filter(Boolean);
      if (items.length > 20 || !items.every((item) => /^[\w.:\-]{1,48}$/.test(item))) return { ok: false, error: `${key} must be a list of short identifiers.` };
      return { ok: true, value: items };
    }
    default:
      return { ok: false, error: `Unsupported fact type for ${key}.` };
  }
}

/** Build a fact map from bundled synthetic fixture facts (trusted as fixture data only). */
export function factsFromFixture(plainFacts = {}, factEvidence = {}) {
  const facts = {};
  for (const [key, raw] of Object.entries(plainFacts)) {
    if (!Object.hasOwn(FACT_VOCABULARY, key)) continue;
    const coerced = coerceFactValue(key, raw);
    if (coerced.ok) facts[key] = { key, value: coerced.value, source: 'fixture', confirmed: true, evidenceIds: factEvidence[key] ?? [] };
  }
  return facts;
}

/** Operator-confirmed facts arrive from the client as { key: value }. Invalid entries are dropped and reported. */
export function factsFromOperator(input = {}, candidates = {}) {
  const facts = {};
  const rejected = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { facts, rejected };
  for (const key of Object.keys(input).slice(0, 40)) {
    if (!Object.hasOwn(FACT_VOCABULARY, key)) { rejected.push({ key, error: 'Unknown fact key.' }); continue; }
    const coerced = coerceFactValue(key, input[key]);
    if (!coerced.ok) { rejected.push({ key, error: coerced.error }); continue; }
    const candidate = candidates[key];
    facts[key] = { key, value: coerced.value, source: 'operator', confirmed: true, evidenceIds: candidate?.evidenceIds ?? [], extractedBy: candidate?.source ?? null };
  }
  return { facts, rejected };
}

/** Return the value only if the fact is confirmed; otherwise undefined. */
export function trusted(facts, key) {
  const fact = facts?.[key];
  return fact && fact.confirmed === true ? fact.value : undefined;
}

export function plainConfirmedFacts(facts) {
  const out = {};
  for (const [key, fact] of Object.entries(facts ?? {})) if (fact.confirmed) out[key] = fact.value;
  return out;
}
