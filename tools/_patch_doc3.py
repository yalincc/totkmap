# -*- coding: utf-8 -*-
'''开发计划文档：层判定规则更新为组合判层（V1.8.0 M3 修正）。'''
import io

P = r"E:\WorkSpace\TOTKmap\TOTKmap V1.8.0开发计划.md"
with io.open(P, "r", encoding="utf-8", newline="") as f:
    t = f.read()

pairs = [
    # line 51
    (" ├─ 层自动切换：玩家高度 h = gz − 105；h≥950→天空(20)、h<0→地底(19)、否则地上(18)",
     " ├─ 层自动切换（M3 修正，组合判层）：gz<0→地底(19)；天空 = 空岛多边形命中 ∨ gz≥900 ∨（gz≥300 且 600 内存在天空标记）；否则地上(18)。修复西哈特尔天空诸岛(z≈558)误判地上"),
    # line 100
    ("- 层阈值：`h = gz − 105`；`h≥950 → 20 天空`、`h<0 → 19 地底`、`否则 → 18 地上`（对照 TOTKmap 数据层，实测校准）",
     "- 层判定（M3 修正，实测校准）：`gz<0 → 19 地底`；`gz≥900 → 20 天空`（地面最高约 650，高空无歧义）；`空岛多边形命中（data/area_sky.js 64 大岛）→ 20 天空`；`gz≥300 且 600 游戏单位内有 layer=20 天空标记 → 20 天空`（低空岛兜底，如西哈特尔天空诸岛 z≈558）；`否则 → 18 地上`。背景：TOTK 天空岛最低约 z=400，地面最高（海布拉山 647 / 格鲁德高地塔 635）与低空岛重叠，纯高度不可靠；objmap-totk sky_polys.json 仅 64 岛缺西哈特尔，故加低空标记缓冲"),
]
for old, new in pairs:
    n = t.count(old)
    assert n == 1, "count=%d: %s" % (n, old[:40])
    t = t.replace(old, new)
    print("OK:", old[:30])

with io.open(P, "w", encoding="utf-8", newline="") as f:
    f.write(t)
print("文档更新完成")
