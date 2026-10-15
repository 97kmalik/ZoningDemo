// Offline tests for the NJ data helpers. Run: npm test
const assert = require('assert');
const P = require('../lib/nj-parcels');
const { municipalityFor } = require('../lib/geo');
const { pickFields, baseName, TITLE_ZONING } = require('../lib/nj-zoning');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('tax-record dimensions', () => {
  assert.deepStrictEqual(P.taxDims('210X208'), { frontageFt: 210, depthFt: 208 });
  assert.deepStrictEqual(P.taxDims('50 X 100.5'), { frontageFt: 50, depthFt: 100.5 });
  assert.strictEqual(P.taxDims('0.3788 AC'), null);
});

t('MOD-IV deed dates', () => {
  assert.strictEqual(P.deedDate('220822'), '2022-08-22');
  assert.strictEqual(P.deedDate('950101'), '1995-01-01');
  assert.strictEqual(P.deedDate(''), null);
});

t('building description codes', () => {
  assert.strictEqual(P.decodeBldgDesc('2SF2G'), '2-story, frame, 2-car garage');
  assert.strictEqual(P.decodeBldgDesc('1SB3G'), '1-story, brick, 3-car garage');
});

t('parcel outline to frontage and depth', () => {
  // 100 ft x 200 ft rectangle near 40.7N
  const dLat = 200 / 364000, dLng = 100 / (364000 * Math.cos(40.7 * Math.PI / 180));
  const ring = [[-74, 40.7], [-74 + dLng, 40.7], [-74 + dLng, 40.7 + dLat], [-74, 40.7 + dLat], [-74, 40.7]];
  const d = P.parcelDims(ring);
  assert.strictEqual(d.frontageFtEst, 100); assert.strictEqual(d.depthFtEst, 200);
  assert.ok(Math.abs(d.polygonAreaSF - 20000) < 50);
});

t('Census county subdivision to NJ municipal code', () => {
  assert.strictEqual(municipalityFor('Millburn township', 'Essex County').code, '0712');
  assert.strictEqual(municipalityFor('Plainfield city', 'Union County').code, '2012');
  // Same name in several counties resolves by county
  const f = municipalityFor('Franklin township', 'Somerset County');
  assert.strictEqual(f.county, 'Somerset');
});

t('zone field detection', () => {
  assert.deepStrictEqual(pickFields({ OBJECTID: 1, Zone: 'R-3', Zone_Desc: 'R-3: Residential 29,000 Sq. Ft.' }), { zoneField: 'Zone', descField: 'Zone_Desc' });
  assert.strictEqual(pickFields({ ZONENAME: 'Light Industrial' }).zoneField, 'ZONENAME');
});

t('zoning layer titles', () => {
  assert.ok(TITLE_ZONING.test('Township of Millburn: Zoning'));
  assert.ok(TITLE_ZONING.test('Monroe Zoning Districts'));
  assert.ok(!TITLE_ZONING.test('Tidszoner'));
  assert.strictEqual(baseName('Millburn Township'), 'Millburn');
});

console.log(`\n${n} parser tests passed`);
