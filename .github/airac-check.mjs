// On every AIRAC date: compare LVNL's open winch-site points (ArcGIS Aerodrome_data, layers 10 Glider
// and 11 Hangglider) with lier-*.geojson and print a Markdown checklist for a GitHub issue.
// The eAIP itself blocks automated requests, so heights and SUPs stay a manual check.
import { readFileSync } from 'node:fs';

const LVNL = 'https://services-eu1.arcgis.com/OtUwzhpKSdeXgRIB/arcgis/rest/services/Aerodrome_data/FeatureServer';
const lvnl = new Map();
for (const layer of [10, 11]) {
  const { features } = await (await fetch(`${LVNL}/${layer}/query?where=1%3D1&outFields=Designator,Name,EffectiveDate&outSR=4326&f=geojson`)).json();
  for (const f of features) lvnl.set(f.properties.Designator, { name: f.properties.Name, at: f.geometry.coordinates, since: f.properties.EffectiveDate });
}
// our sites are 1 NM circles; their centre is the mean of the ring without the closing point
const ours = new Map();
for (const file of ['lier-zweefvliegen.geojson', 'lier-paragliden.geojson']) {
  for (const f of JSON.parse(readFileSync(file, 'utf8')).features) {
    const ring = f.geometry.coordinates[0].slice(0, -1);
    ours.set(f.properties.Designator, { file, at: [0, 1].map(i => ring.reduce((s, p) => s + p[i], 0) / ring.length) });
  }
}
const metres = ([a, b], [c, d]) => Math.hypot((c - a) * Math.cos(b * Math.PI / 180), d - b) * 111320;
const lines = [];
for (const [id, site] of lvnl) {
  if (!ours.has(id)) {
    lines.push(`- Nieuw bij LVNL: **${id}** ${site.name} (${site.at[1].toFixed(4)}, ${site.at[0].toFixed(4)})`);
  } else if (metres(site.at, ours.get(id).at) > 200) {
    lines.push(`- Verschoven: **${id}** ${site.name}, ${Math.round(metres(site.at, ours.get(id).at))} m`);
  }
}
// aerodrome winches (EHxxGLD) are not in the LVNL service, so only EHAA sites can disappear
for (const id of ours.keys()) {
  if (id.startsWith('EHAA') && !lvnl.has(id)) lines.push(`- Niet meer bij LVNL: **${id}** (${ours.get(id).file})`);
}
const since = Math.max(...[...lvnl.values()].map(s => s.since));
console.log(`Nieuwe AIRAC-editie. LVNL-lierpunten bijgewerkt per ${new Date(since).toISOString().slice(0, 10)}.

## Lierlocaties (LVNL open data vs. vfr3d)
${lines.length ? lines.join('\n') : 'Geen verschillen gevonden.'}

## Handmatig in de eAIP nakijken
- [ ] ENR 5.5: hoogtes en lierlocaties op vliegvelden (bij wijzigingen ENR 5.5 in de vfr3d-chat plakken)
- [ ] Lijst met geldige AIP SUP's: is SUP 03/2022 (tijdafhankelijke klasse TMA's) nog geldig en ongewijzigd?
- [ ] Nieuwe ICAO-kaart 1:500.000 verschenen? (icao-nl.jpg)

Niets veranderd? Sluit dit issue.`);
