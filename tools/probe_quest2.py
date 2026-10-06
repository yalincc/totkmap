# -*- coding: utf-8 -*-
"""Step_ 变量值的真实语义深挖。

疑点：值 398436934 / 1471695344 都不是任何状态字符串的哈希。
假设 A：Step_ 是 int64 变量，我只读了低 4 字节。
假设 B：值是字符串表索引，指向真正的状态名。
验证手段：读 12 字节看完整值 + 跨存档对比同一 key。
用法: probe_quest2.py <save1> [save2 ...]
"""
import sys, os, struct, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_quest import murmur3_x86_32 as H


def parse(path):
    data = open(path, 'rb').read()
    vb, goff = {}, None
    for j in range(0x28, min(0x03c800, len(data)) - 7, 8):
        h = struct.unpack('<I', data[j:j+4])[0]
        if h == 0xA3DB7114:
            goff = struct.unpack('<I', data[j+4:j+8])[0]
            break
        vb[h] = j + 4
    return data, vb, goff


def raw(data, off, n=12):
    return data[off:off+n].hex()


if __name__ == '__main__':
    saves = sys.argv[1:]
    parsed = {}
    for p in saves:
        data, vb, goff = parse(p)
        parsed[p] = (data, vb, goff)
        print('%s  条目=%d guid@0x%x' % (os.path.basename(os.path.dirname(os.path.dirname(p))), len(vb), goff))

    data, vb, goff = parsed[saves[0]]

    print('\n=== 1) 同一 Step_ 变量的 12 字节原始值 ===')
    for k in ['AisyaRescue', 'ArrowMeister_Momo', 'CarryGoronKid2', 'CDungeon_AllDone']:
        off = vb[H('Step_' + k)]
        print('  %-22s off=0x%06x  %s' % (k, off, raw(data, off, 12)))

    print('\n=== 2) 已知 int 变量的值形态（对照：数量类）===')
    for k in ['Count_Shrine', 'WoodenSword', 'Key_Sword', 'RupeeCount']:
        h = H(k)
        if h in vb:
            off = vb[h]
            print('  %-22s off=0x%06x  %s  u32=%d' % (k, off, raw(data, off, 12), struct.unpack('<I', data[off:off+4])[0]))

    print('\n=== 3) 跨存档对比（值是否随进度变化）===')
    keys = ['AisyaRescue', 'ArrowMeister_Momo', 'Big_Rotate', 'BuildHouse',
            'CarryStone', 'CDungeon_AllDone', 'BirdManContest']
    print('  %-24s %s' % ('key', ' | '.join('save%d' % (i+1) for i in range(len(saves)))))
    for k in keys:
        row = []
        for p in saves:
            d, v, _ = parsed[p]
            o = v.get(H('Step_' + k))
            row.append('-' if o is None else str(struct.unpack('<I', d[o:o+4])[0]))
        print('  %-24s %s' % (k, ' | '.join(row)))

    print('\n=== 4) 值 -> 字符串表反查（在 guid 表之后的字符串区找）===')
    # TOTK 字符串表：每个条目 [hash:4][len:4][utf16le 字符串]
    # 试在 guid 表附近与文件尾扫描
    for p in saves[:1]:
        d, v, g = parsed[p]
        targets = {398436934, 1471695344, 1275749364}
        found = {}
        for i in range(0, len(d) - 4, 4):
            val = struct.unpack('<I', d[i:i+4])[0]
            if val in targets and val not in found:
                found[val] = i
        print('  目标值在文件中的首次出现偏移:')
        for val, off in found.items():
            ctx = d[max(0, off-8):off+40]
            # 尝试解 utf-16le
            try:
                s = ctx.decode('utf-16-le', errors='replace')
            except Exception:
                s = ''
            print('    %d @0x%06x  十六进制=%s' % (val, off, ctx.hex()))
            print('        utf16预览=%r' % s[:40])

    print('\n=== 5) 字符串表扫描：定位所有 utf16 字符串区 ===')
    d = parsed[saves[0]][0]
    runs = []
    i = 0
    n = len(d)
    while i < n - 8:
        # 找 [hash:4][len:4] 后面跟着 len 个 utf16 字符的形态
        if i + 8 < n:
            slen = struct.unpack('<I', d[i+4:i+8])[0]
            if 2 <= slen <= 200 and (i + 8 + slen * 2) <= n:
                try:
                    raw_s = d[i+8:i+8+slen*2]
                    txt = raw_s.decode('utf-16-le')
                    if txt and all(ord(c) < 0x3000 for c in txt) and any(c.isalpha() for c in txt):
                        runs.append((i, slen, txt))
                        i += 8 + slen * 2
                        continue
                except Exception:
                    pass
        i += 2
    print('  找到字符串条目数 =', len(runs))
    if runs:
        print('  范围: 0x%x ~ 0x%x' % (runs[0][0], runs[-1][0] + 8 + runs[-1][1]*2))
        print('  前 30 条:')
        for off, slen, txt in runs[:30]:
            print('    @0x%06x len=%-4d %r' % (off, slen, txt[:60]))
        # 在字符串表里找状态词
        print('\n  字符串表里的状态词:')
        kw = ['Complete', 'NotStarted', 'InProgress', 'Clear', 'Ongoing', 'Ready', 'Done', 'Waiting']
        for off, slen, txt in runs:
            if txt in kw:
                print('    @0x%06x %r' % (off, txt))