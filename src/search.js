export function hasTavilyConfig(env = process.env) {
  return Boolean(env.TAVILY_API_KEY?.trim());
}

export async function searchDocumentation(query, env = process.env, { maxResults = 5 } = {}) {
  const apiKey = env.TAVILY_API_KEY?.trim();
  if (!apiKey) return { configured: false, ok: false, error: 'TAVILY_API_KEY is not configured.' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ query: String(query).slice(0, 500), search_depth: 'basic', max_results: Math.max(1, Math.min(8, maxResults)), include_answer: false, include_raw_content: false, topic: 'general' })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { configured: true, ok: false, error: body?.detail?.error || body?.message || `Tavily returned HTTP ${response.status}.` };
    return {
      configured: true,
      ok: true,
      query,
      results: (body.results ?? []).slice(0, 8).map((result) => ({ title: result.title, url: result.url, content: String(result.content ?? '').slice(0, 700), score: result.score, publishedDate: result.published_date ?? null })),
      responseTime: body.response_time ?? null,
      credits: body.usage?.credits ?? null
    };
  } catch (error) {
    return { configured: true, ok: false, error: error.name === 'AbortError' ? 'Tavily request timed out.' : (error.message || 'Network error calling Tavily.') };
  } finally {
    clearTimeout(timeout);
  }
}
