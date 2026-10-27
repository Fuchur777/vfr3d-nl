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
    // POST (the app's refresh button when the date is orange or red): fetch one of these circles now if it is
    // behind and the FAA's limit allows; otherwise nothing happens and the answer is the same as a GET
    if (request.method === 'POST') await step(env, circles);
    const stored = await Promise.all(circles.map(i => env.NOTAMS.get(date ? `dag:${date}:${i}` : `cirkel:${i}`, 'json')));
    // never fetched yet (a fresh deploy): fetch one circle now instead of waiting for the next slot
    if (!date && stored.some(c => !c)) ctx.waitUntil(step(env));
    const state = await env.NOTAMS.get('staat', 'json') ?? {};
    const features = new Map(), at = date ? Date.parse(`${date}T12:00:00Z`) : Date.now();
    for (const f of stored.flatMap(c => c?.features ?? [])) {
      const p = f.properties;
      if (!prefixes.some(c => p.Name.startsWith(c))) continue;
      // the days of the schedule, worked out now so they always run from a day ago to three days ahead
      if (p.Schema) p.Vensters = windows(p.Schema, Date.parse(p.Van), p.Tot === 'PERM' ? NaN : Date.parse(p.Tot), at);
      features.set(`${p.Name} ${p.Designator}`, f);
    }
    // a failed fetch is retried every 5 minutes and the last good NOTAMs stay; 'fout' only for a circle never fetched,
    // 'actueel' says whether these NOTAMs are current (the app's update date and the Status-check Action read it)
    const fout = circles.map((i, k) => !stored[k] && state.fout?.[i]).filter(Boolean);
    const fetched = stored.length && stored.every(Boolean) ? Math.min(...stored.map(c => c.opgehaald)) : undefined;
    return Response.json({
      type: 'FeatureCollection',
      opgehaald: fetched && new Date(fetched).toISOString(),
      fout: fout.length ? fout.join('; ') : undefined,
      actueel: date || !circles.length ? undefined : current(fetched, circles.map(i => state.fout?.[i]).filter(Boolean)),
      features: [...features.values()],
    }, { headers: HEADERS });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(step(env));
  },
};

// green when fetched after the latest fetch moment, orange in the hour after it, then red (Frank 2026-10-16)
function current(fetched, errors) {
  const now = Date.now(), slot = lastSlot(now), failed = errors.length ? ` (laatste fout: ${errors.join('; ')})` : '';
  if (fetched >= slot) {
    return { kleur: 'groen', reden: `Opgehaald na het ophaalmoment van ${lt(slot)}` };
  }
  return { kleur: now - slot < 3600e3 ? 'oranje' : 'rood', reden: `Nog niet opgehaald na het ophaalmoment van ${lt(slot)}${failed}` };
}

// "vr 16 okt 06:00 LT (0400Z)"
function lt(t) {
  const d = new Date(t);
  return `${d.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} LT (${d.toISOString().slice(11, 16).replace(':', '')}Z)`;
}

// the latest 06:00, 18:00 or 22:00 Amsterdam time before now: step back whole hours until the Amsterdam hour is a slot,
// so the clock change nights come out right too
function lastSlot(now) {
  const hourLT = t => +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: 'numeric', hourCycle: 'h23' }).format(t);
  let t = now - now % 3600e3;
  while (!SLOTS.includes(hourLT(t))) t -= 3600e3;
  return t;
}

