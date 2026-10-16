// Cloudflare Worker: NOTAMs from the FAA NMS-API as GeoJSON in the same shape as the LVNL layers,
// so the app draws them like any other airspace. Same requests as briefing.illustrious.nl
// (app/Services/Notams/NmsClient.php).
// Secrets NMS_CLIENT_ID and NMS_CLIENT_SECRET are set in the Cloudflare dashboard, never in this file.
// A KV namespace bound as NOTAMS keeps the results; a Cron Trigger every 5 minutes fetches them three
// times a day (06:00, 18:00 and 22:00 LT), one circle per run because the FAA allows 1 request per 3 min.
// ?land=EB,EL picks countries by ICAO prefix; the Netherlands (EH) by default.
// Every fetch is also kept per Dutch calendar day for a year; ?datum=2026-10-15 gives that day's NOTAMs.

const API = 'https://api-nms.aim.faa.gov';
const SLOTS = [6, 18, 22];
// circles of at most 100 NM (the API maximum) that cover each country
const CIRCLES = [
  [52.2, 5.3], // Netherlands
  [50.4, 4.6], // Belgium and Luxembourg
  [48.34, 9.03], [50.86, 10.77], [48.51, 11.62], [51.71, 7.78], [53.05, 12.28], [51.96, 13.8], [53.62, 9.23], [50.09, 8.2], // Germany
];
const COUNTRIES = { EH: [0], EB: [1], EL: [1], ED: [2, 3, 4, 5, 6, 7, 8, 9] };
const YEAR = 366 * 24 * 3600;
const HEADERS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' };
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
    if (!env.NOTAMS) {
      return Response.json({ fout: 'Geen KV-namespace gekoppeld als NOTAMS.' }, { status: 500, headers: HEADERS });
    }
    const url = new URL(request.url);
    // ?staat shows when each circle was last fetched and why one failed
    if (url.searchParams.has('staat')) {
      return Response.json(await env.NOTAMS.get('staat', 'json'), { headers: HEADERS });
    }
    const prefixes = (url.searchParams.get('land') ?? 'EH').toUpperCase().split(',');
    const circles = [...new Set(prefixes.flatMap(p => COUNTRIES[p] ?? []))];
    const date = url.searchParams.get('datum');
    const stored = await Promise.all(circles.map(i => env.NOTAMS.get(date ? `dag:${date}:${i}` : `cirkel:${i}`, 'json')));
    // never fetched yet (a fresh deploy): fetch one circle now instead of waiting for the next slot
    if (!date && stored.some(c => !c)) ctx.waitUntil(step(env));
    const state = await env.NOTAMS.get('staat', 'json') ?? {};
    const features = new Map();
    for (const f of stored.flatMap(c => c?.features ?? [])) {
      if (prefixes.some(p => f.properties.Name.startsWith(p))) features.set(`${f.properties.Name} ${f.properties.Designator}`, f);
    }
    // a failed fetch is retried every 5 minutes and the last good NOTAMs stay; only say so when they are over 12 hours old
    const fout = circles.filter((i, k) => !stored[k] || Date.now() - stored[k].opgehaald > 12 * 3600e3).map(i => state.fout?.[i]).filter(Boolean);
    return Response.json({
      type: 'FeatureCollection',
      opgehaald: stored.length && stored.every(Boolean) ? new Date(Math.min(...stored.map(c => c.opgehaald))).toISOString() : undefined,
      fout: fout.length ? fout.join('; ') : undefined,
      features: [...features.values()],
    }, { headers: HEADERS });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(step(env));
  },
};

// the latest 06:00, 18:00 or 22:00 Amsterdam time before now
function lastSlot(now) {
  const t = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now).map(x => [x.type, +x.value]));
  const slot = SLOTS.findLast(h => h <= t.hour) ?? SLOTS.at(-1) - 24;
  return now - ((t.hour - slot) * 60 + t.minute) * 60e3 - now % 60e3;
}

// fetch the first circle not yet fetched since the latest slot, if the FAA's limit allows
async function step(env) {
  const now = Date.now(), state = await env.NOTAMS.get('staat', 'json') ?? { klaar: {}, fout: {} };
  // of the circles not yet fetched since the slot, the one tried longest ago, so one failing circle can't block the rest
  state.poging ??= {};
  const due = CIRCLES.map((_, i) => i).filter(i => !(state.klaar[i] >= lastSlot(now))).sort((a, b) => (state.poging[a] ?? 0) - (state.poging[b] ?? 0))[0];
  if (due === undefined || now - (state.laatste ?? 0) < 200e3) return;
  state.laatste = state.poging[due] = now;
  await env.NOTAMS.put('staat', JSON.stringify(state));
  try {
    const features = await notams(env, CIRCLES[due]);
    await env.NOTAMS.put(`cirkel:${due}`, JSON.stringify({ opgehaald: now, features }));
    // the day's archive keeps every NOTAM seen that day, also those cancelled by a later fetch
    const day = `dag:${new Date(now).toLocaleDateString('sv', { timeZone: 'Europe/Amsterdam' })}:${due}`;
    const kept = await env.NOTAMS.get(day, 'json');
    const all = new Map([...kept?.features ?? [], ...features].map(f => [`${f.properties.Name} ${f.properties.Designator}`, f]));
    await env.NOTAMS.put(day, JSON.stringify({ opgehaald: now, features: [...all.values()] }), { expirationTtl: YEAR });
    state.klaar[due] = now;
    delete state.fout[due];
  } catch (error) {
    state.fout[due] = `${new Date(now).toISOString()} ${error}`;
  }
  await env.NOTAMS.put('staat', JSON.stringify(state));
}

