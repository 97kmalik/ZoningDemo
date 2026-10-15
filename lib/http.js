// Small HTTP helpers shared by every data module. Node 18+ (global fetch).
// Runs in Node (server, scripts) and in the browser (GitHub Pages build). Browsers set their own
// User-Agent, and a custom one would trigger a CORS preflight.
const IS_BROWSER = typeof window !== 'undefined';
const UA = IS_BROWSER ? {} : { 'User-Agent': 'nj-zoning-envelope/1.0 (zoning research tool)' };

async function getJSON(url, { timeout = 20000, headers = {} } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { ...UA, ...headers }, signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timed out reaching ${new URL(url).host}`);
    throw e;
  } finally { clearTimeout(t); }
}

// ArcGIS REST query. Uses POST so long polygon geometries fit.
async function arcgisQuery(layerUrl, params, { timeout = 40000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const body = new URLSearchParams({ f: 'json', returnGeometry: 'false', outFields: '*', ...params });
    // Browsers: use GET when the query fits in a URL, since some servers (FEMA) answer GET but
    // not POST across origins. Long polygon geometries still go by POST.
    const qs = body.toString();
    const res = IS_BROWSER && qs.length < 1800
      ? await fetch(`${layerUrl}/query?${qs}`, { signal: ctl.signal })
      : await fetch(`${layerUrl}/query`, { method: 'POST', body, headers: { ...UA, 'content-type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} from ${new URL(layerUrl).host}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || 'ArcGIS query error');
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timed out reaching ${new URL(layerUrl).host}`);
    throw e;
  } finally { clearTimeout(t); }
}

// Wrap an async function so failures come back as { error } instead of throwing.
const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { return { error: e.message }; } };
const esc = (s) => String(s).replace(/'/g, "''");

// Run tasks with limited concurrency.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

module.exports = { getJSON, arcgisQuery, safe, esc, pool, IS_BROWSER };
