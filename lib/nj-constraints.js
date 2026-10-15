// New Jersey site constraints and incentives from state GIS layers.
// Each layer is queried against the parcel polygon (or a point), optionally with a buffer.
// Results become "overlays" in the zoning packet; the engine and UI render them as flags.
const { arcgisQuery, pool } = require('./http');

const DEP = 'https://mapsdep.nj.gov/arcgis/rest/services/Features';
const DEP_AGOL = 'https://services1.arcgis.com/QWdNfRs7lkPq4g4Q/arcgis/rest/services';
const DCA = 'https://services.arcgis.com/Aur8tCo478N3VovT/arcgis/rest/services';
const fmtDate = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

// severity: high = can stop or shrink a project; caution = adds permits, cost or time;
// positive = incentive; info = context.
const LAYERS = [
  // ---------- Environmental: can remove buildable land ----------
  { id: 'wetlands', group: 'Environmental', label: 'Freshwater wetlands (2020 mapping)', url: `${DEP_AGOL}/Wetlands_2020/FeatureServer/14`, bufferFt: 150,
    when: (hits, inParcel) => ({ severity: inParcel ? 'high' : 'caution',
      name: inParcel ? 'Mapped wetlands on the parcel' : 'Mapped wetlands within 150 ft',
      effect: 'NJDEP Freshwater Wetlands Protection Act: wetlands carry a 50 to 150 ft transition area depending on resource value. Expect a Letter of Interpretation (LOI) before site plan approval; affected land may not count as buildable.' }) },
  { id: 'c1', group: 'Environmental', label: 'Category One (C1) waters', url: `${DEP}/Hydrography/MapServer/6`, bufferFt: 300,
    when: () => ({ severity: 'high', name: 'Category One stream within 300 ft',
      effect: 'C1 waters carry a 300 ft riparian zone under the Flood Hazard Area rules (N.J.A.C. 7:13), where new disturbance is tightly limited.' }) },
  { id: 'streams', group: 'Environmental', label: 'Streams (2020)', url: `${DEP_AGOL}/Stream_Network_2020/FeatureServer/20`, bufferFt: 150,
    when: () => ({ severity: 'caution', name: 'Stream within 150 ft',
      effect: 'Regulated waters carry a 50 to 150 ft riparian zone (300 ft if C1). A Flood Hazard Area verification or permit may be needed.' }) },
  { id: 'cafeTidal', group: 'Environmental', label: 'Climate-adjusted tidal flood area (5 ft sea-level rise)', url: `${DEP}/Hydrography/MapServer/48`, bufferFt: 0,
    when: () => ({ severity: 'caution', name: 'Inside NJDEP climate-adjusted tidal flood area',
      effect: 'Under NJ PACT / REAL rules, new construction in tidal areas may need to elevate to a climate-adjusted flood elevation above the FEMA base flood elevation.' }) },
  { id: 'highlands', group: 'Environmental', label: 'Highlands region', url: 'https://services6.arcgis.com/ZrVlS0wslq8Nvq5I/arcgis/rest/services/Preservation_and_Planning_Area/FeatureServer/1', bufferFt: 0,
    when: (hits) => { const r = hits[0].REGION || ''; const pres = /preserv/i.test(r);
      return { severity: pres ? 'high' : 'caution', name: r || 'Highlands region',
        effect: pres ? 'Highlands Preservation Area: major development needs an NJDEP Highlands Preservation Area Approval; impervious cover is capped near 3% and septic density is very low.'
          : 'Highlands Planning Area: rules depend on whether the town has conformed to the Highlands Regional Master Plan.' }; } },
  { id: 'pinelands', group: 'Environmental', label: 'Pinelands management area', url: 'https://services1.arcgis.com/nCm6SZaiGMuGX35l/arcgis/rest/services/Pinelands_ManagementAreas/FeatureServer/0', bufferFt: 0,
    when: (hits) => { const m = hits[0].MGT_NAME || 'Pinelands'; const growth = /regional growth|town|village/i.test(m);
      return { severity: growth ? 'caution' : 'high', name: `Pinelands: ${m}`,
        effect: growth ? 'Pinelands Comprehensive Management Plan applies; growth areas allow development with Pinelands Commission review and Pinelands Development Credit rules.'
          : 'Pinelands Comprehensive Management Plan severely limits development in this management area. Pinelands Commission review is required.' }; } },
  { id: 'cafra', group: 'Environmental', label: 'CAFRA coastal zone', url: `${DEP}/Land_CAFRA_coast/MapServer/0`, bufferFt: 0,
    when: () => ({ severity: 'caution', name: 'Inside the CAFRA coastal zone',
      effect: 'Residential projects of 25+ units (or 75+ parking spaces commercial) generally need a CAFRA permit; impervious cover limits depend on the coastal planning area or center.' }) },
  { id: 'cafraCenter', group: 'Environmental', label: 'CAFRA and coastal centers', url: `${DEP_AGOL}/CAFRA_and_Coastal_Centers_2023_of_New_Jersey/FeatureServer/9`, bufferFt: 0,
    when: (hits) => ({ severity: 'positive', name: `Coastal center${hits[0].NAME ? `: ${hits[0].NAME}` : ''}`, effect: 'Designated coastal centers allow higher impervious cover under the Coastal Zone Management rules.' }) },

  // ---------- Contamination ----------
  { id: 'kcs', group: 'Contamination', label: 'Known contaminated sites', url: `${DEP}/Environmental_NJEMS/MapServer/0`, bufferFt: 500,
    when: (hits, inParcel) => ({ severity: inParcel ? 'high' : 'caution', name: inParcel ? 'Listed on the Known Contaminated Sites List' : `${hits.length} known contaminated site${hits.length > 1 ? 's' : ''} within 500 ft`,
      effect: inParcel ? 'Remediation under a Licensed Site Remediation Professional (LSRP) is likely before or during development. Budget for a Phase I/II and possible vapor mitigation.'
        : 'Neighbouring contamination can mean vapor intrusion or groundwater issues. Order a Phase I ESA.',
      detail: hits.slice(0, 3).map((h) => [h.PI_NAME || h.SITE_NAME, h.ADDRESS, h.STATUS].filter(Boolean).join(', ')).join('; ') }) },
  { id: 'deedNotice', group: 'Contamination', label: 'Deed notice areas', url: `${DEP}/Environmental/MapServer/40`, bufferFt: 0,
    when: () => ({ severity: 'high', name: 'Deed notice on the parcel', effect: 'Contamination left in place under an engineering or institutional control. Disturbing it requires LSRP oversight and NJDEP notification; it can limit basements and use.' }) },
  { id: 'cea', group: 'Contamination', label: 'Groundwater classification exception areas', url: `${DEP}/Environmental_mon_gw/MapServer/11`, bufferFt: 0,
    when: () => ({ severity: 'caution', name: 'Groundwater contamination area (CEA)', effect: 'Groundwater use is restricted. Wells are not allowed; usually manageable for development on public water.' }) },
  { id: 'filled', group: 'Contamination', label: 'Historically filled land', url: `${DEP}/Geology/MapServer/22`, bufferFt: 0,
    when: () => ({ severity: 'caution', name: 'Historically filled land', effect: 'Historic fill often contains contaminants and poor bearing soils. Expect soil testing and possibly deep foundations.' }) },
  { id: 'brownfieldBDA', group: 'Contamination', label: 'Brownfield development areas', url: `${DEP}/Environmental/MapServer/37`, bufferFt: 0,
    when: () => ({ severity: 'positive', name: 'Brownfield Development Area', effect: 'NJDEP Brownfield Development Area: eligible for remediation grants and coordinated state review; may qualify for the Brownfields Redevelopment Incentive tax credit.' }) },

  // ---------- Land use and preservation ----------
  { id: 'openSpace', group: 'Land use', label: 'Preserved open space (Green Acres and other)', url: `${DEP_AGOL}/Open_Space/FeatureServer/66`, bufferFt: 0,
    when: (hits) => ({ severity: 'high', name: `Preserved open space${hits[0].NAME_LABEL ? `: ${hits[0].NAME_LABEL}` : ''}`, effect: `Owned or encumbered as open space (${hits[0].OWNERTYPE || 'public'}${hits[0].ENCUMBRANCE_STATUS ? `, ${hits[0].ENCUMBRANCE_STATUS}` : ''}). Green Acres-encumbered land cannot be developed or diverted without state approval.` }) },
  { id: 'farmland', group: 'Land use', label: 'Preserved farmland', url: 'https://services.arcgis.com/gzSkSfQGxyX6dicF/arcgis/rest/services/NJFPP_Preserved_Farms/FeatureServer/0', bufferFt: 0,
    when: (hits) => ({ severity: 'high', name: 'Preserved farm (development easement)', effect: `Development rights were sold through the Farmland Preservation Program (${hits[0].PROGRAM || 'SADC'}). Non-agricultural development is prohibited.` }) },
  { id: 'sewer', group: 'Land use', label: 'Sewer service area', url: `${DEP}/Utilities/MapServer/8`, bufferFt: 0, reportMiss: true,
    when: (hits) => ({ severity: 'info', name: `Inside a sewer service area (${hits[0].FACNAME || hits[0].WMP || 'public sewer'})`, effect: 'Public sewer is planned for this area, which supports multifamily and denser development.' }),
    miss: () => ({ severity: 'high', name: 'Outside any sewer service area', effect: 'Development relies on septic systems. NJDEP nitrate-dilution standards typically limit density to roughly one unit per 2 to 4+ acres unless the Water Quality Management Plan is amended.' }) },
  { id: 'statePlan', group: 'Land use', label: 'State Plan planning area', url: 'https://services3.arcgis.com/iy3mGBSHxkFa1uPL/arcgis/rest/services/Planning_Area_Boundaries_of_the_NJ_State_Development_and_Redevelopment_Plan_New_Jersey/FeatureServer/0', bufferFt: 0,
    when: (hits) => { const a = hits[0].SPDETAIL || hits[0].SPDETAIL2 || 'Unknown'; const pa = /metro|suburban|PA1|PA2/i.test(a);
      return { severity: pa ? 'info' : 'caution', name: `State Plan: ${a.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/(\w)(\w*)/g, (m, f, r) => f + r.toLowerCase())} planning area`,
        effect: pa ? 'State policy directs growth to Metropolitan and Suburban planning areas.' : 'Fringe, rural and environmentally sensitive planning areas discourage dense development outside designated centers; state permits and infrastructure funding are harder to get.' }; } },
  { id: 'stateCenter', group: 'Land use', label: 'State Plan designated center', url: 'https://services3.arcgis.com/iy3mGBSHxkFa1uPL/arcgis/rest/services/Designated_Centers_of_the_NJ_State_Development_and_Redevelopment_Plan/FeatureServer/0', bufferFt: 0,
    when: (hits) => ({ severity: 'positive', name: `State Plan designated center${hits[0].CENNAME || hits[0].NAME ? `: ${hits[0].CENNAME || hits[0].NAME}` : ''}`, effect: 'Growth is encouraged here; supports density, state funding priority and smoother state permitting.' }) },
  { id: 'dandr', group: 'Land use', label: 'Delaware & Raritan Canal Commission review zone', url: `${DEP}/Government/MapServer/32`, bufferFt: 0,
    when: (hits) => ({ severity: 'caution', name: `D&R Canal Commission review zone ${hits[0].ZONE || ''}`.trim(), effect: 'Projects disturbing an acre or more, or adding a quarter acre of impervious cover, need D&R Canal Commission approval (stormwater and stream corridor standards).' }) },

  // ---------- Historic ----------
  { id: 'historicDistrict', group: 'Historic', label: 'Historic districts (NJ HPO)', url: `${DEP}/Land/MapServer/57`, bufferFt: 0,
    when: (hits) => ({ severity: 'caution', name: `Historic district: ${hits[0].NAME || hits[0].HIST_NAME || 'listed or eligible'}`, effect: 'State or National Register listed or eligible district. Local historic commission review applies if the town has also designated it; state-funded or permitted projects get HPO review.' }) },
  { id: 'historicProperty', group: 'Historic', label: 'Historic properties (NJ HPO)', url: `${DEP}/Land/MapServer/55`, bufferFt: 50,
    when: (hits) => ({ severity: 'caution', name: `Historic property: ${hits[0].NAME || hits[0].HIST_NAME || 'listed or eligible'}`, effect: 'Demolition or alteration may need historic review; listed properties can qualify for preservation tax credits.' }) },

  // ---------- Redevelopment and incentives ----------
  { id: 'redevArea', group: 'Incentives', label: 'Area in Need of Redevelopment (NJ DCA)', url: `${DCA}/NJ_Areas_in_Need_of_Redevelopment/FeatureServer/0`, bufferFt: 0,
    when: (hits) => ({ severity: 'positive', name: `Area in Need of Redevelopment${hits[0].RESOLUTION ? ` (Res. ${hits[0].RESOLUTION}, ${fmtDate(hits[0].RES_DATE) || 'date n/a'})` : ''}`,
      effect: `A redevelopment plan can replace base zoning, and long-term tax abatements (PILOT) are available under the Local Redevelopment and Housing Law. Condemnation: ${hits[0].CONDEMN || 'unknown'}. Check the town's adopted redevelopment plan for this area.` }) },
  { id: 'rehabArea', group: 'Incentives', label: 'Area in Need of Rehabilitation (NJ DCA)', url: `${DCA}/NJ_Areas_in_Need_of_Rehabilitation/FeatureServer/1`, bufferFt: 0,
    when: (hits) => ({ severity: 'positive', name: `Area in Need of Rehabilitation${hits[0].RESOLUTION ? ` (Res. ${hits[0].RESOLUTION})` : ''}`, effect: 'A redevelopment plan may apply, and 5-year tax exemptions or abatements for improvements are available.' }) },
  { id: 'uez', group: 'Incentives', label: 'Urban Enterprise Zone', url: `${DCA}/Govt_admin_UEZ_bnd/FeatureServer/0`, bufferFt: 0,
    when: (hits) => ({ severity: 'positive', name: `Urban Enterprise Zone: ${hits[0].UEZ_NAME || hits[0].MUNICIPAL}`, effect: 'Reduced sales tax for qualified retailers and other UEZ business benefits.' }) },
  { id: 'oz', group: 'Incentives', label: 'Qualified Opportunity Zone', url: 'https://services6.arcgis.com/BAJNi3EgCdtQ1BCG/arcgis/rest/services/Federal_Opportunity_Zones_New/FeatureServer/0', bufferFt: 0, point: true,
    when: () => ({ severity: 'positive', name: 'Qualified Opportunity Zone', effect: 'Capital gains invested through a Qualified Opportunity Fund can be deferred and, after a 10-year hold, appreciation excluded.' }) },
  { id: 'oz2', group: 'Incentives', label: 'Opportunity Zone 2.0 eligible tract', url: 'https://services6.arcgis.com/BAJNi3EgCdtQ1BCG/arcgis/rest/services/Opportunity_Zone_2_Eligible_Tracts/FeatureServer/0', bufferFt: 0, point: true,
    when: () => ({ severity: 'info', name: 'Eligible for Opportunity Zone 2.0 designation', effect: 'The tract meets eligibility for the next round of Opportunity Zones; designation is up to the Governor.' }) }
];

