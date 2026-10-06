# -*- coding: utf-8 -*-
"""交叉验证：用存档里其他已知进度（神庙/龙之泪/鸟望台）推断游戏进度阶段，
验证「任务只完成 3 个」是真实情况而非判定错误。
用法: cross_check.py <progress.sav>
"""
import sys, os, re, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_quest import murmur3_x86_32 as H

app = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app')

data = open(sys.argv[1], 'rb').read()
vb = {}
for j in range(0x28, min(0x03c800, len(data)) - 7, 8):
    h = int.from_bytes(data[j:j+4], 'little')
    if h == 0xA3DB7114:
        break
    vb[h] = j + 4


def val(name):
    off = vb.get(H(name))
    return None if off is None else int.from_bytes(data[off:off+4], 'little')


# 读 CompletismHashes（粗略提取 SHRINES_STATUS / TOWERS_FOUND 的哈希列表）
txt = open(os.path.join(app, 'data', 'totk_save_hashes.js'), encoding='utf-8').read()


def grab(var):
    m = re.search(var + r'\s*:\s*\[(.*?)\]', txt, re.S)
    if not m:
        return []
    return [int(x, 16) for x in re.findall(r'0x([0-9a-fA-F]+)', m.group(1))]


shrines = grab('SHRINES_STATUS')
towers = grab('TOWERS_FOUND')
print('神庙哈希数 =', len(shrines), ' 鸟望台哈希数 =', len(towers))

clear_h = H('Clear')
sc = sum(1 for h in shrines if vb.get(h) is not None and int.from_bytes(data[vb[h]:vb[h]+4], 'little') == clear_h)
sf = sum(1 for h in shrines if vb.get(h) is not None)
tc = sum(1 for h in towers if vb.get(h) is not None and int.from_bytes(data[vb[h]:vb[h]+4], 'little') == 1)
tf = sum(1 for h in towers if vb.get(h) is not None)
print('神庙：已清除 %d / 存档中存在 %d （全表152）' % (sc, sf))
print('鸟望台：已激活 %d / 存档中存在 %d （全表15）' % (tc, tf))

print()
print('=== 关键进度变量 ===')
for n in ['GameClock', 'PlayTime', 'RupeeCount', 'HeartPiece',
          'MapData.CurrentLayer', 'PlayerStatus.CurrentSpecialPower',
          'ClearCount_Shrine', 'Count_Shrine']:
    print('  %-34s = %s' % (n, val(n)))