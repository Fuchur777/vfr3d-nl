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
    const features = new Map();
    for (const f of stored.flatMap(c => c?.features ?? [])) {
      if (prefixes.some(p => f.properties.Name.startsWith(p))) features.set(`${f.properties.Name} ${f.properties.Designator}`, f);
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

// the latest 06:00, 18:00 or 22:00 Amsterdam time before now
function lastSlot(now) {
  const t = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now).map(x => [x.type, +x.value]));
  const slot = SLOTS.findLast(h => h <= t.hour) ?? SLOTS.at(-1) - 24;
  return now - ((t.hour - slot) * 60 + t.minute) * 60e3 - now % 60e3;
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
      Vensters: n.schedule ? windows(n.schedule, start, end, firstPoint(geometry.coordinates), now) : undefined,
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

// The D line ('Schema', UTC) as time windows in ms: "MON WED THU SR MINUS15-SS PLUS15", "MON-FRI 0500-1700",
// "14-16 19-23 0600-1500, 26 0830-1630", "OCT 26-28 NOV 02-04 0700-2255", "SUN 2300-THU 2259", "DAILY SS PLUS30 - 0300".
// Only from a day ago to three days ahead, which is all the app shows; undefined when the text is not understood,
// and the app then uses Van to Tot as before.
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const DAY = 24 * 3600e3;
function windows(schedule, start, end, [lon, lat], now) {
  // tokens: month, weekday, day of the month, time (a function of the day's 00:00 UTC), H24, '-' and ','
  const tokens = [], pattern = /\s*(?:([A-Z]{3})\b|(SR|SS)(?:\s*(PLUS|MINUS)\s*(\d+))?|(\d{4})|(\d{1,2})(?!\d)|(H24)|(-)|(,)|(DAILY|EVERY))/y;
  const text = schedule.toUpperCase().trim();
  for (let m; pattern.lastIndex < text.length;) {
    const at = pattern.lastIndex;
    if (!(m = pattern.exec(text)) || pattern.lastIndex === at) return;
    if (m[1] === 'H24' || m[7]) tokens.push({ k: 'h24' });
    else if (MONTHS.includes(m[1])) tokens.push({ k: 'mon', v: MONTHS.indexOf(m[1]) });
    else if (WEEKDAYS.includes(m[1])) tokens.push({ k: 'wd', v: WEEKDAYS.indexOf(m[1]) });
    else if (m[1]) return;
    else if (m[2]) { const rise = m[2] === 'SR', shift = (m[3] === 'MINUS' ? -1 : 1) * (+m[4] || 0) * 60e3; tokens.push({ k: 't', v: d => sun(d, lat, lon, rise) + shift }); }
    else if (m[5]) tokens.push({ k: 't', v: d => d + (+m[5].slice(0, 2) * 60 + +m[5].slice(2)) * 60e3 });
    else if (m[6]) tokens.push({ k: 'd', v: +m[6] });
    else if (m[8]) tokens.push({ k: '-' });
    else if (m[9]) tokens.push({ k: ',' });
  }
  // groups of day tokens followed by time ranges; a range may end on another day ("MON 0000 - FRI 1700")
  const groups = [];
  let group = { days: [], times: [] };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.k === ',') continue;
    if (t.k === 'h24') { group.times.push([d => d, d => d + DAY]); continue; }
    if (t.k !== 't') {
      if (group.times.length) { groups.push(group); group = { days: [], times: [] }; }
      group.days.push(t);
      continue;
    }
    if (tokens[i + 1]?.k !== '-') return;
    const until = [];
    for (i += 2; tokens[i] && tokens[i].k !== 't'; i++) until.push(tokens[i]);
    if (!tokens[i]) return;
    group.times.push([t.v, tokens[i].v, until.length ? until : undefined]);
  }
  if (!group.times.length) return;
  groups.push(group);

  const first = start - start % DAY, last = Number.isNaN(end) ? now + 3 * DAY : end, from = Math.max(start, now - DAY), to = Math.min(last, now + 3 * DAY);
  // days of the month in the NOTAM's period, in order: "26-28" after "OCT" is 26 to 28 October
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
    const find = (from, item) => {
      for (let c = from; c <= last; c += DAY) {
        const date = new Date(c);
        if (date.getUTCDate() === item.d && (item.m === undefined || date.getUTCMonth() === item.m)) return c;
      }
    };
    const out = [];
    for (let i = 0, cursor = first; i < items.length; i++) {
      const a = find(cursor, items[i]);
      if (a === undefined) return;
      if (!items[i].range) { out.push(a); cursor = a + DAY; continue; }
      const b = find(a, items[++i] ?? {});
      if (b === undefined) return;
      for (let c = a; c <= b; c += DAY) out.push(c);
      cursor = b + DAY;
    }
    return out;
  };
  const weekdays = days => {
    const set = new Set();
    for (let i = 0; i < days.length; i++) {
      if (days[i].k !== 'wd') return;
      if (days[i + 1]?.k === '-') {
        if (days[i + 2]?.k !== 'wd') return;
        for (let w = days[i].v; ; w = (w + 1) % 7) { set.add(w); if (w === days[i + 2].v) break; }
        i += 2;
      } else set.add(days[i].v);
    }
    const out = [];
    for (let c = first - DAY; c <= last; c += DAY) if (set.has(new Date(c).getUTCDay())) out.push(c);
    return out;
  };
  const all = () => { const out = []; for (let c = first - DAY; c <= last; c += DAY) out.push(c); return out; };
  const pick = days => !days.length ? all() : days.every(t => t.k === 'wd' || t.k === '-') ? weekdays(days) : dates(days);

  const found = [];
  for (const { days, times } of groups) {
    const set = pick(days);
    if (!set) return;
    for (const d of set) {
      for (const [a, b, until] of times) {
        const s = a(d);
        let e;
        if (!until) {
          e = b(d) <= s ? b(d + DAY) : b(d);
        } else if (until.length === 1 && until[0].k === 'wd' && days.length === 1 && days[0].k === 'wd') {
          const ahead = (until[0].v - days[0].v + 7) % 7;
          e = b(d + ahead * DAY);
          if (e <= s) e = b(d + (ahead + 7) * DAY);
        } else {
          const ends = dates(until.length === 1 && until[0].k === 'd' ? [...days.filter(t => t.k === 'mon'), ...until] : until);
          const later = ends?.find(c => c >= d);
          if (later === undefined) return;
          e = b(later);
        }
        if (e > from && s < to) found.push([Math.max(s, from), Math.min(e, to)]);
      }
    }
  }
  // sorted, and touching windows ("0000-2359" on following days) joined
  found.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const w of found) {
    if (merged.length && w[0] - merged.at(-1)[1] <= 60e3) merged.at(-1)[1] = Math.max(merged.at(-1)[1], w[1]);
    else merged.push(w);
  }
  return merged;
}

// the first [lon, lat] of a polygon or multipolygon, for the sun times
const firstPoint = c => typeof c[0] === 'number' ? c : firstPoint(c[0]);

// sunrise or sunset (ms) on the UTC day starting at d, at lat/lon (sunrise equation, about a minute accurate)
function sun(d, lat, lon, rise) {
  const rad = Math.PI / 180, j = d / DAY + 2440587.5 - 2451545 + 0.5 - lon / 360;
  const m = (357.5291 + 0.98560028 * j) % 360, c = 1.9148 * Math.sin(m * rad) + 0.02 * Math.sin(2 * m * rad) + 0.0003 * Math.sin(3 * m * rad);
  const l = (m + c + 180 + 102.9372) % 360, transit = j + 0.0053 * Math.sin(m * rad) - 0.0069 * Math.sin(2 * l * rad);
  const decl = Math.asin(Math.sin(l * rad) * Math.sin(23.4397 * rad));
  const w = Math.acos((Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(decl)) / (Math.cos(lat * rad) * Math.cos(decl))) / rad;
  return (transit + (rise ? -w : w) / 360 + 2451545 - 2440587.5) * DAY;
}
