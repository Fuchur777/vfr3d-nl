// Cloudflare Worker: the NOTAMs over the Netherlands from the FAA NMS-API as GeoJSON in the
// same shape as the LVNL layers, so index.html draws them like any other airspace.
// Same requests as briefing.illustrious.nl (app/Services/Notams/NmsClient.php).
// Secrets NMS_CLIENT_ID and NMS_CLIENT_SECRET are set in the Cloudflare dashboard, never in this file.

const API = 'https://api-nms.aim.faa.gov';
// one circle of 100 NM (the API maximum) around the middle of the country covers all of it
const CENTRE = { latitude: 52.2, longitude: 5.3, radius: 100 };
// fetched at most once an hour; ?vernieuw asks for fresh data, at most once per 10 minutes
const MAX_AGE = 3600e3, MIN_AGE = 600e3;
// Q-code prefixes per heading, from briefing's config/notams.php, plus obstacles (cranes, wind
// turbines); the rest (aerodrome, navaids) is left out
const CATEGORIES = [
  ['TRA/TSA', ['QR', 'QA']],
  ['Parachutespringen', ['QWP']],
  ['Evenementen', ['QWA', 'QWB', 'QWC', 'QWL', 'QWO', 'QWT', 'QWV', 'QWZ']],
  ['Drones/UAS', ['QWU']],
  ['Obstakelverlichting', ['QOL']],
  ['Obstakels', ['QOB']],
  ['Overige activiteit', ['QWD', 'QWE', 'QWF', 'QWG', 'QWH', 'QWJ', 'QWM', 'QWR', 'QWS', 'QWW', 'QWY']],
];
// the text says more than the Q-code: an area activation stays airspace even when it is for drones;
// otherwise the first matching kind wins, else the Q-code heading
const KINDS = [
  ['TRA/TSA', /\b(RESTRICTED|SEGREGATED|RESERVED|DANGER) AREA\b|\bCTR\b.*\bCLOSED\b/],
  ['Obstakelverlichting', /\bOBST(ACLE)? LI?GH?TS?\b/],
  ['Lasershow', /\bLASER/],
  ['Drones/UAS', /\b(UAS|RPAS|UAV|DRONES?)\b/],
  ['Windturbines', /\bWIND ?(TURBINES?|MILLS?|PARK|FARM)\b/],
  ['Kranen', /\bCRANES?\b|\bMOBILE (PLATFORM|RIG)S?\b/],
  ['Militair', /\bMIL(ITARY)? (ACFT|AIRCRAFT|EXER|EXERCISES?)\b|\bEXERCISE\b/],
  ['Parachutespringen', /\bPARACHUT|\bPJE\b/],
];

export default {
  async fetch(request, env, ctx) {
    const cache = caches.default, key = new Request(new URL('/notams.geojson', request.url));
    const cached = await cache.match(key);
    const age = Date.now() - Date.parse(cached?.headers.get('Date'));
    if (age < (new URL(request.url).searchParams.has('vernieuw') ? MIN_AGE : MAX_AGE)) {
      return cached;
    }
    let collection;
    try {
      collection = await notams(env);
    } catch (error) {
      // when the FAA fails, keep showing the last good NOTAMs (kept for a day), with the error added
      const last = cached ? await cached.json() : {};
      return Response.json({ ...last, fout: String(error) }, { status: cached ? 200 : 502, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    // s-maxage only applies to Cloudflare's cache, so browsers always ask the Worker
    const response = new Response(JSON.stringify(collection), { headers: {
      'Content-Type': 'application/geo+json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, s-maxage=86400',
      Date: new Date().toUTCString(),
    } });
    ctx.waitUntil(cache.put(key, response.clone()));
    return response;
  },
};

async function notams(env) {
  const auth = await fetch(`${API}/v1/auth/token`, {
    method: 'POST', headers: { Authorization: `Basic ${btoa(`${env.NMS_CLIENT_ID}:${env.NMS_CLIENT_SECRET}`)}` },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  const token = auth.ok && (await auth.json()).access_token;
  if (!token) throw new Error(`Geen NMS-token (${auth.status} ${(await auth.text().catch(() => '')).slice(0, 300)}): controleer NMS_CLIENT_ID en NMS_CLIENT_SECRET.`);
  const response = await fetch(`${API}/nmsapi/v1/notams?${new URLSearchParams(CENTRE)}`, {
    headers: { Authorization: `Bearer ${token}`, nmsResponseFormat: 'GEOJSON', Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`NMS-API: ${response.status} ${await response.text()}`);

  const now = Date.now(), day = now + 24 * 3600e3, features = [];
  for (const f of (await response.json()).data?.geojson ?? []) {
    const n = f.properties?.coreNOTAMData?.notam;
    const heading = CATEGORIES.find(([, codes]) => codes.some(c => n?.selectionCode?.startsWith(c)))?.[0];
    const text = (n?.text ?? '').toUpperCase();
    const category = heading && (KINDS.find(([, pattern]) => pattern.test(text))?.[0] ?? heading);
    const start = Date.parse(n?.effectiveStart), end = Date.parse(n?.effectiveEnd);
    // only what is active now or starts within a day; no cancellations (type C), and no
    // country-wide notices drawn as a circle over half the map (radius in NM)
    // only Dutch NOTAMs: location EHAA (Amsterdam FIR) or a Dutch aerodrome EH..
    if (!/^EH/.test(n?.icaoLocation ?? n?.location ?? '')) continue;
    if (!category || n.type === 'C' || +n.radius > 50 || !(start < day) || end < now) continue;
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
      Designator: n.number, Name: `${n.icaoLocation ?? n.location ?? ''} ${category}`.trim(), Type: 'NOTAM', Soort: category,
      LowerLimit, LowerLimitUnit, LowerLimitReference, UpperLimit, UpperLimitUnit, UpperLimitReference,
      Van: n.effectiveStart, Tot: Number.isNaN(end) ? 'PERM' : n.effectiveEnd, Schema: n.schedule || undefined,
      Tekst: (f.properties.coreNOTAMData.notamTranslation?.find(t => t.type === 'ICAO')?.formattedText ?? n.text ?? '').trim(),
    } });
  }
  return { type: 'FeatureCollection', opgehaald: new Date().toISOString(), features };
}

// 'GND', '2500FT AMSL', 'FL095', or else the three-digit minimumFl/maximumFl
function limit(text, fl, top) {
  const t = (text ?? '').trim().toUpperCase();
  let m;
  if (/^(GND|SFC)$/.test(t)) return [0, 'FT', 'SFC'];
  if ((m = t.match(/^FL\s*(\d+)/))) return [+m[1], 'FL', 'STD'];
  // AGL is drawn as MSL: index.html has no terrain heights, and the Netherlands is flat
  if ((m = t.match(/^(\d+)\s*FT\s*(AGL)?/))) return [+m[1], 'FT', m[2] ?? 'MSL'];
  if (t === 'UNL' || (top && (fl ?? '999') === '999')) return [999, 'FL', 'STD'];
  if (fl && fl !== '000') return [+fl, 'FL', 'STD'];
  return [0, 'FT', 'SFC'];
}

// a circle as a polygon, for NOTAMs that only give a centre and a radius in NM
const circle = ([lon, lat], nm) => [[...Array(65).keys()].map(i => {
  const a = i / 32 * Math.PI, d = nm / 60;
  return [lon + d * Math.sin(a) / Math.cos(lat * Math.PI / 180), lat + d * Math.cos(a)];
})];