const RAIL = `${DCA}/NJ_Passenger_Rail_Stations/FeatureServer/0`;
const AIRPORTS = 'https://services.arcgis.com/HggmsDF7UJsNN1FK/arcgis/rest/services/NJDOT_Public_Airports/FeatureServer/0';

function geomParams({ ring, lat, lng }, point) {
  if (ring && !point) return { geometry: JSON.stringify({ rings: [ring], spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryPolygon', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' };
  return { geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' };
}

function distFt(lat1, lng1, lat2, lng2) {
  const R = 20902231; const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function checkLayer(L, site) {
  const g = geomParams(site, L.point);
  try {
    let inside = await arcgisQuery(L.url, { ...g, returnCountOnly: 'false', resultRecordCount: '5' });
    let hits = (inside.features || []).map((f) => f.attributes);
    let inParcel = hits.length > 0;
    if (!hits.length && L.bufferFt) {
      const near = await arcgisQuery(L.url, { ...g, distance: String(L.bufferFt), units: 'esriSRUnit_Foot', resultRecordCount: '5' });
      hits = (near.features || []).map((f) => f.attributes);
    }
    if (!hits.length) return L.reportMiss ? { ...L.miss(), id: L.id, group: L.group, type: L.group.toLowerCase(), source: L.label } : { id: L.id, clear: true };
    return { ...L.when(hits, inParcel), id: L.id, group: L.group, type: L.group.toLowerCase(), source: L.label };
  } catch (e) {
    return { id: L.id, error: e.message, label: L.label };
  }
}

// Nearest NJ Transit / PATH / Amtrak station within 1.5 miles.
async function nearestRail(site) {
  try {
    const j = await arcgisQuery(RAIL, { geometry: `${site.lng},${site.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', distance: '7920', units: 'esriSRUnit_Foot', returnGeometry: 'true', outSR: '4326', outFields: 'STATION,RAIL_LINE,MUNI' });
    const st = (j.features || []).map((f) => ({ ...f.attributes, ft: distFt(site.lat, site.lng, f.geometry.y, f.geometry.x) })).sort((a, b) => a.ft - b.ft)[0];
    if (!st) return { nearestStation: null };
    const mi = st.ft / 5280;
    return { nearestStation: { name: st.STATION, line: st.RAIL_LINE, miles: Math.round(mi * 100) / 100 },
      flag: mi <= 0.5 ? { id: 'transit', group: 'Incentives', type: 'parking', severity: 'positive', name: `${st.STATION} station ${mi.toFixed(2)} mi away (${st.RAIL_LINE})`,
        effect: 'Within a half mile of rail. Towns often allow higher density and reduced parking near stations, and transit villages qualify for state support. RSIS allows reduced parking with a demonstrated transit alternative.', source: 'NJ DCA passenger rail stations' } : null };
  } catch (e) { return { nearestStation: null, error: e.message }; }
}

async function nearestAirport(site) {
  try {
    const j = await arcgisQuery(AIRPORTS, { geometry: `${site.lng},${site.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', distance: '10560', units: 'esriSRUnit_Foot', returnGeometry: 'true', outSR: '4326' });
    const a = (j.features || []).map((f) => ({ ...f.attributes, ft: distFt(site.lat, site.lng, f.geometry.y, f.geometry.x) })).sort((x, y) => x.ft - y.ft)[0];
    if (!a) return null;
    const name = a.NAME || a.AIRPORT_NAME || a.FAC_NAME || 'Public airport';
    return { id: 'airport', group: 'Land use', type: 'airport', severity: 'caution', name: `${name} ${(a.ft / 5280).toFixed(1)} mi away`,
      effect: 'Within 2 miles of a public-use airport. Check NJDOT Airport Safety Zone rules (N.J.A.C. 16:62) and FAA Part 77 height limits; a Form 7460-1 may be needed for taller buildings or cranes.', source: 'NJDOT public airports' };
  } catch (_) { return null; }
}

// site = { lat, lng, ring? }
async function checkConstraints(site) {
  if (!site?.lat) return { flags: [], clear: [], errors: [], transit: null };
  const [results, rail, airport] = await Promise.all([pool(LAYERS, 6, (L) => checkLayer(L, site)), nearestRail(site), nearestAirport(site)]);
  const flags = results.filter((r) => r.name);
  if (rail.flag) flags.push(rail.flag);
  if (airport) flags.push(airport);
  const order = { high: 0, caution: 1, positive: 2, info: 3 };
  flags.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  return {
    flags,
    clear: results.filter((r) => r.clear).map((r) => LAYERS.find((L) => L.id === r.id).label),
    errors: results.filter((r) => r.error).map((r) => `${r.label}: ${r.error}`),
    transit: rail.nearestStation,
    checkedAt: new Date().toISOString()
  };
}

module.exports = { checkConstraints, LAYERS };
