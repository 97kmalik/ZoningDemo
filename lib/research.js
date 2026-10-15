// Ordinance research with the Claude API (server-side web search + web fetch).
const { researchPrompt, parsePrompt } = require('../public/rules-schema');
const { IS_BROWSER } = require('./http');

const API = 'https://api.anthropic.com/v1/messages';

async function callClaude(env, messages, { tools, maxTokens = 16000 } = {}) {
  const body = { model: env.ZONING_MODEL || 'claude-sonnet-5-5', max_tokens: maxTokens, messages };
  if (tools) body.tools = tools;
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01',
      // In the GitHub Pages build each visitor supplies their own key, kept in their own browser.
      ...(IS_BROWSER ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}) },
    body: JSON.stringify(body)
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message || `Claude API ${res.status}`);
  return j;
}

function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const cand = fence ? fence[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(cand);
}

// Agentic loop: Claude searches and reads ordinances; server tools run on Anthropic's side.
async function research(env, ctx, onProgress = () => {}) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY to enable ordinance research.');
  const tools = [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 12,
      user_location: ctx.property?.state ? { type: 'approximate', region: ctx.property.state, country: 'US' } : undefined },
    { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 15, max_content_tokens: 60000 }
  ];
  tools.forEach((t) => Object.keys(t).forEach((k) => t[k] === undefined && delete t[k]));

  let messages = [{ role: 'user', content: researchPrompt(ctx) }];
  const visited = [];
  for (let turn = 0; turn < 8; turn++) {
    const r = await callClaude(env, messages, { tools });
    for (const b of r.content) {
      if (b.type === 'server_tool_use') {
        const what = b.name === 'web_search' ? `Searching: ${b.input?.query}` : `Reading: ${b.input?.url}`;
        onProgress(what);
        if (b.name === 'web_fetch' && b.input?.url) visited.push(b.input.url);
      }
    }
    if (r.stop_reason === 'pause_turn') {
      // Long server-tool run: hand the partial turn back so Claude continues.
      messages = [...messages, { role: 'assistant', content: r.content }];
      continue;
    }
    const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    try {
      const rules = extractJSON(text);
      rules.researchedAt = new Date().toISOString();
      rules.pagesRead = visited;
      return rules;
    } catch (e) {
      // Ask once for clean JSON.
      messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: 'Return only the JSON object, no prose.' }];
    }
  }
  throw new Error('Research did not return usable JSON. Try again or paste the ordinance text instead.');
}

async function parseOrdinance(env, text, ctx) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY to enable ordinance parsing.');
  const r = await callClaude(env, [{ role: 'user', content: parsePrompt(text.slice(0, 180000), ctx) }], { maxTokens: 8000 });
  return extractJSON(r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
}

module.exports = { research, parseOrdinance, extractJSON };
