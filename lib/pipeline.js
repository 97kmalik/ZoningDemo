// Address or block/lot -> a seeded zoning packet for one New Jersey parcel.
const geo = require('./geo');
const parcels = require('./nj-parcels');
const { lookupZoning } = require('./nj-zoning');
const { regionalZoning } = require('./nj-regional-zoning');
const { checkConstraints } = require('./nj-constraints');
const LINKS = require('../data/nj-zoning-links.json').municipalities;
const { IS_BROWSER } = require('./http');

async function lookup(input, { onProgress = () => {} } = {}) {
  const out = { query: input, notes: [] };

  // 1. Find the parcel
  if (input.mode === 'blocklot') {
    const muni = input.municipalityCode ? geo.MUNIS.find((m) => m.code === input.municipalityCode) : geo.municipalityFor(input.municipality, input.county);
    if (!muni && !input.municipality) return { ...out, error: 'Choose a municipality.' };
    onProgress(`Finding Block ${input.block}, Lot ${input.lot} in ${muni?.name || input.municipality}`);
    out.parcel = await parcels.byBlockLot({ municipalityCode: muni?.code, municipality: input.municipality, block: input.block, lot: input.lot, qualifier: input.qualifier });
    if (out.parcel.error) return { ...out, error: out.parcel.error };
    out.location = { lat: out.parcel.lat, lng: out.parcel.lng, municipality: muni?.name || out.parcel.municipality, municipalityCode: out.parcel.municipalityCode, county: out.parcel.county, matchedAddress: out.parcel.address };
  } else {
    onProgress('Locating the address');
    const g = await geo.geocode(input.address);
    if (g.error) return { ...out, error: `Couldn't locate that address (${g.error}). Include the town and NJ.` };
    if (g.state && g.state !== 'NJ') return { ...out, error: `That address is in ${g.state}. This tool covers New Jersey.` };
    out.location = g;
    onProgress(`Matching the tax parcel in ${g.municipality || 'the municipality'}`);
    out.parcel = await parcels.byAddress({ lat: g.lat, lng: g.lng, address: input.address, municipality: g.municipality, municipalityCode: g.municipalityCode });
    if (out.parcel.error) { out.notes.push(out.parcel.error); out.parcel = null; }
    else if (out.parcel.matchNote) out.notes.push(out.parcel.matchNote);
  }

  const p = out.parcel;
  const site = { lat: p?.lat ?? out.location.lat, lng: p?.lng ?? out.location.lng, ring: p?.ring || null };
  const code = p?.municipalityCode || out.location.municipalityCode;
  const muniName = geo.MUNIS.find((m) => m.code === code)?.name || out.location.municipality;
  const county = p?.county || String(out.location.county || '').replace(/ County$/i, '');

  // 2. Everything else in parallel
  onProgress('Checking zoning maps, state constraint layers, flood zones and nearby sales');
  const [zoning, regional, constraints, flood, sales] = await Promise.all([
    lookupZoning({ ...site, municipalityCode: code, municipalityName: muniName, county }),
    IS_BROWSER ? null : regionalZoning(site).catch(() => null), // NJTPA's server blocks browser requests
    checkConstraints(site),
    geo.femaFlood(site),
    p ? parcels.nearbySales(p) : null
  ]);
  out.zoning = zoning && !zoning.error ? zoning : null;
  out.regional = regional;
  out.constraints = constraints;
  out.flood = flood && !flood.error ? flood : null;
  if (flood?.error) out.notes.push(`FEMA flood layer unavailable (${flood.error})`);
  out.sales = sales && !sales.error ? sales : null;
  out.tax = p ? parcels.taxProfile(p, out.sales) : null;
  out.links = code ? LINKS[code] || null : null;
  if (!out.zoning && !out.regional?.district) out.notes.push('No zoning map layer covers this parcel. The district will come from the ordinance research or the official map.');

  out.packet = seedPacket(out, { code, muniName, county });
  return out;
}

