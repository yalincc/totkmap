#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""M6.5：抽取防具强化数据 → app/data/armor-upgrade.js

为什么要单独抽：
  app/data/armors.js 是**只收录基装**的（136 件，即 rank=1），
  强化后的条目（Armor_002_* 等）不在里面。所以本地数据算不出「能升几级」——
  armors.js 虽有 next 字段，但 next 指向的目标在本地根本找不到（实测 104/136 条断链）。

  真正的强化数据在两个地方（E:/WorkSpace/BOTWroms/totk-site/public/data/）：
    · items.json        553 条防具条目，next 串起强化链，带中文名/防御/图标
    · enhancement.json  每级的材料与星星数，带中文材料名

  本脚本把这两个源合并成「基装key → [{level, def, stars, mats}]」，
  前端 ArmorData.upgradeOf() 直接读，不用现算。

用法：
    python tools/build_armor_upgrade.py --dry    # 只看统计
    python tools/build_armor_upgrade.py --write  # 写出 app/data/armor-upgrade.js
"""
import argparse
import io
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = pathlib.Path("E:/WorkSpace/BOTWroms/totk-site/public/data")
ITEMS = SITE / "items.json"
ENH = SITE / "enhancement.json"
OUT = ROOT / "app" / "data" / "armor-upgrade.js"

SLOT = re.compile(r"_(Head|Upper|Lower)$")
# _B 结尾是「备用/替代款」（游戏里有同名不同来源的两件），
# 它是独立一件，不该混进主强化链。
BACKUP = re.compile(r"_B$")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    if not ITEMS.exists():
        print("找不到 %s ——totk-site 不在预期位置" % ITEMS)
        return 1

    items = json.loads(ITEMS.read_text(encoding="utf-8"))
    enh = json.loads(ENH.read_text(encoding="utf-8"))

    armors = [x for x in items if x.get("cat") == "Armor"]
    by_id = {x["id"]: x for x in armors}

    # 强化链：next 指向同一部位的下一级
    def chain_of(start_id):
        chain = [start_id]
        cur = by_id.get(start_id)
        guard = 0
        while cur and cur.get("next") and guard < 12:
            nxt = cur["next"]
            if nxt in chain or nxt not in by_id:
                break
            chain.append(nxt)
            cur = by_id[nxt]
            guard += 1
        return chain

    # 基装 = rank==1 且不是 _B 备用款
    bases = [x for x in armors if (x.get("rank") or 1) == 1 and not BACKUP.search(x["id"])]
    out = {}
    stats = {"base": len(bases), "multi": 0, "maxlv": 0, "lv_dist": {}}

    for b in bases:
        chain = chain_of(b["id"])
        lv = len(chain)
        if lv > 1:
            stats["multi"] += 1
        stats["maxlv"] = max(stats["maxlv"], lv)
        stats["lv_dist"][lv] = stats["lv_dist"].get(lv, 0) + 1

        steps = []
        for i, cid in enumerate(chain):
            it = by_id[cid]
            # 强化材料：enhancement.json 的键就是这一级的 id
            mats = []
            stars = None
            for rec in enh.get(cid) or []:
                if stars is None:
                    stars = rec.get("price")
                for m in rec.get("items_zh") or []:
                    mats.append({"zh": m.get("zh"), "n": m.get("num")})
            steps.append({
                "lv": i + 1,
                "id": cid,
                "zh": it.get("zh"),
                "def": it.get("perf"),
                "stars": stars,
                "mats": mats,
            })
        out[b["id"]] = {
            "zh": b.get("zh"),
            "slot": (SLOT.search(b["id"]).group(1) if SLOT.search(b["id"]) else None),
            "steps": steps,
        }

    print("基装 %d 条（可强化 %d / 单级 %d）" % (
        stats["base"], stats["multi"], stats["base"] - stats["multi"]))
    print("最高强化等级：%d 级" % stats["maxlv"])
    print("等级分布：", dict(sorted(stats["lv_dist"].items())))
    # 抽样
    for k in list(out)[:2]:
        s = out[k]
        print("  %s %s：" % (k, s["zh"]))
        for st in s["steps"]:
            print("    L%d %s def=%s 星星=%s 材料=%s" % (
                st["lv"], st["zh"], st["def"], st["stars"],
                "、".join("%s×%s" % (m["zh"], m["n"]) for m in st["mats"]) or "无"))

    if args.write:
        body = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
        OUT.write_text(
            "/* 自动生成，请勿手改。\n"
            "   生成器：tools/build_armor_upgrade.py\n"
            "   上游：E:/WorkSpace/BOTWroms/totk-site/public/data/{items,enhancement}.json\n"
            "   key = armors.js 里的防具key（只含基装 rank=1）\n"
            "   steps[].lv 从 1 起；stars=该级所需海拉鲁星星；mats=材料\n"
            "*/\nwindow.TOTK_ARMOR_UPGRADE=%s;\n" % body,
            encoding="utf-8")
        print("\n已写出 %s（%d 条）" % (OUT, len(out)))
    else:
        print("\n(dry-run，未写文件)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())