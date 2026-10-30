# CTRs are excluded from TMZs (EH-6-TMZ notes). Splits each TMZ of data/lvnl/8.geojson into the part outside all CTRs and one part
# per CTR it covers (property CTR = that CTR's designator), written to data/lvnl/tmz-ctr.geojson. The app starts such a part above
# the CTR while the CTR is switched on, and draws the TMZ as published when it is off: military CTRs are only active when open (Frank 2026-10-30)
import json
from shapely.geometry import shape, mapping
from shapely.ops import unary_union

load = lambda n: json.load(open(f'data/lvnl/{n}.geojson'))['features']
ctrs = [(c['properties']['Designator'], shape(c['geometry']).buffer(0)) for c in load(15) if c.get('geometry')]
polygons = lambda g: [g] if g.geom_type == 'Polygon' else [p for p in getattr(g, 'geoms', []) if p.geom_type == 'Polygon']
rounded = lambda g: json.loads(json.dumps(mapping(g)), parse_float=lambda x: round(float(x), 6))

out = []
for t in load(8):
    if not t.get('geometry'):
        continue
    tmz = shape(t['geometry']).buffer(0)
    # slivers along shared borders (well under 1% of the CTR) are not a real overlap
    parts = [(d, tmz.intersection(c)) for d, c in ctrs if tmz.intersection(c).area > 0.01 * c.area]
    rest = tmz.difference(unary_union([c for d, c in ctrs if any(d == p for p, _ in parts)])) if parts else tmz
    for g in polygons(rest):
        if g.area > 1e-9:
            out.append({'type': 'Feature', 'geometry': rounded(g), 'properties': t['properties']})
    for d, part in parts:
        for g in polygons(part):
            if g.area > 1e-9:
                out.append({'type': 'Feature', 'geometry': rounded(g), 'properties': {**t['properties'], 'CTR': d}})
json.dump({'type': 'FeatureCollection', 'features': out}, open('data/lvnl/tmz-ctr.geojson', 'w'), separators=(',', ':'))
