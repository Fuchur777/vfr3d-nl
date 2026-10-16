// Cloudflare Worker: which Dutch TRA/TSA/D/R areas are activated today, read from the public
// EUROCONTROL NOP portal ("European AUP/UUP"). The portal is a GWT app without an API, so the
// Worker opens it in Cloudflare Browser Rendering and clicks the active EAUP/EUUP like a person
// would (same steps as gitlab.com/portugal-vacc/eaup, src/scrapers/nop.py).
// ?debug shows the text last read from the portal, to fix the parser when EUROCONTROL changes it.
// With a KV namespace bound as FUA, every read is also kept per Dutch calendar day for a year;
// ?datum=2026-10-15 gives that day's activations.
import puppeteer from '@cloudflare/puppeteer';

const PORTAL = 'https://www.public.nm.eurocontrol.int/PUBPORTAL/gateway/spec/';
// the free plan has 10 browser minutes a day and few browsers at once; one visit takes well under a minute
const HEADERS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' };

// /gebieden?land=EB,EL gives the shapes of those countries' switchable areas from openAIP (CC BY-NC),
// for the pages outside the Netherlands; the secret OPENAIP_KEY is set in the Cloudflare dashboard
const OPENAIP = 'https://api.core.openaip.net/api/airspaces';
const ISO = { EH: 'NL', EB: 'BE', EL: 'LU', ED: 'DE' };
// openAIP type numbers: restricted, danger, prohibited, TRA, TSA, other, alert, warning
const TYPES = { 1: 'R', 2: 'D', 3: 'P', 8: 'TRA', 9: 'TSA', 0: 'Overig', 17: 'Alert', 18: 'Warning' };
const WEEK = 7 * 24 * 3600e3;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/gebieden') {
      return areas(url, env, ctx);
    }
    if (!env.FUA) {
      return Response.json({ fout: 'Geen KV-namespace gekoppeld als FUA.', gebieden: [] }, { status: 500, headers: HEADERS });
    }
    if (url.searchParams.has('debug')) {
      return new Response(await env.FUA.get('ruw') ?? 'Nog niets gelezen', { headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    // KV holds every country; ?land=EB,EL picks ICAO prefixes, the Netherlands (EH) by default
    const countries = (url.searchParams.get('land') ?? 'EH').toUpperCase().split(',');
    const only = all => Response.json({ ...all, gebieden: all.gebieden.filter(g => countries.some(c => g.naam.startsWith(c))) }, { headers: HEADERS });
    const day = url.searchParams.get('datum');
    if (day) {
      const kept = await env.FUA.get(`dag:${day}`, 'json');
      return kept ? only(kept) : Response.json({ fout: `Niets bewaard voor ${day}.`, gebieden: [] }, { status: 404, headers: HEADERS });
    }
    // only the cron reads the portal (no 30 s limit there, and no visitor can use up the browser minutes)
    const last = await env.FUA.get('laatste', 'json'), state = await env.FUA.get('staat', 'json') ?? {};
    if (!last) {
      return Response.json({ fout: state.fout ?? 'Nog niets gelezen.', gebieden: [] }, { status: 502, headers: HEADERS });
    }
    // a failed read keeps the last good plan; 'mislukt' always says the latest read failed (time and reason, gone after
    // a good read), 'fout' only once the plan is over 12 hours old
    return only({ ...last, mislukt: state.fout, fout: Date.now() - Date.parse(last.opgehaald) > 12 * 3600e3 ? state.fout : undefined });
  },
  // the cron fires every hour (wrangler.jsonc); read every 3 hours, and every hour from 06:00 to 10:00 LT (Frank),
  // 11 reads a day; also for the day archive
  async scheduled(event, env, ctx) {
    const hour = +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: 'numeric', hourCycle: 'h23' }).format(event.scheduledTime);
    if ((hour >= 6 && hour <= 10) || hour % 3 === 0) {
      ctx.waitUntil(refresh(env));
    }
  },
};

