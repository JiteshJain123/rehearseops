import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { SCENARIOS, getScenario, publicScenario } from './src/fixtures.js';
import { analyzeIncident } from './src/analysis.js';
import { runAgent } from './src/agent.js';
import { rehearseProposal } from './src/simulator.js';
import { runBenchmark } from './src/benchmark.js';
import { runLiveInjection } from './src/redteam.js';
import { getProviderConfig, hasNebiusConfig, listModels, probe, runtimeStatus } from './src/provider.js';
import { hasTavilyConfig, searchDocumentation } from './src/search.js';
import { factsFromFixture, factsFromOperator, FACT_VOCABULARY } from './src/facts.js';
import { ACTION_TYPES } from './src/actions.js';
import { buildEvidence } from './src/normalize.js';
import { extractFacts } from './src/extract.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const VERSION = '2.1.0';
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

// ---------- .env (optional, no dependency) ----------
async function loadDotEnv() {
  try {
    const source = await readFile(path.join(ROOT, '.env'), 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const cleaned = line.trim();
      if (!cleaned || cleaned.startsWith('#')) continue;
      const index = cleaned.indexOf('=');
      if (index < 1) continue;
      const key = cleaned.slice(0, index).trim();
      let value = cleaned.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch { /* .env is optional */ }
}

// ---------- Rate limiting and a global hourly budget for model-backed calls ----------
const rateBuckets = new Map();
function clientId(req) {
  const forwarded = process.env.TRUST_PROXY === '1' ? req.headers['x-forwarded-for'] : null;
  return typeof forwarded === 'string' ? forwarded.split(',')[0].trim().slice(0, 64) : (req.socket.remoteAddress || 'unknown');
}
function rateLimit(bucket, limit, windowMs = 60_000) {
  return (req, res, next) => {
    const key = `${clientId(req)}:${bucket}`;
    const now = Date.now();
    let entry = rateBuckets.get(key);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + windowMs };
    entry.count += 1;
    rateBuckets.set(key, entry);
    if (rateBuckets.size > 5000) for (const [k, v] of rateBuckets) if (v.resetAt <= now) rateBuckets.delete(k);
    if (entry.count <= limit) return next();
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.set('Retry-After', String(retryAfter)).status(429).json({ error: `Too many requests. Try again in ${retryAfter}s.` });
  };
}
const modelBudget = { windowStart: Date.now(), used: 0 };
function takeModelBudget() {
  const cap = Number(process.env.MAX_MODEL_RUNS_PER_HOUR || 60);
  if (Date.now() - modelBudget.windowStart > 3_600_000) { modelBudget.windowStart = Date.now(); modelBudget.used = 0; }
  if (modelBudget.used >= cap) return false;
  modelBudget.used += 1;
  return true;
}

// ---------- Helpers ----------
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function requireScenario(req, res) {
  const scenario = getScenario(String(req.body?.scenarioId ?? ''));
  if (!scenario) { res.status(400).json({ error: 'Choose a valid incident scenario.' }); return null; }
  return scenario;
}
const clipLogs = (value) => (typeof value === 'string' ? value.slice(0, 40000) : undefined);

function healthPayload() {
  const config = getProviderConfig();
  const runtime = runtimeStatus();
  const live = hasNebiusConfig();
  return {
    status: 'ok',
    app: 'RehearseOps',
    version: VERSION,
    environment: process.env.NODE_ENV || 'development',
    nebiusConfigured: live,
    model: live ? (runtime.resolvedModels.reasoning || config.models.reasoning) : null,
    models: live ? { reasoning: runtime.resolvedModels.reasoning || config.models.reasoning, fast: runtime.resolvedModels.fast || config.models.fast, configured: config.models, autoResolved: runtime.resolvedModels } : null,
    lastLiveCall: runtime.lastLiveCall,
    lastProbe: runtime.lastProbe,
    tavilyConfigured: hasTavilyConfig(),
    mode: live ? 'live-model-available' : 'demo-mode',
    productionActionsEnabled: false,
    scenarioCount: SCENARIOS.length,
    actionTypes: Object.keys(ACTION_TYPES).length
  };
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' });
    next();
  });
  // Reject malformed percent-encoding before routing.
  app.use((req, res, next) => { try { decodeURIComponent(req.path); next(); } catch { res.status(400).json({ error: 'Invalid path.' }); } });

  const api = express.Router();
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.use(express.json({ limit: '1mb' }));

  api.get('/health', (req, res) => res.json(healthPayload()));

  api.get('/scenarios', (req, res) => res.json({ scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, subtitle: s.subtitle, severity: s.severity, category: s.category, affectedServices: s.affectedServices })) }));

  api.get('/scenarios/:id', (req, res) => {
    const scenario = /^[a-z0-9-]+$/.test(req.params.id) ? getScenario(req.params.id) : null;
    if (!scenario) return res.status(404).json({ error: 'Scenario not found.' });
    res.json({ scenario: publicScenario(scenario) });
  });

  api.get('/grammar', (req, res) => res.json({
    facts: FACT_VOCABULARY,
    actions: Object.fromEntries(Object.entries(ACTION_TYPES).map(([k, v]) => [k, { description: v.description, mutating: v.mutating, params: Object.fromEntries(Object.entries(v.params).map(([n, p]) => [n, { type: p.type, min: p.min, max: p.max, values: p.values }])), facts: v.facts }]))
  }));

  // Streaming agent run (NDJSON): investigate → propose → gate → revise
  api.post('/agent', rateLimit('agent', 8), asyncRoute(async (req, res) => {
    const scenario = requireScenario(req, res);
    if (!scenario) return;
    const env = { ...process.env };
    let budgetNote = null;
    if (hasNebiusConfig() && !takeModelBudget()) { env.NEBIUS_API_KEY = ''; budgetNote = 'The hourly live-model budget for this demo is used up, so this run uses the labeled scripted proposer.'; }
    res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let aborted = false;
    res.on('close', () => { if (!res.writableEnded) aborted = true; });
    const emit = (event) => { if (!aborted && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`); };
    if (budgetNote) emit({ type: 'notice', message: budgetNote });
    try {
      await runAgent({ scenario, rawLogs: clipLogs(req.body.rawLogs), operatorFacts: req.body.facts, env, emit, isAborted: () => aborted, maxRounds: Math.min(3, Math.max(1, Number(req.body.maxRounds) || 3)) });
    } catch (error) {
      console.error(error);
      emit({ type: 'error', message: 'The agent run failed on the server. Check the server log.' });
    }
    if (!res.writableEnded) res.end();
  }));

  api.post('/analyze', rateLimit('analyze', 8), asyncRoute(async (req, res) => {
    const scenario = requireScenario(req, res);
    if (!scenario) return;
    const env = hasNebiusConfig() && !takeModelBudget() ? { ...process.env, NEBIUS_API_KEY: '' } : process.env;
    res.json(await analyzeIncident(scenario, clipLogs(req.body.rawLogs), env, { operatorFacts: req.body.facts }));
  }));

  api.post('/extract', rateLimit('extract', 10), asyncRoute(async (req, res) => {
    const rawLogs = clipLogs(req.body.rawLogs) ?? '';
    if (!rawLogs.trim()) return res.status(400).json({ error: 'Paste some log lines to extract facts from.' });
    const evidence = buildEvidence({ rawLogs: '', events: [] }, rawLogs);
    const useModel = hasNebiusConfig() && takeModelBudget();
    res.json({ evidence, ...(await extractFacts(evidence, process.env, { useModel })) });
  }));

  // Rehearse: re-gates on the server and never trusts the browser's verdict.
  const rehearse = (req, res) => {
    const scenario = requireScenario(req, res);
    if (!scenario) return;
    let proposal = req.body.proposal;
    if (!proposal && req.body.actionId) {
      const action = scenario.actions.find((a) => a.id === String(req.body.actionId));
      if (!action) return res.status(400).json({ ok: false, error: 'Action not found for this scenario.' });
      proposal = { type: action.type, params: action.params };
    }
    if (!proposal) return res.status(400).json({ ok: false, error: 'Send a proposal {type, params} or an actionId.' });
    // For bundled scenarios the server ignores client facts, so facts can't be spoofed.
    const facts = req.body.custom === true ? factsFromOperator(req.body.facts).facts : factsFromFixture(scenario.facts, scenario.factEvidence);
    const result = rehearseProposal(proposal, facts);
    res.status(result.ok ? 200 : 409).json(result);
  };
  api.post('/rehearse', rehearse);
  api.post('/simulate', rehearse);

  api.get('/benchmark', (req, res) => res.json(runBenchmark()));

  api.post('/redteam/live', rateLimit('redteam', 2, 600_000), asyncRoute(async (req, res) => {
    if (!hasNebiusConfig()) return res.status(424).json({ ok: false, error: 'The live injection test needs NEBIUS_API_KEY.' });
    if (!takeModelBudget()) return res.status(429).json({ ok: false, error: 'The hourly live-model budget is used up.' });
    res.json(await runLiveInjection());
  }));

  api.get('/models', asyncRoute(async (req, res) => {
    const result = await listModels(process.env);
    const nemotron = result.ok ? result.models.filter((id) => /nemotron|nvidia/i.test(id)) : [];
    res.status(result.ok ? 200 : (result.configured ? 502 : 424)).json({ ...result, models: undefined, nemotron, totalModels: result.ok ? result.models.length : 0, configured: getProviderConfig().models });
  }));

  api.post('/probe', rateLimit('probe', 4), asyncRoute(async (req, res) => {
    if (!hasNebiusConfig()) return res.status(424).json({ ok: false, configured: false, error: 'NEBIUS_API_KEY is not configured.' });
    if (!takeModelBudget()) return res.status(429).json({ ok: false, error: 'The hourly live-model budget is used up.' });
    res.json(await probe(process.env));
  }));

  api.post('/search', rateLimit('search', 20), asyncRoute(async (req, res) => {
    const query = String(req.body.query ?? '').trim();
    if (query.length < 4) return res.status(400).json({ error: 'Type a more specific search query.' });
    const result = await searchDocumentation(query);
    res.status(result.ok ? 200 : (result.configured ? 502 : 424)).json(result);
  }));

  api.use((req, res) => res.status(req.method === 'GET' ? 404 : 405).json({ error: 'API route not found.' }));
  // JSON errors for the API (bad JSON, body too large, unexpected failures).
  api.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = error.status || error.statusCode || 500;
    if (status >= 500) console.error(error);
    if (res.headersSent) return res.end();
    const message = error.type === 'entity.parse.failed' ? 'Request body must be valid JSON.' : error.type === 'entity.too.large' ? 'Request body is too large.' : status >= 500 ? 'Internal server error.' : error.message;
    res.status(status).json({ error: message });
  });

  app.use('/api', api);
  app.use(express.static(PUBLIC_DIR, {
    index: 'index.html',
    dotfiles: 'ignore',
    setHeaders: (res, filePath) => res.set('Cache-Control', filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=300')
  }));
  app.use((req, res) => res.status(req.method === 'GET' || req.method === 'HEAD' ? 404 : 405).json({ error: req.method === 'GET' || req.method === 'HEAD' ? 'Not found.' : 'Method not allowed.' }));
  return app;
}

/** Kept for tests and back-compat: returns a plain http.Server wrapping the Express app. */
export function createServer() {
  const server = http.createServer(createApp());
  server.requestTimeout = 300_000;
  return server;
}

await loadDotEnv();

// Works on Windows and in folders with spaces (compare resolved file paths, not URL strings).
const isEntryPoint = (() => {
  try { return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (process.env.NODE_ENV !== 'test' && isEntryPoint) {
  const server = createServer();
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '0.0.0.0';
  server.listen(port, host, () => {
    const config = getProviderConfig();
    console.log(`RehearseOps ${VERSION} (Express) running on http://localhost:${port}`);
    console.log(hasNebiusConfig() ? `Nebius Token Factory configured · reasoning: ${config.models.reasoning} · fast: ${config.models.fast}` : 'Demo mode (no NEBIUS_API_KEY): the scripted proposer is used and labeled as such.');
    console.log(`Tavily: ${hasTavilyConfig() ? 'configured' : 'not configured (optional)'}`);
  });
}
