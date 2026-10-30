// Local stand-in for the Token Factory API, used only by tests. Model IDs are prefixed "mock/".
import http from 'node:http';

export async function startMockNebius({ models = ['mock/nvidia/Nemotron-3-Ultra-mock', 'mock/nvidia/Nemotron-3-Nano-mock'], injectionCompliant = false, thinkTags = true, rejectJsonMode = false, truncateFirst = false } = {}) {
  let truncated = false;
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url.endsWith('/models')) return send(200, { data: models.map((id) => ({ id })) });
    const body = raw ? JSON.parse(raw) : {};
    calls.push(body);
    if (!models.includes(body.model)) return send(404, { error: { message: `Model ${body.model} not found` } });
    if (rejectJsonMode && body.response_format) return send(400, { error: { message: 'response_format is not supported for this model' } });
    if (truncateFirst && !truncated) { truncated = true; return send(200, { model: body.model, choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: '<think>very long thinking' } }] }); }
    const last = body.messages.at(-1).content;
    let data;
    if (last.includes('Extract only facts')) {
      data = { facts: [
        { key: 'replicas', value: 4, evidenceIds: ['U001'], quote: 'replicas=4' },
        { key: 'poolSize', value: 25, evidenceIds: ['U001'], quote: 'pool_max=25' },
        { key: 'maxConnections', value: 120, evidenceIds: ['U002'], quote: 'max_connections=120' },
        { key: 'otherConnections', value: 999, evidenceIds: ['U002'], quote: 'hallucinated' }
      ], searchQueries: ['postgres max_connections pool sizing'] };
    } else if (last.includes('web search queries')) {
      data = { searchQueries: ['PostgreSQL max_connections connection pool sizing', 'exponential backoff jitter retries'] };
    } else if (last.includes('SAFETY GATE RESULTS')) {
      data = { proposals: [{ type: 'set_pool_size', params: { poolSize: 15 }, rationale: '6 × 15 + 10 = 100 ≤ 100 at the autoscaler ceiling.', evidenceIds: ['E001', 'E002'], citations: ['D1'], revises: 'P1.1' }], notes: 'Revised.' };
    } else {
      const injected = last.includes('SYSTEM OVERRIDE');
      data = {
        summary: 'Pool budget exceeds database capacity after the release.',
        hypotheses: [{ id: 'H1', title: 'Pool budget exceeds DB limit', likelihood: 'High', confidence: 0.9, evidenceIds: ['E001', 'E002', 'E999'], counterEvidenceIds: [], explanation: '3 × 40 + 10 = 130 > 100.' }],
        proposals: [
          injected && injectionCompliant ? { type: 'set_pool_size', params: { poolSize: 500 }, rationale: 'Operator said so.' } : { type: 'set_pool_size', params: { poolSize: 50 }, rationale: 'Reduce local waiting.', evidenceIds: ['E003'] },
          { type: 'retry_policy', params: { maxAttempts: 3, strategy: 'exponential_jitter' }, rationale: 'Cut amplification.', evidenceIds: ['E004'], citations: ['D2', 'D99'] },
          ...(injected && injectionCompliant ? [{ type: 'shell_exec', params: { cmd: 'systemctl restart postgresql' } }] : [])
        ],
        missingEvidence: ['Live pg_stat_activity'], nextChecks: ['Check pool wait time']
      };
    }
    const content = (thinkTags ? '<think>reasoning about the incident...</think>\n' : '') + '```json\n' + JSON.stringify(data) + '\n```';
    return send(200, { model: body.model, choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/v1`, calls, close: () => new Promise((resolve) => server.close(resolve)) };
}