// fetch the first circle (of 'only', default all) not yet fetched since the latest slot, if the FAA's limit allows
async function step(env, only = CIRCLES.map((_, i) => i)) {
  const now = Date.now(), state = await env.NOTAMS.get('staat', 'json') ?? { klaar: {}, fout: {} };
  // of the circles not yet fetched since the slot, the one tried longest ago, so one failing circle can't block the rest
  state.poging ??= {};
  const due = only.filter(i => !(state.klaar[i] >= lastSlot(now))).sort((a, b) => (state.poging[a] ?? 0) - (state.poging[b] ?? 0))[0];
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
    // country-wide notices drawn as a circle over half the map (radius in NM), unless it is about airspace (QA/QR) and
    // names a TRA, TSA or EHD/R/P: the app draws those with their own shape (same pattern as designators() in notam-regels.js)
    const named = /^Q[AR]/.test(n?.selectionCode ?? '') && /\b(?:EH\s?)?(TRA|TSA)\s?\d+[A-Z]?\b|\bEH\s?[DRP]\s?\d+[A-Z]?\b/.test(text);
    if (!category || n.type === 'C' || (+n.radius > 50 && !named) || !(start < day) || end < now) continue;
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

// [[lon, lat], radius in NM] from the E line's one circle: "WI 45M RADIUS CENTRED ON 514842N 0043132E", "WI 0,25NM RADIUS CENTRED AT …"
// or "PSN 513102N 0055120E RADIUS 300M" (seconds optional); null when there is none, several, or it follows EXC (cut out of the area).
// The same function is in worker/notams.js and notam-regels.js; keep both the same
function textCircle(text) {
  const COORD = '(\\d{2})(\\d{2})(\\d{2}(?:[.,]\\d+)?)?([NS])\\s*(\\d{3})(\\d{2})(\\d{2}(?:[.,]\\d+)?)?([EW])', R = '(\\d+(?:[.,]\\d+)?)\\s*(M|KM|NM)';
  const all = [
    ...[...text.matchAll(new RegExp(`\\bWI\\s+${R}\\s+RADIUS\\s+(?:CENTRED|CENTERED)\\s+(?:ON|AT)\\s+${COORD}`, 'g'))].map(m => [m.index, m[1], m[2], m.slice(3, 11)]),
    ...[...text.matchAll(new RegExp(`\\bPSN\\s+${COORD}\\s+RADIUS\\s+${R}\\b`, 'g'))].map(m => [m.index, m[9], m[10], m.slice(1, 9)]),
  ];
  if (all.length !== 1 || /\bEXC(EPT)?\s*$/.test(text.slice(0, all[0][0]))) return null;
  const num = s => s ? +s.replace(',', '.') : 0, [, r, unit, [a, b, c, ns, d, e, f, ew]] = all[0];
  const lat = (+a + b / 60 + num(c) / 3600) * (ns === 'S' ? -1 : 1), lon = (+d + e / 60 + num(f) / 3600) * (ew === 'W' ? -1 : 1);
  return [[lon, lat], num(r) / { M: 1852, KM: 1.852, NM: 1 }[unit]];
}

// a circle as a polygon, for NOTAMs that only give a centre and a radius in NM
const circle = ([lon, lat], nm) => [[...Array(65).keys()].map(i => {
  const a = i / 32 * Math.PI, d = nm / 60;
  return [lon + d * Math.sin(a) / Math.cos(lat * Math.PI / 180), lat + d * Math.cos(a)];
})];

// The D line ('Schema') as the days it is active: "MON WED THU SR MINUS15-SS PLUS15", "14-16 19-23 0600-1500, 26 0830-1630",
// "OCT 26-28 NOV 02-04 0700-2255", "MON 0000 - FRI 1700". Only the days count, each as a whole Dutch day (Frank 2026-10-25:
// the times are daylight or in the FUA); from a day ago to three days ahead, which is all the app shows. Undefined when
// the text is not understood (e.g. EXC), and the app then uses Van to Tot as before.
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const DAY = 24 * 3600e3;
function windows(schedule, start, end, now) {
  // tokens: month, weekday, day of the month, time (any kind), '-' and ','
  const tokens = [], pattern = /\s*(?:(SR|SS)(?:\s*(?:PLUS|MINUS)\s*\d+)?|(\d{4}|H24)|(\d{1,2})(?!\d)|(-)|(,)|(DAILY|EVERY)|([A-Z]{3})\b)/y;
  const text = schedule.toUpperCase().trim();
  for (let m; pattern.lastIndex < text.length;) {
    if (!(m = pattern.exec(text))) return;
    if (m[1] || m[2]) tokens.push({ k: 't' });
    else if (m[3]) tokens.push({ k: 'd', v: +m[3] });
    else if (m[4] || m[5]) tokens.push({ k: m[4] ?? m[5] });
    else if (MONTHS.includes(m[7])) tokens.push({ k: 'mon', v: MONTHS.indexOf(m[7]) });
    else if (WEEKDAYS.includes(m[7])) tokens.push({ k: 'wd', v: WEEKDAYS.indexOf(m[7]) });
    else if (!m[6]) return;
  }
  // groups of day tokens, ended by their times; "MON 0000 - FRI 1700" stays one group MON-FRI
  const groups = [[]];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i], after = tokens[i + 2]?.k;
    if (t.k === 't' && tokens[i + 1]?.k === '-' && after && after !== 't' && after !== ',') continue;
    if (t.k === 't' || t.k === ',') {
      if (t.k === 't' && tokens[i + 1]?.k === '-') i += 2;
      if (groups.at(-1).length) groups.push([]);
    } else groups.at(-1).push(t);
  }
  const first = start - start % DAY, last = Number.isNaN(end) ? now + 3 * DAY : end, picked = new Set();
  const span = () => { const out = []; for (let c = first; c <= last; c += DAY) out.push(c); return out; };
  // dates in the NOTAM's period, in order: "26-28" after "OCT" is 26 to 28 October, "01 OCT-24 OCT" too
  const dates = days => {
    const items = [], monthFirst = days[0].k === 'mon';
    let month;
    for (let i = 0; i < days.length; i++) {
      const t = days[i];
      if (t.k === 'mon') { if (monthFirst) month = t.v; continue; }
      if (t.k === '-') { if (!items.length) return; items.at(-1).range = true; continue; }
      if (t.k !== 'd') return;
      items.push({ d: t.v, m: monthFirst ? month : days[i + 1]?.k === 'mon' ? days[i + 1].v : undefined });
    }
    const find = (from, item) => span().find(c => c >= from && new Date(c).getUTCDate() === item.d && (item.m === undefined || new Date(c).getUTCMonth() === item.m));
    const out = [];
    for (let i = 0, cursor = first; i < items.length; i++) {
      const a = find(cursor, items[i]), b = items[i].range ? find(a, items[++i] ?? {}) : a;
      if (a === undefined || b === undefined) return;
      for (let c = a; c <= b; c += DAY) out.push(c);
      cursor = b + DAY;
    }
    return out;
  };
  const weekdays = days => {
    const set = new Set();
    for (let i = 0; i < days.length; i++) {
      if (days[i].k !== 'wd') return;
      if (days[i + 1]?.k !== '-') { set.add(days[i].v); continue; }
      if (days[i + 2]?.k !== 'wd') return;
      for (let w = days[i].v; ; w = (w + 1) % 7) { set.add(w); if (w === days[i + 2].v) break; }
      i += 2;
    }
    return span().filter(c => set.has(new Date(c).getUTCDay()));
  };
  for (const days of groups.filter(g => g.length)) {
    const found = days.every(t => t.k === 'wd' || t.k === '-') ? weekdays(days) : dates(days);
    if (!found) return;
    found.forEach(c => picked.add(c));
  }
  if (groups.every(g => !g.length)) span().forEach(c => picked.add(c));
  // each day from 00:00 to 24:00 Dutch time, following days joined
  const out = [];
  for (const c of [...picked].sort((a, b) => a - b).filter(c => c + DAY > now - DAY && c < now + 3 * DAY)) {
    const from = midnight(c + DAY / 2), to = midnight(c + DAY * 1.5);
    if (to <= start || from >= end) continue;
    if (out.length && out.at(-1)[1] === from) out.at(-1)[1] = to;
    else out.push([from, to]);
  }
  return out;
}

// 00:00 Amsterdam time of the day t falls on
function midnight(t) {
  const utc = Date.parse(`${new Date(t).toLocaleDateString('sv', { timeZone: 'Europe/Amsterdam' })}T00:00:00Z`);
  return utc - (Date.parse(`${new Date(utc).toLocaleString('sv', { timeZone: 'Europe/Amsterdam' }).replace(' ', 'T')}Z`) - utc);
}
