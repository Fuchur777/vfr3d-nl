// Prints the NOTAMs about airspace (Q-code QA… or QR…) that the app cannot give an LVNL shape, so it draws the FAA circle
// (empty = all have a shape). Same matching as notamShapes() in index.html: a designator (EHTRA81, TSA 50, EHD09) or a full LVNL name (DE PEEL CTR).
import { readFileSync, readdirSync } from 'node:fs';

const fuaKey = s => String(s ?? '').toUpperCase().replace(/\s/g, '').replace(/(\D)0+(\d)/g, '$1$2');
const keys = new Set(), names = new Set();
for (const f of readdirSync('data/lvnl').filter(f => f.endsWith('.geojson')))
  for (const { geometry, properties: p } of JSON.parse(readFileSync(`data/lvnl/${f}`, 'utf8')).features)
    if (/Polygon/.test(geometry?.type)) keys.add(fuaKey(p.Designator)), p.Name && names.add(String(p.Name).toUpperCase());
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const notams = await fetch('https://vfr3d-notams.frank-e97.workers.dev/').then(r => r.json());
const missing = notams.features.filter(({ properties: p }) => {
  const tekst = String(p.Tekst ?? '').toUpperCase();
  if (!/\bQ\)\s*\w+\/Q[AR]/.test(tekst)) return false;
  const found = [...tekst.matchAll(/\b(?:EH\s?)?(TRA|TSA)\s?(\d+[A-Z]?)\b|\bEH\s?([DRP])\s?(\d+[A-Z]?)\b/g)].some(m => keys.has(fuaKey(`EH${m[1] ?? m[3]}${m[2] ?? m[4]}`)))
    || [...names].some(n => new RegExp(`\\b${escape(n)}\\b`).test(tekst));
  return !found;
});
if (missing.length) console.log(`Deze NOTAMs over luchtruim tekent vfr3d.nl als cirkel, omdat er geen LVNL-gebied in de tekst gevonden is. Klopt de vorm niet, plak de NOTAM dan in het project.\n\n${
  missing.map(({ properties: p }) => `### ${p.Designator} (${p.Soort ?? 'onbekend'})\n\`\`\`\n${p.Tekst}\n\`\`\``).join('\n\n')}`);
