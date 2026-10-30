# CTRs are excluded from TMZs (EH-6-TMZ notes). Splits each TMZ of data/lvnl/8.geojson into the part outside all cut areas and one part
# per cut area it covers, written to data/lvnl/tmz-ctr.geojson:
# - a CTR (property CTR = its designator): the app starts that part above the CTR while the CTR is switched on, and draws the TMZ as
#   published when it is off: military CTRs are only active when open (Frank 2026-10-30)
# - the Malden area in TMZ D (property Malden): exempted in weekends, the app starts that part at FL045 then
# - Schiphol TMA 7 and 8 in TMZ Schiphol Area (note 5, excluded): that part ends at 1300 ft, under the TMA
import json
from shapely.geometry import shape, mapping

load = lambda n: json.load(open(f'data/lvnl/{n}.geojson'))['features']
area = lambda f: shape(f['geometry']).buffer(0)
TMZ_D = ('EHAATMZD', 'EHTMZD1', 'EHTMZD2')
# [geometry, extra properties, TMZ designators it applies to (None = all)]
cuts = [(area(c), {'CTR': c['properties']['Designator']}, None) for c in load(15) if c.get('geometry')]
cuts += [(area(m), {'Malden': True}, TMZ_D) for m in load(11) if m['properties'].get('Designator') == 'EHAAGLD087']
cuts += [(area(t), {'UpperLimit': 1300, 'UpperLimitUnit': 'FT', 'UpperLimitReference': 'MSL', 'SchipholTma': True}, ('EHAMTMZ',))
         for t in load(14) if t['properties'].get('Designator') in ('EHAM7', 'EHAM8')]
polygons = lambda g: [g] if g.geom_type == 'Polygon' else [p for p in getattr(g, 'geoms', []) if p.geom_type == 'Polygon']
rounded = lambda g: json.loads(json.dumps(mapping(g)), parse_float=lambda x: round(float(x), 6))

out = []
for t in load(8):
    if not t.get('geometry'):
        continue
    rest, props = area(t), t['properties']
    for g, extra, only in cuts:
        # slivers along shared borders (well under 1% of the cut area) are not a real overlap
        if only and props['Designator'] not in only or rest.intersection(g).area <= 0.01 * g.area:
            continue
        out += [{'type': 'Feature', 'geometry': rounded(p), 'properties': {**props, **extra}} for p in polygons(rest.intersection(g)) if p.area > 1e-9]
        rest = rest.difference(g)
    out += [{'type': 'Feature', 'geometry': rounded(p), 'properties': props} for p in polygons(rest) if p.area > 1e-9]
json.dump({'type': 'FeatureCollection', 'features': out}, open('data/lvnl/tmz-ctr.geojson', 'w'), separators=(',', ':'))
