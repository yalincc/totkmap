# -*- coding: utf-8 -*-
"""验证 /target layer 契约 + /pos target 回传。"""
import json
import urllib.request

BASE = "http://127.0.0.1:8766"

def post(path, obj):
    req = urllib.request.Request(BASE + path, data=json.dumps(obj).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(req).read().decode("utf-8"))

def get(path):
    return json.loads(urllib.request.urlopen(BASE + path).read().decode("utf-8"))

print("pos:", json.dumps({k: get("/pos")[k] for k in ("ok", "mx", "my", "gz", "layer", "verified", "source")}))
post("/target", {"x": -298.5, "y": -140.8, "name": "监视堡垒", "type": "测试", "layer": 18})
print("target-with-layer:", json.dumps(get("/target"), ensure_ascii=False))
p = get("/pos")
print("pos.target:", json.dumps(p["target"], ensure_ascii=False))
post("/target", {"clear": True})
print("cleared:", json.dumps(get("/target")))
