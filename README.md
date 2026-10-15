# NJ Zoning Envelope

**Live tool: https://97kmalik.github.io/ZoningDemo/**

What can be built on a New Jersey property. Enter an address or a municipality, block and lot, and get:

- **The parcel:** lot size and dimensions, property class, building, assessment, last sale and owner of record from the state tax list (MOD-IV).
- **The zoning district:** from the town's own zoning map layer where one is published (a town, county or regional zoning layer covers 322 of the 564 municipalities), from the NJTPA county compilations for about 280 North Jersey towns, and otherwise from Claude reading the official ordinance. Every town's official ordinance and map links are built in (all 564).
- **What the district allows:** uses, lot minimums, FAR, coverage, height, setbacks, density, parking, affordable set-asides and bonuses, with citations to the ordinance sections.
- **The buildable envelope:** footprint, stories, floor area and unit count, with the binding constraint named at each step, plus a site plan and section drawing and a test of any program you plan.
- **Site constraints and incentives** from 25+ state layers: wetlands, C1 streams, Highlands, Pinelands, CAFRA, contaminated sites, deed notices, preserved open space and farmland, sewer service area, historic districts, redevelopment and rehabilitation areas, Urban Enterprise and Opportunity Zones, rail stations, airports and FEMA flood zones.
- **Comparable sales** within half a mile over five years, an estimated effective tax rate, and a residual land value.

It runs as a small Node server with a browser UI. The same page also works as a Claude artifact (load a packet, parse ordinance text), and `skill/SKILL.md` lets Claude produce a packet for any NJ property in chat.

## Two ways to run it

**GitHub Pages (no server).** `docs/` is a static build where every lookup runs in the visitor's browser against the state's public services. Ordinance research uses the visitor's own Anthropic API key, saved only in their browser. The NJTPA county zoning server blocks browser requests, so that one fallback is server-only. Rebuild after changing `lib/` or `public/`:

```bash
npm run build-pages
```

**Node server.** Everything, including NJTPA zoning and a shared API key on the server:

```bash
git clone https://github.com/97kmalik/ZoningDemo.git
cd ZoningDemo
cp .env.example .env        # add ANTHROPIC_API_KEY for ordinance research
npm start                   # http://localhost:8080
```

Node 18+, no npm dependencies. Parcel lookups, constraints, comps and zoning map layers work without a key; the key adds automatic ordinance research and ordinance-text parsing.

Deploy anywhere that runs Node or Docker (Render, Railway, Fly.io, Cloud Run): `docker build -t nj-zoning . && docker run -p 8080:8080 --env-file .env nj-zoning`.

## How a lookup works

```
address ──► Census geocoder ──► municipality code ─┐
block/lot ─────────────────────────────────────────┼─► NJ parcel + MOD-IV ─┬─► zoning layer (registry → search)
                                                    │                        ├─► NJTPA county zoning
                                                    │                        ├─► 25+ state constraint layers
                                                    │                        ├─► FEMA flood (whole parcel)
                                                    │                        └─► nearby sales, tax rate
                                                    └─► DCA ordinance + map links ──► Claude ordinance research
                                                                                            │
                                    zoning packet (JSON) ◄──────────────────────────────────┘
                                            │
                                            ▼
                         public/zoning-engine.js: envelope, units, parking, feasibility
```

Everything is assembled into one JSON **zoning packet** (`docs/example-packet-900-south-orange.json`). You can export it, edit it, load it back, or have Claude produce one.

## Project layout

```
server.js                    HTTP server and API (/api/lookup, /api/research, /api/parse)
lib/
  pipeline.js                orchestrates a lookup and seeds the packet
  nj-parcels.js              parcels, MOD-IV, comps, tax profile
  nj-zoning.js               municipal zoning layers (registry, then live search)
  nj-regional-zoning.js      NJTPA county zoning compilations and their bulk fields
  nj-constraints.js          state constraint and incentive layers
  geo.js                     geocoding, municipality matching, FEMA flood
  research.js                Claude API ordinance research (web search + fetch)
  http.js                    fetch helpers
public/
  workbench.html             the UI (also publishable as a Claude artifact)
  zoning-engine.js           buildout and feasibility engine (browser + Node)
  rules-schema.js            the zoning rules schema and research prompts
data/
  nj-municipalities.json     564 municipalities with codes and centroids
  nj-zoning-links.json       official ordinance and map links (NJ DCA)
  nj-zoning-layers.json      verified municipal zoning map layers
scripts/
  refresh-state-data.js      refresh the municipality and link files
  discover-zoning-layers.js  rebuild the zoning layer registry
docs/                        GitHub Pages build (generated by scripts/build-pages.js)
skill/SKILL.md               Claude skill for in-chat zoning reports
docs/data-sources.md         every source, endpoint and buffer distance
lib/browser.js               entry point for the Pages build
test/                        engine and parser tests; live service checks
```

## Keeping the data current

```bash
npm run refresh-data         # municipalities and DCA ordinance/map links
npm run discover-zoning      # re-sweep all 564 towns for zoning layers (about 20 minutes)
node scripts/discover-zoning-layers.js 0712 2012   # just these municipal codes
```

The GitHub Actions workflow runs the tests on every push and a weekly live check that the state services still answer.

## Engine logic

- **Footprint** = smallest of building coverage × lot, the setback box (frontage − side yards) × (depth − front − rear), any footprint cap.
- **Stories** = height ÷ floor-to-floor (taller ground floor when commercial), capped by the story limit.
- **Floor area** per use = smallest of FAR × lot (plus toggled bonuses), footprint × stories, any floor-area cap.
- **Units** = smallest of units/acre, lot area per unit, any unit cap, net floor area ÷ average unit. When density binds first, the program is right-sized and the unused capacity reported. One-dwelling districts keep the full floor area.
- **Parking** totals the ratios and tests whether surface stalls fit under the impervious limit; if not, reports the units surface parking can support.
- **Residual land value** = stabilized value (NOI ÷ cap rate, or sellout) − hard, soft, financing and structured-parking costs − developer margin, with affordable units discounted.

## Limits

A planning estimate, not a zoning determination. It does not model steep-slope ordinances, sky-exposure or contextual envelopes, use-group nuance, easements or title conditions, sewer capacity, or conditions attached to prior approvals. Zoning map layers from consultants or third parties, and the NJTPA compilations, can lag the adopted map. Confirm with the zoning officer or a land-use attorney before pricing or filing.
