// Nebius Token Factory client (OpenAI-compatible). Two model tiers:
//   reasoning — investigation, typed proposals, revision after gate feedback (default: Nemotron 3 Ultra)
//   fast      — log fact extraction and search-query planning (default: Nemotron 3 Nano)
// Model IDs are configurable; if a configured ID is not found, the client discovers the
// account's catalog via GET /models and picks the closest Nemotron model for that tier.

const DEFAULT_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';
export const DEFAULT_MODELS = {
  reasoning: 'nvidia/Nemotron-3-Ultra-550b-a55b',
  fast: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B'
};
const TIER_PATTERNS = {
  reasoning: [/ultra/i, /super/i, /lightning/i, /nemotron/i],
  fast: [/nano/i, /lightning/i, /super/i, /nemotron/i]
};

const runtime = {
  resolved: {},            // tier -> model id actually used after discovery
  jsonModeUnsupported: new Set(),
  lastLiveCall: null,      // { at, model, tier, ms, tokens }
  lastProbe: null,
  catalog: null,
  catalogAt: 0
};

export function getProviderConfig(env = process.env) {
  const timeout = Number(env.NEBIUS_TIMEOUT_MS || 90000);
  return {
    apiKey: env.NEBIUS_API_KEY?.trim() ?? '',
    baseUrl: (env.NEBIUS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    models: {
      reasoning: env.NEBIUS_REASONING_MODEL?.trim() || env.NEBIUS_MODEL?.trim() || DEFAULT_MODELS.reasoning,
      fast: env.NEBIUS_FAST_MODEL?.trim() || env.NEBIUS_MODEL?.trim() || DEFAULT_MODELS.fast
    },
    // Back-compat field used by older callers/tests.
    get model() { return this.models.reasoning; },
    timeoutMs: Number.isFinite(timeout) ? Math.max(5000, timeout) : 90000
  };
}

export function hasNebiusConfig(env = process.env) {
  return Boolean(env.NEBIUS_API_KEY?.trim());
}

export function runtimeStatus() {
  return { resolvedModels: { ...runtime.resolved }, lastLiveCall: runtime.lastLiveCall, lastProbe: runtime.lastProbe };
}

export function resetRuntime() {
  runtime.resolved = {}; runtime.jsonModeUnsupported.clear(); runtime.lastLiveCall = null; runtime.lastProbe = null; runtime.catalog = null; runtime.catalogAt = 0;
}

export function modelFor(tier, env = process.env) {
  return runtime.resolved[tier] || getProviderConfig(env).models[tier];
}

/** Remove reasoning traces and code fences, then parse the first JSON object. */
export function extractJsonObject(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('Model response content is empty.');
  let text = content.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(text); } catch { /* fall through */ }
  const first = text.indexOf('{');
  if (first >= 0) {
    // Scan for the balanced object starting at the first brace.
    let depth = 0; let inString = false; let escaped = false;
    for (let i = first; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) { try { return JSON.parse(text.slice(first, i + 1)); } catch { break; } } }
    }
    const last = text.lastIndexOf('}');
    if (last > first) { try { return JSON.parse(text.slice(first, last + 1)); } catch { /* normalized error below */ } }
  }
  throw new Error('Nemotron response was not valid JSON.');
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

