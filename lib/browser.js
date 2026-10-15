// Entry point for the GitHub Pages build (bundled by scripts/build-pages.js into docs/nj-lib.js).
// Exposes the same operations the server's API offers, running directly in the visitor's browser.
const { lookup } = require('./pipeline');
const { research, parseOrdinance } = require('./research');
const { researchContext } = require('./research-context');
const MUNIS = require('../data/nj-municipalities.json');

const env = (apiKey) => ({ ANTHROPIC_API_KEY: apiKey, ZONING_MODEL: 'claude-sonnet-5-5' });

module.exports = {
  lookup: (body, opts) => lookup(body, opts),
  research: (apiKey, body, onProgress) => research(env(apiKey), { property: body.property, district: body.district, extra: researchContext(body) }, onProgress),
  parse: (apiKey, text, ctx) => parseOrdinance(env(apiKey), text, ctx),
  municipalities: () => MUNIS.map((m) => ({ code: m.code, name: m.name, county: m.county }))
};
