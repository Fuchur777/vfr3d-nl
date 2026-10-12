// 3D aircraft models for IGC playback, removed from index.html on 2026-10-12 (Frank: keep for later).
// To restore: paste this block above "// altitude as the altimeter shows it" in index.html, then
// 1. in the IGC onchange: after `fixes = parseIgc(text);` add `kind = craft(text);`
// 2. at the end of showTrack(), after `track.position = position;`, add:
//     // the model faces its direction over the ground, so the vertical scale does not tilt it
//     const ground = new Cesium.SampledPositionProperty();
//     fixes.forEach(f => ground.addSample(f.time, Cesium.Cartesian3.fromDegrees(f.lon, f.lat)));
//     track.orientation = new Cesium.VelocityOrientationProperty(ground);
//     track.model = kind ? { uri: MODELS[kind], minimumPixelSize: 40, show: !cockpit.checked } : undefined;
//     track.point.show = !kind && !cockpit.checked;
// 3. in cockpit.onchange: `track.point.show = !kind && !cockpit.checked; if (track.model) track.model.show = !cockpit.checked;`
// 4. optional: show KIND_NAMES[kind] in the flight line.

// aircraft kind from the glider type (and class) in the IGC header; unknown means the dot stays
const craft = text => {
  const t = [...text.matchAll(/^HF(?:GTY|CCL)[^:\r\n]*:(.*)$/gim)].map(m => m[1]).join(' ').toLowerCase().trim();
  if (!t || /^(nil|none|unknown)?$/.test(t)) return;
  if (/paraglid|gleitschirm|parapente|scherm|advance|ozone|\bgin\b|\bnova\b|niviuk|skywalk|mac ?para|\bbgd\b|\bphi\b|supair|dudek|\bswing\b|u-turn|airdesign|icaro/.test(t)) return 'scherm';
  if (/cessna|piper|robin|tecnam|ikarus|\bc42\b|katana|diamond da|socata|cirrus sr|zlin|aquila|eurostar|bristell|motor/.test(t)) return 'motor';
  return 'zweef';
};
// simple 3D models as glTF built from coloured boxes: [x forward, y up, z sideways, length, height, width, colour], metres
const MODEL_PARTS = {
  zweef: [[0, 0, 0, 8, .8, .7, '#f4f4f4'], [1.8, .45, 0, 1.4, .35, .6, '#33414d'], [.6, .35, 0, 1, .12, 20, '#f4f4f4'], [.6, .35, 9.6, 1, .13, .8, '#e03131'], [.6, .35, -9.6, 1, .13, .8, '#e03131'],
    [-3.7, .9, 0, .8, 1.6, .1, '#f4f4f4'], [-3.9, 1.7, 0, .6, .08, 3, '#f4f4f4']],
  motor: [[0, 0, 0, 7, 1.2, 1.1, '#f4f4f4'], [1.2, .5, 0, 1.6, .5, 1.05, '#33414d'], [.5, .7, 0, 1.5, .15, 10, '#c92a2a'], [3.55, 0, 0, .1, 1.8, .2, '#222'],
    [-3.2, .9, 0, .9, 1.4, .1, '#c92a2a'], [-3.3, .3, 0, .8, .08, 3.4, '#f4f4f4']],
  scherm: [...[-3, -2, -1, 0, 1, 2, 3].map(i => [0, 7 - .25 * i * i, i * 1.6, 2.6, .35, 1.7, i % 2 ? '#fab005' : '#f76707']), [0, 0, 0, .7, 1, .5, '#33414d']],
};
function boxesToGltf(parts) {
  const pos = [], nor = [], col = [], idx = [];
  const F = [[0, 1, 2, 1], [0, 1, 2, -1], [1, 2, 0, 1], [1, 2, 0, -1], [2, 0, 1, 1], [2, 0, 1, -1]]; // axis pairs per face, normal sign
  for (const [x, y, z, l, h, w, c] of parts) {
    const ctr = [x, y, z], half = [l / 2, h / 2, w / 2], rgb = Cesium.Color.fromCssColorString(c);
    for (const [a, b, n, sgn] of F) {
      const base = pos.length / 3;
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const pt = [...ctr]; pt[a] += u * half[a]; pt[b] += v * half[b]; pt[n] += sgn * half[n];
        const nn = [0, 0, 0]; nn[n] = sgn;
        pos.push(...pt); nor.push(...nn); col.push(rgb.red, rgb.green, rgb.blue);
      }
      idx.push(...(sgn > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]).map(i => base + i));
    }
  }
  const f = new Float32Array([...pos, ...nor, ...col]), ix = new Uint16Array(idx), bytes = new Uint8Array(f.byteLength + ix.byteLength);
  bytes.set(new Uint8Array(f.buffer)); bytes.set(new Uint8Array(ix.buffer), f.byteLength);
  const n = pos.length / 3, view = (byteOffset, byteLength, target) => ({ buffer: 0, byteOffset, byteLength, target });
  const min = [0, 1, 2].map(k => Math.min(...pos.filter((_, i) => i % 3 === k))), max = [0, 1, 2].map(k => Math.max(...pos.filter((_, i) => i % 3 === k)));
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: .8 } }],
    buffers: [{ byteLength: bytes.byteLength, uri: 'data:application/octet-stream;base64,' + btoa(String.fromCharCode(...bytes)) }],
    bufferViews: [view(0, n * 12, 34962), view(n * 12, n * 12, 34962), view(n * 24, n * 12, 34962), view(n * 36, ix.byteLength, 34963)],
    accessors: [{ bufferView: 0, componentType: 5126, count: n, type: 'VEC3', min, max }, { bufferView: 1, componentType: 5126, count: n, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: n, type: 'VEC3' }, { bufferView: 3, componentType: 5123, count: idx.length, type: 'SCALAR' }],
  };
  return URL.createObjectURL(new Blob([JSON.stringify(gltf)], { type: 'model/gltf+json' }));
}
const MODELS = Object.fromEntries(Object.entries(MODEL_PARTS).map(([k, parts]) => [k, boxesToGltf(parts)]));
const KIND_NAMES = { zweef: 'zweefvliegtuig', motor: 'motorvliegtuig', scherm: 'paraglider' };
let kind;

