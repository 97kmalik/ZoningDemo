// County zoning compilations hosted by the North Jersey Transportation Planning
// Authority (NJTPA). They cover most towns in eight counties plus Jersey City, and
// several carry bulk standards (lot size, coverage, FAR, height, density).
// They are compiled from municipal maps of varying age, so anything taken from
// them is marked low confidence and verified against the current ordinance.
const { arcgisQuery, pool } = require('./http');

const BASE = 'https://gis.njtpa.org/server/rest/services/LandUse/NJTPA_Zoning/FeatureServer';
const n = (v) => (v === null || v === undefined || v === '' || +v === 0 || isNaN(+v) ? null : +v);
const pct = (v) => { const x = n(v); return x === null ? null : x <= 1 ? Math.round(x * 1000) / 10 : x; };
const ftOf = (v) => { const m = String(v ?? '').match(/(\d+(?:\.\d+)?)/); return m ? +m[1] : null; };
const yearOf = (v) => { if (!v) return null; if (typeof v === 'number') return new Date(v).getFullYear(); const m = String(v).match(/(19|20)\d\d/); return m ? +m[0] : null; };
const clean = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === null || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) ? undefined : v)));

const ADAPTERS = [
  { id: 0, county: 'Bergen', read: (a) => ({ district: a.MUNZonCode, description: a.MUNZonDef, asOf: a.AdoptDate || a.MapDate, source: a.Source,
    hints: { minLotAreaSF: n(a.MinLotSF) } }) },
  { id: 1, county: 'Hunterdon', read: (a) => ({ district: a.MUN_SYMBOL, description: a.MUN_ZONE, category: a.GEN_ZONE,
    hints: { minLotAreaSF: n(a.MIN_LOT_SF), minLotWidthFt: n(a.LOT_WIDTH), minLotDepthFt: n(a.LOT_DEPTH),
      setbacks: { frontFt: n(a.FRONT_S_B), rearFt: n(a.REAR_S_B), sideFt: n(a.SIDE_S_B) },
      maxImperviousPct: pct(a.PCT_IMPCOV), far: { residential: n(a.PCT_FAR) ? (a.PCT_FAR > 1 ? a.PCT_FAR / 100 : a.PCT_FAR) : null } },
    notes: [n(a.SEW_LOT_SF) ? `With public sewer the minimum lot drops to ${Number(a.SEW_LOT_SF).toLocaleString()} SF.` : null, a.CLUSTER && a.CLUSTER !== 'N' && a.CLUSTER !== ' ' ? `Cluster option: ${n(a.CL_LOT_SF) ? Number(a.CL_LOT_SF).toLocaleString() + ' SF lots' : 'available'}${n(a.CL_PCT_OS) ? `, ${a.CL_PCT_OS}% open space` : ''}.` : null, a.COMMENTS && a.COMMENTS.trim() ? a.COMMENTS.trim() : null].filter(Boolean) }) },
  { id: 2, county: 'Middlesex', read: (a) => ({ district: a.Zone_code, description: a.ZONENAME, asOf: a.LASTUPDATE,
    hints: { density: { maxUnitsPerAcre: n(a.UNITS_AC) }, far: { commercial: n(a.FLOORARRAT), residential: n(a.ResFAR) },
      maxHeightFt: n(a.HEIGHT), maxStories: n(a.STORIES), maxImperviousPct: pct(a.COVERPERCE), maxLotCoveragePct: pct(a.BLDGCOVERP) },
    redevelopment: a.Redevelopment && !/ordinary/i.test(a.Redevelopment) ? a.Redevelopment : null }) },
  { id: 3, county: 'Monmouth', read: (a) => ({ district: a.ZON_ID, description: a.ZoneDesc, category: a.CompDesc, asOf: a.ADOPTDATE?.trim() || a.MAPDATE,
    overlay: a.Overlay && a.Overlay.trim() ? a.Overlay.trim() : null }) },
  { id: 4, county: 'Morris', read: (a) => ({ district: a.Zone_, description: a.ZoneLabel, asOf: a.DateofGISM,
    overlay: [a.OverlayZon, a.OverlayZ_1, a.OverlayZ_3, a.OverlayZ_4, a.OverlayZ_6, a.OverlayZ_7].filter((x) => x && String(x).trim()).join(', ') || null }) },
  { id: 5, county: 'Somerset', read: (a) => ({ district: (a.RevZone && a.RevZone.trim()) || a.ZONING, description: null, asOf: a.LASTUPDATE || a.SRCDATE }) },
  { id: 6, county: 'Sussex', read: (a) => ({ district: a.SUSSEX_S_2, description: a.SUSSEX_S_3, category: a.SUSSEX_S_5,
    hints: { minLotAreaSF: /acre/i.test(a.SUSSEX_S_4 || '') && ftOf(a.SUSSEX_S_4) ? Math.round(ftOf(a.SUSSEX_S_4) * 43560) : null },
    notes: a.SUSSEX_S_4 ? [`Minimum lot: ${a.SUSSEX_S_4}`] : [] }) },
  { id: 7, county: 'Hudson (Jersey City)', read: (a) => ({ district: a.ZONE, description: null,
    redevelopment: a.Replan && /yes/i.test(a.Replan) ? 'Inside a Jersey City redevelopment plan area: the plan, not base zoning, controls.' : null }) },
  { id: 8, county: 'Warren', read: (a) => ({ district: a.ZONE_, description: a.ZONE_DESCR || a.Zone_Desci, category: a.USE_ || a.GeneralUse,
    hints: { minLotAreaSF: n(a.MIN_LOT_SI) ? Math.round(a.MIN_LOT_SI * 43560) : null, density: { maxUnitsPerAcre: n(a.Dwelling_U) },
      far: { residential: n(a.Floor_Area) }, maxLotCoveragePct: pct(a.Lot_Covera), maxHeightFt: ftOf(a.Max_Bld_Ht) } }) },
  { id: 10, county: 'Middlesex overlay', overlayOnly: true, read: (a) => ({ overlay: `${a.ZONENAME || a.Zone_code}${a.Redevelopment && !/ordinary/i.test(a.Redevelopment) ? ` (${a.Redevelopment})` : ''}` }) }
];

