/*!
 * Zoning Engine — jurisdiction-agnostic buildout + feasibility calculator.
 * Works in the browser (window.ZoningEngine) and Node (module.exports).
 *
 * Inputs are a "zoning packet":
 *   { property: {...}, rules: {...}, overlays: [...], assumptions: {...}, market: {...} }
 * Every rule is optional; the engine computes what it can, names the binding
 * constraint, and lists what's missing.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZoningEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SF_PER_ACRE = 43560;

  const DEFAULT_ASSUMPTIONS = {
    floorToFloorResFt: 10.5,     // residential floor-to-floor
    floorToFloorComFt: 14,       // ground-floor retail / office
    groundFloorRetail: false,    // mixed-use: put commercial on floor 1
    efficiency: 0.82,            // net rentable / gross
    avgUnitNetSF: 850,
    parkingSFPerSpace: 350,      // surface stall + aisle
    structuredParking: false,    // if true, parking does not consume land
    landscapeBufferPct: 0.10,    // of lot area kept unpaved beyond coverage rules
    gfaCountsBasement: false,
    maxAvgUnitNetSF: 1300,       // cap on unit size when density, not floor area, binds
    proposedGFASF: null          // optional: the program actually planned, tested against the max
  };

  const DEFAULT_MARKET = {
    tenure: 'rental',            // 'rental' | 'sale'
    rentPerNetSFMonth: 3.50,
    otherIncomePct: 0.03,
    vacancyPct: 0.05,
    opexPct: 0.32,               // of EGI
    exitCapRate: 0.0575,
    salePricePerNetSF: 650,
    retailRentPerSFYear: 35,
    hardCostPerGSF: 250,           // wood-frame mid-rise; podium/steel runs higher
    softCostPct: 0.22,           // of hard
    parkingCostPerStructuredSpace: 32000,
    developerMarginPct: 0.12,    // of total value
    financingCostPct: 0.06       // of hard+soft
  };

  // ---------- helpers ----------
  const num = (v) => (v === null || v === undefined || v === '' || isNaN(+v) ? null : +v);
  const pos = (v) => { const n = num(v); return n !== null && n > 0 ? n : null; };
  const minOf = (cands) => {
    const valid = cands.filter((c) => c.value !== null && isFinite(c.value));
    if (!valid.length) return { value: null, binding: null, all: cands };
    const best = valid.reduce((a, b) => (b.value < a.value ? b : a));
    return { value: best.value, binding: best.label, all: cands };
  };
  const round = (n, d = 0) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);

  // ---------- core ----------
  function analyze(packet) {
    const p = packet || {};
    const prop = p.property || {};
    const rules = p.rules || {};
    const A = Object.assign({}, DEFAULT_ASSUMPTIONS, p.assumptions || {});
    const M = Object.assign({}, DEFAULT_MARKET, p.market || {});
    const warnings = [];
    const missing = [];

    // ---- lot geometry ----
    let lotSF = pos(prop.lotAreaSF);
    if (!lotSF && pos(prop.lotAcres)) lotSF = prop.lotAcres * SF_PER_ACRE;
    const front = pos(prop.frontageFt);
    let depth = pos(prop.depthFt);
    if (!lotSF && front && depth) lotSF = front * depth;
    if (!depth && lotSF && front) depth = lotSF / front;
    if (!lotSF) missing.push('Lot area');
    const acres = lotSF ? lotSF / SF_PER_ACRE : null;

    const sb = rules.setbacks || {};
    const fSB = num(sb.frontFt) || 0;
    const rSB = num(sb.rearFt) || 0;
    let sideEach = num(sb.sideFt);
    let sideTotal = num(sb.sideTotalFt);
    if (prop.cornerLot && num(sb.cornerSideFt) !== null) {
      // corner lot: one side is a second front
      sideTotal = (num(sb.cornerSideFt) || 0) + (sideEach || 0);
    }
    if (sideTotal === null) sideTotal = (sideEach || 0) * 2;
    if (sideEach === null && sb.sideTotalFt) sideEach = sideTotal / 2;

    // Buildable "box" after setbacks (rectangular approximation)
    let boxW = null, boxD = null, boxSF = null;
    if (front && depth) {
      boxW = Math.max(0, front - sideTotal);
      boxD = Math.max(0, depth - fSB - rSB);
      boxSF = boxW * boxD;
    } else if (lotSF && (fSB || rSB || sideTotal)) {
      // square-lot approximation when only area is known
      const s = Math.sqrt(lotSF);
      boxW = Math.max(0, s - sideTotal);
      boxD = Math.max(0, s - fSB - rSB);
      boxSF = boxW * boxD;
      warnings.push('Frontage and depth unknown, so setbacks were applied to a square lot of equal area. Enter actual dimensions for an accurate footprint.');
    }

    // ---- lot conformity ----
    const conformity = [];
    const chk = (label, actual, req, unit, cmp = '>=') => {
      if (req === null || req === undefined || actual === null) return;
      const ok = cmp === '>=' ? actual >= req : actual <= req;
      conformity.push({ label, actual: round(actual, 1), required: req, unit, ok });
    };
    chk('Lot area', lotSF, num(rules.minLotAreaSF), 'SF');
    chk('Lot width / frontage', front, num(rules.minLotWidthFt), 'ft');
    chk('Lot depth', depth, num(rules.minLotDepthFt), 'ft');
    const nonconforming = conformity.some((c) => !c.ok);
    if (nonconforming) warnings.push('The lot does not meet one or more minimum lot standards. Development may need a variance (in NJ, a "c" bulk variance) or rely on an undersized-lot provision.');

    // ---- footprint ----
    const covPct = num(rules.maxLotCoveragePct);
    const footprint = minOf([
      { label: 'Lot coverage', value: lotSF && covPct !== null ? lotSF * covPct / 100 : null },
      { label: 'Setbacks', value: boxSF },
      { label: 'Max footprint rule', value: pos(rules.maxBuildingFootprintSF) },
      { label: 'Lot area', value: lotSF }
    ]);

    // ---- floors ----
    const ftf = A.groundFloorRetail ? null : A.floorToFloorResFt;
    const hMax = pos(rules.maxHeightFt);
    let floorsByHeight = null;
    if (hMax) {
      floorsByHeight = A.groundFloorRetail
        ? 1 + Math.floor(Math.max(0, hMax - A.floorToFloorComFt) / A.floorToFloorResFt)
        : Math.floor(hMax / ftf);
    }
    const floors = minOf([
      { label: 'Height limit (ft)', value: floorsByHeight },
      { label: 'Story limit', value: pos(rules.maxStories) }
    ]);
    if (!floors.value) missing.push('Height or story limit');

    // ---- use scenarios ----
    const far = rules.far || {};
    const legacyFar = num(rules.maxFAR);
    const scenarios = [];
    const useDefs = [
      { key: 'residential', label: 'Residential', far: num(far.residential) ?? legacyFar },
      { key: 'commercial', label: 'Commercial', far: num(far.commercial) },
      { key: 'communityFacility', label: 'Community facility', far: num(far.communityFacility) },
      { key: 'industrial', label: 'Industrial', far: num(far.industrial) },
      { key: 'mixed', label: 'Mixed use (max combined)', far: num(far.mixedMax) }
    ];
    const bonusFar = (rules.bonuses || [])
      .filter((b) => b && b.apply && num(b.farBonus))
      .reduce((s, b) => s + num(b.farBonus), 0);

    for (const u of useDefs) {
      const isRes = u.key === 'residential' || u.key === 'mixed';
      if (u.far === null && !(u.key === 'residential' && (floors.value || footprint.value))) continue;
      if (u.far === null && u.key !== 'residential') continue;
      const farTotal = u.far !== null ? u.far + (isRes ? bonusFar : 0) : null;
      const gfa = minOf([
        { label: 'FAR', value: lotSF && farTotal !== null ? lotSF * farTotal : null },
        { label: footprint.binding ? `Footprint (${footprint.binding}) × floors (${floors.binding || 'n/a'})` : 'Footprint × floors',
          value: footprint.value && floors.value ? footprint.value * floors.value : null },
        { label: 'Max GFA rule', value: pos(rules.maxGFASF) }
      ]);
      const s = {
        key: u.key, label: u.label, far: u.far, bonusFar: isRes ? bonusFar : 0,
        gfa: round(gfa.value), gfaBinding: gfa.binding, gfaCandidates: gfa.all.map((c) => ({ label: c.label, value: round(c.value) })),
        floorsUsed: footprint.value && gfa.value ? Math.min(floors.value || Infinity, Math.ceil(gfa.value / footprint.value)) : null
      };

      if (isRes && gfa.value) {
        Object.assign(s, residentialYield(gfa.value, lotSF, acres, rules, A, warnings));
      }
      s.parking = parkingRequired(s, rules, gfa.value, u.key);
      s.parkingFit = parkingFit(s.parking.spaces, lotSF, footprint.value, rules, A);
      if (isRes && s.parkingFit && !s.parkingFit.fits && s.units) {
        // back-solve units that fit with surface parking
        const perUnit = (num((rules.parking || {}).perUnit) || 0) + (num((rules.parking || {}).guestPerUnit) || 0);
        if (perUnit > 0 && s.parkingFit.availableSF >= 0) {
          const maxSpaces = Math.floor(s.parkingFit.availableSF / A.parkingSFPerSpace);
          s.unitsWithSurfaceParking = Math.max(0, Math.floor(maxSpaces / perUnit));
        }
      }
      scenarios.push(s);
    }
    if (!scenarios.length) missing.push('FAR or bulk standards for at least one use');

    // ---- uses ----
    const uses = {
      permitted: rules.uses?.permitted || [],
      conditional: rules.uses?.conditional || [],
      accessory: rules.uses?.accessory || [],
      prohibited: rules.uses?.prohibited || []
    };

    // ---- feasibility (best residential scenario) ----
    const resScenario = scenarios.find((s) => s.key === 'mixed' && s.units) || scenarios.find((s) => s.key === 'residential' && s.units);
    const feasibility = resScenario ? residualLandValue(resScenario, A, M, prop) : null;
    const comScenario = scenarios.find((s) => s.key === 'commercial' && s.gfa);
    const feasibilityCommercial = comScenario ? commercialRLV(comScenario, A, M, prop) : null;

    // ---- existing vs. potential ----
    const existing = {
      bldgSF: pos(prop.existingBldgSF), units: num(prop.existingUnits),
      builtFAR: lotSF && pos(prop.existingBldgSF) ? round(prop.existingBldgSF / lotSF, 2) : null
    };
    const maxGFA = Math.max(0, ...scenarios.map((s) => s.gfa || 0)) || null;
    existing.unusedGFA = maxGFA && existing.bldgSF !== null ? round(maxGFA - existing.bldgSF) : null;
    existing.utilizationPct = maxGFA && existing.bldgSF ? round(existing.bldgSF / maxGFA * 100) : null;
    if (existing.utilizationPct > 100) warnings.push(`The existing building is about ${existing.utilizationPct}% of what current zoning allows. It is likely a legal non-complying structure: keep it, since a teardown would rebuild smaller.`);

    // ---- overlays / risk flags ----
    const flags = buildFlags(p.overlays || [], prop, rules);

    return {
      lot: { lotSF: round(lotSF), acres: round(acres, 3), frontageFt: front, depthFt: round(depth, 1),
        cornerLot: !!prop.cornerLot, buildableBox: boxSF ? { widthFt: round(boxW, 1), depthFt: round(boxD, 1), areaSF: round(boxSF) } : null,
        setbacks: { frontFt: fSB, rearFt: rSB, sideEachFt: sideEach, sideTotalFt: sideTotal } },
      conformity, nonconforming,
      footprint: { value: round(footprint.value), binding: footprint.binding, candidates: footprint.all.map((c) => ({ label: c.label, value: round(c.value) })) },
      floors: { value: floors.value, binding: floors.binding, heightFt: hMax },
      scenarios, uses, existing, feasibility, feasibilityCommercial, flags,
      assumptions: A, market: M, warnings, missing
    };
  }

  function residentialYield(gfa, lotSF, acres, rules, A, warnings) {
    const d = rules.density || {};
    const netSF = gfa * A.efficiency;
    const minUnit = pos(rules.minUnitSizeSF);
    const avgUnit = Math.max(A.avgUnitNetSF, minUnit || 0);
    const units = minOf([
      { label: 'Density (units/acre)', value: acres && pos(d.maxUnitsPerAcre) ? Math.floor(acres * d.maxUnitsPerAcre + 1e-9) : null },
      { label: 'Lot area per unit', value: lotSF && pos(d.minLotAreaPerUnitSF) ? Math.floor(lotSF / d.minLotAreaPerUnitSF + 1e-9) : null },
      { label: 'Dwelling unit factor', value: pos(d.dwellingUnitFactor) ? Math.floor(gfa / d.dwellingUnitFactor) : null },
      { label: 'Max units rule', value: pos(d.maxUnits) },
      { label: `Floor area ÷ ${round(avgUnit)} SF avg unit`, value: Math.floor(netSF / avgUnit) }
    ]);
    if (d.singleFamilyOnly) {
      units.all.push({ label: 'One dwelling per lot', value: 1 });
      units.value = 1; units.binding = 'One dwelling per lot';
    }
    // If density (not floor area) binds, right-size the building: units at a
    // realistic size, capped by the zoning GFA. A single house keeps its full GFA.
    let programNetSF = netSF;
    if (!d.singleFamilyOnly && units.value && units.binding && !units.binding.startsWith('Floor area')) {
      const maxAvg = Math.max(A.maxAvgUnitNetSF || 1300, avgUnit);
      programNetSF = Math.min(netSF, units.value * maxAvg);
    }
    // A proposed program (e.g. the house or building actually planned) overrides the max.
    const proposed = pos(A.proposedGFASF);
    let proposedCheck = null;
    if (proposed) {
      proposedCheck = { proposedGFA: proposed, allowedGFA: round(gfa), fits: proposed <= gfa + 0.5, headroomSF: round(gfa - proposed) };
      if (!proposedCheck.fits) warnings.push(`The proposed ${round(proposed).toLocaleString()} SF exceeds the ${round(gfa).toLocaleString()} SF allowed. That needs a floor-area variance (in NJ, a "d(4)" variance from the zoning board).`);
      programNetSF = Math.min(proposed, gfa) * A.efficiency;
    }
    const programGFA = programNetSF / A.efficiency;
    const incl = num(rules.inclusionaryPct);
    const affordable = units.value && incl ? Math.ceil(units.value * incl / 100) : 0;
    return {
      netSF: round(netSF), units: units.value, unitsBinding: units.binding,
      unitCandidates: units.all.map((c) => ({ label: c.label, value: c.value })),
      affordableUnits: affordable, marketUnits: units.value ? units.value - affordable : null,
      avgUnitNetSF: units.value ? round(programNetSF / units.value) : null,
      programNetSF: round(programNetSF), programGFA: round(programGFA),
      rightsized: !proposed && programNetSF < netSF - 1, proposedCheck
    };
  }

  function parkingRequired(s, rules, gfa, key) {
    const pk = rules.parking || {};
    const lines = [];
    let spaces = 0;
    if (s.units) {
      const pu = num(pk.perUnit);
      if (pu !== null) { lines.push({ label: `${s.units} units × ${pu}`, spaces: s.units * pu }); spaces += s.units * pu; }
      const g = num(pk.guestPerUnit);
      if (g) { lines.push({ label: `Guest: ${s.units} × ${g}`, spaces: s.units * g }); spaces += s.units * g; }
      if (pu === null && pk.rsis) lines.push({ label: 'Per NJ RSIS (by bedroom count, roughly 1.8–2.0 per unit for garden apartments)', spaces: null });
    }
    const ksf = gfa ? gfa / 1000 : 0;
    const perK = { commercial: num(pk.perKSFRetail), communityFacility: num(pk.perKSFCommunity), industrial: num(pk.perKSFIndustrial) }[key];
    if (perK && ksf) { lines.push({ label: `${round(ksf, 1)} KSF × ${perK}`, spaces: ksf * perK }); spaces += ksf * perK; }
    const office = num(pk.perKSFOffice);
    if (key === 'commercial' && office && !perK && ksf) { lines.push({ label: `Office: ${round(ksf, 1)} KSF × ${office}`, spaces: ksf * office }); spaces += ksf * office; }
    const red = num(pk.reductionPct);
    if (red && spaces) { lines.push({ label: `Reduction ${red}% (transit / shared)`, spaces: -spaces * red / 100 }); spaces *= 1 - red / 100; }
    if (pk.waived) { lines.push({ label: 'Parking waived in this district', spaces: -spaces }); spaces = 0; }
    return { spaces: Math.ceil(spaces - 1e-9), lines: lines.map((l) => ({ label: l.label, spaces: l.spaces === null ? null : round(l.spaces, 1) })), loading: pk.loadingBerths || null };
  }

  function parkingFit(spaces, lotSF, footprint, rules, A) {
    if (!spaces || !lotSF || !footprint) return null;
    if (A.structuredParking) return { fits: true, structured: true, requiredSF: spaces * A.parkingSFPerSpace, availableSF: null };
    const imp = num(rules.maxImperviousPct);
    const paveable = (imp !== null ? lotSF * imp / 100 : lotSF * (1 - A.landscapeBufferPct)) - footprint;
    const required = spaces * A.parkingSFPerSpace;
    return { fits: required <= paveable, structured: false, requiredSF: round(required), availableSF: round(Math.max(0, paveable)), shortfallSF: round(Math.max(0, required - paveable)) };
  }

  function residualLandValue(s, A, M, prop) {
    const netSF = s.programNetSF || s.netSF;
    const gfa = s.programGFA || s.gfa;
    const affordShare = s.units ? (s.affordableUnits || 0) / s.units : 0;
    const affordDiscount = 0.45; // affordable rents ≈ 55% of market
    let value, noi = null, gpr = null;
    if (M.tenure === 'sale') {
      value = netSF * M.salePricePerNetSF * (1 - affordShare * affordDiscount);
    } else {
      gpr = netSF * M.rentPerNetSFMonth * 12 * (1 - affordShare * affordDiscount);
      const egi = gpr * (1 + M.otherIncomePct) * (1 - M.vacancyPct);
      noi = egi * (1 - M.opexPct);
      value = noi / M.exitCapRate;
    }
    const hard = gfa * M.hardCostPerGSF;
    const structured = s.parkingFit && s.parkingFit.structured ? (s.parking.spaces || 0) * M.parkingCostPerStructuredSpace : 0;
    const soft = (hard + structured) * M.softCostPct;
    const fin = (hard + structured + soft) * M.financingCostPct;
    const margin = value * M.developerMarginPct;
    const cost = hard + structured + soft + fin;
    const rlv = value - cost - margin;
    const assessedLand = pos(prop.landValue);
    return {
      scenario: s.label, tenure: M.tenure,
      grossPotentialRent: round(gpr), noi: round(noi), value: round(value),
      costs: { hard: round(hard), structuredParking: round(structured), soft: round(soft), financing: round(fin), total: round(cost) },
      developerMargin: round(margin), residualLandValue: round(rlv),
      programGFA: round(gfa), programNetSF: round(netSF),
      perUnit: s.units ? round(rlv / s.units) : null, perBuildableSF: gfa ? round(rlv / gfa, 2) : null,
      yieldOnCost: noi ? round(noi / (cost + Math.max(rlv, 0)) * 100, 2) : null,
      assessedLandValue: assessedLand, rlvToAssessed: assessedLand ? round(rlv / assessedLand, 2) : null
    };
  }

  function commercialRLV(s, A, M, prop) {
    const net = s.gfa * A.efficiency;
    const noi = net * M.retailRentPerSFYear * (1 - M.vacancyPct) * (1 - 0.1);
    const value = noi / (M.exitCapRate + 0.0075);
    const hard = s.gfa * M.hardCostPerGSF * 0.85;
    const soft = hard * M.softCostPct, fin = (hard + soft) * M.financingCostPct;
    const margin = value * M.developerMarginPct;
    const rlv = value - hard - soft - fin - margin;
    return { scenario: s.label, noi: round(noi), value: round(value), costs: { hard: round(hard), soft: round(soft), financing: round(fin), total: round(hard + soft + fin) }, developerMargin: round(margin), residualLandValue: round(rlv), perBuildableSF: round(rlv / s.gfa, 2) };
  }

  function buildFlags(overlays, prop, rules) {
    const flags = [];
    for (const o of overlays) {
      if (!o) continue;
      flags.push({ type: o.type || 'overlay', name: o.name, severity: o.severity || 'info', effect: o.effect || '', source: o.source || '' });
    }
    const fz = (prop.floodZone || '').toUpperCase();
    if (fz) {
      const sfha = /^(A|AE|AH|AO|AR|A99|V|VE)/.test(fz);
      flags.push({ type: 'flood', name: `FEMA flood zone ${fz}`, severity: sfha ? 'high' : 'info',
        effect: sfha ? 'Special Flood Hazard Area. Lowest floor must sit above base flood elevation plus freeboard (NJ requires BFE + 1 ft at minimum). Expect flood insurance and possibly state stream-encroachment permits.' : 'Outside the 1% annual-chance floodplain.', source: 'FEMA NFHL' });
    }
    if (prop.historic) flags.push({ type: 'historic', name: prop.historic, severity: 'high', effect: 'Exterior changes and demolition need historic commission approval. Massing may be limited below zoning maximums.', source: '' });
    if (prop.opportunityZone) flags.push({ type: 'incentive', name: 'Qualified Opportunity Zone', severity: 'positive', effect: 'Capital gains deferral and exclusion for qualifying investments.', source: '' });
    if (prop.redevelopmentArea) flags.push({ type: 'incentive', name: prop.redevelopmentArea, severity: 'positive', effect: 'A redevelopment plan may supersede base zoning and allow PILOT abatements.', source: '' });
    if (rules.siteplanThresholdUnits) flags.push({ type: 'process', name: 'Site plan review', severity: 'info', effect: `Required at ${rules.siteplanThresholdUnits}+ units.`, source: '' });
    return flags;
  }

  // NJ RSIS residential parking (N.J.A.C. 5:21-4.14), garden apartment / mid-rise / high-rise by bedrooms
  const NJ_RSIS = {
    'garden apartment': { 1: 1.8, 2: 2.0, 3: 2.1 },
    'mid-rise apartment': { 1: 1.7, 2: 1.8, 3: 1.9 },
    'high-rise apartment': { 1: 0.8, 2: 1.3, 3: 1.9 },
    'townhouse': { 1: 1.8, 2: 2.3, 3: 2.4 },
    'single-family detached': { 2: 1.5, 3: 2.0, 4: 2.5, 5: 3.0 }
  };

  return { analyze, DEFAULT_ASSUMPTIONS, DEFAULT_MARKET, NJ_RSIS, SF_PER_ACRE, version: '1.0.0' };
});
