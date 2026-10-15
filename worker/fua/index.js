// Cloudflare Worker: which Dutch TRA/TSA/D/R areas are activated today, read from the public
// EUROCONTROL NOP portal ("European AUP/UUP"). The portal is a GWT app without an API, so the
// Worker opens it in Cloudflare Browser Rendering and clicks the active EAUP/EUUP like a person
// would (same steps as gitlab.com/portugal-vacc/eaup, src/scrapers/nop.py).
// ?debug shows the text last read from the portal, to fix the parser when EUROCONTROL changes it.
import puppeteer from '@cloudflare/puppeteer';

const PORTAL = 'https://www.public.nm.eurocontrol.int/PUBPORTAL/gateway/spec/';
// the free plan has 10 browser minutes a day; one visit takes well under a minute
const MAX_AGE = 2 * 3600e3;
const HEADERS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, s-maxage=7200' };

// /gebieden?land=EB,EL gives the shapes of those countries' switchable areas from openAIP (CC BY-NC),
// for the pages outside the Netherlands; the secret OPENAIP_KEY is set in the Cloudflare dashboard
const OPENAIP = 'https://api.core.openaip.net/api/airspaces';
const ISO = { EH: 'NL', EB: 'BE', EL: 'LU', ED: 'DE' };
// openAIP type numbers: restricted, danger, prohibited, TRA, TSA, other, alert, warning
const TYPES = { 1: 'R', 2: 'D', 3: 'P', 8: 'TRA', 9: 'TSA', 0: 'Overig', 17: 'Alert', 18: 'Warning' };
const WEEK = 7 * 24 * 3600e3;

export default {
  async fetch(request, env, ctx) {
    const cache = caches.default, url = new URL(request.url);
    if (url.pathname === '/gebieden') {
      return areas(url, env, ctx);
    }
    const key = new Request(new URL('/fua.json', url)), rawKey = new Request(new URL('/fua.txt', url));
    if (url.searchParams.has('debug')) {
      return (await cache.match(rawKey)) ?? new Response('Nog niets gelezen', { status: 404, headers: HEADERS });
    }
    // the cache holds every country; ?land=EB,EL picks ICAO prefixes, the Netherlands (EH) by default
    const countries = (url.searchParams.get('land') ?? 'EH').toUpperCase().split(',');
    const only = all => Response.json({ ...all, gebieden: all.gebieden.filter(g => countries.some(c => g.naam.startsWith(c))) }, { headers: HEADERS });
    const cached = await cache.match(key);
    if (Date.now() - Date.parse(cached?.headers.get('Date')) < MAX_AGE) {
      return only(await cached.json());
    }
    let read;
    try {
      read = await scrape(env);
    } catch (error) {
      // a broken portal visit keeps the last good answer
      return cached ? only({ ...await cached.json(), fout: String(error) }) : Response.json({ fout: String(error) }, { status: 502, headers: HEADERS });
    }
    const date = new Date().toUTCString(), all = parse(read);
    ctx.waitUntil(Promise.all([
      cache.put(key, Response.json(all, { headers: { ...HEADERS, Date: date } })),
      cache.put(rawKey, new Response(`${read.header}\n\n${read.table}`, { headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8', Date: date } })),
    ]));
    return only(all);
  },
};

async function scrape(env) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.goto(PORTAL, { waitUntil: 'networkidle0', timeout: 60e3 });
    const row = 'tr.active_eaup_highlight';
    const link = await page.waitForSelector(`${row} div.eurocontrol_gwt_ext_linkEnabled`, { timeout: 60e3 });
    const header = await page.$eval(row, element => element.innerText);
    // the AUP opens in a new window
    const [table] = await Promise.all([new Promise(resolve => page.once('popup', resolve)), link.click()]);
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
  const at = (time, after) => {
    if (!date) {
      return null;
    }
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
    areas.push({ naam: name, ondergrensFL: +m[1], bovengrensFL: +m[2], van: from?.toISOString() ?? m[3], tot: at(m[4], from)?.toISOString() ?? m[4] });
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
      const key = new Request(new URL(`/gebieden-${country}.json`, url));
      const cached = await caches.default.match(key);
      if (Date.now() - Date.parse(cached?.headers.get('Date')) < WEEK) {
        return cached.json();
      }
      const features = await openaip(env, ISO[country]);
      ctx.waitUntil(caches.default.put(key, Response.json(features, { headers: { ...HEADERS, Date: new Date().toUTCString() } })));
      return features;
    }));
    return Response.json({ type: 'FeatureCollection', bron: 'openAIP (CC BY-NC)', features: all.flat() }, { headers: HEADERS });
  } catch (error) {
    return Response.json({ fout: String(error) }, { status: 502, headers: HEADERS });
  }
}

// the country's airspaces in openAIP, in the same shape as the LVNL layers
async function openaip(env, country) {
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
      features.push({ type: 'Feature', geometry: a.geometry, properties: {
        // "ED-R 205 C" becomes EDR205C, the way AUP/UUP names it
        Designator: a.name.toUpperCase().replace(/[^A-Z0-9]/g, ''), Name: a.name, Type: TYPES[a.type],
        LowerLimit, LowerLimitUnit, LowerLimitReference, UpperLimit, UpperLimitUnit, UpperLimitReference,
      } });
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
