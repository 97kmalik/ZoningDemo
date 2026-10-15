// What the lookup already knows, handed to the research step so Claude starts from the right sources.
function researchContext(b) {
  const c = b.context || {};
  const lines = [];
  if (c.links?.ordinance) lines.push(`Official zoning ordinance (NJ DCA): ${c.links.ordinance}. Start here.`);
  if (c.links?.zoningMap) lines.push(`Official zoning map (NJ DCA): ${c.links.zoningMap}`);
  if (c.zoningLayer) lines.push(`District from the municipal zoning map layer "${c.zoningLayer.layer}": ${c.zoningLayer.district}${c.zoningLayer.allDistricts?.length > 1 ? ` (parcel touches ${c.zoningLayer.allDistricts.join(', ')})` : ''}.`);
  if (c.regional?.district) lines.push(`District in the ${c.regional.layer}${c.regional.asOfYear ? ` (compiled ${c.regional.asOfYear}, may be outdated)` : ''}: ${c.regional.district}${c.regional.description ? ` (${c.regional.description})` : ''}. Prefilled values: ${JSON.stringify(c.regional.hints || {})}. Verify against the current ordinance.`);
  const flags = (b.overlays || []).filter((o) => ['Incentives', 'Historic', 'Zoning'].includes(o.group)).map((o) => o.name);
  if (flags.length) lines.push(`State GIS shows: ${flags.join('; ')}. If the parcel is in a redevelopment or rehabilitation area, find the adopted redevelopment plan and use its standards, since it supersedes base zoning.`);
  lines.push('New Jersey specifics: residential parking follows RSIS (N.J.A.C. 5:21) unless a redevelopment plan sets its own; check for Mount Laurel affordable housing overlays or inclusionary set-asides adopted under the town\'s Fourth Round Housing Element and Fair Share Plan; note any steep slope, tree removal or stormwater ordinances that limit disturbance.');
  return lines.join('\n');
}

module.exports = { researchContext };
