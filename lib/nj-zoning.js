// Zoning district lookup from municipal GIS layers.
// 1. data/nj-zoning-layers.json: layers verified by scripts/discover-zoning-layers.js
// 2. Live ArcGIS Online search for the town (catches layers published since the last sweep)
const { getJSON, arcgisQuery, safe } = require('./http');

let registry = {};
try { registry = require('../data/nj-zoning-layers.json').municipalities || {}; } catch (_) {}

const ZONE_FIELD = /^(zone|zoning|zones|zone_?code|zoning_?code|zone_?dist|zonedist\d?|zoning_?dist(rict)?|district|zone_?class|zone_?name|zone_?type|zon_?code|zoning_?class|zone_?abbr|base_?zone|zone_?id|zoning_?zone|zone_?label|zonelabel|zoning_?lab(el)?)$/i;
const DESC_FIELD = /(desc|label|name|title|full|long)/i;
const TITLE_ZONING = /(zoning|zones?(?:\b|\d|_)|zone ?dist)/i;
const TITLE_OK = /zoning|zone[ _]?dist|zones?\b(?!.*(flood|opportunit|time|climate|state plane|frequency|enterprise|innovation|karst|school|traffic|parking|snow|evac|fire|police|ward|census|wind|safety|hazard))/i;
const TITLE_NOISE = /collection|recycl|garbage|leaf|review|case|inspect|navigat|health|school|evac|snow|wind|opportunit|sales|permit|trash|sanitation|police|fire|election|ward|census|flood|time zone|climate|state plane|enterprise|innovation|karst|parking|traffic|historic|sewer|water|noise|airport|change|proposed|amendment|application|variance/i;

function baseName(name) { return String(name || '').replace(/\b(township|twp|borough|boro|city|town|village|of|the)\b/gi, '').replace(/\s+/g, ' ').trim(); }

// Prefer explicit zone fields over generic ones like "District" (often a municipal code).
const ZONE_PRIORITY = [/^zone_?$/i, /^zoning$/i, /^zone_?(code|abbr|id|label)$/i, /^zoning_?(code|zone|lab(el)?|dist(rict)?)$/i, /^zone_?(dist|name|class|type)$/i, /^zonedist\d?$/i, /^(zones|zon_?code|base_?zone|zonelabel|zoning_?class)$/i, /^district$/i];
function pickFields(attrs) {
  const keys = Object.keys(attrs || {});
  const ok = (k) => attrs[k] !== null && attrs[k] !== '' && String(attrs[k]).length <= 25 && /[A-Za-z]/.test(String(attrs[k]));
  let zoneField;
  for (const re of ZONE_PRIORITY) { zoneField = keys.find((k) => re.test(k) && ok(k)); if (zoneField) break; }
  const descField = keys.find((k) => k !== zoneField && DESC_FIELD.test(k) && typeof attrs[k] === 'string' && attrs[k].length > 3 && !/shape|globalid/i.test(k));
  return { zoneField, descField };
}

// Query one layer at a point (or polygon); returns the zone record or null.
async function queryLayer(layerUrl, geom, fields) {
  const j = await arcgisQuery(layerUrl, { ...geom, outFields: '*' });
  const feats = j.features || [];
  if (!feats.length) return null;
  const f = fields?.zoneField ? fields : pickFields(feats[0].attributes);
  if (!f.zoneField) return null;
  // Split lots: report every district touching the parcel, largest first when areas exist.
  const districts = [...new Set(feats.map((x) => String(x.attributes[f.zoneField] ?? '').trim()).filter((v) => v && /[A-Za-z]/.test(v)))];
  if (!districts.length) return null;
  const a = feats[0].attributes;
  return { district: districts[0], allDistricts: districts, description: f.descField ? a[f.descField] : null, zoneField: f.zoneField, descField: f.descField || null };
}

function pointGeom(lat, lng) { return { geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' }; }
function polygonGeom(ring) { return { geometry: JSON.stringify({ rings: [ring], spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryPolygon', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' }; }

// Search ArcGIS Online for candidate zoning layers for a town.
async function searchCandidates(townName, county) {
  const base = baseName(townName);
  const qs = [`zoning "${base}" type:"Feature Service"`, `"${base}" zoning districts`, `"${base}" zoning map`];
  if (county) qs.push(`"${county} County" zoning type:"Feature Service"`);
  const seen = new Set(), out = [];
  for (const q of qs) {
    const r = await getJSON(`https://www.arcgis.com/sharing/rest/search?q=${encodeURIComponent(q)}&num=20&f=json`).catch(() => ({}));
    for (const x of r.results || []) {
      if (!x.url || !/FeatureServer|MapServer/i.test(x.url) || seen.has(x.url)) continue;
      if (!TITLE_ZONING.test(x.title.replace(/_/g, ' ')) || TITLE_NOISE.test(x.title)) continue;
      seen.add(x.url); out.push({ title: x.title, owner: x.owner, url: x.url.replace(/\/$/, ''), modified: x.modified, named: new RegExp(base.split(' ')[0], 'i').test(`${x.title} ${x.owner} ${x.snippet || ''} ${(x.tags || []).join(' ')}`) });
    }
  }
  out.sort((a, b) => (b.named ? 1 : 0) - (a.named ? 1 : 0));
  return out;
}

// Resolve a candidate service into concrete layer URLs worth querying.
async function layersOf(serviceUrl) {
  if (/\/(FeatureServer|MapServer)\/\d+$/.test(serviceUrl)) return [serviceUrl];
  const svc = await getJSON(`${serviceUrl}?f=json`, { timeout: 12000 });
  const layers = (svc.layers || []).filter((l) => !l.subLayerIds && (!l.geometryType || /Polygon/.test(l.geometryType)));
  const ranked = layers.filter((l) => /zon/i.test(l.name)).concat(layers.filter((l) => !/zon/i.test(l.name)));
  return ranked.slice(0, 3).map((l) => `${serviceUrl}/${l.id}`);
}

// Main lookup. `parcel` may carry a ring (lng/lat pairs) for a polygon query.
const lookupZoning = safe(async ({ lat, lng, ring, municipalityCode, municipalityName, county }) => {
  const geom = ring ? polygonGeom(ring) : pointGeom(lat, lng);
  const known = municipalityCode && registry[municipalityCode];
  if (known) {
    for (const L of known.layers) {
      try {
        const hit = await queryLayer(L.url, geom, L);
        if (hit) return { ...hit, layer: L.title, owner: L.owner, url: L.url, source: 'registry', verifiedAt: known.checkedAt };
      } catch (_) { /* layer moved or down: fall through to live search */ }
    }
  }
  const cands = await searchCandidates(municipalityName, county);
  for (const c of cands.slice(0, 6)) {
    try {
      for (const url of await layersOf(c.url)) {
        const hit = await queryLayer(url, pointGeom(lat, lng));
        if (hit) return { ...hit, layer: c.title, owner: c.owner, url, source: 'search' };
      }
    } catch (_) {}
  }
  return null;
});

module.exports = { TITLE_ZONING, lookupZoning, searchCandidates, layersOf, queryLayer, pointGeom, polygonGeom, pickFields, baseName, registry };