/** List models available to this key. Cached for 10 minutes. */
export async function listModels(env = process.env, { force = false } = {}) {
  const config = getProviderConfig(env);
  if (!config.apiKey) return { ok: false, configured: false, error: 'NEBIUS_API_KEY is not configured.' };
  if (!force && runtime.catalog && Date.now() - runtime.catalogAt < 600_000) return { ok: true, configured: true, models: runtime.catalog, cached: true };
  try {
    const response = await fetchWithTimeout(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` } }, 20000);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, configured: true, status: response.status, error: body?.error?.message || body?.detail || `HTTP ${response.status}` };
    const models = (body.data ?? []).map((item) => String(item.id)).filter(Boolean);
    runtime.catalog = models; runtime.catalogAt = Date.now();
    return { ok: true, configured: true, models };
  } catch (error) {
    return { ok: false, configured: true, error: error.name === 'AbortError' ? 'Timed out listing models.' : error.message };
  }
}

export function pickModelForTier(tier, models) {
  const nvidia = models.filter((id) => /nemotron/i.test(id));
  for (const pattern of TIER_PATTERNS[tier] ?? []) {
    const match = nvidia.filter((id) => pattern.test(id) && !/vl|omni|embed|reward|guard|safety/i.test(id));
    if (match.length) return match.sort((a, b) => a.length - b.length)[0];
  }
  return null;
}

function isModelNotFound(status, message) {
  return status === 404 || (status === 400 && /model/i.test(message) && /(not\s*found|does not exist|unknown|invalid|not available|unsupported)/i.test(message));
}

/**
 * Chat completion that must return a JSON object.
 * Returns { ok, data, model, tier, ms, usage } or { ok:false, reason, statusCode }.
 */
export async function chatJSON({ tier = 'reasoning', messages, maxTokens = 3000, temperature = 0.1, env = process.env, _attempt = 0, _grown = false }) {
  const config = getProviderConfig(env);
  if (!config.apiKey) return { ok: false, configured: false, reason: 'NEBIUS_API_KEY is not configured.' };
  const model = modelFor(tier, env);
  const useJsonMode = !runtime.jsonModeUnsupported.has(model);
  const started = Date.now();
  let response; let raw;
  try {
    response = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}) })
    }, config.timeoutMs);
    raw = await response.text();
  } catch (error) {
    const reason = error.name === 'AbortError' ? `Nebius request timed out after ${config.timeoutMs} ms.` : (error.message || 'Network error calling Nebius Token Factory.');
    if (_attempt === 0 && error.name !== 'AbortError') return chatJSON({ tier, messages, maxTokens, temperature, env, _grown, _attempt: 1 });
    return { ok: false, configured: true, reason, model, tier };
  }
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = { error: { message: raw.slice(0, 400) } }; }
  if (!response.ok) {
    const message = String(payload?.error?.message || payload?.detail || payload?.message || `HTTP ${response.status}`);
    if (useJsonMode && response.status === 400 && /response_format|json_object|json mode|guided/i.test(message) && _attempt < 3) {
      runtime.jsonModeUnsupported.add(model);
      return chatJSON({ tier, messages, maxTokens, temperature, env, _grown, _attempt: _attempt + 1 });
    }
    if (isModelNotFound(response.status, message) && !runtime.resolved[tier] && _attempt < 3) {
      const catalog = await listModels(env, { force: true });
      const alternative = catalog.ok ? pickModelForTier(tier, catalog.models) : null;
      if (alternative && alternative !== model) {
        runtime.resolved[tier] = alternative;
        return chatJSON({ tier, messages, maxTokens, temperature, env, _grown, _attempt: _attempt + 1 });
      }
    }
    if ((response.status === 429 || response.status >= 500) && _attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return chatJSON({ tier, messages, maxTokens, temperature, env, _grown, _attempt: 1 });
    }
    return { ok: false, configured: true, reason: message.slice(0, 400), statusCode: response.status, model, tier };
  }
  const message = payload?.choices?.[0]?.message ?? {};
  const content = (typeof message.content === 'string' && message.content.trim()) ? message.content : (message.reasoning_content || '');
  const finishReason = payload?.choices?.[0]?.finish_reason;
  let data;
  try { data = extractJsonObject(content); }
  catch (error) {
    // Reasoning models can spend the whole token budget thinking. Retry once with a bigger budget.
    if (!_grown && (finishReason === 'length' || !String(message.content ?? '').trim())) {
      return chatJSON({ tier, messages, maxTokens: Math.min(16000, maxTokens * 2), temperature, env, _attempt, _grown: true });
    }
    return { ok: false, configured: true, reason: `${error.message}${finishReason === 'length' ? ' (response hit max_tokens)' : ''}`, model, tier, ms: Date.now() - started, rawPreview: String(content).slice(0, 300) };
  }
  const ms = Date.now() - started;
  const usage = payload.usage ? { promptTokens: payload.usage.prompt_tokens, completionTokens: payload.usage.completion_tokens, totalTokens: payload.usage.total_tokens } : null;
  runtime.lastLiveCall = { at: new Date().toISOString(), model: payload.model || model, tier, ms, tokens: usage?.totalTokens ?? null };
  return { ok: true, configured: true, data, model: payload.model || model, requestedModel: model, tier, ms, usage, autoResolved: Boolean(runtime.resolved[tier]), assistantContent: content.slice(0, 20000) };
}

/** Minimal live call per tier, used as verifiable evidence of the runtime integration. */
export async function probe(env = process.env) {
  const config = getProviderConfig(env);
  if (!config.apiKey) return { ok: false, configured: false, error: 'NEBIUS_API_KEY is not configured.' };
  const results = {};
  for (const tier of ['fast', 'reasoning']) {
    const started = Date.now();
    const result = await chatJSON({ tier, env, maxTokens: 1500, messages: [
      { role: 'system', content: 'Return only JSON.' },
      { role: 'user', content: 'Return {"ok": true, "model_family": "<your model family name>"}' }
    ] });
    results[tier] = { ok: result.ok, model: result.model, configuredModel: config.models[tier], autoResolved: result.autoResolved ?? false, ms: result.ms ?? Date.now() - started, tokens: result.usage?.totalTokens ?? null, error: result.ok ? null : result.reason, statusCode: result.statusCode ?? null };
  }
  runtime.lastProbe = { at: new Date().toISOString(), ...results, ok: results.fast.ok && results.reasoning.ok };
  return { ok: runtime.lastProbe.ok, configured: true, ...runtime.lastProbe };
}
