/*!
 * Shared description of the zoning "rules" object, used by every research path
 * (server-side Claude research, in-page ordinance parsing, and the Claude skill).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZoningSchema = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RULES_SCHEMA = `{
  "jurisdiction": "Governing municipality (in NJ the township/borough/city, never the county)",
  "district": "Zoning district code, e.g. R-5, B-2, C4-4A",
  "districtName": "Full district name",
  "ordinanceUpdated": "Date of the most recent amendment you saw, or null",
  "uses": {
    "permitted": ["principal permitted uses, short phrases"],
    "conditional": ["conditional / special-exception uses"],
    "accessory": ["accessory uses"],
    "prohibited": ["notable prohibited uses"]
  },
  "minLotAreaSF": number|null,
  "minLotWidthFt": number|null,
  "minLotDepthFt": number|null,
  "far": { "residential": number|null, "commercial": number|null, "communityFacility": number|null, "industrial": number|null, "mixedMax": number|null },
  "maxLotCoveragePct": number|null,        // building coverage, percent 0-100
  "maxImperviousPct": number|null,         // total impervious coverage, percent 0-100
  "maxBuildingFootprintSF": number|null,
  "maxGFASF": number|null,                 // absolute floor-area cap if the code has one (common for single-family)
  "maxHeightFt": number|null,
  "maxStories": number|null,
  "setbacks": { "frontFt": number|null, "sideFt": number|null, "sideTotalFt": number|null, "rearFt": number|null, "cornerSideFt": number|null },
  "density": { "maxUnitsPerAcre": number|null, "minLotAreaPerUnitSF": number|null, "dwellingUnitFactor": number|null, "maxUnits": number|null, "singleFamilyOnly": boolean },
  "minUnitSizeSF": number|null,
  "parking": { "perUnit": number|null, "guestPerUnit": number|null, "perKSFRetail": number|null, "perKSFOffice": number|null, "perKSFIndustrial": number|null, "perKSFCommunity": number|null, "reductionPct": number|null, "waived": boolean, "rsis": boolean, "loadingBerths": "text or null" },
  "inclusionaryPct": number|null,          // required affordable set-aside, percent of units
  "bonuses": [ { "name": "", "farBonus": number|null, "unitsBonus": number|null, "description": "", "apply": false } ],
  "overlays": [ { "type": "overlay|historic|redevelopment|special district|environmental|airport|flood|incentive", "name": "", "severity": "high|info|positive", "effect": "how it changes what can be built", "source": "" } ],
  "approvals": [ "What approvals a typical multifamily or mixed-use project would need (site plan, variances, conditional use, historic review, etc.)" ],
  "stateOverrides": [ "State laws that override local zoning here (e.g. NJ RSIS parking for residential; CA SB 9/ADU; MA MBTA Communities; NYC City of Yes)" ],
  "notes": [ "Anything that materially affects buildout but doesn't fit above" ],
  "confidence": { "overall": "high|medium|low", "lowConfidenceFields": ["field names you inferred or could not verify"] },
  "citations": [ { "label": "Ordinance section and title, e.g. §21-12.4 R-5 District bulk standards", "url": "https://..." } ]
}`;

  const RULES_RULES = [
    'Use null for anything the code does not regulate or that you could not find. Never guess a number; leave it null and list the field under confidence.lowConfidenceFields.',
    'Convert units: acres to SF (1 acre = 43,560 SF), percentages to 0-100, heights to feet. Lot area per unit goes in minLotAreaPerUnitSF.',
    'If the district has different standards by building type (e.g. single-family vs townhouse vs multifamily), use the standards for the most intensive permitted residential type and explain the others in notes.',
    'If a FAR is not used, leave far fields null rather than inventing one; coverage, height and setbacks will define the envelope.',
    'In New Jersey, residential parking is governed statewide by RSIS (N.J.A.C. 5:21). Set parking.rsis true and leave perUnit null unless the municipality has an RSIS-exempt plan or redevelopment plan with its own ratio.',
    'Record redevelopment plans, rehabilitation areas, historic districts, inclusionary overlays and special districts in overlays, since these frequently supersede base zoning.',
    'Cite the specific ordinance sections you relied on with working URLs.'
  ];

  function researchPrompt(ctx) {
    return `You are a land-use and zoning analyst. Determine what can be built on this property under current zoning.

PROPERTY
${JSON.stringify(ctx.property || {}, null, 2)}

ALREADY KNOWN
${ctx.district ? `Zoning district from authoritative data: ${ctx.district}` : 'Zoning district: unknown. Find it on the municipality\'s official zoning map (often an ArcGIS viewer, a PDF map, or a county GIS portal). If you cannot confirm it, give your best supported determination and mark district as low confidence.'}
${ctx.extra || ''}

TASK
1. Identify the governing jurisdiction and its current zoning ordinance (eCode360, Municode, American Legal, Code Publishing, or the municipality's own site).
2. Determine the zoning district and any overlays, redevelopment plans, special districts or historic designations covering this parcel.
3. Extract the district's use and bulk standards, parking requirements, density limits, inclusionary requirements and bonuses.
4. Note state laws that override local zoning here.

Return ONLY a JSON object matching this schema (comments explain fields; omit the comments):
${RULES_SCHEMA}

Rules:
- ${RULES_RULES.join('\n- ')}`;
  }

  function parsePrompt(ordinanceText, ctx) {
    return `Extract zoning standards from the ordinance text below into JSON.

${ctx && ctx.district ? `Target district: ${ctx.district}. If the text covers several districts, extract only this one.` : 'If the text covers several districts, extract the one the reader most likely means and name it in "district".'}
${ctx && ctx.jurisdiction ? `Jurisdiction: ${ctx.jurisdiction}` : ''}

Return ONLY a JSON object matching this schema (comments explain fields; omit the comments):
${RULES_SCHEMA}

Rules:
- ${RULES_RULES.join('\n- ')}
- Only use what the text says. Anything not in the text stays null. Citations should name the sections that appear in the text (url may be empty).

ORDINANCE TEXT
"""
${ordinanceText}
"""`;
  }

  return { RULES_SCHEMA, RULES_RULES, researchPrompt, parsePrompt };
});
