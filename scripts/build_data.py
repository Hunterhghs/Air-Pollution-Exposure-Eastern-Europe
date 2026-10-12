"""
Build the dashboard's data files from raw downloads.

Inputs (see scripts/fetch_data.sh):
  RAW/eea/stats.json            EEA AirQualityStatistics (annual means, station level)
  RAW/who/v8.csv                WHO Ambient Air Quality Database v8 (2026), flattened to CSV
  RAW/geonames/cities15000.txt  GeoNames populated places (pop >= 15k)
  RAW/eurostat/*.json           Eurostat JSON-stat: road_eqs_carhab, road_eqs_carage,
                                road_eqs_carpda, env_air_emis (NOx)

Outputs (data/):
  stations.json   monitoring stations with annual NO2 / PM2.5 means
  cities.json     urban areas: stations grouped to the nearest city, with population
  countries.json  per-country vehicle-fleet and emissions context

Usage: python3 scripts/build_data.py RAW_DIR OUT_DIR
"""
import csv, json, math, os, sys
from collections import defaultdict

RAW, OUT = sys.argv[1], sys.argv[2]
YEARS = range(2013, 2026)

COUNTRIES = {
    # iso2: (name, iso3)
    "PL": ("Poland", "POL"), "CZ": ("Czechia", "CZE"), "SK": ("Slovakia", "SVK"),
    "HU": ("Hungary", "HUN"), "RO": ("Romania", "ROU"), "BG": ("Bulgaria", "BGR"),
    "SI": ("Slovenia", "SVN"), "HR": ("Croatia", "HRV"), "EE": ("Estonia", "EST"),
    "LV": ("Latvia", "LVA"), "LT": ("Lithuania", "LTU"), "RS": ("Serbia", "SRB"),
    "BA": ("Bosnia and Herzegovina", "BIH"), "ME": ("Montenegro", "MNE"),
    "MK": ("North Macedonia", "MKD"), "AL": ("Albania", "ALB"), "XK": ("Kosovo", "XKX"),
    "UA": ("Ukraine", "UKR"), "BY": ("Belarus", "BLR"), "MD": ("Moldova", "MDA"),
}
ISO3_TO_2 = {v[1]: k for k, v in COUNTRIES.items()}


