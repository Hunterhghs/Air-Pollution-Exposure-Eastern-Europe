#!/usr/bin/env bash
# Download raw inputs into ./raw and rebuild data/*.json.
# Requires: curl, unzip, python3 with openpyxl, node + npm (for the boundary file).
set -euo pipefail
cd "$(dirname "$0")/.."
RAW=raw
mkdir -p "$RAW"/{eea,who,geonames,eurostat,geo}

echo "EEA station statistics (Discodata SQL API)…"
python3 - "$RAW/eea/stats.json" <<'EOF'
import json, sys, urllib.request, urllib.parse
cols = ("CountryCode, AirQualityStationEoICode, AQStationName, AirPollutant, YearOfStatistics, "
        "AirPollutionLevel, AirQualityStationType, AirQualityStationArea, Longitude, Latitude, "
        "City, CityCode, CityPopulation, Verification, SourceDataFlow, DataCoverage")
rows = []
for cc in "PL CZ SK HU RO BG SI HR EE LV LT RS BA ME MK AL XK".split():
    q = (f"SELECT {cols} FROM [AirQualityDataFlows].[latest].[AirQualityStatistics] "
         f"WHERE DataAggregationProcessId='P1Y' AND AirPollutant IN ('NO2','PM2.5') AND CountryCode='{cc}' "
         f"AND DataCovFilterYN='Yes' AND YearOfStatistics BETWEEN 2013 AND 2025")
    p = 1
    while True:
        url = "https://discodata.eea.europa.eu/sql?" + urllib.parse.urlencode({"query": q, "p": p, "nrOfHits": 5000})
        res = json.load(urllib.request.urlopen(url, timeout=180)).get("results", [])
        rows += res
        if len(res) < 5000: break
        p += 1
    print(" ", cc, len(rows))
json.dump(rows, open(sys.argv[1], "w"))
EOF

echo "WHO Ambient Air Quality Database v8 (2026)…"
curl -sL -o "$RAW/who/v8.xlsx" \
  "https://cdn.who.int/media/docs/default-source/air-pollution-documents/air-quality-and-health/who-ambient-air-quality-database-version-2026-v8.xlsx?download=true"
python3 - "$RAW/who/v8.xlsx" "$RAW/who/v8.csv" <<'EOF'
# The workbook stores each CSV line in the first cell(s) of a row; re-join them.
import openpyxl, sys
ws = openpyxl.load_workbook(sys.argv[1], read_only=True).worksheets[0]
with open(sys.argv[2], "w", encoding="utf-8") as f:
    for r in ws.iter_rows(values_only=True):
        f.write(",".join("" if v is None else str(v) for v in r).rstrip(",") + "\n")
EOF

echo "GeoNames cities15000…"
curl -sL -o "$RAW/geonames/cities15000.zip" https://download.geonames.org/export/dump/cities15000.zip
unzip -o -q "$RAW/geonames/cities15000.zip" -d "$RAW/geonames"

echo "Eurostat…"
B="https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data"
G="geo=PL&geo=CZ&geo=SK&geo=HU&geo=RO&geo=BG&geo=SI&geo=HR&geo=EE&geo=LV&geo=LT&geo=RS&geo=BA&geo=ME&geo=MK&geo=AL&geo=XK&geo=EU27_2020"
for ds in road_eqs_carhab road_eqs_carage road_eqs_carpda; do
  curl -s -o "$RAW/eurostat/$ds.json" "$B/$ds?format=JSON&lang=EN&sinceTimePeriod=2015&$G"
done
curl -s -o "$RAW/eurostat/env_air_emis.json" "$B/env_air_emis?format=JSON&lang=EN&sinceTimePeriod=2018&airpol=NOX&$G"

echo "Building data/…"
python3 scripts/build_data.py "$RAW" data

echo "Country boundaries…"
curl -sL -o "$RAW/geo/countries-50m.json" https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json
(cd "$RAW" && npm init -y >/dev/null && npm i --silent topojson-client@3.1.0)
NODE_PATH="$RAW/node_modules" node scripts/build_geo.js "$RAW/geo/countries-50m.json" data/countries.geojson
echo "Done."
