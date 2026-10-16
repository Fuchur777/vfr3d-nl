// Keep a copy of LVNL's airspace (ArcGIS Airspaces_data) in data/lvnl, so the app does not ask LVNL on every visit.
// Only downloads again when LVNL's newest edit date is later than the stored one.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const LVNL = 'https://services-eu1.arcgis.com/OtUwzhpKSdeXgRIB/arcgis/rest/services/Airspaces_data/FeatureServer';
const { layers } = await (await fetch(`${LVNL}/layers?f=json`)).json();
const lastEditDate = Math.max(...layers.map(l => l.editingInfo?.lastEditDate ?? 0));
const stored = JSON.parse(await readFile('data/lvnl/meta.json', 'utf8').catch(() => '{}'));
if (!lastEditDate || lastEditDate <= (stored.lastEditDate ?? 0)) {
  console.log('LVNL ongewijzigd sinds', new Date(stored.lastEditDate).toISOString());
  process.exit(0);
}
await mkdir('data/lvnl', { recursive: true });
for (const { id, name } of layers) {
  const geojson = await (await fetch(`${LVNL}/${id}/query?where=1%3D1&outFields=*&outSR=4326&f=geojson`)).json();
  if (geojson.type !== 'FeatureCollection') throw new Error(`laag ${id} ${name}: ${JSON.stringify(geojson).slice(0, 200)}`);
  if (geojson.properties?.exceededTransferLimit) throw new Error(`laag ${id} ${name}: meer features dan één verzoek teruggeeft`);
  await writeFile(`data/lvnl/${id}.geojson`, JSON.stringify(geojson));
  console.log(id, name, geojson.features.length);
}
await writeFile('data/lvnl/meta.json', JSON.stringify({ lastEditDate, opgehaald: new Date().toISOString() }) + '\n');
