// Cloudflare Worker: the NOTAMs over the Netherlands from the FAA NMS-API as GeoJSON in the
// same shape as the LVNL layers, so index.html draws them like any other airspace.
// Same requests as briefing.illustrious.nl (app/Services/Notams/NmsClient.php).
// Secrets NMS_CLIENT_ID and NMS_CLIENT_SECRET are set in the Cloudflare dashboard, never in this file.

const API = 'https://api-nms.aim.faa.gov';
// one circle of 100 NM (the API maximum) around the middle of the country covers all of it
const CENTRE = { latitude: 52.2, longitude: 5.3, radius: 100 };
// the API allows one request per 3 minutes
const CACHE_SECONDS = 600;
// Q-code prefixes per heading, from briefing's config/notams.php; the rest (aerodrome, navaids, obstacles) is left out
const CATEGORIES = [
  ['TRA/TSA', ['QR', 'QA']],
  ['Parachutespringen', ['QWP']],
  ['Evenementen', ['QWA', 'QWB', 'QWC', 'QWL', 'QWO', 'QWT', 'QWV', 'QWZ']],
  ['Drones', ['QWU']],
  ['Overige activiteit', ['QWD', 'QWE', 'QWF', 'QWG', 'QWH', 'QWJ', 'QWM', 'QWR', 'QWS', 'QWW', 'QWY']],
];

export default {
  async fetch(request, env, ctx) {
    const cache = caches.default, key = new Request(new URL('/notams.geojson', request.url));
    let response = await cache.match(key);
    if (!response) {
      response = new Response(JSON.stringify(await notams(env)), { headers: {
        'Content-Type': 'application/geo+json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
      } });
      ctx.waitUntil(cache.put(key, response.clone()));
    }
    return response;
  },
};

async function notams(env) {
  const token = (await (await fetch(`${API}/v1/auth/token`, {
    method: 'POST', headers: { Authorization: `Basic ${btoa(`${env.NMS_CLIENT_ID}:${env.NMS_CLIENT_SECRET}`)}` },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  })).json()).access_token;
  if (!token) throw new Error('Geen NMS-token: controleer NMS_CLIENT_ID en NMS_CLIENT_SECRET.');
  const response = await fetch(`${API}/nmsapi/v1/notams?${new URLSearchParams(CENTRE)}`, {
    headers: { Authorization: `Bearer ${token}`, nmsResponseFormat: 'GEOJSON', Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`NMS-API: ${response.status} ${await response.text()}`);

  const now = Date.now(), day = now + 24 * 3600e3, features = [];
  for (const f of (await response.json()).data.geojson) {
    const n = f.properties?.coreNOTAMData?.notam;
    const category = CATEGORIES.find(([, codes]) => codes.some(c => n?.selectionCode?.startsWith(c)))?.[0];
    const start = Date.parse(n?.effectiveStart), end = Date.parse(n?.effectiveEnd);
    // only what is active now or starts within a day
    if (!category || !(start < day) || end < now) continue;
    const geometries = f.geometry?.type === 'GeometryCollection' ? f.geometry.geometries : [f.geometry].filter(Boolean);
    const areas = geometries.filter(g => ['Polygon', 'MultiPolygon'].includes(g.type));
    const point = geometries.find(g => g.type === 'Point');
    const geometry = areas.length
      ? { type: 'MultiPolygon', coordinates: areas.flatMap(g => g.type === 'Polygon' ? [g.coordinates] : g.coordinates) }
      : point && { type: 'Polygon', coordinates: circle(point.coordinates, +n.radius || 1) };
    if (!geometry) continue;
    const [LowerLimit, LowerLimitUnit, LowerLimitReference] = limit(n.lowerLimit, n.minimumFl, false);
    const [UpperLimit, UpperLimitUnit, UpperLimitReference] = limit(n.upperLimit, n.maximumFl, true);
    features.push({ type: 'Feature', geometry, properties: {
      Designator: n.number, Name: `${n.icaoLocation ?? n.location ?? ''} ${category}`.trim(), Type: 'NOTAM',
      LowerLimit, LowerLimitUnit, LowerLimitReference, UpperLimit, UpperLimitUnit, UpperLimitReference,
      Van: n.effectiveStart, Tot: Number.isNaN(end) ? 'PERM' : n.effectiveEnd, Schema: n.schedule || undefined,
      Tekst: (f.properties.coreNOTAMData.notamTranslation?.find(t => t.type === 'ICAO')?.formattedText ?? n.text ?? '').trim(),
    } });
  }
  return { type: 'FeatureCollection', features };
}

// 'GND', '2500FT AMSL', 'FL095', or else the three-digit minimumFl/maximumFl
function limit(text, fl, top) {
  const t = (text ?? '').trim().toUpperCase();
  let m;
  if (/^(GND|SFC)$/.test(t)) return [0, 'FT', 'SFC'];
  if ((m = t.match(/^FL\s*(\d+)/))) return [+m[1], 'FL', 'STD'];
  if ((m = t.match(/^(\d+)\s*FT/))) return [+m[1], 'FT', 'MSL'];
  if (t === 'UNL' || (!t && (fl ?? '999') === '999' && top)) return [999, 'FL', 'STD'];
  if (!t && fl && fl !== '000') return [+fl, 'FL', 'STD'];
  return [0, 'FT', 'SFC'];
}

// a circle as a polygon, for NOTAMs that only give a centre and a radius in NM
const circle = ([lon, lat], nm) => [[...Array(65).keys()].map(i => {
  const a = i / 32 * Math.PI, d = nm / 60;
  return [lon + d * Math.sin(a) / Math.cos(lat * Math.PI / 180), lat + d * Math.cos(a)];
})];
