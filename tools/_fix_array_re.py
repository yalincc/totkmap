# -*- coding: utf-8 -*-
"""修正 _parse_completism 的数组正则：以换行+缩进的 ] 作为数组闭合（注释里的 [x,y,z] 不干扰）。"""
import io

p = r"E:\WorkSpace\TOTKmap\live-python\server.py"
t = io.open(p, encoding="utf-8", newline="").read()

old = r'for km in re.finditer(r"([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\[(.*?)\]", m.group(1), re.S):'
new = r'for km in re.finditer(r"([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\[(.*?)\n\s*\],?", m.group(1), re.S):'
assert t.count(old) == 1, t.count(old)
io.open(p, "w", encoding="utf-8", newline="").write(t.replace(old, new))
print("数组正则修正完成")