// Returns { district, description, hints, notes, overlays[], asOf, layer } or null.
async function regionalZoning({ lat, lng, ring }) {
  // Parcel polygon when available; otherwise the point with a small buffer (points often land on a street gap).
  const g = ring
    ? { geometry: JSON.stringify({ rings: [ring], spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryPolygon', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' }
    : { geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' }; // this server ignores buffered queries
  const results = await pool(ADAPTERS, 5, async (A) => {
    try {
      const j = await arcgisQuery(`${BASE}/${A.id}`, g, { timeout: 15000 });
      const a = j.features?.[0]?.attributes;
      return a ? { A, r: A.read(a) } : null;
    } catch (_) { return null; }
  });
  const base = results.find((x) => x && !x.A.overlayOnly && x.r.district && String(x.r.district).trim());
  const overlays = results.filter((x) => x && (x.A.overlayOnly || x.r.overlay)).map((x) => x.r.overlay).filter(Boolean);
  if (!base && !overlays.length) return null;
  const r = base?.r || {};
  const yr = yearOf(r.asOf);
  return clean({
    district: r.district ? String(r.district).trim() : null, description: r.description || null, category: r.category || null,
    hints: r.hints || {}, notes: [...(r.notes || []), r.redevelopment || null].filter(Boolean),
    overlays, asOfYear: yr,
    layer: base ? `NJTPA ${base.A.county} County zoning compilation` : null,
    url: base ? `${BASE}/${base.A.id}` : null
  });
}

module.exports = { regionalZoning, ADAPTERS, BASE };
