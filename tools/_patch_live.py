# -*- coding: utf-8 -*-
"""js/live.js：轮询检测 progressGen 变化 → 触发 TOTK_APP.syncProgressFromServer（3s 节流）。"""
import io

P = r"E:\WorkSpace\TOTKmap\js\live.js"
with io.open(P, "r", encoding="utf-8", newline="") as f:
    t = f.read()

def rep(old, new, label):
    global t
    n = t.count(old)
    assert n == 1, "%s count=%d" % (label, n)
    t = t.replace(old, new)
    print("OK:", label)

# 1) 声明 lastProgGen / lastProgFetch
rep("""  var follow = false, autoLayer = true, arriveM = ARRIVE_DEF, paused = false;""",
"""  var follow = false, autoLayer = true, arriveM = ARRIVE_DEF, paused = false;
  var lastProgGen = null, lastProgFetch = 0;   // 存档进度代次（服务端 /pos.progressGen）""",
"声明 gen 变量")

# 2) poll 内 pos.located 分支末尾加 gen 检测
rep("""      autoSwitchLayer();
    } else {
      offlineStreak++;
      lastPosKey = null;
    }""",
"""      autoSwitchLayer();
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
    }""",
"poll 加 gen 检测")

with io.open(P, "w", encoding="utf-8", newline="") as f:
    f.write(t)
print("live.js 自动同步完成")
