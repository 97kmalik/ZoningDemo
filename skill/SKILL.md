---
name: zoning-envelope-report
description: Research what can be built on a New Jersey property from its address or block and lot, and produce a zoning packet plus buildout summary (district, uses, floor area, units, parking, site constraints, comps, approvals).
---

# Zoning envelope report

Given an address, an NJ municipality + block + lot, or an NYC borough-block-lot, find the governing zoning, extract the district's standards from the current ordinance, compute the buildable envelope, and deliver:

1. A **zoning packet** JSON file (`<street>-zoning-packet.json`) in the format below. It loads directly into the user's Zoning Envelope workbench artifact ("Load packet") and the self-hosted Zoning Envelope app.
2. A short written summary in the reply: district, what's allowed, the envelope numbers with the binding constraint named, flags, likely approvals, confidence, and sources.

Ask nothing up front unless the property can't be identified. If the user mentions a planned program (e.g. "8,000 SF house", "40 units"), test it against the maximum.

## 1. Locate the parcel

Try the shell first (`curl -s -m 30 …`); these public endpoints usually work through the proxy. If the shell can't reach them, use WebSearch/WebFetch (njparcels.com, the county assessor, Regrid's free parcel pages).

- **Geocode:** `https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=<urlencoded>&benchmark=Public_AR_Current&vintage=Current_Current&layers=all&format=json` → coordinates, county, **County Subdivisions** (the governing township in NJ, PA, NY, New England), Incorporated Places.
- **New Jersey parcel + tax data (all 565 towns):** `https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0/query`
  - by block/lot: `where=UPPER(MUN_NAME) LIKE 'MILLBURN%' AND PCLBLOCK='4206' AND PCLLOT='3'`
  - by address: `where=UPPER(MUN_NAME) LIKE 'MILLBURN%' AND PROP_LOC LIKE '900 %ORANGE%'` (the geocoded point usually lands in the street, so text match beats a point query)
  - add `&outFields=*&returnGeometry=true&outSR=4326&f=json`
  - Useful fields: CALC_ACRE, LAND_DESC (often "FRONT X DEPTH" in feet), PROP_CLASS (1 vacant, 2 residential ≤4 units, 4A commercial, 4B industrial, 4C apartments), LAND_VAL, IMPRVT_VAL, YR_CONSTR, DWELL, SALE_PRICE.
- **NYC:** `https://geosearch.planninglabs.nyc/v2/search?text=<address>&size=1` → `properties.addendum.pad.bbl`; then `https://data.cityofnewyork.us/resource/64uk-42ks.json?bbl=<bbl>` (MapPLUTO). PLUTO gives zonedist1-4, overlay1-2, spdist1-3, ltdheight, splitzone, landmark, histdist, residfar/commfar/facilfar/affresfar, lotarea, lotfront, lotdepth, bldgarea, lottype (3 or 4 = corner), transitzone. Treat its FARs as authoritative.
- **Flood:** `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?geometry=<lng>,<lat>&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE&returnGeometry=false&f=json`

## 2. Find the zoning district

If the `nj-zoning-envelope` repo is available locally, run `node -e "require('./lib/pipeline').lookup({mode:'address',address:'…'}).then(r=>console.log(JSON.stringify(r.packet,null,1)))"` from its folder: it does steps 1-2, the state constraint checks, comps and tax in one call, and returns a seeded packet. Otherwise:

0. **Official links:** `https://services.arcgis.com/Aur8tCo478N3VovT/arcgis/rest/services/Municipal_Zoning/FeatureServer/0/query?where=Muni='<4-digit code>'&outFields=*&f=json` gives the town's official ordinance URL (usually eCode360) and zoning map URL. Use these first.
1. **NJTPA county compilations** (Bergen, Hunterdon, Middlesex, Monmouth, Morris, Somerset, Sussex, Warren, Jersey City): `https://gis.njtpa.org/server/rest/services/LandUse/NJTPA_Zoning/FeatureServer/<layer>/query` by point. Some carry bulk standards; they date from 2005-2017, so verify.

Then, in order:
1. NYC: PLUTO `zonedist1` (note split lots).
2. Municipal GIS on ArcGIS Online: `https://www.arcgis.com/sharing/rest/search?q=zoning "<Town>" type:"Feature Service"&num=15&f=json`. For results whose title contains "zoning", query `<url>/<layerId>/query?geometry=<lng>,<lat>&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json` at the **parcel centroid** and read the zone field. A town's zoning-viewer web app (`…/webappviewer/index.html?id=<appId>`) can be unpacked with `https://<org>.maps.arcgis.com/sharing/rest/content/items/<appId>/data?f=json` → `map.itemId` → `/items/<webmapId>/data?f=json` → `operationalLayers[].url`. The same web map often carries historic district and landmark layers; query those too.
3. The town's PDF zoning map, a county GIS viewer, or a recent planning or zoning board resolution for the same block.

Say where the district came from. A layer published by a consultant or a third party is fine but should be confirmed against the official map.

## 3. Read the ordinance

Find the current code on eCode360, Municode, American Legal, Code Publishing, General Code, or the town's site (Zoneomics mirrors are useful but may lag; say so when you use one). Read, at minimum:

- The district's **use** section (permitted, conditional, accessory) and **bulk/area table**.
- The **definitions** for floor area / FAR (what counts: garages, basements, attics, tall ceilings), building vs. lot (impervious) coverage, height measurement, half story. These change the answer more than people expect.
- **Parking** ratios. In New Jersey, residential parking follows RSIS (N.J.A.C. 5:21) statewide unless a redevelopment plan says otherwise.
- **Overlays and superseding plans:** redevelopment and rehabilitation areas, affordable housing (Mount Laurel) overlays and inclusionary set-asides, special districts, historic districts, steep slopes, airport zones.
- **State laws and state permits** that override or add to local zoning: RSIS parking, Highlands, Pinelands, CAFRA, Flood Hazard Area rules, freshwater wetlands, D&R Canal review.
- **Site constraints:** query the NJDEP and NJ DCA layers listed in the repo's `docs/data-sources.md` (wetlands 150 ft, C1 waters 300 ft, contaminated sites 500 ft, sewer service area in/out, redevelopment and rehabilitation areas, Opportunity Zones, rail within half a mile). An unsewered parcel or a C1 buffer can matter more than the zoning.

Setbacks written as formulas (e.g. "rear yard 20% of lot depth", "combined sides 35% of lot width") get computed for this lot and explained in notes.

## 4. Build the packet

```json
{
  "property": { "address": "", "jurisdiction": "", "county": "", "state": "", "parcelId": "Block X, Lot Y | BBL ...",
    "lat": 0, "lng": 0, "lotAreaSF": 0, "frontageFt": 0, "depthFt": 0, "dimsEstimated": false, "cornerLot": false,
    "existingBldgSF": null, "existingUnits": null, "yearBuilt": null, "existingUse": "", "landValue": null,
    "floodZone": "X", "historic": "" },
  "rules": {
    "jurisdiction": "", "district": "", "districtName": "", "ordinanceUpdated": null,
    "uses": { "permitted": [], "conditional": [], "accessory": [], "prohibited": [] },
    "minLotAreaSF": null, "minLotWidthFt": null, "minLotDepthFt": null,
    "far": { "residential": null, "commercial": null, "communityFacility": null, "industrial": null, "mixedMax": null },
    "maxLotCoveragePct": null, "maxImperviousPct": null, "maxBuildingFootprintSF": null, "maxGFASF": null,
    "maxHeightFt": null, "maxStories": null,
    "setbacks": { "frontFt": null, "sideFt": null, "sideTotalFt": null, "rearFt": null, "cornerSideFt": null },
    "density": { "maxUnitsPerAcre": null, "minLotAreaPerUnitSF": null, "dwellingUnitFactor": null, "maxUnits": null, "singleFamilyOnly": false },
    "minUnitSizeSF": null,
    "parking": { "perUnit": null, "guestPerUnit": null, "perKSFRetail": null, "perKSFOffice": null, "perKSFIndustrial": null, "perKSFCommunity": null, "reductionPct": null, "waived": false, "rsis": false, "loadingBerths": null },
    "inclusionaryPct": null,
    "bonuses": [ { "name": "", "farBonus": null, "unitsBonus": null, "description": "", "apply": false } ],
    "overlays": [ { "type": "", "name": "", "severity": "high|info|positive", "effect": "", "source": "" } ],
    "approvals": [], "stateOverrides": [], "notes": [],
    "confidence": { "overall": "high|medium|low", "lowConfidenceFields": [] },
    "citations": [ { "label": "§ and title", "url": "" } ],
    "researchedAt": "ISO date"
  },
  "overlays": [],
  "assumptions": { "proposedGFASF": null },
  "market": {}
}
```

Rules: percentages are 0-100; areas in SF; heights in feet. Use null for anything not regulated or not found; never fill a number you didn't read. List inferred or unverified fields in `lowConfidenceFields`. FAR stays null where the code uses coverage and height instead. For districts with standards by building type, use the most intensive permitted residential type and explain the rest in notes. Write the file with Write and send it with SendUserFile.

## 5. Compute and report

Apply the same logic the workbench uses, and name the binding constraint at each step:

- **Footprint** = min(coverage × lot area, setback box = (frontage − side yards) × (depth − front − rear), footprint cap).
- **Stories** = min(⌊height ÷ floor-to-floor (10.5 ft residential, 14 ft ground-floor commercial)⌋, story cap). Mention a permitted half story separately.
- **Floor area** per use = min(FAR × lot area (+ bonuses), footprint × stories, floor-area cap).
- **Units** = min(units/acre × acres, lot area ÷ area per unit, a unit cap, net floor area (82%) ÷ 850 SF).
- **Parking** = ratios × program; check whether surface stalls (≈350 SF each) fit on the land left under the impervious limit.
- **Lot conformity** against minimum area, width and depth (a short lot needs a c variance in NJ).
- A planned program is tested against the maximum floor area (over the FAR in NJ = d(4) variance).

Reply format: one sentence with the headline ("Up to 10,921 SF of floor area on this R-3 lot; floor area ratio binds."), then a compact table of the standards that matter, then flags and approvals, then "Sources:" with links. Tell the user they can load the packet into the Zoning Envelope workbench to adjust assumptions and see the drawings and land value.

Close with the limits that apply to this lot (unverified fields, a district taken from a third-party layer, a mirror instead of the official code). It is a planning estimate, not a zoning determination.
