/* Urban Air Exposure: Eastern Europe — dashboard logic */
(() => {
  "use strict";

  // ------------------------------------------------------------------ config
  const POL = {
    no2: {
      label: "NO₂", long: "Nitrogen dioxide", who: 10, eu2030: 20, euNow: 40,
      bins: [10, 20, 30, 40], xbins: [5, 10, 15, 20],
      binNotes: ["below WHO guideline", "meets EU 2030 limit", "", "", "above current EU limit"],
    },
    pm25: {
      label: "PM2.5", long: "Fine particulate matter", who: 5, eu2030: 10, euNow: 25,
      bins: [5, 10, 15, 25], xbins: [1, 2, 4, 6],
      binNotes: ["below WHO guideline", "meets EU 2030 limit", "", "", "above current EU limit"],
    },
  };
  const MEASURES = {
    all: { label: "City average", short: "City avg." },
    T: { label: "Traffic stations", short: "Traffic" },
    B: { label: "Background stations", short: "Background" },
    X: { label: "Roadside excess (traffic − background)", short: "Roadside excess" },
  };
  const YEARS = [];
  for (let y = 2025; y >= 2013; y--) YEARS.push(String(y));
  const LATEST_MIN = "2021";
  const TYPE_LABEL = { T: "Traffic", B: "Background", I: "Industrial" };
  const AREA_LABEL = { U: "urban", S: "suburban", R: "rural" };
  const STYLE = {
    dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  };

  const state = { pol: "no2", measure: "all", year: "latest", cc: "ALL", stations: true, shading: true, city: null };
  let D = null;           // loaded data
  let map = null;
  let colors = {};        // resolved CSS tokens
  let fleetSort = { key: "level", dir: -1 };

  // ------------------------------------------------------------------ helpers
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (v, d = 1) => (v == null || isNaN(v) ? "—" : v.toFixed(d));
  const fmtPop = (p) => (p >= 1e6 ? (p / 1e6).toFixed(p >= 1e7 ? 0 : 1) + "M" : p >= 1e3 ? Math.round(p / 1e3) + "k" : String(p));
  const svgEl = (tag, attrs = {}, text) => {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  };
  const unit = "µg/m³";

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    colors = {
      ramp: [1, 2, 3, 4, 5].map((i) => g(`--ramp-${i}`)),
      surface: g("--surface-1"), text: g("--text-primary"), text2: g("--text-secondary"),
      muted: g("--text-muted"), border: g("--border"),
      bg: g("--series-bg"), tr: g("--series-tr"), all: g("--series-all"),
    };
  }
  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    if (t) return t === "dark";
    return matchMedia("(prefers-color-scheme: dark)").matches;
  };

  // ------------------------------------------------------------------ data access
  /** Record for a city/pollutant in the selected year; "latest" = most recent year >= 2021. */
  function rec(obj, pol, year = state.year) {
    const series = obj[pol];
    if (!series) return null;
    if (year !== "latest") return series[year] ? { y: year, r: series[year] } : null;
    for (const y of YEARS) {
      if (y < LATEST_MIN) break;
      if (series[y]) return { y, r: series[y] };
    }
    return null;
  }
  function pick(r, measure) {
    if (!r) return null;
    if (measure === "X") return r.T != null && r.B != null ? r.T - r.B : null;
    return r[measure] ?? null;
  }
  const residential = (r) => (r ? r.B ?? r.all ?? null : null);
  const binsFor = (pol, measure) => (measure === "X" ? POL[pol].xbins : POL[pol].bins);
  function binIndex(v, bins) {
    let i = 0;
    while (i < bins.length && v >= bins[i]) i++;
    return i;
  }
  const colorFor = (v, bins) => colors.ramp[binIndex(v, bins)];
  const inScope = (cc) => state.cc === "ALL" || state.cc === cc;
  const countryName = (cc) => (D.countries[cc] ? D.countries[cc].name : cc);

  /** Population-weighted residential exposure for a set of cities. */
  function exposure(cities, pol, year) {
    let pop = 0, sum = 0, n = 0, overWho = 0, over2030 = 0, overNow = 0;
    let xPop = 0, xSum = 0, xN = 0;
    for (const c of cities) {
      const x = rec(c, pol, year);
      const v = residential(x && x.r);
      if (v == null) continue;
      const p = c.pop || 0;
      n++; pop += p; sum += v * p;
      if (v > POL[pol].who) overWho += p;
      if (v > POL[pol].eu2030) over2030 += p;
      if (v > POL[pol].euNow) overNow += p;
      const ex = pick(x.r, "X");
      if (ex != null) { xPop += p; xSum += ex * p; xN++; }
    }
    return {
      n, pop, mean: pop ? sum / pop : null,
      overWho: pop ? overWho / pop : null, over2030: pop ? over2030 / pop : null, overNow: pop ? overNow / pop : null,
      excess: xPop ? xSum / xPop : null, xN,
    };
  }

  // ------------------------------------------------------------------ map
  function firstSymbolId() {
    const layers = map.getStyle().layers || [];
    const l = layers.find((l) => l.type === "symbol");
    return l ? l.id : undefined;
  }

  function addLayers() {
    readColors();
    const before = firstSymbolId();
    const empty = { type: "FeatureCollection", features: [] };
    map.addSource("countries", { type: "geojson", data: empty });
    map.addSource("stations", { type: "geojson", data: empty });
    map.addSource("cities", { type: "geojson", data: empty });

    map.addLayer({
      id: "country-fill", type: "fill", source: "countries",
      paint: {
        "fill-color": ["get", "col"],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 5, ["case", ["get", "has"], isDark() ? 0.28 : 0.32, 0], 8, ["case", ["get", "has"], 0.06, 0]],
      },
    }, before);
    map.addLayer({
      id: "country-line", type: "line", source: "countries",
      paint: { "line-color": ["case", ["get", "sel"], colors.text, colors.muted], "line-width": ["case", ["get", "sel"], 1.6, 0.6], "line-opacity": 0.8 },
    }, before);

    map.addLayer({
      id: "station-pts", type: "circle", source: "stations", minzoom: 5.5,
      layout: { "circle-sort-key": ["get", "key"] },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 5.5, 2.2, 9, 5, 13, 8],
        "circle-color": ["get", "col"],
        "circle-stroke-color": ["case", ["==", ["get", "t"], "T"], colors.text, colors.surface],
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 5.5, ["case", ["==", ["get", "t"], "T"], 1, 0.6], 10, ["case", ["==", ["get", "t"], "T"], 2.2, 0.8]],
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], 5.5, 0, 6.2, ["case", ["get", "in"], 1, 0.25]],
        "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 5.5, 0, 6.2, ["case", ["get", "in"], 1, 0.25]],
      },
    });

    const r = (k) => ["+", 2.5, ["*", ["sqrt", ["get", "pop"]], k]];
    map.addLayer({
      id: "city-pts", type: "circle", source: "cities",
      layout: { "circle-sort-key": ["get", "key"] },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, r(0.006), 5, r(0.0095), 8, r(0.016), 11, r(0.03)],
        "circle-color": ["get", "col"],
        "circle-stroke-color": colors.surface,
        "circle-stroke-width": 1.5,
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], 6, ["case", ["get", "in"], 0.95, 0.18], 9, ["case", ["get", "in"], 0.55, 0.18]],
        "circle-stroke-opacity": ["case", ["get", "in"], 1, 0.25],
      },
    });
    map.addLayer({
      id: "city-sel", type: "circle", source: "cities", filter: ["==", ["get", "id"], ""],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, r(0.006), 5, r(0.0095), 8, r(0.016), 11, r(0.03)],
        "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": colors.text, "circle-stroke-width": 2.5,
      },
    });
    applyLayerVisibility();
  }

  function applyLayerVisibility() {
    if (!map.getLayer("station-pts")) return;
    map.setLayoutProperty("station-pts", "visibility", state.stations ? "visible" : "none");
    map.setLayoutProperty("country-fill", "visibility", state.shading ? "visible" : "none");
    map.setFilter("city-sel", ["==", ["get", "id"], state.city || ""]);
  }

  function updateMap() {
    if (!map || !map.getSource("cities")) return;
    const { pol, measure } = state;
    const bins = binsFor(pol, measure);

    const cityFeats = [];
    for (const c of D.cities) {
      const x = rec(c, pol);
      const v = pick(x && x.r, measure);
      if (v == null) continue;
      cityFeats.push({
        type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] },
        properties: { id: c.id, v, y: x.y, pop: c.pop || 20000, col: colorFor(v, bins), in: inScope(c.cc), key: -(c.pop || 0) },
      });
    }
    map.getSource("cities").setData({ type: "FeatureCollection", features: cityFeats });

    // stations: always the station's own value; for "roadside excess" colour by absolute level
    const sBins = POL[pol].bins;
    const stFeats = [];
    for (const s of D.stations) {
      if (measure === "T" && s.t !== "T") continue;
      if (measure === "B" && s.t !== "B") continue;
      const x = stationRec(s, pol);
      if (!x) continue;
      stFeats.push({
        type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: { id: s.id, v: x.v, y: x.y, t: s.t, col: colorFor(x.v, sBins), in: inScope(s.cc), key: s.t === "T" ? 2 : 1 },
      });
    }
    map.getSource("stations").setData({ type: "FeatureCollection", features: stFeats });

    // countries: population-weighted residential level
    const byCc = {};
    for (const c of D.cities) (byCc[c.cc] = byCc[c.cc] || []).push(c);
    const geo = {
      type: "FeatureCollection",
      features: D.geo.features.map((f) => {
        const e = exposure(byCc[f.properties.cc] || [], pol, state.year);
        return { ...f, properties: { cc: f.properties.cc, has: e.mean != null, col: e.mean != null ? colorFor(e.mean, POL[pol].bins) : colors.surface, sel: state.cc === f.properties.cc } };
      }),
    };
    map.getSource("countries").setData(geo);
    applyLayerVisibility();
  }

  function stationRec(s, pol, year = state.year) {
    const series = s[pol];
    if (!series) return null;
    if (year !== "latest") return series[year] != null ? { y: year, v: series[year] } : null;
    for (const y of YEARS) {
      if (y < LATEST_MIN) break;
      if (series[y] != null) return { y, v: series[y] };
    }
    return null;
  }

  // ------------------------------------------------------------------ tooltip
  const tip = $("#tip");
  function showTip(html, point) {
    tip.innerHTML = html;
    tip.hidden = false;
    const wrap = $(".map-wrap").getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = point.x + 14, y = point.y + 14;
    if (x + tw > wrap.width - 8) x = point.x - tw - 14;
    if (y + th > wrap.height - 8) y = point.y - th - 14;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }
  const hideTip = () => { tip.hidden = true; };

  function cityTipHtml(c) {
    const P = POL[state.pol];
    const x = rec(c, state.pol);
    const r = x ? x.r : {};
    const rows = [];
    if (r.T != null) rows.push(["Traffic", fmt(r.T)]);
    if (r.B != null) rows.push(["Background", fmt(r.B)]);
    if (r.T == null && r.B == null && r.all != null) rows.push(["City average", fmt(r.all)]);
    if (r.T != null && r.B != null) rows.push(["Roadside excess", "+" + fmt(r.T - r.B)]);
    return `<b>${esc(c.name)}</b> <span class="muted">${esc(countryName(c.cc))}</span>
      <div class="muted" style="margin:2px 0 6px">${P.label} ${x ? x.y : ""} · ${unit} · pop. ${fmtPop(c.pop)}</div>
      ${rows.map(([a, b]) => `<div class="row"><span>${a}</span><span>${b}</span></div>`).join("")}
      <div class="muted" style="margin-top:6px">Click for trend & stations</div>`;
  }

  function bindMapEvents() {
    map.on("mousemove", "city-pts", (e) => {
      map.getCanvas().style.cursor = "pointer";
      const c = D.byId[e.features[0].properties.id];
      if (c) showTip(cityTipHtml(c), e.point);
    });
    map.on("mouseleave", "city-pts", () => { map.getCanvas().style.cursor = ""; hideTip(); });
    map.on("click", "city-pts", (e) => {
      const f = e.features[0];
      if (f) selectCity(f.properties.id);
    });
    map.on("mousemove", "station-pts", (e) => {
      if (map.queryRenderedFeatures(e.point, { layers: ["city-pts"] }).length) return;
      map.getCanvas().style.cursor = "pointer";
      const p = e.features[0].properties;
      const s = D.stById[p.id];
      const city = s.city && D.byId[s.city];
      showTip(`<b>${esc(s.name)}</b>
        <div class="muted" style="margin:2px 0 6px">${TYPE_LABEL[s.t]} station, ${AREA_LABEL[s.a]}${city ? " · " + esc(city.name) : ""}</div>
        <div class="row"><span>${POL[state.pol].label} ${p.y}</span><span>${fmt(p.v)} ${unit}</span></div>`, e.point);
    });
    map.on("mouseleave", "station-pts", () => { map.getCanvas().style.cursor = ""; hideTip(); });
    map.on("click", "station-pts", (e) => {
      if (map.queryRenderedFeatures(e.point, { layers: ["city-pts"] }).length) return;
      const s = D.stById[e.features[0].properties.id];
      if (s && s.city) selectCity(s.city);
    });
  }

  // ------------------------------------------------------------------ legend
  function renderLegend() {
    const P = POL[state.pol];
    const bins = binsFor(state.pol, state.measure);
    const isX = state.measure === "X";
    const labels = [];
    for (let i = 0; i <= bins.length; i++) {
      const lo = bins[i - 1], hi = bins[i];
      let txt = i === 0 ? `&lt; ${hi}` : i === bins.length ? `≥ ${lo}` : `${lo}–${hi}`;
      if (isX) txt = (i === 0 ? "&lt; +" + hi : i === bins.length ? "≥ +" + lo : `+${lo}–${hi}`);
      const note = isX ? "" : P.binNotes[i];
      labels.push(`<span class="sw" style="background:${colors.ramp[i]}"></span><span>${txt}${note ? ` <span class="ref">${note}</span>` : ""}</span>`);
    }
    const sizes = [5, 9, 14].map((s) => `<i style="width:${s}px;height:${s}px"></i>`).join("");
    $("#legend").innerHTML = `
      <h3>${P.label} · ${MEASURES[state.measure].short} <span class="ref">(${unit}${isX ? " above background" : ""})</span></h3>
      <div class="bins">${labels.join("")}</div>
      <button class="collapse" type="button">More keys</button>
      <div class="keys">
        <div class="key"><span class="sizes">${sizes}</span> City, sized by population</div>
        ${state.stations ? `<div class="key"><span class="ring"></span> Traffic station <span class="ref">(zoom in)</span></div>
        <div class="key"><span class="dot"></span> Background / industrial station</div>` : ""}
        ${state.shading ? `<div class="key"><span class="sw" style="border-radius:3px;opacity:.6;background:${colors.ramp[2]}"></span> Country: pop-weighted residential level</div>` : ""}
      </div>`;
    const btn = $("#legend .collapse");
    btn.addEventListener("click", () => {
      $("#legend").classList.toggle("open");
      btn.textContent = $("#legend").classList.contains("open") ? "Fewer keys" : "More keys";
    });
  }

  // ------------------------------------------------------------------ panel: overview
  function scopedCities() {
    return D.cities.filter((c) => inScope(c.cc));
  }

  function renderOverview() {
    const P = POL[state.pol];
    const yearLabel = state.year === "latest" ? "latest year" : state.year;
    const cities = scopedCities();
    const e = exposure(cities, state.pol, state.year);
    $("#scope").innerHTML = `<strong>${state.cc === "ALL" ? "All of Eastern Europe" : esc(countryName(state.cc))}</strong><span>${P.label} · ${yearLabel}</span>`;

    const pct = (x) => (x == null ? "—" : Math.round(x * 100) + "<small>%</small>");
    const mult = e.mean != null ? (e.mean / P.who).toFixed(1) : null;
    $("#kpis").innerHTML = `
      <div class="kpi"><div class="k-label">Urban residents covered</div>
        <div class="k-value">${e.pop ? fmtPop(e.pop) : "—"}</div>
        <div class="k-note">in ${e.n} monitored cities</div></div>
      <div class="kpi"><div class="k-label">Average residential ${P.label}</div>
        <div class="k-value">${fmt(e.mean)} <small>${unit}</small></div>
        <div class="k-note">${mult ? mult + "× the WHO guideline (" + P.who + ")" : "no data"}</div></div>
      <div class="kpi"><div class="k-label">Residents above the EU 2030 limit (${P.eu2030})</div>
        <div class="k-value">${pct(e.over2030)}</div>
        <div class="k-note">${e.overWho != null ? Math.round(e.overWho * 100) + "% above WHO guideline" : ""}</div></div>
      <div class="kpi"><div class="k-label">Roadside excess at traffic stations</div>
        <div class="k-value">${e.excess != null ? "+" + fmt(e.excess) : "—"} <small>${e.excess != null ? unit : ""}</small></div>
        <div class="k-note">${e.xN ? `vs background, ${e.xN} cities` : "no paired stations"}</div></div>`;

    renderGap(cities);
    renderRank(cities);
    renderFleet();
  }

  /** Dumbbell: background → traffic per city. The vehicle signal. */
  function renderGap(cities) {
    const P = POL[state.pol];
    const rows = [];
    for (const c of cities) {
      const x = rec(c, state.pol);
      if (x && x.r.T != null && x.r.B != null) rows.push({ c, T: x.r.T, B: x.r.B, y: x.y });
    }
    rows.sort((a, b) => b.c.pop - a.c.pop);
    const top = rows.slice(0, 14);
    $("#gapTitle").textContent = `Traffic vs background ${P.label}`;
    $("#gapSub").textContent = top.length
      ? `Largest cities with both station types. The gap is the extra ${P.label} people breathe beside busy roads.`
      : "";
    $("#gapLegend").innerHTML = top.length
      ? `<span><i style="background:${colors.bg}"></i>Background</span><span><i style="background:${colors.tr}"></i>Traffic</span><span><i class="line"></i>WHO ${P.who} · EU 2030 ${P.eu2030}</span>`
      : "";
    const host = $("#gapChart");
    host.innerHTML = "";
    if (!top.length) { host.innerHTML = `<div class="empty">No city in this selection has both traffic and background stations for ${P.label}.</div>`; return; }

    const W = 380, L = 104, R = 40, rowH = 22, T = 18, H = T + top.length * rowH + 6;
    const max = Math.max(P.eu2030 * 1.25, ...top.map((d) => d.T)) * 1.05;
    const x = (v) => L + (v / max) * (W - L - R);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", "aria-label": `Traffic versus background ${P.label} by city` });
    const step = max > 60 ? 20 : max > 30 ? 10 : 5;
    for (let v = 0; v <= max; v += step) {
      svg.append(svgEl("line", { class: "grid", x1: x(v), x2: x(v), y1: T - 4, y2: H - 4 }));
      svg.append(svgEl("text", { class: "axis-label", x: x(v), y: 10, "text-anchor": "middle" }, v));
    }
    for (const [v, lab] of [[P.who, "WHO"], [P.eu2030, "EU 2030"]]) {
      svg.append(svgEl("line", { class: "refline", x1: x(v), x2: x(v), y1: T - 4, y2: H - 4 }));
    }
    top.forEach((d, i) => {
      const cy = T + i * rowH + rowH / 2;
      const g = svgEl("g", { tabindex: 0, role: "button", "aria-label": `${d.c.name}: background ${fmt(d.B)}, traffic ${fmt(d.T)}` });
      g.append(svgEl("rect", { class: "hit", x: 0, y: cy - rowH / 2, width: W, height: rowH, rx: 4 }));
      const name = d.c.name.length > 15 ? d.c.name.slice(0, 14) + "…" : d.c.name;
      g.append(svgEl("text", { class: "city-label", x: L - 8, y: cy + 4, "text-anchor": "end" }, name));
      g.append(svgEl("line", { x1: x(d.B), x2: x(d.T), y1: cy, y2: cy, stroke: colors.muted, "stroke-width": 2, "stroke-linecap": "round", opacity: 0.6 }));
      g.append(svgEl("circle", { cx: x(d.B), cy, r: 5, fill: colors.bg, stroke: colors.surface, "stroke-width": 2 }));
      g.append(svgEl("circle", { cx: x(d.T), cy, r: 5, fill: colors.tr, stroke: colors.surface, "stroke-width": 2 }));
      const ex = d.T - d.B;
      g.append(svgEl("text", { x: Math.max(x(d.T), x(d.B)) + 9, y: cy + 4, "font-size": 11, "font-weight": 600, style: "fill:var(--text-primary)" }, (ex >= 0 ? "+" : "") + fmt(ex)));
      const t = svgEl("title", {}, `${d.c.name} (${d.y}): background ${fmt(d.B)}, traffic ${fmt(d.T)} ${unit}`);
      g.append(t);
      g.addEventListener("click", () => selectCity(d.c.id));
      g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectCity(d.c.id); } });
      svg.append(g);
    });
    host.append(svg);
  }

  function renderRank(cities) {
    const P = POL[state.pol];
    const m = state.measure;
    const bins = binsFor(state.pol, m);
    const rows = [];
    for (const c of cities) {
      const x = rec(c, state.pol);
      const v = pick(x && x.r, m);
      if (v != null) rows.push({ c, v, y: x.y });
    }
    rows.sort((a, b) => b.v - a.v);
    const top = rows.slice(0, 12);
    const titles = { all: "Highest city averages", T: "Worst traffic hotspots", B: "Highest background levels", X: "Largest roadside excess" };
    $("#rankTitle").textContent = `${titles[m]} · ${P.label}`;
    $("#rankSub").textContent = rows.length
      ? `${rows.length} cities with ${MEASURES[m].label.toLowerCase()} data. Dashed mark = ${m === "X" ? "+5 µg/m³" : "EU 2030 limit (" + P.eu2030 + ")"}.`
      : "";
    const host = $("#rank");
    if (!top.length) { host.innerHTML = `<li class="empty">No data for this selection.</li>`; return; }
    const max = Math.max(...top.map((d) => d.v), m === "X" ? 5 : P.eu2030) * 1.05;
    const refV = m === "X" ? 5 : P.eu2030;
    host.innerHTML = top.map((d, i) => `
      <li><button type="button" data-id="${esc(d.c.id)}" title="${esc(d.c.name)} (${d.y})">
        <span class="n">${i + 1}</span>
        <span class="nm">${esc(d.c.name)}<small>${d.c.cc}</small></span>
        <span class="track"><span class="bar" style="display:block;width:${Math.max(0, (d.v / max) * 100)}%;background:${colorFor(d.v, bins)}"></span><span class="mark" style="left:${(refV / max) * 100}%"></span></span>
        <span class="v">${m === "X" ? "+" : ""}${fmt(d.v)}</span>
      </button></li>`).join("");
    host.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => selectCity(b.dataset.id)));
  }

  function renderFleet() {
    const P = POL[state.pol];
    const byCc = {};
    for (const c of D.cities) (byCc[c.cc] = byCc[c.cc] || []).push(c);
    const cols = [
      { key: "name", label: "Country" },
      { key: "level", label: `Resid. ${P.label}`, d: 1 },
      { key: "carsPer1000", label: "Cars / 1k people", d: 0 },
      { key: "over20", label: "Cars > 20 yrs", d: 0, pct: true, hi: 30 },
      { key: "diesel", label: "Diesel share", d: 0, pct: true, hi: 50 },
      { key: "roadNOx", label: "Road share of NOx", d: 0, pct: true, hi: 40 },
    ];
    const rows = Object.entries(D.countries).filter(([cc]) => cc !== "EU27_2020").map(([cc, r]) => {
      const e = exposure(byCc[cc] || [], state.pol, state.year);
      return { cc, ...r, level: e.mean };
    });
    const { key, dir } = fleetSort;
    rows.sort((a, b) => {
      const va = a[key], vb = b[key];
      if (va == null && vb == null) return a.name.localeCompare(b.name);
      if (va == null) return 1;
      if (vb == null) return -1;
      return typeof va === "string" ? dir * va.localeCompare(vb) : dir * (va - vb);
    });
    const eu = { cc: "EU27_2020", ...D.countries.EU27_2020, name: "EU-27 average", level: null };
    const cell = (r, c) => {
      if (c.key === "name") return esc(r.name);
      const v = r[c.key];
      if (v == null) return "—";
      const s = fmt(v, c.d) + (c.pct ? "%" : "");
      return c.hi && v >= c.hi ? `<span class="hi">${s}</span>` : s;
    };
    $("#fleet").innerHTML = `
      <thead><tr>${cols.map((c) => `<th data-k="${c.key}" ${c.key === key ? `aria-sort="${dir > 0 ? "ascending" : "descending"}"` : ""}>${c.label}${c.key === key ? (dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.cc === state.cc ? "sel" : ""}">${cols.map((c) => `<td>${cell(r, c)}</td>`).join("")}</tr>`).join("")}
      <tr class="eu">${cols.map((c) => `<td>${cell(eu, c)}</td>`).join("")}</tr></tbody>`;
    $("#fleet").querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
      const k = th.dataset.k;
      fleetSort = { key: k, dir: fleetSort.key === k ? -fleetSort.dir : k === "name" ? 1 : -1 };
      renderFleet();
    }));
  }

  // ------------------------------------------------------------------ panel: city detail
  function selectCity(id) {
    const c = D.byId[id];
    if (!c) return;
    state.city = id;
    applyLayerVisibility();
    renderDetail();
    writeHash();
    if (map) {
      const b = map.getBounds();
      if (!b.contains([c.lon, c.lat]) || map.getZoom() < 5) map.easeTo({ center: [c.lon, c.lat], zoom: Math.max(map.getZoom(), 6.5), duration: 700 });
    }
    if (matchMedia("(max-width: 960px)").matches) $("#panel").scrollIntoView({ behavior: "smooth", block: "start" });
    else $("#panel").scrollTop = 0;
  }
  function closeCity() {
    state.city = null;
    applyLayerVisibility();
    $("#detail").hidden = true;
    $("#overview").hidden = false;
    writeHash();
  }

  function renderDetail() {
    const c = D.byId[state.city];
    if (!c) return closeCity();
    const P = POL[state.pol];
    const x = rec(c, state.pol);
    const r = x ? x.r : {};
    const ex = pick(r, "X");
    const sts = c.st.map((i) => D.stById[i]).filter(Boolean);
    const badges = [];
    if (c.src === "WHO") badges.push("WHO city-level data · no station types");
    else badges.push(`${c.nT} traffic`, `${c.nB} background`, ...(c.nI ? [`${c.nI} industrial`] : []));
    const tile = (label, v, extra = "", plus = false) => `
      <div class="kpi"><div class="k-label">${label}</div>
      <div class="k-value">${v == null ? "—" : (plus && v >= 0 ? "+" : "") + fmt(v)} <small>${v == null ? "" : unit}</small></div>
      <div class="k-note">${extra}</div></div>`;
    const whoX = (v) => (v == null ? "" : `${(v / P.who).toFixed(1)}× WHO guideline`);

    $("#detail").innerHTML = `
      <button class="back" type="button">← All cities</button>
      <div class="d-head">
        <h2>${esc(c.name)}</h2>
        <p>${esc(countryName(c.cc))} · population ${c.pop ? c.pop.toLocaleString("en-US") : "n/a"} · ${P.long}, ${x ? x.y : "no data for " + (state.year === "latest" ? "recent years" : state.year)}</p>
        <div class="badges">${badges.map((b) => `<span class="badge">${b}</span>`).join("")}</div>
      </div>
      <div class="kpis">
        ${tile("Traffic stations", r.T, whoX(r.T))}
        ${tile("Background stations", r.B, whoX(r.B))}
        ${tile("Roadside excess", ex, ex != null && r.B ? `+${Math.round((ex / r.B) * 100)}% over background` : "", true)}
        ${tile("City average (all stations)", r.all, whoX(r.all))}
      </div>
      <section class="card">
        <h2>${P.label} trend, 2013–2025</h2>
        <p class="sub">Annual mean by station type. Station networks change over time.</p>
        <div class="chart-legend" id="trendLegend"></div>
        <div id="trend"></div>
      </section>
      <section class="card">
        <h2>Monitoring stations</h2>
        <p class="sub">${sts.length ? `${P.label} annual mean, ${x ? x.y : "selected year"}.` : "City-level value reported to WHO; individual stations not published."}</p>
        ${sts.length ? stationTable(sts, x ? x.y : null) : ""}
      </section>`;
    $("#detail .back").addEventListener("click", closeCity);
    $("#overview").hidden = true;
    $("#detail").hidden = false;
    renderTrend(c);
  }

  function stationTable(sts, year) {
    const P = state.pol;
    const rows = sts.map((s) => ({ s, v: year ? (s[P] || {})[year] : null }))
      .sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
    const dotCol = { T: colors.tr, B: colors.bg, I: colors.muted };
    return `<div class="table-scroll"><table class="stations"><thead><tr><th>Station</th><th>Type</th><th style="text-align:right">${unit}</th></tr></thead><tbody>
      ${rows.map(({ s, v }) => `<tr><td>${esc(s.name)}</td><td><span class="type"><i style="background:${dotCol[s.t]}"></i>${TYPE_LABEL[s.t]}</span> <span style="color:var(--text-muted)">${AREA_LABEL[s.a]}</span></td><td class="v">${fmt(v)}</td></tr>`).join("")}
    </tbody></table></div>`;
  }

  function renderTrend(c) {
    const P = POL[state.pol];
    const series = c[state.pol] || {};
    const years = YEARS.slice().reverse();
    const lines = [];
    const hasT = years.some((y) => series[y] && series[y].T != null);
    const hasB = years.some((y) => series[y] && series[y].B != null);
    if (hasT) lines.push({ key: "T", label: "Traffic", col: colors.tr });
    if (hasB) lines.push({ key: "B", label: "Background", col: colors.bg });
    if (!hasT && !hasB) lines.push({ key: "all", label: "City average", col: colors.all });
    $("#trendLegend").innerHTML = lines.map((l) => `<span><i style="background:${l.col}"></i>${l.label}</span>`).join("") +
      `<span><i class="line"></i>WHO ${P.who} · EU 2030 ${P.eu2030}</span>`;

    const host = $("#trend");
    host.innerHTML = "";
    const vals = [];
    years.forEach((y) => lines.forEach((l) => { const v = series[y] && series[y][l.key]; if (v != null) vals.push(v); }));
    if (!vals.length) { host.innerHTML = `<div class="empty">No ${P.label} measurements for this city.</div>`; return; }

    const W = 380, H = 190, L = 30, R = 12, T = 10, B = 22;
    const max = Math.max(P.eu2030 * 1.15, ...vals) * 1.08;
    const x = (i) => L + (i / (years.length - 1)) * (W - L - R);
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", "aria-label": `${P.label} trend for ${c.name}` });
    const step = max > 60 ? 20 : max > 30 ? 10 : 5;
    for (let v = 0; v <= max; v += step) {
      svg.append(svgEl("line", { class: "grid", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
      svg.append(svgEl("text", { class: "axis-label", x: L - 6, y: y(v) + 3, "text-anchor": "end" }, v));
    }
    years.forEach((yr, i) => { if (i % 2 === 0) svg.append(svgEl("text", { class: "axis-label", x: x(i), y: H - 6, "text-anchor": "middle" }, yr)); });
    for (const [v, lab] of [[P.who, "WHO"], [P.eu2030, "EU 2030"]]) {
      svg.append(svgEl("line", { class: "refline", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
      svg.append(svgEl("text", { class: "ref-label", x: W - R - 2, y: y(v) - 3, "text-anchor": "end" }, lab));
    }
    for (const l of lines) {
      let d = "", pen = false;
      years.forEach((yr, i) => {
        const v = series[yr] && series[yr][l.key];
        if (v == null) { pen = false; return; }
        d += (pen ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1);
        pen = true;
      });
      svg.append(svgEl("path", { d, fill: "none", stroke: l.col, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      years.forEach((yr, i) => {
        const v = series[yr] && series[yr][l.key];
        if (v == null) return;
        const prev = series[years[i - 1]], next = series[years[i + 1]];
        const isolated = !(prev && prev[l.key] != null) && !(next && next[l.key] != null);
        if (isolated || i === years.length - 1 || !(next && next[l.key] != null))
          svg.append(svgEl("circle", { cx: x(i), cy: y(v), r: 3.5, fill: l.col, stroke: colors.surface, "stroke-width": 1.5 }));
      });
    }
    // hover crosshair
    const cross = svgEl("line", { x1: 0, x2: 0, y1: T, y2: H - B, stroke: colors.muted, "stroke-width": 1, visibility: "hidden" });
    const dots = lines.map((l) => svgEl("circle", { r: 4.5, fill: l.col, stroke: colors.surface, "stroke-width": 2, visibility: "hidden" }));
    svg.append(cross, ...dots);
    const overlay = svgEl("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" });
    svg.append(overlay);
    const ttip = document.createElement("div");
    ttip.className = "tip";
    ttip.hidden = true;
    host.style.position = "relative";
    host.append(svg, ttip);
    const move = (clientX) => {
      const rect = svg.getBoundingClientRect();
      const sx = ((clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(years.length - 1, Math.round(((sx - L) / (W - L - R)) * (years.length - 1))));
      const rec_ = series[years[i]];
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
      let html = `<b>${years[i]}</b>`;
      lines.forEach((l, k) => {
        const v = rec_ && rec_[l.key];
        if (v != null) { dots[k].setAttribute("cx", x(i)); dots[k].setAttribute("cy", y(v)); dots[k].setAttribute("visibility", "visible"); }
        else dots[k].setAttribute("visibility", "hidden");
        html += `<div class="row"><span>${l.label}</span><span>${v != null ? fmt(v) : "—"}</span></div>`;
      });
      ttip.innerHTML = html;
      ttip.hidden = false;
      const px = (x(i) / W) * rect.width;
      ttip.style.top = "4px";
      ttip.style.left = (px > rect.width / 2 ? px - ttip.offsetWidth - 10 : px + 10) + "px";
    };
    const leave = () => { cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); ttip.hidden = true; };
    overlay.addEventListener("mousemove", (e) => move(e.clientX));
    overlay.addEventListener("touchstart", (e) => move(e.touches[0].clientX), { passive: true });
    overlay.addEventListener("touchmove", (e) => move(e.touches[0].clientX), { passive: true });
    overlay.addEventListener("mouseleave", leave);
  }

  // ------------------------------------------------------------------ controls & state
  function syncControls() {
    document.querySelectorAll(".seg").forEach((seg) => {
      const k = seg.dataset.key;
      seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === state[k])));
    });
    $("#yearSel").value = state.year;
    $("#ccSel").value = state.cc;
    $("#stToggle").checked = state.stations;
    $("#cfToggle").checked = state.shading;
  }

  function refresh() {
    readColors();
    syncControls();
    renderLegend();
    updateMap();
    if (state.city) renderDetail(); else { $("#detail").hidden = true; $("#overview").hidden = false; }
    renderOverview();
    writeHash();
  }

  function writeHash() {
    const p = new URLSearchParams();
    if (state.pol !== "no2") p.set("p", state.pol);
    if (state.measure !== "all") p.set("m", state.measure);
    if (state.year !== "latest") p.set("y", state.year);
    if (state.cc !== "ALL") p.set("c", state.cc);
    if (state.city) p.set("city", state.city);
    const h = p.toString();
    history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (POL[p.get("p")]) state.pol = p.get("p");
    if (MEASURES[p.get("m")]) state.measure = p.get("m");
    if (YEARS.includes(p.get("y"))) state.year = p.get("y");
    if (p.get("c") && D.countries[p.get("c")]) state.cc = p.get("c");
    if (p.get("city") && D.byId[p.get("city")]) state.city = p.get("city");
  }

  function bboxOf(cc) {
    const f = D.geo.features.find((f) => f.properties.cc === cc);
    if (!f) return null;
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
    const walk = (a) => { if (typeof a[0] === "number") { x0 = Math.min(x0, a[0]); x1 = Math.max(x1, a[0]); y0 = Math.min(y0, a[1]); y1 = Math.max(y1, a[1]); } else a.forEach(walk); };
    walk(f.geometry.coordinates);
    return [[x0, y0], [x1, y1]];
  }
  const HOME = [[13.5, 39.6], [40.2, 59.6]];
  const fitOpts = () => ({ padding: matchMedia("(max-width: 600px)").matches ? 16 : 40, duration: 800 });

  function bindControls() {
    document.querySelectorAll(".seg").forEach((seg) => {
      seg.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        state[seg.dataset.key] = b.dataset.v;
        refresh();
      });
      seg.addEventListener("keydown", (e) => {
        if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
        const bs = [...seg.querySelectorAll("button")];
        const i = bs.findIndex((b) => b.dataset.v === state[seg.dataset.key]);
        const n = bs[(i + (e.key === "ArrowRight" ? 1 : bs.length - 1)) % bs.length];
        state[seg.dataset.key] = n.dataset.v;
        refresh();
        n.focus();
      });
    });
    const ys = $("#yearSel");
    ys.innerHTML = `<option value="latest">Latest (${LATEST_MIN}–25)</option>` + YEARS.map((y) => `<option value="${y}">${y}</option>`).join("");
    ys.addEventListener("change", () => { state.year = ys.value; refresh(); });

    const cs = $("#ccSel");
    const ccs = Object.keys(D.countries).filter((c) => c !== "EU27_2020").sort((a, b) => countryName(a).localeCompare(countryName(b)));
    cs.innerHTML = `<option value="ALL">All countries</option>` + ccs.map((c) => `<option value="${c}">${esc(countryName(c))}</option>`).join("");
    cs.addEventListener("change", () => {
      state.cc = cs.value;
      if (state.city && D.byId[state.city].cc !== state.cc && state.cc !== "ALL") closeCity();
      refresh();
      const bb = state.cc === "ALL" ? HOME : bboxOf(state.cc);
      if (bb && map) map.fitBounds(bb, fitOpts());
    });
    $("#stToggle").addEventListener("change", (e) => { state.stations = e.target.checked; renderLegend(); applyLayerVisibility(); });
    $("#cfToggle").addEventListener("change", (e) => { state.shading = e.target.checked; renderLegend(); applyLayerVisibility(); });

    $("#themeBtn").addEventListener("click", () => {
      const next = isDark() ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("aq-theme", next); } catch (e) {}
      applyTheme();
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (!document.documentElement.dataset.theme) applyTheme();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.city) closeCity(); });
  }

  let currentStyle = null;
  function applyTheme() {
    const dark = isDark();
    if (dark) document.documentElement.dataset.dark = ""; else delete document.documentElement.dataset.dark;
    readColors();
    const want = dark ? "dark" : "light";
    if (map && currentStyle !== want) {
      currentStyle = want;
      map.setStyle(STYLE[want], { diff: false }); // "style.load" re-adds our layers
    }
    refresh();
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    try {
      const get = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p + " " + r.status); return r.json(); });
      const [cities, stations, countries, geo] = await Promise.all([
        get("data/cities.json"), get("data/stations.json"), get("data/countries.json"), get("data/countries.geojson"),
      ]);
      D = { cities, stations, countries, geo, byId: {}, stById: {} };
      cities.forEach((c) => (D.byId[c.id] = c));
      stations.forEach((s) => (D.stById[s.id] = s));
    } catch (err) {
      const l = $("#loading");
      l.classList.add("error");
      l.textContent = "Could not load data. If you opened index.html from disk, serve the folder over HTTP instead (e.g. python3 -m http.server).";
      console.error(err);
      return;
    }
    $("#nStations").textContent = D.stations.length.toLocaleString("en-US");
    $("#nCities").textContent = D.cities.length.toLocaleString("en-US");
    readHash();
    bindControls();
    if (isDark()) document.documentElement.dataset.dark = "";
    readColors();

    if (typeof maplibregl === "undefined") {
      $("#loading").textContent = "Map library failed to load. Check your connection and reload.";
      refresh();
      return;
    }
    currentStyle = isDark() ? "dark" : "light";
    map = new maplibregl.Map({
      container: "map", style: STYLE[currentStyle], bounds: HOME,
      fitBoundsOptions: { padding: matchMedia("(max-width: 600px)").matches ? 10 : { top: 20, right: 20, bottom: 20, left: 180 } },
      attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, cooperativeGestures: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("style.load", () => {
      addLayers();
      updateMap();
      $("#loading").hidden = true;
    });
    bindMapEvents();
    refresh();
    if (state.cc !== "ALL") map.once("load", () => { const bb = bboxOf(state.cc); if (bb) map.fitBounds(bb, { ...fitOpts(), duration: 0 }); });
  }

  boot();
})();