async function refresh(env) {
  const now = Date.now(), state = {};
  try {
    const read = await scrape(env), all = parse(read);
    await Promise.all([
      env.FUA.put('laatste', JSON.stringify(all)),
      env.FUA.put('ruw', `${read.header}\n\n${read.table}`),
      keep(env, all),
    ]);
  } catch (error) {
    state.fout = `${new Date(now).toISOString()} ${error}`;
  }
  await env.FUA.put('staat', JSON.stringify(state));
}

async function scrape(env) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.goto(PORTAL, { waitUntil: 'networkidle0', timeout: 60e3 });
    const row = 'tr.active_eaup_highlight';
    const link = await page.waitForSelector(`${row} div.eurocontrol_gwt_ext_linkEnabled`, { timeout: 60e3 });
    const header = await page.$eval(row, element => element.innerText);
    // the AUP opens in a new window
    const [table] = await Promise.all([new Promise((resolve, reject) => {
      page.once('popup', resolve);
      setTimeout(() => reject(new Error('Geen AUP-venster binnen 60 s')), 60e3);
    }), link.click()]);
    await table.waitForFunction(() => /\d{3}\s+\d{3}\s+\d\d:\d\d\s+\d\d:\d\d/.test(document.body.innerText), { timeout: 60e3 });
    return { header, table: await table.evaluate(() => document.body.innerText) };
  } finally {
    await browser.close();
  }
}

// Rows read like "EHTRA12A   ...   055 095 08:00 16:00 ... EHAA" (RSA, NOTAM, REMARK, MNM FL,
// MAX FL, WEF, UNT, FUA/EU RS, FIR, UIR). Times are UTC within the AUP day, 06:00 to 06:00 next day.
function parse({ header, table }) {
  const text = `${header}\n${table}`;
  const d = text.match(/(\d\d)\/(\d\d)\/(\d{4})/), date = d ? `${d[3]}-${d[2]}-${d[1]}` : text.match(/\d{4}-\d\d-\d\d/)?.[0];
  // without the AUP date the times can't be placed; keep the last good plan instead
  if (!date) {
    throw new Error('Geen AUP-datum gevonden');
  }
  const at = (time, after) => {
    const moment = new Date(`${date}T${time}:00Z`);
    if (time < '06:00' || moment <= after) {
      moment.setUTCDate(moment.getUTCDate() + 1);
    }
    return moment;
  };
  const areas = [];
  for (const line of table.split('\n')) {
    const m = line.match(/(\d{3})\s+(\d{3})\s+(\d\d:\d\d)\s+(\d\d:\d\d)/);
    const name = line.trim().split(/\s+/)[0];
    // every country's areas; the name starts with its ICAO prefix (EH, EB, ED, ..)
    if (!m || !/^[A-Z]{2}[A-Z0-9]/.test(name)) {
      continue;
    }
    const from = at(m[3]);
    areas.push({ naam: name, ondergrensFL: +m[1], bovengrensFL: +m[2], van: from.toISOString(), tot: at(m[4], from).toISOString() });
  }
  return {
    bron: 'EUROCONTROL NOP, European AUP/UUP',
    type: text.match(/\b(EAUP|EUUP)\b/)?.[1] ?? null,
    kop: header.trim(),
    opgehaald: new Date().toISOString(),
    gebieden: areas,
  };
}

// one country per cache entry, kept a week; airspace changes per AIRAC (28 days) at most
async function areas(url, env, ctx) {
  const countries = (url.searchParams.get('land') ?? 'EH').toUpperCase().split(',').filter(c => ISO[c]);
  try {
    const all = await Promise.all(countries.map(async country => {
      const key = new Request(new URL(`/gebieden-2-${country}.json`, url));
      const cached = await caches.default.match(key);
      if (Date.now() - Date.parse(cached?.headers.get('Date')) < WEEK) {
        return cached.json();
      }
      const features = await openaip(env, ISO[country], country);
      ctx.waitUntil(caches.default.put(key, Response.json(features, { headers: { ...HEADERS, 'Cache-Control': 'public, s-maxage=604800', Date: new Date().toUTCString() } })));
      return features;
    }));
    return Response.json({ type: 'FeatureCollection', bron: 'openAIP (CC BY-NC)', features: all.flat() }, { headers: HEADERS });
  } catch (error) {
    return Response.json({ fout: String(error) }, { status: 502, headers: HEADERS });
  }
}

