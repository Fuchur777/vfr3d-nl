// Keep a copy of LVNL's airspace (ArcGIS Airspaces_data) in data/lvnl, so the app does not ask LVNL on every visit.
// Only downloads again when LVNL's newest edit date is later than the stored one.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const LVNL = 'https://services-eu1.arcgis.com/OtUwzhpKSdeXgRIB/arcgis/rest/services/Airspaces_data/FeatureServer';
// only the layers the app draws (LAYERS in index.html)
const USED = [3, 5, 6, 7, 8, 10, 11, 13, 14, 15, 17, 18, 19];
const layers = (await (await fetch(`${LVNL}/layers?f=json`)).json()).layers.filter(l => USED.includes(l.id));
if (layers.length !== USED.length) throw new Error(`LVNL mist lagen: ${USED.filter(id => !layers.some(l => l.id === id))}`);
const lastEditDate = Math.max(...layers.map(l => l.editingInfo?.lastEditDate ?? 0));
const stored = JSON.parse(await readFile('data/lvnl/meta.json', 'utf8').catch(() => '{}'));
// 'actueel' in meta.json is what the app and the Status-check Action show for this set; only written when it changes
const nlDate = t => new Date(t).toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam' });
const GROEN = { kleur: 'groen', reden: 'Gelijk aan de nieuwste versie bij LVNL (elk uur gecontroleerd)' };
const save = meta => JSON.stringify(meta) === JSON.stringify(stored) ? null : writeFile('data/lvnl/meta.json', JSON.stringify(meta) + '\n');
if (!lastEditDate || lastEditDate <= (stored.lastEditDate ?? 0)) {
  console.log('LVNL ongewijzigd sinds', stored.lastEditDate ? new Date(stored.lastEditDate).toISOString() : 'onbekend');
  await save({ ...stored, actueel: GROEN });
  process.exit(0);
}
// fetch everything first; a doubtful layer keeps the old set, marks it red and fails the run (GitHub mails a failed run)
const sets = [];
try { for (const { id, name } of layers) {
  const geojson = await (await fetch(`${LVNL}/${id}/query?where=1%3D1&outFields=*&outSR=4326&f=geojson`)).json();
  if (geojson.type !== 'FeatureCollection') throw new Error(`laag ${id} ${name}: ${JSON.stringify(geojson).slice(0, 200)}`);
  if (geojson.properties?.exceededTransferLimit) throw new Error(`laag ${id} ${name}: meer features dan één verzoek teruggeeft`);
  // an empty layer, or one that lost more than half its features, is more likely an LVNL hiccup than real
  const before = JSON.parse(await readFile(`data/lvnl/${id}.geojson`, 'utf8').catch(() => '{"features":[]}')).features.length;
  if (geojson.features.length < (before ? Math.max(1, before / 2) : 0)) throw new Error(`laag ${id} ${name}: van ${before} naar ${geojson.features.length} features, niet overgenomen`);
  console.log(id, name, before, '->', geojson.features.length);
  sets.push([id, geojson]);
} } catch (e) {
  await save({ ...stored, actueel: { kleur: 'rood', reden: `LVNL heeft een versie van ${nlDate(lastEditDate)}, die is niet overgenomen (${e.message})` } });
  throw e;
}
await mkdir('data/lvnl', { recursive: true });
for (const [id, geojson] of sets) await writeFile(`data/lvnl/${id}.geojson`, JSON.stringify(geojson));
await writeFile('data/lvnl/meta.json', JSON.stringify({ lastEditDate, opgehaald: new Date().toISOString(), actueel: GROEN }) + '\n');
