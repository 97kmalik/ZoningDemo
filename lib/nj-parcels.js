// New Jersey parcels, tax data and sales (NJOGIS statewide parcel composite joined to MOD-IV).
const { arcgisQuery, safe, esc } = require('./http');

const PARCELS = 'https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0';
const FIELDS = 'PAMS_PIN,PCL_MUN,PCLBLOCK,PCLLOT,PCLQCODE,MUN_NAME,COUNTY,PROP_LOC,PROP_CLASS,PROP_USE,BLDG_DESC,LAND_DESC,BLDG_CLASS,CALC_ACRE,LAND_VAL,IMPRVT_VAL,NET_VALUE,LAST_YR_TX,YR_CONSTR,DWELL,COMM_DWELL,SALE_PRICE,DEED_DATE,SALES_CODE,DEED_BOOK,DEED_PAGE,ZIP5,ADD_LOTS1,ADD_LOTS2,FAC_NAME,OWNER_NAME';

const PROP_CLASS = { '1': 'Vacant land', '2': 'Residential (1-4 units)', '3A': 'Farm (regular)', '3B': 'Farm (qualified)', '4A': 'Commercial', '4B': 'Industrial', '4C': 'Apartment (5+ units)', '5A': 'Railroad (class I)', '5B': 'Railroad (class II)', '6A': 'Telephone', '6B': 'Petroleum refinery', '15A': 'Public school', '15B': 'Other school', '15C': 'Public property', '15D': 'Church or charitable', '15E': 'Cemetery', '15F': 'Other exempt' };

// MOD-IV building description codes, e.g. "2SF2G" = 2-story frame, 2-car garage. Decoded loosely.
function decodeBldgDesc(s) {
  const m = String(s || '').toUpperCase().match(/^(\d(?:\.\d)?)S?\s*([A-Z]{1,3})?\s*(\d)?G?/);
  if (!m) return null;
  const mat = { F: 'frame', B: 'brick', S: 'stone', BF: 'brick and frame', SF: 'stone and frame', AL: 'aluminum', V: 'vinyl', M: 'masonry', ST: 'stucco', C: 'concrete', B3: 'brick' };
  const stories = +m[1];
  const parts = [];
  if (stories) parts.push(`${stories}-story`);
  if (m[2] && mat[m[2]]) parts.push(mat[m[2]]);
  if (m[3] && /G/.test(s)) parts.push(`${m[3]}-car garage`);
  return parts.length ? parts.join(', ') : null;
}

// Approximate frontage and depth from the parcel outline (minimum-area bounding rectangle).
function parcelDims(ring) {
  if (!ring || ring.length < 4) return null;
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const lng0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const FT_LAT = 364000, FT_LNG = FT_LAT * Math.cos(lat0 * Math.PI / 180);
  const pts = ring.map(([x, y]) => [(x - lng0) * FT_LNG, (y - lat0) * FT_LAT]);
  let area = 0, perim = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    area += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
    perim += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  }
  area = Math.abs(area) / 2;
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const ang = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { const rx = x * c - y * s, ry = x * s + y * c; x0 = Math.min(x0, rx); x1 = Math.max(x1, rx); y0 = Math.min(y0, ry); y1 = Math.max(y1, ry); }
    if (!best || (x1 - x0) * (y1 - y0) < best.a) best = { a: (x1 - x0) * (y1 - y0), w: x1 - x0, h: y1 - y0 };
  }
  return {
    polygonAreaSF: Math.round(area), perimeterFt: Math.round(perim),
    frontageFtEst: Math.round(Math.min(best.w, best.h)), depthFtEst: Math.round(Math.max(best.w, best.h)),
    rectangularity: Math.round((area / best.a) * 100) / 100,
    outlineFt: pts.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
    centroid: { lat: lat0, lng: lng0 }
  };
}

// "210X208" or "100 X 150" in the tax record = frontage x depth.
function taxDims(landDesc) {
  const m = String(landDesc || '').toUpperCase().match(/^\s*(\d+(?:\.\d+)?)\s*X\s*(\d+(?:\.\d+)?)/);
  return m ? { frontageFt: +m[1], depthFt: +m[2] } : null;
}

