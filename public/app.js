const state = {
  scenarios: [], scenario: null, health: null, grammar: null, benchmark: null,
  result: null, rounds: [], facts: {}, candidates: {}, sources: [], hypotheses: [], evidence: [],
  operatorFacts: {}, running: false, lastRehearsal: null, activeView: 'incident'
};

const EXAMPLE_CUSTOM_LOGS = `[2026-10-28T09:41:00Z] INFO deployer release=api-v7.3 pool_max=30 replicas=4
[2026-10-28T09:41:20Z] WARN postgres connection_count=146 max_connections=150 waiters=31
[2026-10-28T09:41:24Z] ERROR api db_acquire_timeout_ms=3000 route=/orders
[2026-10-28T09:41:30Z] INFO reporting-worker external_db_connections=20
[2026-10-28T09:41:33Z] WARN api retry_attempts=6 policy=fixed
[2026-10-28T09:41:40Z] ERROR gateway http_status=503 rate=22% route=/orders`;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function asCount(value) { return String(value ?? 0); }
function fmtValue(v) { return Array.isArray(v) ? v.join(', ') : String(v); }
function safeHttpUrl(value) { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : null; } catch { return null; } }

function showToast(message, kind = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`; toast.textContent = message;
  $('#toast-region').append(toast);
  setTimeout(() => toast.remove(), 4800);
}
function showNotice(message, kind = 'notice') {
  $('#notice-banner').classList.add('hidden'); $('#error-banner').classList.add('hidden');
  if (!message) return;
  const target = kind === 'error' ? $('#error-banner') : $('#notice-banner');
  target.textContent = message; target.classList.remove('hidden');
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers ?? {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 409) { const e = new Error(payload.error || `Request failed (${response.status}).`); e.status = response.status; e.payload = payload; throw e; }
  return { status: response.status, payload };
}
function isCustom() { return Boolean(state.scenario && $('#raw-logs').value.trim() && $('#raw-logs').value.trim() !== state.scenario.rawLogs.trim()); }
function updateLogCount() { const n = ($('#raw-logs').value || '').split(/\r?\n/).filter((l) => l.trim()).length; $('#log-line-count').textContent = `${n} line${n === 1 ? '' : 's'}`; }

// ---------- Progress ----------
const STEP_ORDER = ['evidence', 'facts', 'sources', 'reasoning', 'gate', 'revise', 'plan'];
function setStep(step, status = 'active') {
  const index = STEP_ORDER.indexOf(step);
  $$('#agent-steps li').forEach((li) => {
    const i = STEP_ORDER.indexOf(li.dataset.step);
    if (i < index) { if (!li.classList.contains('skipped')) li.className = 'done'; }
    else if (i === index) li.className = status;
  });
}
function resetSteps() { $$('#agent-steps li').forEach((li) => { li.className = ''; }); setRunState('idle'); }
function setRunState(value) { document.documentElement.dataset.run = value; }
function setStatus(text) { $('#agent-status').textContent = text; }

// ---------- Scenario ----------
function renderScenarioNav() {
  $('#scenario-count').textContent = asCount(state.scenarios.length);
  $('#scenario-nav').innerHTML = state.scenarios.map((s) => `<button class="scenario-nav-button ${state.scenario?.id === s.id ? 'active' : ''}" data-scenario="${escapeHtml(s.id)}"><span class="scenario-nav-mark"></span><span class="scenario-nav-title">${escapeHtml(s.title)}<small>${escapeHtml(s.severity)} · ${escapeHtml(s.category)}</small></span></button>`).join('');
  $('#scenario-select').innerHTML = state.scenarios.map((s) => `<option value="${escapeHtml(s.id)}" ${state.scenario?.id === s.id ? 'selected' : ''}>${escapeHtml(s.title)}</option>`).join('');
}
function clearResults() {
  state.result = null; state.rounds = []; state.sources = []; state.hypotheses = []; state.lastRehearsal = null;
  $('#trace').innerHTML = '<div class="action-card trace-empty"><p class="event-message">Run the recovery agent to see its rounds.</p></div>';
  $('#actions-grid').innerHTML = '';
  $('#hypotheses-grid').innerHTML = '<div class="empty-hypotheses">Run the agent to surface the leading hypotheses.</div>';
  $('#replay-panel').classList.add('hidden');
  $('#agent-sources').classList.add('hidden');
  $('#export-report').disabled = true;
  ['#metric-proposals', '#metric-blocked', '#metric-approved'].forEach((id) => { $(id).textContent = '—'; });
  $('#metric-rounds').textContent = 'Across agent rounds';
  resetSteps();
}
function renderScenario() {
  const s = state.scenario;
  $('#selected-scenario-title').textContent = s.title;
  $('#selected-scenario-subtitle').textContent = s.subtitle;
  $('#incident-severity').textContent = s.severity;
  $('#raw-logs').value = s.rawLogs; updateLogCount();
  renderScenarioNav();
  renderEvidence(s.events);
  $('#metric-events').textContent = asCount(s.events.length);
  $('#analysis-summary').textContent = 'Run the agent to rank possible causes and link supporting evidence.';
  $('#last-run').textContent = 'Ready';
  setStatus('Ready. Run the recovery agent.');
  clearResults();
  state.operatorFacts = {};
  renderFacts({}, {}, [], false);
}

// ---------- Evidence ----------
function renderEvidence(events) {
  state.evidence = events ?? [];
  const list = state.evidence;
  $('#timeline-count').textContent = `${list.length} events`;
  $('#ledger-indexed').textContent = asCount(list.length);
  $('#ledger-errors').textContent = asCount(list.filter((e) => ['error', 'critical'].includes(e.level)).length);
  $('#timeline').innerHTML = list.length ? list.map((e) => `<article class="timeline-event ${escapeHtml(e.level)} ${e.source === 'red-team' ? 'injected' : ''}" id="timeline-${escapeHtml(e.id)}"><div class="timeline-time">${escapeHtml(e.time)}</div><div class="timeline-track"><span class="event-pin"></span></div><div class="event-content"><div class="event-topline"><span class="event-service">${escapeHtml(e.service)}</span><span class="level-label ${escapeHtml(e.level)}">${escapeHtml(e.level)}</span><span class="event-id">${escapeHtml(e.id)}</span></div><div class="event-message">${escapeHtml(e.message)}</div></div></article>`).join('') : '<div class="empty-hypotheses">No log events were parsed.</div>';
  $('#evidence-list').innerHTML = list.length ? list.map((e) => `<div class="evidence-row" tabindex="0" role="button" data-evidence="${escapeHtml(e.id)}" aria-label="Jump to evidence ${escapeHtml(e.id)}"><span class="evidence-id">${escapeHtml(e.id)}</span><div class="evidence-row-copy"><div class="evidence-row-title">${escapeHtml(e.message)}</div><div class="evidence-row-meta"><span>${escapeHtml(e.source || 'incident.log')}</span><span><i class="evidence-level ${escapeHtml(e.level)}"></i>${escapeHtml(e.level)}</span></div></div></div>`).join('') : '<div class="empty-hypotheses">No evidence available.</div>';
}
function evidenceTags(ids, counter = false) { return (ids ?? []).map((id) => `<span class="${counter ? 'counter-tag ' : ''}evidence-ref" tabindex="0" role="button" data-evidence="${escapeHtml(id)}">${counter ? '−' : ''}${escapeHtml(id)}</span>`).join(''); }

// ---------- Facts ----------
function factLabel(key) { return state.grammar?.facts?.[key]?.label ?? key; }
function sourceChip(source) {
  const map = { fixture: ['Fixture', 'chip-fixture'], operator: ['Operator', 'chip-operator'], pattern: ['Pattern match', 'chip-pattern'], nemotron: ['Nemotron Nano', 'chip-model'] };
  const [label, cls] = map[source] ?? [String(source), ''];
  return `<span class="source-chip ${cls}">${escapeHtml(label)}</span>`;
}
function renderFacts(facts, candidates, rejected, custom) {
  state.facts = facts ?? {}; state.candidates = candidates ?? {};
  const keys = [...new Set([...Object.keys(state.facts), ...Object.keys(state.candidates), ...(custom ? Object.keys(state.operatorFacts) : [])])];
  const trustedCount = custom ? Object.keys(state.operatorFacts).length : Object.keys(state.facts).length;
  $('#facts-count').textContent = `${trustedCount} trusted`;
  $('#facts-subtitle').textContent = custom
    ? 'Extracted candidates are NOT trusted until you tick them. Values must appear verbatim in the cited log line to be offered at all.'
    : 'Synthetic fixture facts for this scenario. The gate computes every constraint from these values.';
  $('#facts-actions').classList.toggle('hidden', !custom);
  if (!keys.length) {
    $('#facts-body').innerHTML = `<tr><td colspan="5" class="empty-table">${custom ? 'No facts extracted yet. Run the agent, or add operator facts below.' : 'Run the agent to load facts.'}</td></tr>`;
  } else {
    $('#facts-body').innerHTML = keys.map((key) => {
      const fact = state.facts[key]; const cand = state.candidates[key];
      const opValue = state.operatorFacts[key];
      const value = custom ? (opValue !== undefined ? opValue : cand?.value) : fact?.value;
      const provenance = custom
        ? `${(cand?.sources ?? []).map(sourceChip).join('')}${opValue !== undefined ? sourceChip('operator') : ''}${cand ? `<small class="agreement">${escapeHtml(cand.agreement)}</small>` : ''}${cand?.conflict ? `<small class="conflict">conflict: ${escapeHtml(cand.conflict.source)} says ${escapeHtml(fmtValue(cand.conflict.value))}</small>` : ''}`
        : sourceChip(fact?.source ?? 'fixture');
      const ev = (custom ? cand?.evidenceIds : fact?.evidenceIds) ?? [];
      const trusted = custom ? opValue !== undefined : Boolean(fact?.confirmed);
      return `<tr class="${trusted ? 'trusted' : 'untrusted'}"><td><strong>${escapeHtml(factLabel(key))}</strong><code>${escapeHtml(key)}</code></td><td class="fact-value">${escapeHtml(fmtValue(value))}</td><td>${provenance}</td><td><div class="evidence-tags">${evidenceTags(ev) || '<span class="muted-small">—</span>'}</div></td><td class="confirm-col"><label class="trust-toggle"><input type="checkbox" data-fact="${escapeHtml(key)}" ${trusted ? 'checked' : ''} ${custom ? '' : 'disabled'}><span>${trusted ? 'Trusted' : 'Unknown'}</span></label></td></tr>`;
    }).join('');
  }
  const rej = rejected ?? [];
  $('#facts-rejected').classList.toggle('hidden', !rej.length);
  $('#facts-rejected').innerHTML = rej.length ? `<strong>Rejected by grounding check (${rej.length})</strong>${rej.map((r) => `<div>${sourceChip(r.source)} <code>${escapeHtml(r.key)}=${escapeHtml(fmtValue(r.value))}</code> — ${escapeHtml(r.reason)}</div>`).join('')}` : '';
}

// ---------- Hypotheses ----------
function renderHypotheses(hypotheses, summary) {
  state.hypotheses = hypotheses ?? [];
  if (summary) $('#analysis-summary').textContent = summary;
  $('#hypotheses-grid').innerHTML = state.hypotheses.length ? state.hypotheses.map((h, i) => {
    const pct = Math.round((Number(h.confidence) || 0) * 100);
    return `<article class="hypothesis-card ${i === 0 ? 'primary' : ''}"><div class="hypothesis-top"><span class="hypothesis-id">${escapeHtml(h.id)}</span><span class="confidence-pill ${escapeHtml(String(h.likelihood).toLowerCase())}">${escapeHtml(h.likelihood)} · ${pct}%</span></div><h4>${escapeHtml(h.title)}</h4><p>${escapeHtml(h.explanation)}</p><div class="evidence-tags">${evidenceTags(h.evidenceIds) || '<span>No linked evidence</span>'}${evidenceTags(h.counterEvidenceIds, true)}</div></article>`;
  }).join('') : '<div class="empty-hypotheses">No hypotheses returned.</div>';
}

// ---------- Trace ----------
function checkClass(c) { return c.passed ? 'pass' : (c.severity === 'warning' ? 'warn' : 'fail'); }
function checksHtml(checks) { return checks.map((c) => `<div class="gate-check ${checkClass(c)}"><span class="gate-check-icon">${c.passed ? '✓' : (c.severity === 'warning' ? '!' : '×')}</span><span><strong>${escapeHtml(c.label)}:</strong> ${escapeHtml(c.detail)}</span></div>`).join(''); }
function citationsHtml(ids) {
  return (ids ?? []).map((id) => { const src = state.sources.find((s) => s.id === id); const url = src && safeHttpUrl(src.url); return url ? `<a class="citation" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(src.title)}">${escapeHtml(id)}</a>` : `<span class="citation">${escapeHtml(id)}</span>`; }).join('');
}
function proposalCard(p) {
  const blocked = p.gate.status === 'blocked';
  const title = p.gate.title || `${p.type || 'invalid'} (rejected)`;
  return `<article class="proposal-card ${blocked ? 'blocked' : 'approved'}"><div class="proposal-top"><span class="proposal-id">${escapeHtml(p.id)}${p.revises ? ` <span class="revises">revises ${escapeHtml(p.revises)}</span>` : ''}</span><span class="verdict ${blocked ? 'blocked' : 'approved'}">${blocked ? 'Blocked' : 'Can rehearse'}</span></div><h4>${escapeHtml(title)}</h4><code class="param-code">${escapeHtml(p.type)} ${escapeHtml(JSON.stringify(p.params))}</code>${p.rationale ? `<p class="proposal-rationale">${escapeHtml(p.rationale)}</p>` : ''}<div class="evidence-tags">${evidenceTags(p.evidenceIds)}${citationsHtml(p.citations)}</div><div class="gate-checks compact">${checksHtml(p.gate.checks)}</div></article>`;
}
function renderRound(round) {
  if (!state.rounds.length || $('.trace-empty')) $('#trace').innerHTML = '';
  state.rounds.push(round);
  const blocked = round.proposals.filter((p) => p.gate.status === 'blocked').length;
  const el = document.createElement('section');
  el.className = 'trace-round';
  el.innerHTML = `<header class="round-head"><span class="round-num">Round ${round.round}</span><span class="round-meta">${escapeHtml(round.model)}${round.ms ? ` · ${(round.ms / 1000).toFixed(1)} s` : ''}${round.tokens ? ` · ${round.tokens} tokens` : ''}</span><span class="round-tally">${round.proposals.length - blocked} passed · ${blocked} blocked</span></header>${round.notes ? `<p class="round-notes">${escapeHtml(round.notes)}</p>` : ''}<div class="round-proposals">${round.proposals.map(proposalCard).join('') || '<p class="event-message">No proposals in this round.</p>'}</div>`;
  $('#trace').append(el);
  if (round.round > 1) setStep('revise', 'done'); else setStep('gate', 'done');
}

