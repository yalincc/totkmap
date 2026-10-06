# -*- coding: utf-8 -*-
"""用真实 progress.sav 验证 task-save.js 的完成判定。

读 app/data/task-save.js + tasks.js，对每个任务算出：
  - 是否命中 hash 表
  - 当前值反查出的阶段名
  - 是否判定为完成
并输出「任务中文名 → 阶段」的对照，便于人工核对正确性。
用法: verify_task_save.py <progress.sav> [tasks.js] [task-save.js]
"""
import sys, os, re, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe_quest import murmur3_x86_32 as H


def load_js_obj(path, var_name):
    """解析 window.X = { "key": {...}, ... } —— 键有引号但值是裸标识符，非合法 JSON。"""
    txt = open(path, encoding='utf-8').read()
    i = txt.index(var_name)
    j = txt.index('{', i)
    depth, k = 0, j
    while True:
        if txt[k] == '{':
            depth += 1
        elif txt[k] == '}':
            depth -= 1
            if depth == 0:
                break
        k += 1
    body = txt[j:k+1]
    out = {}
    for m in re.finditer(
            r'"([^"]+)"\s*:\s*\{\s*hash\s*:\s*"(0x[0-9a-fA-F]+)"\s*,\s*'
            r'done\s*:\s*"(0x[0-9a-fA-F]+)"\s*,\s*doneIdx\s*:\s*(\d+)\s*,\s*'
            r'stages\s*:\s*\[([^\]]*)\]', body):
        stages = re.findall(r'"([^"]+)"', m.group(5))
        out[m.group(1)] = {
            'hash': m.group(2),
            'done': m.group(3),
            'doneIdx': int(m.group(4)),
            'stages': stages,
        }
    return out


def main():
    sav = sys.argv[1]
    app = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app')
    tasks_js = sys.argv[2] if len(sys.argv) > 2 else os.path.join(app, 'data', 'tasks.js')
    save_js = sys.argv[3] if len(sys.argv) > 3 else os.path.join(app, 'data', 'task-save.js')

    data = open(sav, 'rb').read()
    vb = {}
    for j in range(0x28, min(0x03c800, len(data)) - 7, 8):
        h = int.from_bytes(data[j:j+4], 'little')
        if h == 0xA3DB7114:
            break
        vb[h] = j + 4
    print('hash 表条目 =', len(vb))

    tmap = load_js_obj(save_js, 'window.TOTK_TASK_SAVE')
    print('task-save.js 任务数 =', len(tmap))

    # 建 反查表：阶段名哈希 -> 阶段名（每个任务自己的 stages）
    rows = []
    for key, v in tmap.items():
        h = int(v['hash'], 16)
        off = vb.get(h)
        if off is None:
            rows.append((key, None, '不在hash表', False))
            continue
        val = int.from_bytes(data[off:off+4], 'little')
        rev = {H(s): s for s in v['stages']}
        stage = rev.get(val, '未知(0x%08x)' % val)
        done = (val == int(v['done'], 16))
        rows.append((key, val, stage, done))

    hit = sum(1 for r in rows if r[1] is not None)
    done_n = sum(1 for r in rows if r[3])
    print('命中 hash 表 = %d / %d' % (hit, len(rows)))
    print('判定为已完成 = %d' % done_n)
    print()

    # 阶段分布
    from collections import Counter
    dist = Counter(r[2] for r in rows)
    print('=== 阶段分布 ===')
    for s, n in dist.most_common(30):
        print('  %-28s %d' % (s, n))

    # 抽中文名对照：tasks.js 是紧凑 JSON 数组，用 json 解析最稳
    tj = open(tasks_js, encoding='utf-8').read()
    name_by_key = {}
    i = tj.index('[', tj.index('window.TOTK_TASKS'))
    depth, k = 0, i
    while True:
        if tj[k] == '[':
            depth += 1
        elif tj[k] == ']':
            depth -= 1
            if depth == 0:
                break
        k += 1
    try:
        arr = json.loads(tj[i:k+1])
        for t in arr:
            if isinstance(t, dict) and t.get('key'):
                name_by_key[t['key']] = t.get('name') or '?'
    except Exception as e:
        print('tasks.js 解析失败(不影响判定):', e)

    print()
    print('=== 已完成任务清单（前 40）===')
    n = 0
    for key, val, stage, done in rows:
        if done:
            print('  %-32s %-28s %s' % (key[:32], name_by_key.get(key, '?')[:26], stage))
            n += 1
            if n >= 40:
                break

    print()
    print('=== 未完成任务清单（前 40，按 key 排序）===')
    n = 0
    for key, val, stage, done in rows:
        if not done:
            print('  %-32s %-28s %s' % (key[:32], name_by_key.get(key, '?')[:26], stage))
            n += 1
            if n >= 40:
                break


if __name__ == '__main__':
    main()