function seedPacket(o, { code, muniName, county }) {
  const p = o.parcel, loc = o.location || {};
  const z = o.zoning, r = o.regional;
  const property = {
    address: p?.address ? `${titleCase(p.address)}, ${muniName}, NJ` : loc.matchedAddress || '',
    jurisdiction: muniName || '', municipalityCode: code || '', county: county ? titleCase(county) : '', state: 'NJ',
    parcelId: p ? `Block ${p.block}, Lot ${p.lot}${p.qualifier ? ' ' + p.qualifier : ''}` : '',
    pin: p?.pin || '', lat: p?.lat ?? loc.lat, lng: p?.lng ?? loc.lng,
    lotAreaSF: p?.lotAreaSF || null, frontageFt: p?.frontageFt || null, depthFt: p?.depthFt || null,
    dimsEstimated: p?.dimsSource === 'estimated from parcel outline',
    existingBldgSF: null, existingUnits: p?.dwellings ?? null, yearBuilt: p?.yearBuilt || null,
    existingUse: p ? `${p.propertyClassLabel}${p.buildingDescriptionDecoded ? ` (${p.buildingDescriptionDecoded})` : ''}` : '',
    landValue: p?.assessment?.land || null,
    floodZone: o.flood?.zone || '', historic: '',
    outlineFt: p?.geometry?.outlineFt || null
  };
  const hist = (o.constraints?.flags || []).find((f) => f.group === 'Historic');
  if (hist) property.historic = hist.name;

  const rules = { district: '', districtName: '', far: {}, setbacks: {}, density: {}, parking: { rsis: true }, uses: {}, bonuses: [], citations: [], notes: [], confidence: { overall: 'low', lowConfidenceFields: [] } };
  if (z) {
    rules.district = z.district; rules.districtName = z.description || '';
    if (z.allDistricts?.length > 1) rules.notes.push(`The parcel touches more than one district on the zoning map: ${z.allDistricts.join(', ')}. Standards are apportioned by area or follow the district covering most of the lot; check the ordinance.`);
    rules.citations.push({ label: `Zoning map layer: ${z.layer} (published by ${z.owner})`, url: z.url });
  } else if (r?.district) {
    rules.district = r.district; rules.districtName = r.description || '';
    rules.citations.push({ label: `${r.layer}${r.asOfYear ? ` (compiled ${r.asOfYear})` : ''}`, url: r.url });
  }
  // Bulk standards from the regional compilation are hints: kept, but flagged for verification.
  if (r?.hints && (!z || z.district === r.district)) {
    mergeHints(rules, r.hints);
    rules.confidence.lowConfidenceFields.push(...flatKeys(r.hints));
    rules.notes.push(`Bulk standards prefilled from the ${r.layer}${r.asOfYear ? ` (compiled ${r.asOfYear})` : ''}. Verify each against the current ordinance.`);
  }
  (r?.notes || []).forEach((x) => rules.notes.push(x));
  if (o.links?.ordinance) rules.citations.push({ label: `${muniName} zoning ordinance (NJ DCA list)`, url: o.links.ordinance });
  if (o.links?.zoningMap) rules.citations.push({ label: `${muniName} official zoning map (NJ DCA list)`, url: o.links.zoningMap });

  const overlays = (o.constraints?.flags || []).map((f) => ({ type: f.type, group: f.group, name: f.name, severity: f.severity, effect: f.effect, detail: f.detail || '', source: f.source }));
  (r?.overlays || []).forEach((x) => overlays.push({ type: 'overlay', group: 'Zoning', name: `Zoning overlay: ${x}`, severity: 'caution', effect: 'Overlay districts modify the base zone. Check the ordinance.', source: r.layer }));
  if (o.flood?.partial) overlays.push({ type: 'flood', group: 'Environmental', name: `Part of the lot is in FEMA zone ${o.flood.zone}`, severity: 'high', effect: 'Only part of the parcel is in the Special Flood Hazard Area. Siting the building outside it avoids elevation and flood insurance requirements.', source: 'FEMA NFHL' });

  return {
    property, rules, overlays,
    context: { parcel: p ? { ...p, ring: undefined } : null, sales: o.sales, tax: o.tax, links: o.links, transit: o.constraints?.transit || null,
      constraintsClear: o.constraints?.clear || [], constraintErrors: o.constraints?.errors || [], flood: o.flood, regional: r, zoningLayer: z },
    sources: buildSources(o)
  };
}

function mergeHints(rules, hints) {
  for (const [k, v] of Object.entries(hints)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) { rules[k] = rules[k] || {}; for (const [k2, v2] of Object.entries(v)) if (v2 !== null && v2 !== undefined) rules[k][k2] = v2; }
    else if (v !== null && v !== undefined) rules[k] = v;
  }
}
function flatKeys(o, pre = '') { return Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flatKeys(v, `${pre}${k}.`) : [`${pre}${k}`])); }
function titleCase(s) { return String(s).toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()); }

function buildSources(o) {
  const s = [];
  if (o.location?.source) s.push({ label: o.location.source, kind: 'location' });
  if (o.parcel) s.push({ label: o.parcel.source, kind: 'parcel, assessment, sales' });
  if (o.zoning) s.push({ label: `${o.zoning.layer} (${o.zoning.owner})`, kind: 'zoning district' });
  if (o.regional?.layer) s.push({ label: o.regional.layer, kind: 'zoning district and bulk standards (dated)' });
  if (o.constraints) s.push({ label: 'NJDEP, NJ DCA, Pinelands, Highlands, SADC and State Plan GIS layers', kind: 'site constraints and incentives' });
  if (o.flood) s.push({ label: 'FEMA National Flood Hazard Layer', kind: 'flood' });
  if (o.links) s.push({ label: 'NJ DCA municipal zoning links', kind: 'ordinance and map links' });
  return s;
}

module.exports = { lookup, seedPacket };