// ---------- Plan ----------
function renderPlan(result) {
  const plan = result.plan ?? [];
  $('#metric-proposals').textContent = asCount(result.stats.proposals);
  $('#metric-rounds').textContent = `${result.stats.rounds} round${result.stats.rounds === 1 ? '' : 's'} · ${result.stats.revisions} revision${result.stats.revisions === 1 ? '' : 's'}`;
  $('#metric-blocked').textContent = asCount(result.stats.blocked);
  $('#metric-approved').textContent = asCount(plan.length);
  const rejectedList = (result.rejected ?? []).map((p) => `<li><code>${escapeHtml(p.id)}</code> ${escapeHtml(p.gate.title || p.type)} — ${escapeHtml(p.gate.explanation[0] ?? '')}</li>`).join('');
  $('#actions-grid').innerHTML = (plan.length ? plan.map((p, i) => `<article class="action-card approved"><div class="action-head"><div class="action-state-icon">✓</div><div class="action-head-copy"><h4>${escapeHtml(p.gate.title)}</h4><p>${escapeHtml(p.rationale || '')}</p></div><span class="risk-tag ${p.gate.mutating ? 'medium' : 'low'}">${p.gate.mutating ? 'Changes state' : 'Read-only'}</span></div><div class="action-divider"></div><div class="gate-result approved">Approved for rehearsal</div><div class="gate-checks">${checksHtml(p.gate.checks)}</div><div class="action-bottom"><span class="action-id">${escapeHtml(p.id)} · round ${p.round}</span><button class="replay-button" data-rehearse="${i}">Rehearse</button></div></article>`).join('')
    : `<div class="action-card" data-span="all"><div class="gate-result blocked">Nothing to rehearse yet</div><p class="event-message">${result.scenario.custom ? 'Every proposal needed a fact that is not trusted yet. Confirm facts in the Facts panel and re-run.' : 'No proposal passed the gate.'}</p></div>`)
    + (rejectedList ? `<details class="action-card rejected-list" data-span="all"><summary>${result.rejected.length} proposal${result.rejected.length === 1 ? '' : 's'} rejected by the gate (never rehearsed)</summary><ul>${rejectedList}</ul></details>` : '');
  $('#export-report').disabled = false;
}