// MOD-IV deed date is YYMMDD.
function deedDate(s) {
  const m = String(s || '').match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const yy = +m[1]; const year = yy > 50 ? 1900 + yy : 2000 + yy;
  return `${year}-${m[2]}-${m[3]}`;
}

function mapParcel(f) {
  const a = f.attributes;
  const ring = f.geometry?.rings?.[0] || null;
  const dims = parcelDims(ring);
  const td = taxDims(a.LAND_DESC);
  return {
    source: 'NJ statewide parcel composite + MOD-IV tax list (NJOGIS)',
    pin: a.PAMS_PIN, municipalityCode: a.PCL_MUN, municipality: a.MUN_NAME, county: a.COUNTY,
    block: a.PCLBLOCK, lot: a.PCLLOT, qualifier: (a.PCLQCODE || '').trim() || null,
    address: a.PROP_LOC, zip: a.ZIP5,
    propertyClass: a.PROP_CLASS, propertyClassLabel: PROP_CLASS[a.PROP_CLASS] || a.PROP_CLASS,
    buildingDescription: a.BLDG_DESC, buildingDescriptionDecoded: decodeBldgDesc(a.BLDG_DESC), buildingClass: a.BLDG_CLASS || null,
    landDescription: a.LAND_DESC, facilityName: a.FAC_NAME || null,
    lotAcres: a.CALC_ACRE, lotAreaSF: a.CALC_ACRE ? Math.round(a.CALC_ACRE * 43560) : dims?.polygonAreaSF || null,
    frontageFt: td?.frontageFt || dims?.frontageFtEst || null, depthFt: td?.depthFt || dims?.depthFtEst || null,
    dimsSource: td ? 'tax record' : dims ? 'estimated from parcel outline' : null,
    assessment: { land: a.LAND_VAL, improvements: a.IMPRVT_VAL, net: a.NET_VALUE, lastYearTax: a.LAST_YR_TX },
    yearBuilt: a.YR_CONSTR || null, dwellings: a.DWELL || null, commercialDwellings: a.COMM_DWELL || null,
    lastSale: a.SALE_PRICE ? { price: a.SALE_PRICE, date: deedDate(a.DEED_DATE), code: (a.SALES_CODE || '').trim() || null, deed: a.DEED_BOOK ? `Book ${a.DEED_BOOK}, Page ${a.DEED_PAGE}` : null } : null,
    owner: a.OWNER_NAME || null,
    additionalLots: [a.ADD_LOTS1, a.ADD_LOTS2].filter((x) => x && x.trim()),
    lat: dims?.centroid.lat, lng: dims?.centroid.lng, ring,
    geometry: dims ? { polygonAreaSF: dims.polygonAreaSF, perimeterFt: dims.perimeterFt, frontageFtEst: dims.frontageFtEst, depthFtEst: dims.depthFtEst, rectangularity: dims.rectangularity, outlineFt: dims.outlineFt } : null
  };
}

const geo = { returnGeometry: 'true', outSR: '4326', outFields: FIELDS };
const stripType = (s) => String(s || '').toUpperCase().replace(/\b(TOWNSHIP|TWP|BOROUGH|BORO|CITY|TOWN|VILLAGE|OF)\b/g, '').replace(/\s+/g, ' ').trim();

const byBlockLot = safe(async ({ municipality, municipalityCode, block, lot, qualifier }) => {
  const b = esc(String(block).trim()), l = esc(String(lot).trim());
  const munWhere = municipalityCode ? `PCL_MUN='${esc(municipalityCode)}'` : `UPPER(MUN_NAME) LIKE '${esc(stripType(municipality))}%'`;
  let feats = (await arcgisQuery(PARCELS, { ...geo, where: `${munWhere} AND PCLBLOCK='${b}' AND PCLLOT='${l}'`, resultRecordCount: '20' })).features || [];
  if (!feats.length) feats = (await arcgisQuery(PARCELS, { ...geo, where: `${munWhere} AND PCLBLOCK LIKE '${b}%' AND PCLLOT LIKE '${l}%'`, resultRecordCount: '20' })).features || [];
  if (qualifier) { const q = feats.filter((f) => (f.attributes.PCLQCODE || '').trim().toUpperCase() === String(qualifier).trim().toUpperCase()); if (q.length) feats = q; }
  if (!feats.length) throw new Error(`No parcel found for Block ${block}, Lot ${lot} in ${municipality || municipalityCode}. Check the block and lot on the tax map.`);
  const out = mapParcel(feats[0]);
  if (feats.length > 1) out.otherMatches = feats.slice(1, 8).map((f) => `Block ${f.attributes.PCLBLOCK}, Lot ${f.attributes.PCLLOT}${(f.attributes.PCLQCODE || '').trim() ? ' ' + f.attributes.PCLQCODE.trim() : ''}`);
  return out;
});

