// Run: npm test
const assert = require('assert');
const Z = require('../public/zoning-engine.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('FAR binds when coverage x height allows more', () => {
  const r = Z.analyze({ property: { lotAreaSF: 10000, frontageFt: 100, depthFt: 100 },
    rules: { far: { residential: 1 }, maxLotCoveragePct: 50, maxHeightFt: 40 } });
  const s = r.scenarios[0];
  assert.strictEqual(s.gfa, 10000); assert.strictEqual(s.gfaBinding, 'FAR');
  assert.strictEqual(r.floors.value, 3); // 40 / 10.5
});

t('Setbacks bind footprint on a narrow lot', () => {
  const r = Z.analyze({ property: { lotAreaSF: 5000, frontageFt: 50, depthFt: 100 },
    rules: { maxLotCoveragePct: 60, maxStories: 3, setbacks: { frontFt: 25, rearFt: 30, sideFt: 8 } } });
  assert.strictEqual(r.footprint.binding, 'Setbacks');
  assert.strictEqual(r.footprint.value, 34 * 45);
});

t('Density caps units and right-sizes the program', () => {
  const r = Z.analyze({ property: { lotAreaSF: 87120 }, rules: { far: { residential: 1.2 }, density: { maxUnitsPerAcre: 24 } } });
  const s = r.scenarios[0];
  assert.strictEqual(s.units, 48); assert.ok(s.rightsized); assert.ok(s.programGFA < s.gfa);
});

t('Lot area per unit', () => {
  const r = Z.analyze({ property: { lotAreaSF: 20000 }, rules: { far: { residential: 2 }, density: { minLotAreaPerUnitSF: 1500 } } });
  assert.strictEqual(r.scenarios[0].units, 13);
});

t('Nonconforming lot flagged', () => {
  const r = Z.analyze({ property: { lotAreaSF: 6000, frontageFt: 50 }, rules: { minLotAreaSF: 7500, far: { residential: 0.5 } } });
  assert.ok(r.nonconforming);
});

t('Surface parking shortfall back-solves units', () => {
  const r = Z.analyze({ property: { lotAreaSF: 20000, frontageFt: 100, depthFt: 200 },
    rules: { far: { residential: 1.5 }, maxLotCoveragePct: 40, maxImperviousPct: 80, maxStories: 4, parking: { perUnit: 2 } } });
  const s = r.scenarios[0];
  assert.strictEqual(s.parkingFit.fits, false);
  assert.strictEqual(s.unitsWithSurfaceParking, Math.floor(Math.floor(8000 / 350) / 2));
});

t('Inclusionary set-aside rounds up', () => {
  const r = Z.analyze({ property: { lotAreaSF: 43560 }, rules: { far: { residential: 1 }, density: { maxUnits: 21 }, inclusionaryPct: 20 } });
  assert.strictEqual(r.scenarios[0].affordableUnits, 5);
});

t('Bonus FAR applies only when toggled', () => {
  const base = { property: { lotAreaSF: 10000 }, rules: { far: { residential: 2 }, bonuses: [{ name: 'B', farBonus: 0.5, apply: false }] } };
  assert.strictEqual(Z.analyze(base).scenarios[0].gfa, 20000);
  base.rules.bonuses[0].apply = true;
  assert.strictEqual(Z.analyze(base).scenarios[0].gfa, 25000);
});

t('Multiple use scenarios from NYC-style FARs', () => {
  const r = Z.analyze({ property: { lotAreaSF: 49614 }, rules: { far: { residential: 10, commercial: 15, communityFacility: 15 } } });
  assert.deepStrictEqual(r.scenarios.map((s) => s.key), ['residential', 'commercial', 'communityFacility']);
});

t('Flood zone AE raises a high flag', () => {
  const r = Z.analyze({ property: { lotAreaSF: 10000, floodZone: 'AE' }, rules: { far: { residential: 1 } } });
  assert.ok(r.flags.some((f) => f.type === 'flood' && f.severity === 'high'));
});

console.log(`\n${n} tests passed`);
