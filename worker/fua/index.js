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

export default {
  async fetch(request, env, ctx) {
    const cache = caches.default, url = new URL(request.url);
    const key = new Request(new URL('/fua.json', url)), rawKey = new Request(new URL('/fua.txt', url));
    if (url.searchParams.has('debug')) {
      return (await cache.match(rawKey)) ?? new Response('Nog niets gelezen', { status: 404, headers: HEADERS });
    }
    const cached = await cache.match(key);
    if (Date.now() - Date.parse(cached?.headers.get('Date')) < MAX_AGE) {
      return cached;
    }
    let read;
    try {
      read = await scrape(env);
    } catch (error) {
      // a broken portal visit keeps the last good answer
      return cached ?? Response.json({ fout: String(error) }, { status: 502, headers: HEADERS });
    }
    const date = new Date().toUTCString();
    const response = Response.json(parse(read), { headers: { ...HEADERS, Date: date } });
    ctx.waitUntil(Promise.all([
      cache.put(key, response.clone()),
      cache.put(rawKey, new Response(`${read.header}\n\n${read.table}`, { headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8', Date: date } })),
    ]));
    return response;
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
    // only Dutch areas (EH..), not foreign ones that reach into the Amsterdam FIR
    if (!m || !/^EH/.test(name)) {
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
