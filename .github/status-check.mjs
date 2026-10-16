// Same rules as the red update dates in the app: prints what is certainly outdated (empty = all fine).
// LVNL: a newer edit date than our stored set. NOTAMs: not fetched more than an hour after a fetch moment (06, 18, 22 LT).
// FUA: plan older than 2 h 15 min.
import { readFileSync } from 'node:fs';

const LVNL = 'https://services-eu1.arcgis.com/OtUwzhpKSdeXgRIB/arcgis/rest/services/Airspaces_data/FeatureServer';
const now = Date.now(), day = new Date(now).toLocaleDateString('sv', { timeZone: 'Europe/Amsterdam' });
// UTC moment of hour h (LT) on today's Amsterdam date; h < 0 is yesterday evening
const ltAt = h => { const t = Date.parse(`${day}T00:00:00Z`) + h * 3600e3; return t - (Date.parse(new Date(t).toLocaleString('sv', { timeZone: 'Europe/Amsterdam' }).replace(' ', 'T') + 'Z') - t); };
const lt = t => new Date(t).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', dateStyle: 'short', timeStyle: 'short' }) + ' LT';
const red = [];

const ours = JSON.parse(readFileSync('data/lvnl/meta.json', 'utf8')).lastEditDate;
const theirs = await fetch(`${LVNL}/layers?f=json`).then(r => r.json()).then(j => Math.max(...j.layers.map(l => l.editingInfo?.lastEditDate ?? 0))).catch(() => 0);
if (theirs > ours) red.push(`Luchtruim LVNL: LVNL heeft een versie van ${lt(theirs)}, wij van ${lt(ours)} (draait de Action LVNL-luchtruim nog?)`);

const slot = Math.max(...[-2, 6, 18, 22].map(ltAt).filter(t => t <= now));
const notams = await fetch('https://vfr3d-notams.frank-e97.workers.dev/').then(r => r.json()).catch(e => ({ fout: String(e) }));
const notamTime = Date.parse(notams.opgehaald);
if (notamTime < slot && now - slot >= 3600e3) red.push(`NOTAMs: opgehaald ${lt(notamTime)}, niet na het ophaalmoment van ${lt(slot)}${notams.fout ? ` (fout: ${notams.fout})` : ''}`);

const fua = await fetch('https://vfr3d-fua.frank-e97.workers.dev/').then(r => r.json()).catch(e => ({ fout: String(e) }));
const fuaTime = Date.parse(fua.opgehaald);
if (fuaTime && now - fuaTime > 2.25 * 3600e3) red.push(`FUA: plan opgehaald ${lt(fuaTime)}, ouder dan 2 uur${fua.fout ? ` (fout: ${fua.fout})` : ''}`);

if (red.length) console.log(red.map(r => `- ${r}`).join('\n'));
