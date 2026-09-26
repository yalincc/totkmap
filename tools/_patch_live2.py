# -*- coding: utf-8 -*-
"""live.js：progressGen 检测移出 pos.located 分支（服务可达即可检测，不依赖定位成功）。"""
import io

P = r"E:\WorkSpace\TOTKmap\js\live.js"
with io.open(P, "r", encoding="utf-8", newline="") as f:
    t = f.read()

old = """      autoSwitchLayer();
      /* 存档进度代次：游戏内保存 → 存档 mtime 变化 → progressGen 变化 → 自动重新拉取进度
         （BOTWmap 同机制：服务自动定位存档，网页无需上传） */
      if (typeof p.progressGen === 'string' && p.progressGen && p.progressGen !== lastProgGen) {
        lastProgGen = p.progressGen;
        var _n = Date.now();
        if (_n - lastProgFetch > 3000 && window.TOTK_APP && window.TOTK_APP.syncProgressFromServer) {
          lastProgFetch = _n;
          window.TOTK_APP.syncProgressFromServer();
        }
      }
    } else {
      offlineStreak++;
      lastPosKey = null;
    }"""
new = """      autoSwitchLayer();
    } else {
      offlineStreak++;
      lastPosKey = null;
    }
    /* 存档进度代次：游戏内保存 → 存档 mtime 变化 → progressGen 变化 → 自动重新拉取进度
       （BOTWmap 同机制：服务自动定位存档，网页无需上传；服务可达即检测，不依赖定位成功） */
    if (p && typeof p.progressGen === 'string' && p.progressGen && p.progressGen !== lastProgGen) {
      lastProgGen = p.progressGen;
      var _n = Date.now();
      if (_n - lastProgFetch > 3000 && window.TOTK_APP && window.TOTK_APP.syncProgressFromServer) {
        lastProgFetch = _n;
        window.TOTK_APP.syncProgressFromServer();
      }
    }"""
assert t.count(old) == 1, t.count(old)
io.open(P, "w", encoding="utf-8", newline="").write(t.replace(old, new))
print("gen 检测已移出 located 分支")