// one token for all circles while it is valid, so the FAA sees few token requests
async function token(env) {
  const kept = await env.NOTAMS.get('token');
  if (kept) return kept;
  const auth = await fetch(`${API}/v1/auth/token`, {
    method: 'POST', headers: { Authorization: `Basic ${btoa(`${env.NMS_CLIENT_ID}:${env.NMS_CLIENT_SECRET}`)}` },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  const body = auth.ok && await auth.json();
  if (!body?.access_token) throw new Error(`Geen NMS-token (${auth.status} ${(await auth.text().catch(() => '')).slice(0, 300)}): controleer NMS_CLIENT_ID en NMS_CLIENT_SECRET.`);
  // KV keeps a key at least 60 s
  await env.NOTAMS.put('token', body.access_token, { expirationTtl: Math.max(60, (+body.expires_in || 1800) - 120) });
  return body.access_token;
}

async function notams(env, [latitude, longitude]) {
  const response = await fetch(`${API}/nmsapi/v1/notams?${new URLSearchParams({ latitude, longitude, radius: 100 })}`, {
    headers: { Authorization: `Bearer ${await token(env)}`, nmsResponseFormat: 'GEOJSON', Accept: 'application/json' },
  });
  if (!response.ok) {
    // a refused token is fetched anew on the next try
    if ([401, 403].includes(response.status)) await env.NOTAMS.delete('token');
    throw new Error(`NMS-API: ${response.status} ${await response.text()}`);
  }

  const now = Date.now(), day = now + 24 * 3600e3, features = [];
  for (const f of (await response.json()).data?.geojson ?? []) {
    const n = f.properties?.coreNOTAMData?.notam;
    const heading = CATEGORIES.find(([, codes]) => codes.some(c => n?.selectionCode?.startsWith(c)))?.[0];
    const text = (n?.text ?? '').toUpperCase();
    const category = heading && (KINDS.find(([, pattern]) => pattern.test(text))?.[0] ?? heading);
    const start = Date.parse(n?.effectiveStart), end = Date.parse(n?.effectiveEnd);
    // only what is active now or starts within a day; no cancellations (type C), and no
    // country-wide notices drawn as a circle over half the map (radius in NM)
    if (!category || n.type === 'C' || +n.radius > 50 || !(start < day) || end < now) continue;
    const geometries = f.geometry?.type === 'GeometryCollection' ? f.geometry.geometries : [f.geometry].filter(Boolean);
    const areas = geometries.filter(g => ['Polygon', 'MultiPolygon'].includes(g.type));
    const point = geometries.find(g => g.type === 'Point');
    // the E line says it most precisely ("WI 45M RADIUS CENTRED ON 514842N 0043132E"); the Q line's radius is whole NM
    const own = textCircle(text);
    const geometry = own ? { type: 'Polygon', coordinates: circle(...own) } : areas.length
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
  return features;
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

// [[lon, lat], radius in NM] from "WI 45M RADIUS CENTRED ON 514842N 0043132E", or null when there is none, several, or an exception
function textCircle(text) {
  const all = [...text.matchAll(/\bWI\s+(\d+(?:\.\d+)?)\s*(M|KM|NM)\s+RADIUS\s+(?:CENTRED|CENTERED)\s+(?:ON|AT)\s+(\d{2})(\d{2})(\d{2}(?:\.\d+)?)([NS])\s*(\d{3})(\d{2})(\d{2}(?:\.\d+)?)([EW])/g)];
  // only a single circle that is the area itself, not one cut out of it ("... EXC WI 500M RADIUS ...")
  const m = all.length === 1 && !/\bEXC(EPT)?\s*$/.test(text.slice(0, all[0].index)) ? all[0] : null;
  if (!m) return null;
  const nm = +m[1] / { M: 1852, KM: 1.852, NM: 1 }[m[2]];
  const lat = (+m[3] + m[4] / 60 + m[5] / 3600) * (m[6] === 'S' ? -1 : 1), lon = (+m[7] + m[8] / 60 + m[9] / 3600) * (m[10] === 'W' ? -1 : 1);
  return [[lon, lat], nm];
}

// a circle as a polygon, for NOTAMs that only give a centre and a radius in NM
const circle = ([lon, lat], nm) => [[...Array(65).keys()].map(i => {
  const a = i / 32 * Math.PI, d = nm / 60;
  return [lon + d * Math.sin(a) / Math.cos(lat * Math.PI / 180), lat + d * Math.cos(a)];
})];
