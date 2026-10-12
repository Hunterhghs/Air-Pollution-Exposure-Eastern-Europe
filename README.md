# Urban Air Exposure: Eastern Europe

An interactive map of how much nitrogen dioxide (NO₂) and fine particulate matter (PM2.5) people in Eastern European cities breathe, and how much of it comes from traffic.

**Live:** https://hunterhghs.github.io/Air-Pollution-Exposure-Eastern-Europe/

## What it shows

- **Map.** About 400 cities sized by population and colored by annual mean concentration. Bins are tied to the WHO 2021 guideline, the EU 2030 limit and the current EU limit. Zoom in to see the ~1,000 individual monitoring stations; traffic stations have a ring. Countries are shaded by population-weighted residential exposure.
- **Station-type switch.** City average, traffic stations only, background stations only, or **roadside excess** (traffic minus background). Roadside excess is a direct read of the local vehicle contribution.
- **Traffic vs background chart.** For the largest cities that have both station types, it shows how much more NO₂ people breathe beside busy roads.
- **Exposure KPIs.** Urban residents covered, population-weighted residential level, share of residents above the EU 2030 limit, and average roadside excess.
- **City detail.** Click any city for its 2013–2025 trend by station type and a list of its stations.
- **Vehicle fleet context.** Car ownership, the share of cars over 20 years old, diesel share and road transport's share of national NOx emissions (Eurostat).

Filter by country and year. The current view is stored in the URL hash, so links are shareable.

### Headline (NO₂, latest year)

On average, traffic stations read **+10.5 µg/m³** above urban background across the 57 cities that have both. In Warsaw, Wrocław and Bucharest the gap is 15–20 µg/m³, with roadside NO₂ at 1.7–2.3× the background level. A quarter of monitored urban residents live where residential NO₂ is above the EU 2030 limit of 20 µg/m³.

## Data sources

| Data | Source |
|---|---|
| Station annual means, NO₂ & PM2.5, 2013–2025 (EU, Western Balkans, Kosovo) | European Environment Agency, AirQualityStatistics via the [Discodata](https://discodata.eea.europa.eu/) API. Validated E1a data with the coverage filter applied |
| City means for Ukraine and Belarus | [WHO Ambient Air Quality Database v8 (June 2026)](https://www.who.int/publications/m/item/who-ambient-air-quality-database-(update-jun-2026)) |
| City locations & population | [GeoNames](https://www.geonames.org/) cities15000 (CC BY 4.0) |
| Vehicle fleet & NOx by sector | Eurostat `road_eqs_carhab`, `road_eqs_carage`, `road_eqs_carpda`, `env_air_emis` |
| Boundaries | Natural Earth via [world-atlas](https://github.com/topojson/world-atlas), with Crimea shown as part of Ukraine |
| Basemap | © OpenStreetMap contributors, © CARTO |

Moldova reports no data to either the EEA or the WHO.

## Method notes

- Urban and suburban stations are grouped to the largest GeoNames city whose catchment covers them. The radius grows with population, up to 20 km.
- "Residential" exposure uses background stations where a city has them. Otherwise it uses the all-station average, which can overstate exposure where only traffic stations exist (for example, Albania).
- Station networks change over time, so a city's trend can partly reflect stations opening or closing.
- "Latest" means each city's most recent year from 2021 onward.

## Run locally

It's a static site with no build step:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

To rebuild the data from source:

```bash
./scripts/fetch_data.sh
```

## Deploy

GitHub Pages → Settings → Pages → *Deploy from a branch* → `main` / `(root)`.
