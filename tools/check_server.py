# -*- coding: utf-8 -*-
"""校验服务端 _quest_done 的输出与 tools/verify_task_save.py 是否一致（双实现对账）。

用法: check_server.py <progress.sav>
"""
import sys, os, subprocess

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(root, 'live-python'))
import server  # noqa

sav = sys.argv[1]
parsed = server._parse_save(sav)
print('服务端解析 ok=%s ver=%s' % (parsed['ok'], parsed.get('version')))

ts = server._load_task_save()
print('task-save 条目 = %d' % len(ts))

qd = server._quest_done(parsed)
done = sorted(k for k, v in qd.items() if v['done'])
print('questDone 条目 = %d，已完成 = %d' % (len(qd), len(done)))
print('已完成列表:', done)

print()
print('阶段分布:')
from collections import Counter
for s, n in Counter(v['stage'] for v in qd.values()).most_common(12):
    print('  %-30s %d' % (s, n))

print()
print('=== 独立脚本对账 ===')
py = sys.executable
r = subprocess.run([py, os.path.join(root, 'tools', 'verify_task_save.py'), sav],
                   capture_output=True, text=True, encoding='utf-8')
for line in r.stdout.split('\n'):
    if any(k in line for k in ['命中', '已完成 =', 'task-save']):
        print(' ', line.strip())
print('独立脚本已完成 = %s' % sorted(done))