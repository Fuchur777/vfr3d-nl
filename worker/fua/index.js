// Cloudflare Worker: which Dutch TRA/TSA/D/R areas are activated today, read from the public
// EUROCONTROL NOP portal ("European AUP/UUP"). The portal is a GWT app without an API, so the
// Worker opens it in Cloudflare Browser Rendering and clicks the active EAUP/EUUP like a person
// would (same steps as gitlab.com/portugal-vacc/eaup, src/scrapers/nop.py).
// ?debug shows the text last read from the portal, to fix the parser when EUROCONTROL changes it.
// With a KV namespace bound as FUA, every read is also kept per Dutch calendar day for a year;
// ?datum=2026-10-15 gives that day's activations.
// Plans the portal already lists for later days (the EAUP for tomorrow, published the day before) come along in 'volgende'.
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
    // the cron reads the portal; a visitor only through the refresh button (POST) when the plan is not current,
    // at most 3 times a day and 30 minutes after the latest read, so the 10 browser minutes a day stay for the cron
    if (request.method === 'POST') {
      const refused = await manual(env);
      if (refused) {
        return Response.json({ fout: refused }, { status: 429, headers: HEADERS });
      }
    }
    const last = await env.FUA.get('laatste', 'json'), state = await env.FUA.get('staat', 'json') ?? {};
    if (!last) {
      return Response.json({ fout: state.fout ?? 'Nog niets gelezen.', gebieden: [] }, { status: 502, headers: HEADERS });
    }
    // a failed read keeps the last good plan; 'mislukt' says the latest read failed (time and reason, gone after a good
    // read); 'actueel' says whether the plan is current (the app's update date and the Status-check Action read it)
    // plans for later days than the current one (Frank 2026-11-13: the app shows tomorrow and the day after)
    const later = (await env.FUA.get('volgende', 'json') ?? []).filter(p => p.opgehaald && (!last.datum || p.datum > last.datum));
    return only({ ...last, mislukt: state.fout, actueel: current(Date.parse(last.opgehaald), state.fout),
      volgende: later.map(p => ({ ...p, gebieden: p.gebieden.filter(g => countries.some(c => g.naam.startsWith(c))) })) });
  },
  // the cron fires every hour (wrangler.jsonc); read on the scheduled hours; also for the day archive
  async scheduled(event, env, ctx) {
    if (scheduled(hourLT(event.scheduledTime))) {
      ctx.waitUntil(refresh(env));
    }
  },
};

// every 3 hours, and every hour from 06:00 to 10:00 LT (Frank), 11 reads a day
const scheduled = hour => (hour >= 6 && hour <= 10) || hour % 3 === 0;
const hourLT = t => +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: 'numeric', hourCycle: 'h23' }).format(t);

// red once it is past 06:10 LT without a plan read after 06:00 (10 minutes for that read, like the other slots); orange when the latest scheduled read failed or is
// missing (10 minutes for it to finish); else green (Frank 2026-10-16)
function current(fetched, failed) {
  const now = Date.now(), hour = now - now % 3600e3, latest = test => { let t = hour; while (!test(hourLT(t))) t -= 3600e3; return t; };
  const six = latest(h => h === 6), slot = latest(scheduled);
  if (hourLT(now) >= 6 && !(fetched >= six) && now - six >= 600e3) {
    return { kleur: 'rood', reden: `Nog geen plan van na ${lt(six)}${failed ? ` (laatste fout: ${failed})` : ''}` };
  }
  if (failed) {
    return { kleur: 'oranje', reden: `Laatste ophaalpoging mislukt: ${failed}` };
  }
  if (!(fetched >= slot) && now - slot >= 600e3) {
    return { kleur: 'oranje', reden: `Geplande ophaalpoging van ${lt(slot)} niet gelukt` };
  }
  return { kleur: 'groen', reden: `Laatste geplande ophaalpoging gelukt, opgehaald ${lt(fetched)}` };
}

// "vr 16 okt 06:00 LT (0400Z)"
function lt(t) {
  const d = new Date(t);
  return `${d.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} LT (${d.toISOString().slice(11, 16).replace(':', '')}Z)`;
}

// a read asked for with the refresh button; gives the reason when it is refused
async function manual(env) {
  const last = await env.FUA.get('laatste', 'json'), state = await env.FUA.get('staat', 'json') ?? {};
  const day = `handmatig:${new Date().toLocaleDateString('sv', { timeZone: 'Europe/Amsterdam' })}`, used = +(await env.FUA.get(day) ?? 0);
  if (last && current(Date.parse(last.opgehaald), state.fout).kleur === 'groen') {
    return 'Het plan is al actueel.';
  }
  if (Date.now() - (state.poging ?? 0) < 30 * 60e3) {
    return 'Net al geprobeerd; probeer het over een half uur opnieuw.';
  }
  if (used >= 3) {
    return 'Vandaag al 3 keer handmatig ververst.';
  }
  await env.FUA.put(day, String(used + 1), { expirationTtl: 2 * 24 * 3600 });
  await refresh(env);
}

async function refresh(env) {
  const now = Date.now(), state = { poging: now };
  await env.FUA.put('staat', JSON.stringify({ ...await env.FUA.get('staat', 'json'), poging: now }));
  try {
    const read = await scrape(env, await env.FUA.get('volgende', 'json') ?? []), all = parse(read);
    await Promise.all([
      env.FUA.put('laatste', JSON.stringify(all)),
      env.FUA.put('volgende', JSON.stringify(read.later)),
      env.FUA.put('ruw', `${read.header}\n\n${read.table}\n\nRijen:\n${read.rows.join('\n')}`),
      keep(env, all),
    ]);
  } catch (error) {
    state.fout = `${new Date(now).toISOString()} ${error}`;
  }
  await env.FUA.put('staat', JSON.stringify(state));
}

