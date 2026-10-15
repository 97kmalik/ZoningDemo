// NJ Zoning Envelope server. No dependencies; Node 18+.
//   ANTHROPIC_API_KEY  required for ordinance research and ordinance-text parsing
//   ZONING_MODEL       optional, default claude-sonnet-5-5
//   PORT               default 8080
const http = require('http');
const fs = require('fs');
const path = require('path');
const { lookup } = require('./lib/pipeline');
const { research, parseOrdinance } = require('./lib/research');
const { researchContext } = require('./lib/research-context');

loadDotEnv();
const env = process.env;
const PUBLIC = path.join(__dirname, 'public');
const CACHE_FILE = path.join(__dirname, '.cache', 'research-cache.json');
const MUNIS = require('./data/nj-municipalities.json');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) {}
const saveCache = () => { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/health') {
      return json(res, { ok: true, mode: 'server', state: 'NJ', research: !!env.ANTHROPIC_API_KEY, model: env.ZONING_MODEL || 'claude-sonnet-5-5' });
    }
    if (url.pathname === '/api/municipalities') {
      return json(res, MUNIS.map((m) => ({ code: m.code, name: m.name, county: m.county })));
    }
    if (url.pathname === '/api/lookup' && req.method === 'POST') {
      const body = await readBody(req);
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      const send = (o) => res.write(JSON.stringify(o) + '\n');
      try { send({ result: await lookup(body, { onProgress: (p) => send({ progress: p }) }) }); }
      catch (e) { send({ error: e.message }); }
      return res.end();
    }
    if (url.pathname === '/api/research' && req.method === 'POST') {
      const body = await readBody(req, 1e6);
      const key = cacheKey(body);
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      const send = (o) => res.write(JSON.stringify(o) + '\n');
      if (!body.refresh && key && cache[key] && Date.now() - cache[key].t < 30 * 864e5) {
        send({ progress: `Using research from ${new Date(cache[key].t).toLocaleDateString()}` });
        send({ result: cache[key].rules, cached: true });
        return res.end();
      }
      try {
        const rules = await research(env, { property: body.property, district: body.district, extra: researchContext(body) }, (p) => send({ progress: p }));
        if (key) { cache[key] = { t: Date.now(), rules }; saveCache(); }
        send({ result: rules });
      } catch (e) { send({ error: e.message }); }
      return res.end();
    }
    if (url.pathname === '/api/parse' && req.method === 'POST') {
      const body = await readBody(req, 2e6);
      return json(res, { result: await parseOrdinance(env, body.text || '', body) });
    }
    return serveStatic(url.pathname, res);
  } catch (e) {
    return json(res, { error: e.message }, 500);
  }
});

function cacheKey(b) {
  const p = b.property || {};
  if (!p.municipalityCode || !b.district) return null;
  return [p.municipalityCode, b.district].map((s) => String(s || '').toUpperCase().trim()).join('|');
}
function json(res, o, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); }
function readBody(req, limit = 2e5) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > limit) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Error('Invalid JSON')); } });
  });
}
function serveStatic(p, res) {
  if (p === '/' || p === '/index.html') {
    // workbench.html is a page fragment (it doubles as a published Claude artifact); wrap it here.
    return fs.readFile(path.join(PUBLIC, 'workbench.html'), 'utf8', (err, html) => {
      if (err) { res.writeHead(500); return res.end('workbench.html missing'); }
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>[hidden]{display:none!important}body{margin:0}</style></head><body>${html}</body></html>`);
    });
  }
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}
function loadDotEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
}

if (require.main === module) {
  const port = +env.PORT || 8080;
  server.listen(port, () => console.log(`NJ Zoning Envelope at http://localhost:${port}  (ordinance research: ${env.ANTHROPIC_API_KEY ? 'on' : 'off, set ANTHROPIC_API_KEY'})`));
}
module.exports = { server, researchContext };
