#!/usr/bin/env node
// Refreshes the two statewide reference files in data/:
//   nj-municipalities.json  all 564 municipalities with codes, county, population, centroid (NJOGIS)
//   nj-zoning-links.json    official zoning ordinance and map links per municipality (NJ DCA)
// Run monthly or so; then run scripts/discover-zoning-layers.js to rebuild the zoning layer registry.
const fs = require('fs');
const path = require('path');
const { arcgisQuery } = require('../lib/http');

const DATA = path.join(__dirname, '..', 'data');
const MUNI_LAYER = 'https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/NJ_Municipalities_3857/FeatureServer/0';
const DCA_LINKS = 'https://services.arcgis.com/Aur8tCo478N3VovT/arcgis/rest/services/Municipal_Zoning/FeatureServer/0';

(async () => {
  const m = await arcgisQuery(MUNI_LAYER, { where: '1=1', outFields: 'COUNTY,MUN_LABEL,MUN_TYPE,NAME,MUN_CODE,SSN,POP2020,SQ_MILES', returnCentroid: 'true', outSR: '4326', resultRecordCount: '1000' });
  const munis = m.features.map((f) => {
    const a = f.attributes, c = f.centroid || {};
    return { code: a.SSN || a.MUN_CODE, name: a.MUN_LABEL || a.NAME, shortName: a.NAME, type: a.MUN_TYPE, county: a.COUNTY ? a.COUNTY.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()) : '',
      pop2020: a.POP2020, sqMiles: Math.round((a.SQ_MILES || 0) * 100) / 100, lat: Math.round((c.y || 0) * 1e5) / 1e5, lng: Math.round((c.x || 0) * 1e5) / 1e5 };
  }).sort((a, b) => a.code.localeCompare(b.code));
  fs.writeFileSync(path.join(DATA, 'nj-municipalities.json'), JSON.stringify(munis, null, 1));
  console.log(`nj-municipalities.json: ${munis.length} municipalities`);

  const l = await arcgisQuery(DCA_LINKS, { where: '1=1', outFields: 'Muni,Municipali,County_1,Map,Ordinance,Website', resultRecordCount: '1000' });
  const links = {};
  for (const f of l.features) {
    const a = f.attributes;
    links[a.Muni] = { name: a.Municipali, county: a.County_1, zoningMap: (a.Map || '').trim() || null, ordinance: (a.Ordinance || '').trim() || null, website: (a.Website || '').trim() || null };
  }
  const sorted = Object.fromEntries(Object.entries(links).sort());
  fs.writeFileSync(path.join(DATA, 'nj-zoning-links.json'), JSON.stringify({
    description: 'Official zoning map and ordinance links for every NJ municipality, from the NJ Department of Community Affairs Municipal Zoning layer. Refresh with scripts/refresh-state-data.js.',
    source: DCA_LINKS, fetchedAt: new Date().toISOString(), municipalities: sorted
  }, null, 1));
  console.log(`nj-zoning-links.json: ${Object.keys(sorted).length} municipalities`);
})().catch((e) => { console.error(e.message); process.exit(1); });
