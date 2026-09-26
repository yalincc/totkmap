# -*- coding: utf-8 -*-
'''版本号 V1.7.8 -> V1.8.0'''
import io

P = r"E:\WorkSpace\TOTKmap\index.html"
with io.open(P, "r", encoding="utf-8", newline="") as f:
    t = f.read()
old = '<p class="foot-version">TOTKMAP V1.7.8</p>'
assert t.count(old) == 1, t.count(old)
t = t.replace(old, '<p class="foot-version">TOTKMAP V1.8.0</p>')
with io.open(P, "w", encoding="utf-8", newline="") as f:
    f.write(t)
print("版本号 -> V1.8.0")
