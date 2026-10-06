# -*- coding: utf-8 -*-
"""实测 progress.sav 里的任务(Quest)进度变量机制。

要回答三个问题：
 1. Step_<任务key> 这种变量在 hash 表里吗？值长什么样？
 2. 任务 key 是否就是 ROM 里的 Quest key（还是另一种映射）？
 3. 完成态怎么判定（== 'Complete' 的哈希值？还是别的）？
用法: probe_quest.py <progress.sav 路径>
"""
import sys, os, struct, json

def murmur3_x86_32(key, seed=0):
    """murmurHash3.x86.hash32 —— 与前端 murmurhash3js 保持一致"""
    key = key.encode('utf-8')
    c1, c2 = 0xcc9e2d51, 0x1b873593
    length = len(key)
    h1 = seed
    rounded_end = (length & 0xfffffffc)
    for i in range(0, rounded_end, 4):
        k1 = (key[i] & 0xff) | ((key[i+1] & 0xff) << 8) | \
             ((key[i+2] & 0xff) << 16) | (key[i+3] << 24)
        k1 = (k1 * c1) & 0xFFFFFFFF
        k1 = ((k1 << 15) | (k1 >> 17)) & 0xFFFFFFFF
        k1 = (k1 * c2) & 0xFFFFFFFF
        h1 ^= k1
        h1 = ((h1 << 13) | (h1 >> 19)) & 0xFFFFFFFF
        h1 = (h1 * 5 + 0xe6546b64) & 0xFFFFFFFF
    k1 = 0
    val = length & 0x03
    if val == 3:
        k1 = (key[rounded_end + 2] & 0xff) << 16
    if val in (2, 3):
        k1 |= (key[rounded_end + 1] & 0xff) << 8
    if val in (1, 2, 3):
        k1 |= (key[rounded_end] & 0xff)
        k1 = (k1 * c1) & 0xFFFFFFFF
        k1 = ((k1 << 15) | (k1 >> 17)) & 0xFFFFFFFF
        k1 = (k1 * c2) & 0xFFFFFFFF
        h1 ^= k1
    h1 ^= length
    h1 ^= (h1 >> 16)
    h1 = (h1 * 0x85ebca6b) & 0xFFFFFFFF
    h1 ^= (h1 >> 13)
    h1 = (h1 * 0xc2b2ae35) & 0xFFFFFFFF
    h1 ^= (h1 >> 16)
    return h1


def parse(path):
    data = open(path, 'rb').read()
    size = len(data)
    assert struct.unpack('<I', data[0:4])[0] == 0x01020304, 'bad header'
    header = struct.unpack('<I', data[4:8])[0]
    meta = struct.unpack('<I', data[8:12])[0]
    print('size=%d header=0x%08x meta=0x%08x' % (size, header, meta))

    value_by_hash = {}
    guid_off = None
    for j in range(0x28, min(0x03c800, size) - 7, 8):
        h = struct.unpack('<I', data[j:j+4])[0]
        if h == 0xA3DB7114:
            guid_off = struct.unpack('<I', data[j+4:j+8])[0]
            break
        value_by_hash[h] = j + 4
    print('hash表条目数=%d  guid表偏移=0x%x' % (len(value_by_hash), guid_off or 0))
    return data, value_by_hash, guid_off


def hval(data, value_by_hash, h):
    off = value_by_hash.get(h)
    return None if off is None else struct.unpack('<I', data[off:off+4])[0]


if __name__ == '__main__':
    path = sys.argv[1]
    data, vb, _ = parse(path)

    # 1) 拿几个已知任务 key 试探
    probes = ['Step_AisyaRescue', 'Step_AmberCollector', 'Step_ArrowMeister_Momo',
              'Step_GoddessStatue', 'Step_MonsterTruck']
    print('\n--- Step_ 变量探测 ---')
    for p in probes:
        h = murmur3_x86_32(p)
        print('%-28s hash=0x%08x  在hash表=%s  值=%s' %
              (p, h, h in vb, hval(data, vb, h)))

    # 2) 状态枚举的哈希值
    print('\n--- 状态字符串哈希 ---')
    for s in ['Complete', 'Clear', 'NotStarted', 'InProgress', 'True', '1']:
        print('%-12s 0x%08x' % (s, murmur3_x86_32(s)))

    # 3) 全表扫描：找出所有 Step_ 命中的hash（反查不可行，改用任务清单）
    print('\n--- 从 tasks.js 读任务 key ---')
    app = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app')
    tj = open(os.path.join(app, 'data', 'tasks.js'), encoding='utf-8').read()
    import re
    keys = re.findall(r'"?key"?\s*:\s*"([A-Za-z0-9_]+)"', tj)
    keys = sorted(set(keys))
    print('tasks.js 中 key 数 =', len(keys))
    hit = [k for k in keys if murmur3_x86_32('Step_' + k) in vb]
    print('其中 Step_<key> 命中 hash 表的 =', len(hit))
    print('示例命中:', hit[:10])

    if hit:
        print('\n--- 命中任务的状态值分布 ---')
        from collections import Counter
        dist = Counter()
        for k in hit:
            dist[hval(data, vb, murmur3_x86_32('Step_' + k))] += 1
        for v, n in dist.most_common(20):
            print('  值=%s 出现 %d 次' % (v, n))
        print('\n值语义对照: Complete=0x%08x  Clear=0x%08x  True=0x%08x'
              % (murmur3_x86_32('Complete'), murmur3_x86_32('Clear'), murmur3_x86_32('True')))
        print('\n--- 前 20 个命中任务明细 ---')
        for k in hit[:20]:
            print('  %-32s = %s' % (k, hval(data, vb, murmur3_x86_32('Step_' + k))))