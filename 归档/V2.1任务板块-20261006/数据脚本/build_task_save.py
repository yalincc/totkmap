# -*- coding: utf-8 -*-
"""从 marcrobledo/savegame-editors 的 zelda-totk.hashes.csv 提取任务(Quest)存档变量表。

产出 app/data/task-save.js：
  window.TOTK_TASK_SAVE = {
    "<任务key>": {
      hash: 0xe0c24add,        // murmurHash3("Step_<key>")，hash 表里的键
      done:  0x0a1b2c3d,       // murmurHash3("Complete")，该任务"完成"态的值
      stages: ["NotReady","Ready","Step1","Step1a","Step2","Complete"]  // 全部阶段（按官方顺序）
    }, ...
  }

用法: build_task_save.py <hashes.csv 路径> <tasks.js 路径> <输出路径>
"""
import sys, os, re, json

def murmur3_x86_32(key, seed=0):
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
    h1 = (h1 * 85 + 0x6b) & 0xFFFFFFFF   # 占位，下面重算
    h1 = _fmix32(h1 ^ length)
    return h1


def _fmix32(h):
    h ^= h >> 16
    h = (h * 0x85ebca6b) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 0xc2b2ae35) & 0xFFFFFFFF
    h ^= h >> 16
    return h


def H(s):
    """正确版 murmur3（与 probe_quest.py 中已实测通过的版本一致）"""
    key = s.encode('utf-8')
    c1, c2 = 0xcc9e2d51, 0x1b873593
    length = len(key)
    h1 = 0
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
    return _fmix32(h1 ^ length)


def main():
    csv_path, tasks_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

    # 1) 抽 EnumValues 里所有 Step_* 的阶段枚举
    enums = {}   # 'Step_XXX' -> [阶段名...]
    for line in open(csv_path, encoding='utf-8', errors='replace'):
        if not line.startswith('EnumValues;'):
            continue
        parts = line.rstrip('\n').split(';')
        if len(parts) < 3:
            continue
        patterns = parts[1].split(',')
        options = parts[2].split(',')
        for p in patterns:
            if p.startswith('Step_'):
                enums[p] = options

    print('CSV 中 Step_ 枚举数 =', len(enums))

    # 2) 抽 tasks.js 的任务 key
    tj = open(tasks_path, encoding='utf-8').read()
    keys = sorted(set(re.findall(r'"?key"?\s*:\s*"([A-Za-z0-9_]+)"', tj)))
    print('tasks.js 任务 key 数 =', len(keys))

    # 3) 组装
    out, missing = {}, []
    for k in keys:
        var = 'Step_' + k
        if var not in enums:
            missing.append(k)
            continue
        stages = enums[var]
        if 'Complete' not in stages:
            missing.append(k + ' (无Complete)')
            continue
        out[k] = {
            'hash':   H(var),
            'done':   H('Complete'),
            'stages': stages,
            'doneIdx': stages.index('Complete'),
        }

    print('成功映射 =', len(out), ' 缺失 =', len(missing))
    if missing:
        print('缺失示例:', missing[:15])

    # 4) 输出 js（用 hex 字符串免得 JS 大整数十进制丢精度）
    lines = ['/* TOTKmap 任务存档变量表（由 tools/build_task_save.py 自动生成，勿手改）',
             ' * 来源：marcrobledo/savegame-editors (MIT) zelda-totk.hashes.csv 的 EnumValues 行',
             ' * 机制：progress.sav 的 hash 表键 = murmurHash3("Step_<任务key>")',
             ' *       值 = 当前阶段名的 murmurHash3；等于 Complete 的哈希即已完成',
             ' * 依赖：全局 hash() 函数（与 save-parser.js 共用 vendor/murmurhash3js.min.js）',
             ' * 字段：hash 键 / done 完成态哈希 / stages 全部阶段（官方顺序）/ doneIdx 完成态下标',
             ' */',
             'window.TOTK_TASK_SAVE = {']
    for k in sorted(out):
        v = out[k]
        st = ','.join('"%s"' % s for s in v['stages'])
        lines.append('  "%s": { hash: "0x%08x", done: "0x%08x", doneIdx: %d, stages: [%s] },'
                     % (k, v['hash'], v['done'], v['doneIdx'], st))
    lines.append('};')
    lines.append('')
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    open(out_path, 'w', encoding='utf-8').write('\n'.join(lines))
    print('已写出', out_path)


if __name__ == '__main__':
    main()