// ---------- Sources ----------
function renderSources(event) {
  state.sources = event.sources ?? [];
  if (event.status === 'not-configured') { $('#docs-subtitle').textContent = 'Tavily is not configured, so the agent ran without documentation grounding. Set TAVILY_API_KEY to enable.'; $('#agent-sources').classList.add('hidden'); return; }
  $('#docs-subtitle').textContent = state.sources.length ? `Queries: ${(event.queries ?? []).join(' · ')}` : 'Tavily returned no sources for this run.';
  $('#agent-sources').innerHTML = state.sources.map((s) => { const url = safeHttpUrl(s.url); return `<article class="doc-result"><span class="doc-score">${escapeHtml(s.id)} · relevance ${(Number(s.score || 0) * 100).toFixed(0)}%</span><h4>${escapeHtml(s.title)}</h4><p>${escapeHtml(String(s.content).slice(0, 280))}…</p>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>` : ''}</article>`; }).join('');
  $('#agent-sources').classList.toggle('hidden', !state.sources.length);
}

function setEngineBadge(live, model) {
  const chip = $('#model-chip'); const badge = $('#engine-badge');
  if (live) {
    chip.className = 'model-chip live'; chip.innerHTML = `<span class="model-dot"></span><span>Live: ${escapeHtml(model || 'NVIDIA Nemotron')}</span>`;
    badge.className = 'live-badge live'; badge.innerHTML = '<span class="pulse-dot"></span><span>Live Nemotron</span>';
  } else {
    chip.className = 'model-chip'; chip.innerHTML = '<span class="model-dot"></span><span>Scripted demo, no model</span>';
    badge.className = 'live-badge'; badge.innerHTML = '<span class="pulse-dot"></span><span>Scripted demo</span>';
  }
}

// ---------- Agent run (streaming NDJSON) ----------
function handleEvent(event) {
  switch (event.type) {
    case 'notice': showNotice(event.message); break;
    case 'evidence': renderEvidence(event.evidence); $('#metric-events').textContent = asCount(event.evidence.length); setStep('facts'); setStatus(`Parsed ${event.evidence.length} evidence events${event.custom ? ' from custom logs' : ''}.`); break;
    case 'stage':
      setStatus(event.message);
      if (event.stage === 'facts') setStep('facts');
      else if (event.stage === 'search' || event.stage === 'plan') setStep('sources');
      else if (event.stage === 'reasoning') setStep(event.round > 1 ? 'revise' : 'reasoning');
      break;
    case 'facts': renderFacts(event.facts, event.candidates, event.rejected, isCustom()); setStep('sources'); break;
    case 'sources': renderSources(event); if (event.status === 'not-configured') $('#agent-steps li[data-step="sources"]').className = 'skipped'; setStep('reasoning'); break;
    case 'hypotheses': renderHypotheses(event.hypotheses, event.summary); $('#missing-evidence').textContent = (event.missingEvidence ?? []).join(' · ') || '—'; $('#next-checks').textContent = (event.nextChecks ?? []).join(' · ') || '—'; break;
    case 'round': if (event.proposals.some((p) => p.gate.status === 'blocked')) setRunState('blocked'); renderRound(event); setStatus(`Round ${event.round}: ${event.proposals.filter((p) => p.gate.status === 'blocked').length} blocked, ${event.proposals.filter((p) => p.gate.status !== 'blocked').length} passed.`); break;
    case 'model-error': showNotice(`Nemotron call failed in round ${event.round}: ${event.reason}. Check the model ID and key in Integrations → Verify live call.`, 'error'); break;
    case 'error': showNotice(event.message, 'error'); break;
    case 'final': {
      const r = event.result; state.result = r;
      if (!state.rounds.length) $('#trace').innerHTML = `<div class="action-card trace-empty"><p class="event-message">${r.live ? 'The model returned no proposals.' : 'No scripted proposals for custom logs. Configure Nebius Token Factory to let Nemotron propose actions.'}</p></div>`;
      if (r.rounds.length < 2) $('#agent-steps li[data-step="revise"]').className = 'skipped';
      setStep('plan', 'done');
      setRunState(r.plan.length ? 'clear' : 'blocked');
      renderPlan(r);
      if (r.live && r.modelError && !r.rounds.length) {
        $('#model-chip').className = 'model-chip error'; $('#model-chip').innerHTML = '<span class="model-dot"></span><span>Model error</span>';
        $('#engine-badge').className = 'live-badge error'; $('#engine-badge').innerHTML = '<span class="pulse-dot"></span><span>Model call failed</span>';
      } else setEngineBadge(r.live, r.models?.reasoning);
      $('#last-run').textContent = `${(r.stats.durationMs / 1000).toFixed(1)} s · ${r.stats.modelCalls} model call${r.stats.modelCalls === 1 ? '' : 's'}${r.stats.totalTokens ? ` · ${r.stats.totalTokens} tokens` : ''}`;
      if (r.live && r.modelError && !r.rounds.length) showNotice(`Live Nemotron call failed: ${r.modelError}. Open Integrations → Verify live call to diagnose (wrong model ID, key, credits).`, 'error');
      setStatus(`Done. ${r.stats.proposals} proposed, ${r.stats.blocked} blocked, ${r.plan.length} rehearsable.${r.live ? '' : ' (Scripted demo: no model configured.)'}`);
      if (!r.live) showNotice('Scripted demo mode: proposals come from a fixed script, not a model. Configure NEBIUS_API_KEY to run the real Nemotron agent.');
      else if (!r.modelError) showToast('Live Nemotron run complete. Every safety decision was made by deterministic code.');
      break;
    }
    default: break;
  }
}

async function runAgent() {
  if (!state.scenario || state.running) return;
  state.running = true;
  const button = $('#analyze-button');
  button.disabled = true; button.innerHTML = '<span class="spinner"></span><span>Agent running</span>';
  showNotice(''); clearResults(); setRunState('running'); setStep('evidence'); setStatus('Starting the agent…');
  const custom = isCustom();
  try {
    const response = await fetch('/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenarioId: state.scenario.id, rawLogs: $('#raw-logs').value.slice(0, 40000), facts: custom ? state.operatorFacts : undefined }) });
    if (!response.ok) { const p = await response.json().catch(() => ({})); throw new Error(p.error || `HTTP ${response.status}`); }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1); if (line) { try { handleEvent(JSON.parse(line)); } catch (e) { console.error(e); } } }
    }
    if (buffer.trim()) handleEvent(JSON.parse(buffer));
  } catch (error) {
    showNotice(`Agent run failed: ${error.message}`, 'error'); setStatus('Failed.');
  } finally {
    state.running = false; button.disabled = false;
    button.innerHTML = '<span>Run recovery agent</span>';
  }
}

// ---------- Rehearsal ----------
function budgetChart(chart) {
  if (!chart || chart.kind !== 'budget') return '';
  const max = Math.max(chart.limit, chart.before ?? 0, chart.after) * 1.1;
  const bar = (label, value, cls) => `<div class="budget-row"><span>${label}</span><div class="budget-track"><div class="budget-fill ${cls}" data-width="${((value / max) * 100).toFixed(1)}"></div><div class="budget-limit" data-left="${((chart.limit / max) * 100).toFixed(1)}"></div></div><strong>${value}</strong></div>`;
  return `<div class="budget-chart" role="img" aria-label="Connection budget before ${chart.before ?? 'unknown'}, after ${chart.after}, limit ${chart.limit}">${chart.before !== null && chart.before !== undefined ? bar('Before', chart.before, chart.before > chart.limit ? 'over' : 'ok') : ''}${bar('After', chart.after, chart.after > chart.limit ? 'over' : 'ok')}<div class="budget-legend">Dashed line = database limit (${chart.limit})</div></div>`;
}
async function rehearse(index) {
  const p = state.result?.plan?.[index];
  if (!p) return;
  try {
    const custom = Boolean(state.result.scenario.custom);
    const { payload } = await api('/api/rehearse', { method: 'POST', body: JSON.stringify({ scenarioId: state.scenario.id, proposal: { type: p.gate.type, params: p.gate.params }, custom, facts: custom ? state.operatorFacts : undefined }) });
    if (!payload.ok) { showToast(payload.message || 'The server-side gate blocked this action.', 'error'); return; }
    state.lastRehearsal = { proposal: p, result: payload };
    $('#replay-title').textContent = payload.title;
    const metrics = (payload.metrics ?? []).map((m) => `<div class="replay-metric"><span>${escapeHtml(m.label)}</span><strong>${escapeHtml(m.value)}</strong></div>`).join('');
    const checks = (payload.verificationChecklist ?? []).map((item) => `<label><input type="checkbox"><span>${escapeHtml(item)}</span></label>`).join('');
    $('#replay-content').innerHTML = `<div class="replay-content"><div class="replay-summary"><h4>${escapeHtml(payload.headline)}</h4><p>${escapeHtml(payload.detail)}</p></div>${budgetChart(payload.chart)}${metrics ? `<div class="replay-metrics">${metrics}</div>` : ''}<div class="verification-box"><h4>Check these in the real system <span class="muted-small">Tick each one only after you have verified it.</span></h4><div class="verification-list">${checks}</div></div><div class="replay-disclaimer"><strong>Simulation boundary:</strong> ${escapeHtml(payload.disclaimer)}</div></div>`;
    requestAnimationFrame(() => requestAnimationFrame(() => $$('#replay-content [data-width]').forEach((el) => { el.style.width = `${el.dataset.width}%`; })));
    $$('#replay-content [data-left]').forEach((el) => { el.style.left = `${el.dataset.left}%`; });
    $('#replay-panel').classList.remove('hidden');
    $('#replay-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('Rehearsal complete. No production action was executed.');
  } catch (error) { showToast(`Rehearsal failed: ${error.message}`, 'error'); }
}

// ---------- Export ----------
function buildReport() {
  const r = state.result; if (!r) return '';
  const lines = [];
  const now = new Date().toISOString();
  lines.push(`# Change request: ${r.scenario.title}`, '', `Generated by RehearseOps ${now}. **Status: proposal only. Nothing was executed.**`, '');
  lines.push(`- Engine: ${r.live ? `NVIDIA Nemotron via Nebius Token Factory (reasoning: \`${r.models?.reasoning}\`, fast: \`${r.models?.fast}\`)` : 'Scripted demo (no model)'}`);
  lines.push(`- Agent: ${r.stats.rounds} round(s), ${r.stats.proposals} proposals, ${r.stats.blocked} blocked by gate, ${r.plan.length} approved for simulation, ${r.stats.totalTokens || 0} tokens`, '');
  lines.push('## Summary', '', r.summary || '—', '');
  lines.push('## Hypotheses', '');
  for (const h of r.hypotheses) lines.push(`- **${h.title}** (${h.likelihood}) — ${h.explanation} Evidence: ${h.evidenceIds.join(', ') || '—'}`);
  lines.push('', '## Trusted facts used by the gate', '', '| Fact | Value | Source | Evidence |', '|---|---|---|---|');
  const facts = r.scenario.custom ? Object.fromEntries(Object.entries(state.operatorFacts).map(([k, v]) => [k, { value: v, source: 'operator', evidenceIds: state.candidates[k]?.evidenceIds ?? [] }])) : r.facts;
  for (const [k, f] of Object.entries(facts)) lines.push(`| ${k} | ${fmtValue(f.value)} | ${f.source} | ${(f.evidenceIds ?? []).join(', ')} |`);
  lines.push('', '## Proposed plan (approved for simulation only)', '');
  for (const p of r.plan) { lines.push(`### ${p.gate.title}`, '', `\`${p.gate.type} ${JSON.stringify(p.gate.params)}\``, '', p.rationale || '', ''); for (const c of p.gate.checks) lines.push(`- ${c.passed ? '✅' : c.severity === 'warning' ? '⚠️' : '❌'} ${c.label}: ${c.detail}`); lines.push(''); }
  if (r.rejected.length) { lines.push('## Rejected by the safety gate', ''); for (const p of r.rejected) lines.push(`- ${p.id} \`${p.type} ${JSON.stringify(p.params)}\` — ${p.gate.explanation.join('; ')}`); lines.push(''); }
  if (state.lastRehearsal) { const x = state.lastRehearsal.result; lines.push(`## Rehearsal: ${x.title}`, '', x.detail, ''); for (const m of x.metrics) lines.push(`- ${m.label}: ${m.value}`); lines.push('', '### Verification checklist', ''); for (const c of x.verificationChecklist) lines.push(`- [ ] ${c}`); lines.push(''); }
  if (r.sources.length) { lines.push('## Sources', ''); for (const s of r.sources) lines.push(`- ${s.id}: [${s.title}](${s.url})`); lines.push(''); }
  lines.push('## Evidence', ''); for (const e of r.evidence) lines.push(`- \`${e.id}\` ${e.time} ${e.service} [${e.level}] ${e.message}`);
  lines.push('', `> ${r.disclaimer}`);
  return lines.join('\n');
}
function exportReport() {
  const md = buildReport(); if (!md) return;
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `rehearseops-${(state.result.scenario.id || 'incident')}-${Date.now()}.md`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  showToast('Change request exported.');
}

// ---------- Validation ----------
function pill(status) { return `<span class="result-pill ${status === 'blocked' ? 'blocked' : 'approved'}">${status === 'blocked' ? 'Blocked' : 'Can rehearse'}</span>`; }
async function runBenchmark() {
  const button = $('#run-benchmark'); button.disabled = true; button.textContent = 'Running…';
  try {
    const { payload } = await api('/api/benchmark'); state.benchmark = payload;
    const a = payload.adversarial; const f = payload.fixtures;
    $('#benchmark-metrics').innerHTML = `
      <article class="metric-card"><div class="metric-top"><span class="metric-label">Unsafe proposals blocked</span><span class="metric-icon red">⊘</span></div><div class="metric-value">${a.unsafeBlocked}/${a.unsafeTotal}</div><div class="metric-foot">Adversarial &amp; boundary cases</div></article>
      <article class="metric-card"><div class="metric-top"><span class="metric-label">False approvals</span><span class="metric-icon violet">!</span></div><div class="metric-value">${a.falseApprovals}</div><div class="metric-foot">Unsafe case the gate let through</div></article>
      <article class="metric-card"><div class="metric-top"><span class="metric-label">Safe controls approved</span><span class="metric-icon green">✓</span></div><div class="metric-value">${a.safeApproved}/${a.safeTotal}</div><div class="metric-foot">Gate isn't just "deny all"</div></article>
      <article class="metric-card"><div class="metric-top"><span class="metric-label">Scenario fixtures</span><span class="metric-icon blue">⌁</span></div><div class="metric-value">${f.passed}/${f.total}</div><div class="metric-foot">Not a production accuracy metric</div></article>`;
    $('#adversarial-count').textContent = `${a.total} cases`;
    $('#adversarial-body').innerHTML = a.cases.map((c) => `<tr><td>${escapeHtml(c.name)}<small class="case-reason">${escapeHtml(c.reason)}</small></td><td>${escapeHtml(c.oracle)}</td><td>${pill(c.expected)}</td><td>${pill(c.actual)}</td><td><span class="result-pill ${c.passed ? 'pass' : 'fail'}">${c.passed ? 'PASS' : 'FAIL'}</span></td></tr>`).join('');
    $('#benchmark-count').textContent = `${f.total} cases`;
    $('#benchmark-table-body').innerHTML = f.cases.map((c) => `<tr><td>${escapeHtml(c.scenarioTitle)}</td><td>${escapeHtml(c.actionTitle)}</td><td>${pill(c.expected)}</td><td>${pill(c.actual)}</td><td><span class="result-pill ${c.passed ? 'pass' : 'fail'}">${c.passed ? 'PASS' : 'FAIL'}</span></td></tr>`).join('');
    $('#benchmark-note').textContent = payload.disclaimer;
  } catch (error) { showToast(`Could not run suites: ${error.message}`, 'error'); }
  finally { button.disabled = false; button.textContent = 'Run the suites'; }
}
async function runInjection() {
  const button = $('#run-injection'); button.disabled = true; button.textContent = 'Running';
  $('#injection-result').innerHTML = '<span class="spinner"></span><span>Running the agent on poisoned logs. This makes 1–3 Nemotron calls…</span>';
  try {
    const { payload } = await api('/api/redteam/live', { method: 'POST', body: '{}' });
    const rows = payload.proposals.map((p) => `<tr><td><code>${escapeHtml(p.id)}</code></td><td><code>${escapeHtml(p.type)} ${escapeHtml(JSON.stringify(p.params))}</code></td><td>${pill(p.status)}</td><td>${escapeHtml(p.reason || '')}</td></tr>`).join('');
    $('#injection-result').innerHTML = `<div class="injection-summary"><div><span>Unsafe actions approved</span><strong class="${payload.unsafeApprovals ? 'bad' : 'good'}">${payload.unsafeApprovals}</strong></div><div><span>Proposals influenced by injection</span><strong>${payload.injectionInfluencedProposals}</strong></div><div><span>Blocked by gate</span><strong>${payload.blockedProposals}</strong></div><div><span>Model</span><strong>${escapeHtml(payload.models?.reasoning ?? '—')}</strong></div></div><div class="table-scroll"><table class="benchmark-table"><thead><tr><th>ID</th><th>Proposal</th><th>Gate</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted-small">Run at ${escapeHtml(payload.at)}. ${payload.modelError ? `Model error: ${escapeHtml(payload.modelError)}` : ''}</p>`;
  } catch (error) {
    $('#injection-result').innerHTML = `<span class="info-icon">i</span><span>${escapeHtml(error.message)}</span>`;
  } finally { button.disabled = false; button.textContent = 'Run live test'; }
}

// ---------- Integrations ----------
function fmtCall(call) { return call ? `${new Date(call.at).toLocaleTimeString()} · ${escapeHtml(call.model)} · ${(call.ms / 1000).toFixed(1)} s` : 'None yet'; }
async function loadHealth() {
  try {
    const { payload } = await api('/api/health'); state.health = payload;
    const live = payload.nebiusConfigured;
    $('#sidebar-mode').textContent = payload.lastLiveCall ? 'Live call verified' : live ? 'Model configured' : 'Scripted demo';
    $('#sidebar-provider').textContent = live ? payload.models.reasoning : 'No NEBIUS_API_KEY';
    $('#nebius-status-pill').textContent = payload.lastLiveCall ? 'Verified live' : live ? 'Key set, not verified' : 'Not set up';
    $('#nebius-status-pill').className = `connection-state ${payload.lastLiveCall ? 'connected' : ''}`;
    $('#nebius-model-reasoning').textContent = live ? `${payload.models.reasoning}${payload.models.autoResolved?.reasoning ? ' (auto-resolved)' : ''}` : 'Not configured';
    $('#nebius-model-fast').textContent = live ? `${payload.models.fast}${payload.models.autoResolved?.fast ? ' (auto-resolved)' : ''}` : 'Not configured';
    $('#nebius-last-call').innerHTML = fmtCall(payload.lastLiveCall);
    $('#tavily-status-pill').textContent = payload.tavilyConfigured ? 'Connected' : 'Optional';
    $('#tavily-status-pill').className = `connection-state ${payload.tavilyConfigured ? 'connected' : ''}`;
    $('#tavily-key-status').textContent = payload.tavilyConfigured ? 'Present · server-side' : 'Not configured';
    $('#integrations-action-count').textContent = `${payload.actionTypes} typed actions`;
    $('#run-probe').disabled = !live; $('#list-models').disabled = !live; $('#run-injection').disabled = !live;
    return payload;
  } catch (error) { showNotice(`Backend status could not be read: ${error.message}. Start the Node server.`, 'error'); return null; }
}
async function runProbe() {
  const box = $('#probe-result'); box.classList.remove('hidden'); box.innerHTML = '<span class="spinner"></span> Calling each tier…';
  try {
    const { payload } = await api('/api/probe', { method: 'POST', body: '{}' });
    box.innerHTML = ['fast', 'reasoning'].map((tier) => { const t = payload[tier]; return `<div class="probe-row ${t.ok ? 'ok' : 'bad'}"><strong>${tier === 'fast' ? 'Fast tier' : 'Reasoning tier'}</strong><span>${t.ok ? '✓' : '×'} ${escapeHtml(t.model)}${t.autoResolved ? ` <em>(configured ${escapeHtml(t.configuredModel)} not found; auto-resolved)</em>` : ''}</span><span>${(t.ms / 1000).toFixed(2)} s${t.tokens ? ` · ${t.tokens} tok` : ''}</span>${t.error ? `<small>${escapeHtml(t.error)}</small>` : ''}</div>`; }).join('') + `<small class="muted-small">Probed at ${escapeHtml(payload.at)}</small>`;
    await loadHealth();
  } catch (error) { box.innerHTML = `<div class="probe-row bad">${escapeHtml(error.message)}</div>`; }
}
async function listModels() {
  const box = $('#probe-result'); box.classList.remove('hidden'); box.innerHTML = '<span class="spinner"></span> Reading your Token Factory catalog…';
  try {
    const { payload } = await api('/api/models');
    box.innerHTML = `<div class="probe-row ok"><strong>Catalog</strong><span>${payload.nemotron.length} NVIDIA/Nemotron of ${payload.totalModels} models</span></div><ul class="model-list">${payload.nemotron.map((id) => `<li><code>${escapeHtml(id)}</code>${id === payload.configured.reasoning ? ' ← reasoning' : ''}${id === payload.configured.fast ? ' ← fast' : ''}</li>`).join('')}</ul>`;
  } catch (error) { box.innerHTML = `<div class="probe-row bad">${escapeHtml(error.message)}</div>`; }
}

// ---------- Docs search ----------
async function searchDocs(event) {
  event.preventDefault();
  const query = $('#docs-query').value.trim() || `${state.scenario?.title ?? 'software incident'} recovery official documentation`;
  const button = $('#docs-search-button'); button.disabled = true; button.textContent = 'Searching…';
  try {
    const { payload } = await api('/api/search', { method: 'POST', body: JSON.stringify({ query }) });
    if (!payload.ok) throw new Error(payload.error || 'Tavily search failed.');
    $('#docs-results').innerHTML = payload.results.map((r) => { const url = safeHttpUrl(r.url); return `<article class="doc-result"><span class="doc-score">Relevance ${(Number(r.score || 0) * 100).toFixed(0)}%</span><h4>${escapeHtml(r.title)}</h4><p>${escapeHtml(r.content)}</p>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>` : ''}</article>`; }).join('') || '<p class="event-message">No results.</p>';
    $('#docs-results').classList.remove('hidden'); $('#docs-empty').classList.add('hidden');
  } catch (error) {
    $('#docs-empty').innerHTML = `<span class="info-icon">i</span><span>${escapeHtml(error.message)}</span>`; $('#docs-empty').classList.remove('hidden');
  } finally { button.disabled = false; button.textContent = 'Search'; }
}

// ---------- Navigation ----------
function setView(name) {
  state.activeView = name;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.nav-item').forEach((i) => i.classList.toggle('active', i.dataset.view === name));
  $('#crumb-current').textContent = name === 'incident' ? 'Incident room' : name === 'benchmark' ? 'Red-team lab' : 'Integrations';
  if (name === 'benchmark' && !state.benchmark) runBenchmark();
  if (name === 'integrations') loadHealth();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function jumpToEvidence(id) {
  const target = $(`#timeline-${CSS.escape(id)}`); const row = $(`.evidence-row[data-evidence="${CSS.escape(id)}"]`);
  if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.classList.add('evidence-focus'); setTimeout(() => target.classList.remove('evidence-focus'), 1400); }
  if (row) { row.classList.add('active'); setTimeout(() => row.classList.remove('active'), 1400); }
}
async function selectScenario(id, run = false) {
  if (!id) return;
  try { const { payload } = await api(`/api/scenarios/${encodeURIComponent(id)}`); state.scenario = payload.scenario; $('#scenario-select').value = id; renderScenario(); if (run) await runAgent(); }
  catch (error) { showNotice(error.message, 'error'); }
}

function bindEvents() {
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#scenario-select').addEventListener('change', (e) => selectScenario(e.target.value, false));
  $('#analyze-button').addEventListener('click', runAgent);
  $('#raw-logs').addEventListener('input', () => { updateLogCount(); });
  $('#restore-sample').addEventListener('click', () => { $('#raw-logs').value = state.scenario.rawLogs; updateLogCount(); state.operatorFacts = {}; renderFacts({}, {}, [], false); showToast('Restored the scenario sample logs.'); });
  $('#load-example').addEventListener('click', () => { $('#raw-logs').value = EXAMPLE_CUSTOM_LOGS; updateLogCount(); state.operatorFacts = {}; renderFacts({}, {}, [], true); showToast('Loaded example custom logs. Run the agent: facts start untrusted.'); });
  $('#log-upload').addEventListener('change', async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    if (file.size > 200_000) { showToast('Choose a text log file under 200 KB.', 'error'); e.target.value = ''; return; }
    try { $('#raw-logs').value = await file.text(); updateLogCount(); state.operatorFacts = {}; $('#log-input-details').open = true; showToast(`Loaded ${file.name}.`); } catch { showToast('Could not read that file.', 'error'); }
    e.target.value = '';
  });
  $('#scenario-nav').addEventListener('click', (e) => { const b = e.target.closest('[data-scenario]'); if (b) selectScenario(b.dataset.scenario, false); });
  $('#facts-body').addEventListener('change', (e) => {
    const box = e.target.closest('[data-fact]'); if (!box || !isCustom()) return;
    const key = box.dataset.fact;
    if (box.checked) { const cand = state.candidates[key]; if (cand) state.operatorFacts[key] = cand.value; }
    else delete state.operatorFacts[key];
    renderFacts(state.facts, state.candidates, [], true);
  });
  $('#add-fact-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const key = $('#add-fact-key').value; const raw = $('#add-fact-value').value.trim();
    if (!key || !raw) return showToast('Choose a fact and enter a value.', 'error');
    const spec = state.grammar?.facts?.[key];
    let value = raw;
    if (spec?.type === 'int' || spec?.type === 'number') value = Number(raw);
    else if (spec?.type === 'bool') value = raw.toLowerCase() === 'true';
    else if (spec?.type === 'list') value = raw.split(',').map((x) => x.trim()).filter(Boolean);
    state.operatorFacts[key] = value; $('#add-fact-value').value = '';
    renderFacts(state.facts, state.candidates, [], true);
    showToast(`Operator fact ${key} added. Re-run the agent to use it.`);
  });
  $('#rerun-with-facts').addEventListener('click', runAgent);
  document.addEventListener('click', (e) => {
    const r = e.target.closest('[data-rehearse]'); if (r) rehearse(Number(r.dataset.rehearse));
    const ev = e.target.closest('[data-evidence]'); if (ev) jumpToEvidence(ev.dataset.evidence);
  });
  document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-evidence]')) { e.preventDefault(); jumpToEvidence(e.target.dataset.evidence); } });
  $('#export-report').addEventListener('click', exportReport);
  $('#docs-search-form').addEventListener('submit', searchDocs);
  $('#run-benchmark').addEventListener('click', runBenchmark);
  $('#run-injection').addEventListener('click', runInjection);
  $('#run-probe').addEventListener('click', runProbe);
  $('#list-models').addEventListener('click', listModels);
  $('#refresh-health').addEventListener('click', async () => { await loadHealth(); showToast('Status refreshed.'); });
  const modal = $('#about-modal');
  $('#help-button').addEventListener('click', () => modal.classList.remove('hidden'));
  $('#close-about').addEventListener('click', () => modal.classList.add('hidden'));
  $('#close-about-bottom').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.classList.add('hidden'); });
}

async function init() {
  bindEvents();
  const health = await loadHealth();
  try {
    const { payload } = await api('/api/grammar'); state.grammar = payload;
    $('#add-fact-key').innerHTML = Object.entries(payload.facts).map(([k, f]) => `<option value="${escapeHtml(k)}">${escapeHtml(f.label)} (${escapeHtml(k)})</option>`).join('');
    const { payload: list } = await api('/api/scenarios'); state.scenarios = list.scenarios; renderScenarioNav();
    await selectScenario(state.scenarios[0]?.id, false);
    if (!health?.nebiusConfigured) showNotice('Scripted demo mode: no NEBIUS_API_KEY is set, so proposals come from a fixed script, not a model. Add a key to run the real Nemotron agent.');
  } catch (error) { showNotice(`Could not initialize: ${error.message}`, 'error'); }
}
document.addEventListener('DOMContentLoaded', init);
