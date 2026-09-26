# -*- coding: utf-8 -*-
"""V1.8.0 瓦片优化：tiles_obj z3/z4 PNG → WebP q80（体积 23.3MB → ~4.2MB）。
用法: python tools/convert_z34_webp.py   （幂等：已存在 .webp 则跳过对应 png）
"""
import os, glob, io
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TILES = os.path.join(ROOT, 'tiles_obj')
Q = 80

def convert(layer, z):
    d = os.path.join(TILES, layer, z)
    if not os.path.isdir(d):
        return 0, 0, 0
    files = glob.glob(os.path.join(d, '*.png'))
    n = 0
    old = 0
    new = 0
    for f in files:
        webp = f[:-4] + '.webp'
        im = Image.open(f).convert('RGB')
        b = io.BytesIO()
        im.save(b, 'WEBP', quality=Q, method=6)
        old += os.path.getsize(f)
        new += len(b.getvalue())
        with open(webp, 'wb') as w:
            w.write(b.getvalue())
        os.remove(f)
        n += 1
    return n, old, new

def main():
    tot_old = tot_new = 0
    for layer in ('ground', 'depths', 'sky'):
        for z in ('3', '4'):
            n, old, new = convert(layer, z)
            tot_old += old
            tot_new += new
            if n:
                print('%-7s z%s: %3d tiles  %7.1fKB -> %6.1fKB (%.0f%%)' %
                      (layer, z, n, old / 1024, new / 1024, new / old * 100))
    print('合计: %.2f MB -> %.2f MB' % (tot_old / 1e6, tot_new / 1e6))

if __name__ == '__main__':
    main()
