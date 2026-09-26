# -*- coding: utf-8 -*-
"""快速自测 /target UTF-8 与 /pos 字段完整性。"""
import json
import urllib.request

BASE = "http://127.0.0.1:8766"

def post(path, obj):
    req = urllib.request.Request(BASE + path, data=json.dumps(obj).encode("utf-8"),
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    return json.loads(urllib.request.urlopen(req).read().decode("utf-8"))

def get(path):
    return json.loads(urllib.request.urlopen(BASE + path).read().decode("utf-8"))

post("/target", {"x": -298.5, "y": -140.8, "name": "监视堡垒", "type": "shrine"})
t = get("/target")
print("set+get:", json.dumps(t, ensure_ascii=False))
post("/target", {"clear": True})
print("clear:", json.dumps(get("/target"), ensure_ascii=False))
p = get("/pos")
print("pos keys:", sorted(p.keys()))
print("pos:", json.dumps({k: p[k] for k in ("ok", "mx", "my", "gz", "layer", "source")},
                         ensure_ascii=False))
