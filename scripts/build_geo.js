// Build data/countries.geojson from world-atlas (Natural Earth 50m). Crimea is assigned to Ukraine.
// Usage: node scripts/build_geo.js countries-50m.json data/countries.geojson
const tc = require("topojson-client"), fs = require("fs");
const topo = JSON.parse(fs.readFileSync(process.argv[2]));
const ids = {"616":"PL","203":"CZ","703":"SK","348":"HU","642":"RO","100":"BG","705":"SI","191":"HR","233":"EE","428":"LV","440":"LT","688":"RS","070":"BA","499":"ME","807":"MK","008":"AL","804":"UA","112":"BY","498":"MD"};
const fc = tc.feature(topo, topo.objects.countries);
const inR=(p,r)=>{let c=false;for(let i=0,j=r.length-1;i<r.length;j=i++){const[xi,yi]=r[i],[xj,yj]=r[j];if((yi>p[1])!=(yj>p[1])&&p[0]<(xj-xi)*(p[1]-yi)/(yj-yi)+xi)c=!c}return c};
const polys = g => g.type === "Polygon" ? [g.coordinates] : g.coordinates;
const rus = fc.features.find(f => f.id === "643");
const crimea = polys(rus.geometry).filter(p => inR([34.1, 44.95], p[0]));
const r = a => Array.isArray(a[0]) ? a.map(r) : [Math.round(a[0]*1000)/1000, Math.round(a[1]*1000)/1000];
const out = {type:"FeatureCollection", features: fc.features.filter(f => ids[f.id] || f.properties.name === "Kosovo").map(f => {
  const cc = ids[f.id] || "XK";
  let geom = f.geometry;
  if (cc === "UA") geom = {type: "MultiPolygon", coordinates: polys(geom).concat(crimea)};
  return {type:"Feature", properties:{cc}, geometry:{type:geom.type, coordinates:r(geom.coordinates)}};
})};
console.error("crimea parts:", crimea.length);
fs.writeFileSync(process.argv[3], JSON.stringify(out));
