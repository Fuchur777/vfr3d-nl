// Prints what is certainly outdated (red), as the sources say it themselves (empty = all fine): data/lvnl/meta.json
// (written by the LVNL-luchtruim Action) and the NOTAM and FUA Workers, each with 'actueel' { kleur, reden }, the same as the app shows.
import { readFileSync } from 'node:fs';

const red = [];
const check = (bron, j) => j.actueel?.kleur === 'rood' ? red.push(`${bron}: ${j.actueel.reden}`)
  // 'fout' without 'actueel': the Worker has no data at all, or could not be reached
  : !j.actueel && j.fout && red.push(`${bron}: ${j.fout}`);
check('Luchtruim LVNL', JSON.parse(readFileSync('data/lvnl/meta.json', 'utf8')));
for (const [bron, url] of [['NOTAMs', 'https://vfr3d-notams.frank-e97.workers.dev/'], ['FUA', 'https://vfr3d-fua.frank-e97.workers.dev/']])
  check(bron, await fetch(url).then(r => r.json()).catch(e => ({ fout: String(e) })));

if (red.length) console.log(red.map(r => `- ${r}`).join('\n'));
