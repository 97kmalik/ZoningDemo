# Data sources

Every source is a free public service. No API keys are needed except the Anthropic key for ordinance research.

## Parcel, assessment and sales

| Data | Source | Endpoint |
|---|---|---|
| Parcel boundaries, block/lot, MOD-IV tax list (assessment, class, building code, year built, last deed and sale) | NJ Office of GIS statewide parcel composite | `services2.arcgis.com/XVOqAjTOJ5P6ngMu/.../Parcels_Composite_NJ_WM/FeatureServer/0` |
| Municipal boundaries, codes, population | NJ Office of GIS | `.../NJ_Municipalities_3857/FeatureServer/0` |
| Address geocoding and County Subdivision (the governing township) | US Census Geocoder (ArcGIS World Geocoder fallback) | `geocoding.geo.census.gov` |

**Notes.** MOD-IV records the latest deed per parcel only, and does not carry building square footage. Sales coded `Z` or with numeric SR-1A non-usable codes are excluded from comps. Frontage and depth come from the tax record's land description ("210X208") when present, else from the parcel outline's minimum bounding rectangle (flagged as estimated).

## Zoning

| Data | Source | Coverage |
|---|---|---|
| Official zoning ordinance and map links | NJ Department of Community Affairs, Municipal Zoning layer (`services.arcgis.com/Aur8tCo478N3VovT/.../Municipal_Zoning/FeatureServer/0`), saved in `data/nj-zoning-links.json` | All 564 municipalities (503 on eCode360, 18 on Municode) |
| Municipal zoning map layers | Found by `scripts/discover-zoning-layers.js`: the official map link when it is an ArcGIS app, then ArcGIS Online search; each layer is verified by querying points inside the town. Saved in `data/nj-zoning-layers.json` | See the file's `coverage` line |
| County zoning compilations with some bulk standards | North Jersey Transportation Planning Authority (`gis.njtpa.org/.../LandUse/NJTPA_Zoning/FeatureServer`) | ~280 towns in Bergen, Hunterdon, Middlesex, Monmouth, Morris, Somerset, Sussex and Warren counties, plus Jersey City. Compiled 2005 to 2017, so values are prefilled as low confidence and verified against the current ordinance |

Layers published by consultants (e.g. Topology for Millburn, Clark, Perth Amboy), counties, or university classes (`*_rutgers` owners) are kept but labelled with their publisher. Confirm against the official map before relying on them.

## Site constraints and incentives (`lib/nj-constraints.js`)

Queried against the parcel polygon, with a buffer where the regulation reaches beyond the line.

| Check | Source | Buffer |
|---|---|---|
| Freshwater wetlands (2020) | NJDEP | 150 ft |
| Category One waters | NJDEP | 300 ft |
| Streams (2020) | NJDEP | 150 ft |
| Climate-adjusted tidal flood area (5 ft SLR) | NJDEP | on parcel |
| Highlands Preservation / Planning Area | NJ Highlands Council | on parcel |
| Pinelands management areas | NJ Pinelands Commission | on parcel |
| CAFRA zone and coastal centers | NJDEP | on parcel |
| Known Contaminated Sites List | NJDEP | 500 ft |
| Deed notices, groundwater CEAs, historic fill | NJDEP | on parcel |
| Brownfield Development Areas | NJDEP | on parcel |
| Preserved open space (Green Acres and other) | NJDEP | on parcel |
| Preserved farmland | NJ SADC | on parcel |
| Sewer service areas (reports inside **and** outside) | NJDEP | on parcel |
| State Plan planning areas and designated centers | NJ Office of Planning Advocacy | on parcel |
| D&R Canal Commission review zones | NJDEP | on parcel |
| Historic districts and properties | NJ Historic Preservation Office via NJDEP | 0 / 50 ft |
| Areas in Need of Redevelopment / Rehabilitation | NJ DCA | on parcel |
| Urban Enterprise Zones | NJ DCA | on parcel |
| Opportunity Zones and OZ 2.0 eligible tracts | Federal layers | point |
| Nearest passenger rail station | NJ DCA | within 1.5 mi (flag if within 0.5 mi) |
| Public-use airports | NJDOT | within 2 mi |
| FEMA flood zones (whole-parcel, partial flag) | FEMA NFHL | on parcel |

## Not included (yet)

- Steep slopes: no statewide layer; many towns regulate slopes over 15% by ordinance.
- Threatened and endangered species habitat (Landscape Project ranks): available from NJDEP but needs rank interpretation.
- Municipal Fourth Round affordable housing obligations and inclusionary overlay sites.
- Sewer capacity and water allocation, which a sewer service area does not guarantee.
