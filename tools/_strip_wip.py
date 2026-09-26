# -*- coding: utf-8 -*-
"""临时移除 index.html 中的用户图鉴 WIP（detailComp 按钮 + TOTK_COMPENDIUM_URL），
只留本任务的改动（版本号/脚本版本引用）以便单独提交。"""
import io, os, sys

p = r"E:\WorkSpace\TOTKmap\index.html"
raw = io.open(p, "rb").read()
eol = b"\r\n" if raw.count(b"\r\n") > raw.count(b"\n") else b"\n"
txt = raw.decode("utf-8")

pairs = [
    ("      <button id=\"detailComp\" class=\"btn act\" style=\"display:none\">查看图鉴</button>\n", ""),
    ("<!-- 图鉴站地址（联动「查看图鉴」按钮 / 对站跳转）：本地开发指向 5173，部署后改成正式网址 -->\n<script>window.TOTK_COMPENDIUM_URL = 'http://localhost:5173';</script>\n", ""),
]
for old, new in pairs:
    n = txt.count(old)
    if n != 1:
        print("!! %d occurrence(s): %r" % (n, old[:60]))
        sys.exit(1)
    txt = txt.replace(old, new)
io.open(p, "wb").write(txt.encode("utf-8").replace(b"\n", eol))
print("stripped user WIP from index.html")
