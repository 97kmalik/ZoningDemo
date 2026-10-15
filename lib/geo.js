// Geocoding (US Census, with ArcGIS fallback) and FEMA flood zones.
const { getJSON, arcgisQuery, safe, IS_BROWSER } = require('./http');
const MUNIS = require('../data/nj-municipalities.json');

// Census County Subdivision names ("Millburn township") -> NJ municipal code ("0712").
function municipalityFor(name, county) {
  if (!name) return null;
  const norm = (s) => String(s).toLowerCase().replace(/\b(township|twp|borough|boro|city|town|village|of|the)\b/g, '').replace(/[^a-z]/g, '');
  const n = norm(name), c = String(county || '').toLowerCase().replace(/ county$/, '');
  const hits = MUNIS.filter((m) => norm(m.name) === n);
  if (hits.length <= 1) return hits[0] || null;
  // Same name in more than one county (e.g. Franklin, Washington): use the county, then the type.
  const byCounty = hits.filter((m) => m.county.toLowerCase() === c);
  const type = (String(name).match(/township|borough|city|town|village/i) || [''])[0].toLowerCase();
  return byCounty.find((m) => m.type.toLowerCase() === type) || byCounty[0] || hits[0];
}

const geocode = safe(async (address) => {
  const u = new URL('https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress');
  u.search = new URLSearchParams({ address, benchmark: 'Public_AR_Current', vintage: 'Current_Current', layers: 'all', format: 'json' });
  // The Census geocoder doesn't allow browser (CORS) requests; browsers go straight to ArcGIS.
  if (!IS_BROWSER) try {
    const j = await getJSON(u.toString());
    const m = j?.result?.addressMatches?.[0];
    if (m) {
      const g = m.geographies || {}; const first = (k) => (g[k] && g[k][0]) || null;
      const county = first('Counties')?.NAME;
      const sub = first('County Subdivisions')?.NAME;
      const muni = municipalityFor(sub, county);
      return { source: 'US Census Geocoder', matchedAddress: m.matchedAddress, lat: m.coordinates.y, lng: m.coordinates.x,
        state: first('States')?.STUSAB || m.addressComponents?.state, county, countySubdivision: sub,
        municipalityCode: muni?.code || null, municipality: muni?.name || sub, tract: first('Census Tracts')?.GEOID || null, zip: m.addressComponents?.zip };
    }
  } catch (_) { /* fall through */ }
  const a = new URL('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates');
  a.search = new URLSearchParams({ SingleLine: address, f: 'json', outFields: 'City,Subregion,RegionAbbr,Postal', maxLocations: '1' });
  const j = await getJSON(a.toString());
  const c = j?.candidates?.[0];
  if (!c) throw new Error('Address not found');
  const muni = await municipalityAtPoint(c.location.y, c.location.x);
  return { source: 'ArcGIS World Geocoder', matchedAddress: c.address, lat: c.location.y, lng: c.location.x, state: c.attributes.RegionAbbr,
    county: c.attributes.Subregion, municipality: muni?.name || c.attributes.City, municipalityCode: muni?.code || null, zip: c.attributes.Postal };
});

// Point-in-municipality using the state's municipal boundary layer.
async function municipalityAtPoint(lat, lng) {
  try {
    const j = await arcgisQuery('https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/NJ_Municipalities_3857/FeatureServer/0',
      { geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'SSN,MUN_LABEL' });
    const a = j.features?.[0]?.attributes;
    return a ? { code: a.SSN, name: a.MUN_LABEL } : null;
  } catch (_) { return null; }
}

const FEMA_NFHL = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28';
const NJDEP_NFHL = 'https://mapsdep.nj.gov/arcgis/rest/services/Features/Hydrography/MapServer/43'; // NJDEP's copy of the NFHL
const SFHA = /^(A|AE|AH|AO|AR|A99|V|VE)$/i;

const femaFlood = safe(async ({ lat, lng, ring }) => {
  const g = ring ? { geometry: JSON.stringify({ rings: [ring], spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryPolygon' } : { geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint' };
  let j, source = 'FEMA NFHL';
  try {
    j = await arcgisQuery(FEMA_NFHL, { ...g, inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DFIRM_ID' }, { timeout: 30000 });
  } catch (e) {
    j = await arcgisQuery(NJDEP_NFHL, { ...g, inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'FLD_ZONE,ZONE_SUBTY' }, { timeout: 30000 });
    (j.features || []).forEach((f) => { f.attributes.SFHA_TF = SFHA.test(f.attributes.FLD_ZONE || '') ? 'T' : 'F'; });
    source = 'FEMA NFHL (NJDEP copy)';
  }
  const zones = (j.features || []).map((f) => f.attributes);
  if (!zones.length) return { zone: 'X', subtype: 'No mapped flood hazard at this location', sfha: false, partial: false, source };
  const sfhaZones = zones.filter((z) => z.SFHA_TF === 'T');
  const worst = sfhaZones.sort((a, b) => (b.STATIC_BFE || 0) - (a.STATIC_BFE || 0))[0] || zones[0];
  return { zone: worst.FLD_ZONE, subtype: worst.ZONE_SUBTY, sfha: worst.SFHA_TF === 'T', bfe: worst.STATIC_BFE > -9000 ? worst.STATIC_BFE : null,
    partial: sfhaZones.length > 0 && zones.some((z) => z.SFHA_TF !== 'T'), allZones: [...new Set(zones.map((z) => z.FLD_ZONE))], firm: worst.DFIRM_ID || null, source };
});

module.exports = { geocode, femaFlood, municipalityFor, municipalityAtPoint, MUNIS };
