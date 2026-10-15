// Live checks against the state services. Needs network. Run: npm run test:live
const assert = require('assert');
const { lookup } = require('../lib/pipeline');

(async () => {
  const r = await lookup({ mode: 'address', address: '900 S Orange Ave, Short Hills, NJ 07078' });
  assert.ok(!r.error, r.error);
  const p = r.packet;
  assert.strictEqual(p.property.parcelId, 'Block 4206, Lot 3');
  assert.strictEqual(p.property.municipalityCode, '0712');
  assert.strictEqual(p.rules.district, 'R-3');
  assert.ok(p.property.lotAreaSF > 40000);
  assert.ok(p.overlays.some((o) => /sewer service/i.test(o.name)));
  assert.ok(p.context.links.ordinance.includes('ecode360'));
  console.log('ok 900 S Orange Ave resolves to Millburn B4206 L3, R-3, sewered');

  const b = await lookup({ mode: 'blocklot', municipality: 'Plainfield City', block: '604', lot: '8' });
  assert.ok(!b.error, b.error);
  assert.ok(b.packet.overlays.some((o) => /Opportunity Zone/.test(o.name)));
  assert.ok(b.packet.overlays.some((o) => /station/.test(o.name)));
  console.log('ok Plainfield B604 L8 shows Opportunity Zone and rail station');
  console.log('\nlive tests passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