// the country's airspaces in openAIP, in the same shape as the LVNL layers
async function openaip(env, country, icao) {
  if (!env.OPENAIP_KEY) {
    throw new Error('Geen OPENAIP_KEY ingesteld.');
  }
  const features = [];
  for (let page = 1, pages = 1; page <= pages; page++) {
    const response = await fetch(`${OPENAIP}?${new URLSearchParams({ country, page, limit: 1000 })}`, { headers: { 'x-openaip-api-key': env.OPENAIP_KEY } });
    if (!response.ok) {
      throw new Error(`openAIP: ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
    const body = await response.json();
    pages = body.totalPages ?? 1;
    for (const a of body.items ?? []) {
      if (!(a.type in TYPES)) {
        continue;
      }
      const [LowerLimit, LowerLimitUnit, LowerLimitReference] = limit(a.lowerLimit);
      const [UpperLimit, UpperLimitUnit, UpperLimitReference] = limit(a.upperLimit);
      for (const Designator of designator(a.name, icao).split('/')) {
        features.push({ type: 'Feature', geometry: a.geometry, properties: {
          Designator, Name: a.name, Type: TYPES[a.type],
          LowerLimit, LowerLimitUnit, LowerLimitReference, UpperLimit, UpperLimitUnit, UpperLimitReference,
        } });
      }
    }
  }
  return features;
}

// openAIP units 0 metre, 1 feet, 6 FL; datum 0 GND, 1 MSL, 2 STD
function limit(l) {
  if (l?.unit === 6) {
    return [l.value, 'FL', 'STD'];
  }
  const feet = Math.round((l?.value ?? 0) * (l?.unit === 0 ? 3.28084 : 1));
  return [feet, 'FT', l?.referenceDatum === 1 ? 'MSL' : l?.referenceDatum === 2 ? 'STD' : 'SFC'];
}

// the AUP/UUP name hidden in openAIP's name: "ED-R201A TRA-FRIESLAND MON-FRI" is EDR201A, "EB-R04 ELSENBORN 01" EBR04;
// Belgian names without the country prefix get it: "TRA NA - TRA NORTH ALPHA" is EBTRANA, "TSA29C LUXEMBOURG" EBTSA29C,
// and "TRA/TSA S1 NAMUR AREA" EBTRAS1 as well as EBTSAS1 (split into two by the caller); variants like "ED-R10C_2" stay unmatched
function designator(name, icao) {
  const n = name.toUpperCase(), m = n.match(/^(E[A-Z])-?([A-Z]{1,3}) ?(\d+[A-Z]?)\b(?!_)/);
  if (m) {
    return m[1] + m[2] + m[3];
  }
  const local = n.match(/^(TRA\/TSA|TRA|TSA|HTA|LFA) ?([A-Z]{0,2}\d*[A-Z]?)\b/);
  return local ? local[1].split('/').map(kind => icao + kind + local[2]).join('/') : n.replace(/[^A-Z0-9]/g, '');
}

// the day's archive keeps every activation read that day, also those a later EUUP dropped
async function keep(env, all) {
  const day = `dag:${new Date().toLocaleDateString('sv', { timeZone: 'Europe/Amsterdam' })}`;
  const kept = await env.FUA.get(day, 'json');
  const areas = new Map([...kept?.gebieden ?? [], ...all.gebieden].map(g => [`${g.naam} ${g.van} ${g.tot} ${g.ondergrensFL} ${g.bovengrensFL}`, g]));
  await env.FUA.put(day, JSON.stringify({ ...all, gebieden: [...areas.values()] }), { expirationTtl: 366 * 24 * 3600 });
}
