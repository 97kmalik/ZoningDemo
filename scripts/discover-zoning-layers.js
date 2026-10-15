#!/usr/bin/env node
// Sweeps ArcGIS Online for every NJ municipality's public zoning layer and writes
// data/nj-zoning-layers.json. A layer is kept only if a point inside the town
// returns a feature with a recognizable zone field.
//
//   node scripts/discover-zoning-layers.js            # all 564 municipalities
//   node scripts/discover-zoning-layers.js 0712 2012  # specific municipal codes
const fs = require('fs');
const path = require('path');
const { searchCandidates, layersOf, queryLayer, pointGeom } = require('../lib/nj-zoning');
const { arcgisQuery, pool } = require('../lib/http');

const MUNIS = require('../data/nj-municipalities.json');
const LINKS = require('../data/nj-zoning-links.json').municipalities;
const { getJSON } = require('../lib/http');

// The DCA list links some towns' official zoning map to an ArcGIS web app.
// Unpack app -> web map -> operational layers whose title mentions zoning.
async function officialLayers(link) {
  if (!link || !/arcgis\.com/i.test(link)) return [];
  const id = (link.match(/(?:[?&](?:id|appid|webmap)=|experience\/|item\.html\?id=)([0-9a-f]{32})/i) || [])[1];
  if (!id) return [];
  const host = 'https://www.arcgis.com';
  const item = await getJSON(`${host}/sharing/rest/content/items/${id}?f=json`).catch(() => null);
  if (!item) return [];
  let webmaps = [];
  if (item.type === 'Web Map') webmaps = [id];
  else {
    const data = await getJSON(`${host}/sharing/rest/content/items/${id}/data?f=json`).catch(() => ({}));
    const txt = JSON.stringify(data);
    webmaps = [data?.map?.itemId, data?.values?.webmap, ...(txt.match(/"itemId":"([0-9a-f]{32})"/g) || []).map((m) => m.slice(10, 42))].filter(Boolean);
  }
  const out = [];
  for (const wm of [...new Set(webmaps)].slice(0, 4)) {
    const d = await getJSON(`${host}/sharing/rest/content/items/${wm}/data?f=json`).catch(() => null);
    const walk = (ls) => (ls || []).forEach((l) => {
      if (l.url && /zon/i.test(`${l.title} ${l.url}`) && !/overlay|historic|flood/i.test(l.title || '')) out.push({ title: l.title, url: l.url.replace(/\/$/, ''), owner: item.owner });
      walk(l.layers);
    });
    walk(d?.operationalLayers);
  }
  return out;
}
const OUT = path.join(__dirname, '..', 'data', 'nj-zoning-layers.json');
const MUNI_LAYER = 'https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/NJ_Municipalities_3857/FeatureServer/0';

// A few sample points spread across the town, so a centroid on a road or park still finds a zone.
async function samplePoints(m) {
  const pts = [[m.lat, m.lng]];
  try {
    const j = await arcgisQuery(MUNI_LAYER, { where: `SSN='${m.code}'`, returnGeometry: 'true', outSR: '4326', outFields: 'SSN', maxAllowableOffset: '0.002' });
    const ring = j.features?.[0]?.geometry?.rings?.[0] || [];
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    if (xs.length) {
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      for (const [fx, fy] of [[0.35, 0.35], [0.65, 0.65], [0.35, 0.65], [0.65, 0.35]]) pts.push([y0 + (y1 - y0) * fy, x0 + (x1 - x0) * fx]);
    }
  } catch (_) {}
  return pts;
}

async function discover(m) {
  const official = (await officialLayers(LINKS[m.code]?.zoningMap).catch(() => [])).map((c) => ({ ...c, named: true, official: true }));
  const cands = official.concat(await searchCandidates(m.name, m.county).catch(() => []));
  if (!cands.length) return null;
  const pts = await samplePoints(m);
  const found = [];
  for (const c of cands.slice(0, 8)) {
    let urls = [];
    try { urls = await layersOf(c.url); } catch (_) { continue; }
    for (const url of urls) {
      let hits = 0, sample = null, fields = null;
      for (const [lat, lng] of pts) {
        try { const h = await queryLayer(url, pointGeom(lat, lng)); if (h) { hits++; sample = sample || h.district; fields = fields || h; } } catch (_) { break; }
      }
      // Require at least two of the sample points inside the town to resolve, so a
      // neighbouring town's layer that clips one corner isn't mistaken for this one.
      if (hits >= 2 || (hits === 1 && c.named)) {
        found.push({ title: c.title, owner: c.owner, url, official: !!c.official, zoneField: fields.zoneField, descField: fields.descField, sampleZone: sample, pointsMatched: `${hits}/${pts.length}`, named: c.named, modified: c.modified ? new Date(c.modified).toISOString().slice(0, 10) : null });
        break;
      }
    }
    if (found.length >= 2) break;
  }
  return found.length ? { name: m.name, county: m.county, layers: found, checkedAt: new Date().toISOString().slice(0, 10) } : null;
}

(async () => {
  const only = process.argv.slice(2);
  const list = only.length ? MUNIS.filter((m) => only.includes(m.code)) : MUNIS;
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')).municipalities || {}; } catch (_) {}
  let done = 0;
  const results = await pool(list, 8, async (m) => {
    const r = await discover(m).catch(() => null);
    done++;
    if (r) process.stdout.write(`\n${m.code} ${m.name}: ${r.layers[0].title} [${r.layers[0].sampleZone}]`);
    else if (done % 25 === 0) process.stdout.write(`\n…${done}/${list.length}`);
    return [m.code, r];
  });
  const municipalities = only.length ? existing : {};
  for (const [code, r] of results) { if (r) municipalities[code] = r; else if (only.length) delete municipalities[code]; }
  const sorted = Object.fromEntries(Object.entries(municipalities).sort());
  fs.writeFileSync(OUT, JSON.stringify({
    description: 'NJ municipalities with a public, queryable zoning map layer on ArcGIS Online. Generated by scripts/discover-zoning-layers.js. Layers published by consultants or third parties should be confirmed against the official zoning map.',
    generatedAt: new Date().toISOString(), coverage: `${Object.keys(sorted).length} of ${MUNIS.length} municipalities`, municipalities: sorted
  }, null, 1));
  console.log(`\n\nWrote ${OUT}: ${Object.keys(sorted).length} of ${MUNIS.length} municipalities have a zoning layer.`);
})();
