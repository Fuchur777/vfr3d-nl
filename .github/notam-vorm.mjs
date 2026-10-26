// Prints the NOTAMs about airspace (Q-code QA… or QR…) to check (empty = nothing to check), the same rules as index.html:
// - no LVNL shape, so the app draws the FAA circle (notamShapes(): a designator such as EHTRA81, TSA 50, EHD09, or a full LVNL name such as DE PEEL CTR)
// - in doubt about red or green (relaxing()): the Q-code and the E line disagree on whether the airspace is given free, so the app shows it red
import { readFileSync, readdirSync } from 'node:fs';

const fuaKey = s => String(s ?? '').toUpperCase().replace(/\s/g, '').replace(/(\D)0+(\d)/g, '$1$2');
const keys = new Set(), names = new Set();
for (const f of readdirSync('data/lvnl').filter(f => f.endsWith('.geojson')))
  for (const { geometry, properties: p } of JSON.parse(readFileSync(`data/lvnl/${f}`, 'utf8')).features)
    if (/Polygon/.test(geometry?.type)) keys.add(fuaKey(p.Designator)), p.Name && names.add(String(p.Name).toUpperCase());
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const notams = (await fetch('https://vfr3d-notams.frank-e97.workers.dev/').then(r => r.json())).features
  .map(({ properties: p }) => ({ p, t: String(p.Tekst ?? '').toUpperCase() })).filter(({ t }) => /\bQ\)\s*\w+\/Q[AR]/.test(t));
// a circle in the E line ("PSN 513102N 0055120E RADIUS 2NM", "WI 45M RADIUS CENTRED ON …") is the area's own shape
const noShape = notams.filter(({ t }) => !/\bRADIUS\s+\d+([.,]\d+)?\s*(NM|M|KM)\b|\b\d+([.,]\d+)?\s*(NM|M|KM)\s+RADIUS\b/.test(t)
  && ![...t.matchAll(/\b(?:EH\s?)?(TRA|TSA)\s?(\d+[A-Z]?)\b|\bEH\s?([DRP])\s?(\d+[A-Z]?)\b/g)].some(m => keys.has(fuaKey(`EH${m[1] ?? m[3]}${m[2] ?? m[4]}`)))
  && ![...names].some(n => new RegExp(`\\b${escape(n)}\\b`).test(t)));
const doubt = notams.filter(({ t }) => {
  const e = t.split(/\bE\)/)[1]?.split(/\b[FG]\)/)[0] ?? '';
  return /\bQ\)\s*[^/]+\/Q[AR][A-Z](LC|CD|AU|AW)\//.test(t) !== /\b(CLOSED|CLSD|DEACTIVATED|NOT ACTIVE|WITHDRAWN|NOT AVBL|NOT AVAILABLE)\b/.test(e);
});

const list = l => l.map(({ p }) => `### ${p.Designator} (${p.Soort ?? 'onbekend'})\n\`\`\`\n${p.Tekst}\n\`\`\``).join('\n\n');
const parts = [
  noShape.length && `## Zonder vorm\nDeze NOTAMs tekent vfr3d.nl als cirkel, omdat er geen LVNL-gebied in de tekst gevonden is.\n\n${list(noShape)}`,
  doubt.length && `## Twijfel rood of groen\nDe Q-code en de E-regel zeggen iets anders over of het luchtruim vrijkomt; vfr3d.nl kleurt ze daarom rood.\n\n${list(doubt)}`,
].filter(Boolean);
if (parts.length) console.log(`Klopt iets niet, plak de NOTAM dan in het project.\n\n${parts.join('\n\n')}`);