// the AUP date in a portal text: the first dd/mm/yyyy, as yyyy-mm-dd
const aupDate = text => { const d = text.match(/(\d\d)\/(\d\d)\/(\d{4})/); return d ? `${d[3]}-${d[2]}-${d[1]}` : text.match(/\d{4}-\d\d-\d\d/)?.[0]; };

// the active plan, plus one plan per later day the portal lists (the newest row of that day). A later plan is only opened
// again when its row changed, to spare the 10 browser minutes; a failed later read keeps what was there (if anything)
async function scrape(env, kept) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.goto(PORTAL, { waitUntil: 'networkidle0', timeout: 60e3 });
    const row = 'tr.active_eaup_highlight';
    await page.waitForSelector(`${row} div.eurocontrol_gwt_ext_linkEnabled`, { timeout: 60e3 });
    const header = await page.$eval(row, element => element.innerText);
    const table = await open(page, `${row} div.eurocontrol_gwt_ext_linkEnabled`);
    // every innermost table row with a plan link; the ones of a later day than the active plan get a mark to click on.
    // Never at the cost of the active plan: if this fails, the later plans stay as they were
    const rows = await page.evaluate(() => {
      // aupDate() again: this runs in the portal page
      const date = text => { const d = text.match(/(\d\d)\/(\d\d)\/(\d{4})/); return d ? `${d[3]}-${d[2]}-${d[1]}` : ''; };
      const link = 'div.eurocontrol_gwt_ext_linkEnabled';
      const all = [...document.querySelectorAll('tr')].filter(tr => tr.querySelector(link) && !tr.querySelector(`tr ${link}`));
      const active = date(document.querySelector('tr.active_eaup_highlight').innerText), seen = new Set();
      return all.map((tr, i) => {
        const day = date(tr.innerText);
        if (day > active && !seen.has(day)) { seen.add(day); tr.setAttribute('data-volgende', i); }
        return { i, day: tr.hasAttribute('data-volgende') ? day : null, text: tr.innerText.replace(/\s+/g, ' ').trim() };
      });
    }).catch(error => [{ text: `Rijen niet gelezen: ${error}` }]);
    if (!rows.some(r => r.i !== undefined)) return { header, table, later: kept, rows: rows.map(r => r.text) };
    const later = [];
    for (const r of rows.filter(r => r.day)) {
      const old = kept.find(p => p.datum === r.day);
      if (old?.rij === r.text) { later.push(old); continue; }
      try {
        later.push({ ...parse({ header: r.text, table: await open(page, `tr[data-volgende="${r.i}"] div.eurocontrol_gwt_ext_linkEnabled`) }), rij: r.text });
      } catch (error) {
        // not retried until the row changes, so a plan that can't be read costs no browser minutes on every read
        later.push({ ...old ?? { datum: r.day, gebieden: [] }, rij: r.text, fout: String(error) });
      }
    }
    return { header, table, later, rows: rows.map(r => r.text) };
  } finally {
    await browser.close();
  }
}

// clicks a plan link; the AUP opens in a new window, whose text is read once the area rows are there
async function open(page, selector) {
  const link = await page.$(selector);
  if (!link) {
    throw new Error(`Geen link ${selector}`);
  }
  const [popup] = await Promise.all([new Promise((resolve, reject) => {
    page.once('popup', resolve);
    setTimeout(() => reject(new Error('Geen AUP-venster binnen 60 s')), 60e3);
  }), link.click()]);
  try {
    await popup.waitForFunction(() => /\d{3}\s+\d{3}\s+\d\d:\d\d\s+\d\d:\d\d/.test(document.body.innerText), { timeout: 60e3 });
    return await popup.evaluate(() => document.body.innerText);
  } finally {
    await popup.close().catch(() => {});
  }
}

// Rows read like "EHTRA12A   ...   055 095 08:00 16:00 ... EHAA" (RSA, NOTAM, REMARK, MNM FL,
// MAX FL, WEF, UNT, FUA/EU RS, FIR, UIR). Times are UTC within the AUP day, 06:00 to 06:00 next day.
function parse({ header, table }) {
  const text = `${header}\n${table}`;
  const date = aupDate(text);
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
    datum: date,
    opgehaald: new Date().toISOString(),
    gebieden: areas,
  };
}

// the whole answer per ?land= kept a week in KV and sent as stored text, so a visit costs no parsing; airspace changes
// per AIRAC (28 days) at most. (The Cache API used before does nothing on workers.dev, so every visit fetched and parsed openAIP.)
async function areas(url, env, ctx) {
  const countries = (url.searchParams.get('land') ?? 'EH').toUpperCase().split(',').filter(c => ISO[c]);
  const key = `gebieden:${countries.join(',')}`, headers = { ...HEADERS, 'Content-Type': 'application/json' };
  let body = await env.FUA.get(key);
  if (!body) {
    try {
      const all = await Promise.all(countries.map(country => openaip(env, ISO[country], country)));
      body = JSON.stringify({ type: 'FeatureCollection', bron: 'openAIP (CC BY-NC)', features: all.flat() });
    } catch (error) {
      return Response.json({ fout: String(error) }, { status: 502, headers: HEADERS });
    }
    ctx.waitUntil(env.FUA.put(key, body, { expirationTtl: 7 * 24 * 3600 }).catch(() => {}));
  }
  return new Response(body, { headers });
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
