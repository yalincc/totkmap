# -*- coding: utf-8 -*-
import io

p = r"E:\WorkSpace\TOTKmap\live-python\server.py"
t = io.open(p, encoding="utf-8", newline="").read()
old = r'm = re.search(r"var\s+CompletismHashes\s*=\s*(\{.*?\});", t, re.S)'
new = r'm = re.search(r"var\s+CompletismHashes\s*=\s*(\{.*?\})", t, re.S)'
assert t.count(old) == 1, t.count(old)
io.open(p, "w", encoding="utf-8", newline="").write(t.replace(old, new))
print("正则修正完成")