// Geocoders place addresses on the street centreline, so: text match on the tax-list
// address first, then nearby parcels whose address starts with the house number, then the point.
const byAddress = safe(async ({ lat, lng, address, municipality, municipalityCode }) => {
  const m = String(address || '').toUpperCase().match(/^\s*(\d+[A-Z]?)(?:-\d+)?\s+(.+?)(?:,|$)/);
  const house = m?.[1], street = m?.[2];
  const STOP = /^(N|S|E|W|NORTH|SOUTH|EAST|WEST|ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|LN|LANE|PL|PLACE|CT|COURT|BLVD|BOULEVARD|TER|TERRACE|PKWY|PARKWAY|HWY|HIGHWAY|WAY|CIR|CIRCLE|SQ)$/;
  const key = street ? street.split(/\s+/).filter((w) => !STOP.test(w)).sort((a, b) => b.length - a.length)[0] : null;
  const munWhere = municipalityCode ? `PCL_MUN='${esc(municipalityCode)}'` : municipality ? `UPPER(MUN_NAME) LIKE '${esc(stripType(municipality))}%'` : null;
  if (house && key && munWhere) {
    const f = (await arcgisQuery(PARCELS, { ...geo, where: `${munWhere} AND PROP_LOC LIKE '${esc(house)} %${esc(key)}%'`, resultRecordCount: '5' })).features || [];
    if (f.length) return mapParcel(f[0]);
  }
  if (lat == null) throw new Error('No parcel matched this address');
  const near = (await arcgisQuery(PARCELS, { ...geo, geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', distance: '150', units: 'esriSRUnit_Foot', resultRecordCount: '50' })).features || [];
  if (house) {
    const hit = near.find((f) => new RegExp(`^${house}(\\b|-)`).test(String(f.attributes.PROP_LOC || '')));
    if (hit) return mapParcel(hit);
    // Tax lists often use ranges ("198-202 MAIN ST"). Accept a range containing the number,
    // else the closest number on the same street and side, flagged for confirmation.
    const h = parseInt(house, 10);
    const onStreet = near.map((f) => { const m2 = String(f.attributes.PROP_LOC || '').toUpperCase().match(/^(\d+)(?:-(\d+))?\s+(.+)/); return m2 && key && m2[3].includes(key) ? { f, lo: +m2[1], hi: +(m2[2] || m2[1]) } : null; }).filter(Boolean);
    const inRange = onStreet.find((x) => h >= x.lo && h <= (x.hi < x.lo ? x.lo + x.hi : x.hi));
    if (inRange) return mapParcel(inRange.f);
    const sameSide = onStreet.filter((x) => x.lo % 2 === h % 2).sort((a, b) => Math.abs(a.lo - h) - Math.abs(b.lo - h))[0];
    if (sameSide && Math.abs(sameSide.lo - h) <= 10) { const out = mapParcel(sameSide.f); out.matchNote = `No tax record for number ${house}; matched the nearest parcel on the same side of the street (${sameSide.f.attributes.PROP_LOC}). Confirm block and lot.`; return out; }
  }
  const exact = (await arcgisQuery(PARCELS, { ...geo, geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' })).features || [];
  if (exact.length) return mapParcel(exact[0]);
  throw new Error('No NJ parcel matched this address. Try a block and lot search.');
});

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };

// Recent sales near the parcel from MOD-IV. Only the latest deed per parcel is recorded.
// In this dataset 'A' or blank marks most sales; 'Z' and numeric SR-1A non-usable
// codes (deed transfers between family, foreclosures, etc.) are excluded.
const isUsable = (code) => { const c = String(code || '').trim().toUpperCase(); return c === '' || c === 'A'; };

const nearbySales = safe(async (p, { radiusFt = 2640, years = 5 } = {}) => {
  if (!p.lat) return null;
  const j = await arcgisQuery(PARCELS, {
    geometry: `${p.lng},${p.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    distance: String(radiusFt), units: 'esriSRUnit_Foot', where: 'SALE_PRICE > 10000', resultRecordCount: '2000', returnGeometry: 'false',
    outFields: 'PAMS_PIN,PCLBLOCK,PCLLOT,PROP_LOC,PROP_CLASS,CALC_ACRE,SALE_PRICE,DEED_DATE,SALES_CODE,NET_VALUE,LAST_YR_TX,YR_CONSTR,BLDG_DESC'
  });
  const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - years);
  const rows = (j.features || []).map((f) => f.attributes)
    .map((a) => ({ pin: a.PAMS_PIN, address: a.PROP_LOC, block: a.PCLBLOCK, lot: a.PCLLOT, propertyClass: a.PROP_CLASS, acres: a.CALC_ACRE,
      price: a.SALE_PRICE, date: deedDate(a.DEED_DATE), usable: isUsable(a.SALES_CODE), assessed: a.NET_VALUE, tax: a.LAST_YR_TX,
      yearBuilt: a.YR_CONSTR || null, building: decodeBldgDesc(a.BLDG_DESC) }))
    .filter((r) => r.date && new Date(r.date) >= cutoff && r.usable && r.pin !== p.pin);
  rows.forEach((r) => { if (r.acres) r.pricePerAcre = Math.round(r.price / r.acres); r.ratio = r.assessed && r.price ? r.assessed / r.price : null; });
  rows.sort((a, b) => b.date.localeCompare(a.date));
  const same = rows.filter((r) => r.propertyClass === p.propertyClass);
  const vacant = rows.filter((r) => r.propertyClass === '1');
  const summarize = (list) => list.length ? { count: list.length, medianPrice: median(list.map((r) => r.price)), medianPricePerAcre: median(list.filter((r) => r.pricePerAcre).map((r) => r.pricePerAcre)) } : null;
  // Assessment-to-sale ratio across nearby usable sales approximates the town's equalization ratio.
  const ratios = rows.map((r) => r.ratio).filter((x) => x && x > 0.2 && x < 2.5);
  return {
    radiusMiles: Math.round(radiusFt / 528) / 10, years,
    sameClass: summarize(same), vacantLand: summarize(vacant), all: summarize(rows),
    assessmentRatio: ratios.length >= 5 ? Math.round(median(ratios) * 1000) / 1000 : null,
    sales: same.slice(0, 12).concat(vacant.filter((v) => !same.includes(v)).slice(0, 6)).slice(0, 15)
  };
});

// Property tax from the parcel's own bill, adjusted by the local assessment ratio when known.
function taxProfile(p, sales) {
  const net = p.assessment?.net, tax = p.assessment?.lastYearTax;
  if (!net || !tax) return null;
  const ratePer100 = (tax / net) * 100;
  const ratio = sales?.assessmentRatio || null;
  return {
    lastYearTax: tax, netAssessed: net,
    generalRatePer100: Math.round(ratePer100 * 1000) / 1000,
    assessmentRatioEst: ratio,
    effectiveRatePctEst: ratio ? Math.round(ratePer100 * ratio * 1000) / 1000 : null,
    note: ratio ? 'Effective rate = general tax rate x assessment-to-sale ratio from nearby recent sales (an estimate of the equalization ratio).'
      : 'Not enough nearby sales to estimate the assessment ratio; the general rate applies to assessed value, which may be below market value.'
  };
}

module.exports = { byBlockLot, byAddress, nearbySales, taxProfile, mapParcel, parcelDims, taxDims, deedDate, decodeBldgDesc, PROP_CLASS, PARCELS };