def haversine(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 12742 * math.asin(math.sqrt(a))


def r1(x):
    return None if x is None else round(x, 1)


def mean(xs):
    return sum(xs) / len(xs) if xs else None


# ---------------------------------------------------------------- GeoNames
places = defaultdict(list)  # cc -> [(name, lat, lon, pop, id)]
with open(os.path.join(RAW, "geonames/cities15000.txt"), encoding="utf-8") as f:
    for row in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
        cc, fcode, pop = row[8], row[7], int(row[14] or 0)
        if cc not in COUNTRIES or fcode == "PPLX" or pop < 15000:
            continue
        places[cc].append((row[1], float(row[4]), float(row[5]), pop, row[0]))


def radius_km(pop):
    """Catchment radius for grouping stations to a city: grows with city size."""
    return min(20.0, 4 + 4 * math.sqrt(pop / 1e5))


def assign_city(cc, lat, lon):
    cands = [(p, haversine(lat, lon, p[1], p[2])) for p in places[cc]]
    inside = [(p, d) for p, d in cands if d <= radius_km(p[3])]
    if inside:  # the largest city whose catchment covers the station (metro area)
        return max(inside, key=lambda pd: pd[0][3])[0]
    near = [(p, d) for p, d in cands if d <= 10]
    return min(near, key=lambda pd: pd[1])[0] if near else None


# ---------------------------------------------------------------- EEA stations
raw = json.load(open(os.path.join(RAW, "eea/stats.json")))
TYPE = {"Traffic": "T", "Background": "B", "Industrial": "I"}
AREA = {"Urban": "U", "Suburban": "S", "Rural": "R"}
POLL = {"NO2": "no2", "PM2.5": "pm25"}

stations = {}
acc = defaultdict(list)  # (station, poll, year) -> [values]  (several sampling points possible)
for r in raw:
    if r["AirPollutionLevel"] is None or r["YearOfStatistics"] not in YEARS:
        continue
    sid = r["AirQualityStationEoICode"]
    cc = r["CountryCode"].strip()
    if sid not in stations:
        stations[sid] = {
            "id": sid, "name": (r["AQStationName"] or sid).strip(), "cc": cc,
            "t": TYPE.get(r["AirQualityStationType"], "B"),
            "a": AREA.get(r["AirQualityStationArea"], "R"),
            "lat": round(r["Latitude"], 4), "lon": round(r["Longitude"], 4),
        }
    acc[(sid, POLL[r["AirPollutant"]], r["YearOfStatistics"])].append(r["AirPollutionLevel"])

for (sid, pol, yr), vals in acc.items():
    stations[sid].setdefault(pol, {})[str(yr)] = r1(mean(vals))

# group urban & suburban stations into cities
cities = {}
for s in stations.values():
    if s["a"] == "R":
        continue
    p = assign_city(s["cc"], s["lat"], s["lon"])
    if not p:
        continue
    cid = f"{s['cc']}-{p[4]}"
    s["city"] = cid
    c = cities.setdefault(cid, {"id": cid, "name": p[0], "cc": s["cc"], "lat": round(p[1], 4),
                                "lon": round(p[2], 4), "pop": p[3], "src": "EEA", "st": []})
    c["st"].append(s["id"])

for c in cities.values():
    sts = [stations[i] for i in c["st"]]
    c["nT"] = sum(s["t"] == "T" for s in sts)
    c["nB"] = sum(s["t"] == "B" for s in sts)
    c["nI"] = sum(s["t"] == "I" for s in sts)
    for pol in ("no2", "pm25"):
        series = {}
        for y in map(str, YEARS):
            by = defaultdict(list)
            for s in sts:
                v = s.get(pol, {}).get(y)
                if v is not None:
                    by[s["t"]].append(v)
            allv = by["T"] + by["B"] + by["I"]
            if not allv:
                continue
            series[y] = {"all": r1(mean(allv)), "T": r1(mean(by["T"])), "B": r1(mean(by["B"])),
                         "I": r1(mean(by["I"])), "n": len(allv)}
            series[y] = {k: v for k, v in series[y].items() if v is not None}
        if series:
            c[pol] = series

# ---------------------------------------------------------------- WHO (non-EEA countries)
with open(os.path.join(RAW, "who/v8.csv"), encoding="utf-8") as f:
    who = [r for r in csv.DictReader(f) if r["iso3"] in ("UKR", "BLR", "MDA")]


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


for r in who:
    cc = ISO3_TO_2[r["iso3"]]
    lat, lon, yr = num(r["latitude"]), num(r["longitude"]), r["year"]
    if lat is None or int(yr) not in YEARS:
        continue
    name = r["city"].split("/")[0]
    p = assign_city(cc, lat, lon)
    cid = f"{cc}-{p[4]}" if p else f"{cc}-{name}"
    c = cities.setdefault(cid, {"id": cid, "name": p[0] if p else name, "cc": cc,
                                "lat": round(p[1] if p else lat, 4), "lon": round(p[2] if p else lon, 4),
                                "pop": p[3] if p else int(num(r["population"]) or 0),
                                "src": "WHO", "st": [], "nT": 0, "nB": 0, "nI": 0})
    n = int(num(r["number_stations"]) or 0)
    for pol, col in (("no2", "no2_concentration"), ("pm25", "pm25_concentration")):
        v = num(r[col])
        if v is not None:
            c.setdefault(pol, {})[yr] = {"all": r1(v), "n": n}

city_list = sorted((c for c in cities.values() if c.get("no2") or c.get("pm25")),
                   key=lambda c: -c["pop"])

# ---------------------------------------------------------------- Eurostat context


def jsonstat(path):
    d = json.load(open(path))
    ids, sizes = d["id"], d["size"]
    idx = {k: d["dimension"][k]["category"]["index"] for k in ids}
    inv = {k: {v: c for c, v in idx[k].items()} for k in ids}
    out = {}
    for flat, val in d["value"].items():
        flat, coords = int(flat), []
        for k, s in zip(reversed(ids), reversed(sizes)):
            coords.append(inv[k][flat % s])
            flat //= s
        out[tuple(reversed(coords))] = val
    return ids, out


def latest(ids, data, geo, **fixed):
    """Most recent year with a value for geo (and fixed dims). Returns (year, value)."""
    best = None
    for key, v in data.items():
        kd = dict(zip(ids, key))
        if kd["geo"] != geo or any(kd[k] != fv for k, fv in fixed.items()):
            continue
        if best is None or kd["time"] > best[0]:
            best = (kd["time"], v)
    return best


def at(ids, data, geo, year, **fixed):
    for key, v in data.items():
        kd = dict(zip(ids, key))
        if kd["geo"] == geo and kd["time"] == year and all(kd[k] == fv for k, fv in fixed.items()):
            return v
    return None


E = lambda n: os.path.join(RAW, "eurostat", n + ".json")
hab = jsonstat(E("road_eqs_carhab"))
age = jsonstat(E("road_eqs_carage"))
fuel = jsonstat(E("road_eqs_carpda"))
emis = jsonstat(E("env_air_emis"))
ROAD_EXHAUST = ["NFR1A3B1", "NFR1A3B2", "NFR1A3B3", "NFR1A3B4"]

countries = {}
for cc, (name, iso3) in list(COUNTRIES.items()) + [("EU27_2020", ("EU-27 average", "EU27"))]:
    row = {"name": name, "iso3": iso3}
    x = latest(*hab, cc)
    if x:
        row["carsPer1000"], row["carsYear"] = round(x[1]), x[0]
    x = latest(*age, cc, age="TOTAL")
    if x:
        old = at(*age, cc, x[0], age="Y_GT20")
        mid = at(*age, cc, x[0], age="Y10-20")
        if old is not None and x[1]:
            row["over20"] = round(100 * old / x[1], 1)
            if mid is not None:
                row["over10"] = round(100 * (old + mid) / x[1], 1)
            row["ageYear"] = x[0]
    x = latest(*fuel, cc, mot_nrg="TOTAL", leg_form="TOTAL")
    if x and x[1]:
        die = at(*fuel, cc, x[0], mot_nrg="DIE", leg_form="TOTAL")
        elc = at(*fuel, cc, x[0], mot_nrg="ELC", leg_form="TOTAL")
        if die is not None:
            row["diesel"] = round(100 * die / x[1], 1)
        if elc is not None:
            row["bev"] = round(100 * elc / x[1], 2)
        row["fuelYear"] = x[0]
    x = latest(*emis, cc, src_nfr="NFR_TOT_NAT")
    if x and x[1]:
        road = [at(*emis, cc, x[0], src_nfr=s) for s in ROAD_EXHAUST]
        if all(v is not None for v in road):
            row["roadNOx"] = round(100 * sum(road) / x[1], 1)
            row["emisYear"] = x[0]
    countries[cc] = row

# ---------------------------------------------------------------- write
os.makedirs(OUT, exist_ok=True)
compact = dict(separators=(",", ":"), ensure_ascii=False)
st_out = [s for s in stations.values() if s.get("no2") or s.get("pm25")]
json.dump(st_out, open(os.path.join(OUT, "stations.json"), "w", encoding="utf-8"), **compact)
json.dump(city_list, open(os.path.join(OUT, "cities.json"), "w", encoding="utf-8"), **compact)
json.dump(countries, open(os.path.join(OUT, "countries.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
print(f"stations {len(st_out)}  cities {len(city_list)}  countries {len(countries)}")
