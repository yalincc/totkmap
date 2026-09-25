#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json, os
from collections import Counter, defaultdict

P = r'E:\WorkSpace\TOTKmap\data\materials.js'
OUT = r'E:\WorkSpace\TOTKmap\tools\_probe_sky.out.txt'

s = open(P, encoding='utf-8').read()
s = s[s.index('{'):s.rindex(';')]
d = json.loads(s)
pts = d['points']
mats = {m['id']: m for m in d['materials']}

lines = []
lines.append('meta: ' + json.dumps(d['meta'], ensure_ascii=False))

lc = Counter()
for i in range(0, len(pts), 4):
    lc[pts[i+1]] += 1
lines.append('layer dist: ' + str(dict(lc)))

per = defaultdict(Counter)
for i in range(0, len(pts), 4):
    per[pts[i]][pts[i+1]] += 1

names = {18: 'surface', 19: 'depths', 20: 'sky'}
for cat in ['植物','蘑菇','水果','昆虫','鱼','矿岩']:
    lines.append('===== ' + cat + ' =====')
    ids = [m['id'] for m in d['materials'] if m['cat'] == cat]
    for mid in ids:
        c = per[mid]
        tot = sum(c.values())
        sk = c.get(20, 0)
        if sk or tot:
            lines.append('  %-14s total=%-6d sky=%-5d depths=%-6d surface=%-6d' %
                         (mats[mid]['cn'], tot, sk, c.get(19,0), c.get(18,0)))

lines.append('===== SKY (layer 20) detail =====')
sky_pts = []
for i in range(0, len(pts), 4):
    if pts[i+1] == 20:
        sky_pts.append((mats[pts[i]]['cn'], pts[i+2], pts[i+3]))
lines.append('sky point count: %d' % len(sky_pts))
by = Counter(n for n, x, z in sky_pts)
for n, c in by.most_common():
    xs = [x for nn, x, z in sky_pts if nn == n]
    zs = [z for nn, x, z in sky_pts if nn == n]
    lines.append('  %-14s %-5d X[%.0f..%.0f] Z[%.0f..%.0f]' % (n, c, min(xs), max(xs), min(zs), max(zs)))

lines.append('===== surface points with high Z-extent sanity =====')
allx = [pts[i+2] for i in range(0, len(pts), 4)]
allz = [pts[i+3] for i in range(0, len(pts), 4)]
lines.append('X range %.0f..%.0f  Z range %.0f..%.0f' % (min(allx), max(allx), min(allz), max(allz)))

open(OUT, 'w', encoding='utf-8').write('\n'.join(lines))
print('OK', len(lines))
