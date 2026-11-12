// window.TOTK_SHADOW_WEAPONS: 地底残影士兵区域武器池映射与机制说明
window.TOTK_SHADOW_WEAPONS = {
  mechanicNotice: {
    title: "💡 地底洁净武器（✨）刷新与刷取秘籍",
    titleEn: "💡 Depths Pristine Weapon (✨) Rules & Farming Guide",
    bullets: [
      "【碎刀前置判定】：必须在地上拾取过同款腐蚀武器并彻底用碎（耐久耗尽损坏）。未碎刀前此处一律保底刷新基础武器（旅人/士兵系列）。",
      "【层级向下包含（为何有多把武器）】：地底石柱的生成机制向下兼容低阶武器（如王族石柱候选池实际包含王族/骑士/士兵/旅人）。即使已解锁王族，仍有概率摇出低阶武器，故需配合 SL 技巧。",
      "【形态永久锁定】：残影士兵手持形态固定（单手剑 / 双手剑 / 长枪），由地图 Banc 数据永久写死，绝不会随机切换形态。",
      "【移走武器红月才刷（极其关键）】：若石柱手持武器未被移走，哪怕经过再多次红月也绝不会重置！必须用【究极手】摇脱落或捡进背包让残影消散，下一次红月才会重新生成。",
      "【双重 SL 技巧】：\n  • 刷武器品类：武器在进入石柱约 80~100m 视距渲染时锁定。请在 100m 外存档，靠近看若不是心仪武器立即读档重刷。\n  • 刷金色词条：武器附加词条由隐藏世界经验值决定，在拔下瞬间结算。可在黑影面前存档，反复拔刀刷取【攻击力提升+10】等极品词条。"
    ],
    bulletsEn: [
      "[Break Requirement]: Pristine weapons only unlock after finding and fully breaking their decayed counterparts on the surface. Otherwise, default low-tier weapons (Traveler/Soldier) spawn.",
      "[Hierarchical Pool]: Pristine pillars include lower tier candidates (e.g. Royal pillars pool Royal/Knight/Soldier/Traveler). Lower tiers may still roll, which is why save-scumming is useful.",
      "[Permanently Fixed Type]: Soldier weapon type (1H / 2H / Spear) is hardcoded in map Banc data and never changes.",
      "[Must Clear Weapon for Blood Moon]: If the current weapon is left on the soldier, Blood Moons will NOT reset it! You MUST remove it via Ultrahand or pick it up so the ghost fades away.",
      "[Dual Save-Scumming Tips]:\n  • Reroll Weapon: Types lock at 80-100m render distance. Save beyond 100m before approaching.\n  • Reroll Modifiers: Modifiers roll upon picking up. Save right before grabbing to reroll yellow bonuses (+10 Attack Up)."
    ]
  },
  pools: {
    "海拉鲁城堡深穴": {
      "1H": [
        { name: "近卫之剑 ✨", nameEn: "Royal Guard's Sword ✨", atk: 22, dur: 12, effect: "濒临损坏时攻击力提升 2 倍", effectEn: "2x Attack when badly damaged" },
        { name: "王族之剑 ✨", nameEn: "Royal Broadsword ✨", atk: 24, dur: 35, effect: "完美闪避突击攻击力 2 倍", effectEn: "2x Rush attack after Flurry Rush" },
        { name: "骑士之剑 ✨", nameEn: "Knight's Broadsword ✨", atk: 18, dur: 27, effect: "残血心心 ≤ 1 时攻击力 2 倍", effectEn: "2x Attack at 1 heart or less" }
      ],
      "2H": [
        { name: "近卫双手剑 ✨", nameEn: "Royal Guard's Claymore ✨", atk: 39, dur: 12, effect: "濒临损坏时攻击力提升 2 倍（顶级人马杀手）", effectEn: "2x Attack when badly damaged (Top Lynel Killer)" },
        { name: "王族双手剑 ✨", nameEn: "Royal Claymore ✨", atk: 34, dur: 40, effect: "完美闪避突击攻击力 2 倍", effectEn: "2x Rush attack after Flurry Rush" },
        { name: "骑士双手剑 ✨", nameEn: "Knight's Claymore ✨", atk: 32, dur: 30, effect: "残血心心 ≤ 1 时攻击力 2 倍", effectEn: "2x Attack at 1 heart or less" }
      ],
      "Spear": [
        { name: "近卫之枪 ✨", nameEn: "Royal Guard's Spear ✨", atk: 15, dur: 15, effect: "濒临损坏时攻击力提升 2 倍", effectEn: "2x Attack when badly damaged" },
        { name: "王族之枪 ✨", nameEn: "Royal Halberd ✨", atk: 13, dur: 50, effect: "完美闪避突击攻击力 2 倍", effectEn: "2x Rush attack after Flurry Rush" },
        { name: "骑士之枪 ✨", nameEn: "Knight's Halberd ✨", atk: 11, dur: 40, effect: "残血心心 ≤ 1 时攻击力 2 倍", effectEn: "2x Attack at 1 heart or less" }
      ]
    },
    "阿卡莱地区": {
      "1H": [
        { name: "近卫之剑 ✨", nameEn: "Royal Guard's Sword ✨", atk: 22, dur: 12, effect: "濒临损坏时攻击力提升 2 倍", effectEn: "2x Attack when badly damaged" },
        { name: "王族之剑 ✨", nameEn: "Royal Broadsword ✨", atk: 24, dur: 35, effect: "完美闪避突击攻击力 2 倍", effectEn: "2x Rush attack after Flurry Rush" },
        { name: "士兵之剑 ✨", nameEn: "Soldier's Broadsword ✨", atk: 16, dur: 23, effect: "蓄力攻击耐力消耗减少", effectEn: "Reduced stamina for charge attacks" }
      ],
      "2H": [
        { name: "近卫双手剑 ✨", nameEn: "Royal Guard's Claymore ✨", atk: 39, dur: 12, effect: "濒临损坏时攻击力提升 2 倍", effectEn: "2x Attack when badly damaged" },
        { name: "王族双手剑 ✨", nameEn: "Royal Claymore ✨", atk: 34, dur: 40, effect: "完美闪避突击攻击力 2 倍", effectEn: "2x Rush attack after Flurry Rush" },
        { name: "士兵双手剑 ✨", nameEn: "Soldier's Claymore ✨", atk: 20, dur: 25, effect: "蓄力攻击耐力消耗减少", effectEn: "Reduced stamina for charge attacks" }
      ],
      "Spear": [
        { name: "近卫之枪 ✨", nameEn: "Royal Guard's Spear ✨", atk: 15, dur: 15, effect: "濒临损坏时攻击力提升 2 倍", effectEn: "2x Attack when badly damaged" },
        { name: "王族之枪 ✨", nameEn: "Royal Halberd ✨", atk: 13, dur: 50, effect: "完美闪避突击攻击力 2 倍", effectEn: "2x Rush attack after Flurry Rush" },
        { name: "士兵之枪 ✨", nameEn: "Soldier's Spear ✨", atk: 10, dur: 35, effect: "蓄力攻击耐力消耗减少", effectEn: "Reduced stamina for charge attacks" }
      ]
    },
    "中央海拉鲁": {
      "1H": [
        { name: "王族之剑 ✨", nameEn: "Royal Broadsword ✨", atk: 24, dur: 35, effect: "完美闪避突击攻击力 2 倍", effectEn: "2x Rush attack after Flurry Rush" },
        { name: "骑士之剑 ✨", nameEn: "Knight's Broadsword ✨", atk: 18, dur: 27, effect: "残血心心 ≤ 1 时攻击力 2 倍", effectEn: "2x Attack at 1 heart or less" },
        { name: "士兵之剑 ✨", nameEn: "Soldier's Broadsword ✨", atk: 16, dur: 23, effect: "蓄力攻击耐力消耗减少", effectEn: "Reduced stamina for charge attacks" },
        { name: "旅人之剑 ✨", nameEn: "Traveler's Sword ✨", atk: 10, dur: 20, effect: "基础单手剑", effectEn: "Basic 1H sword" }
      ],
      "2H": [
        { name: "王族双手剑 ✨", nameEn: "Royal Claymore ✨", atk: 34, dur: 40, effect: "完美闪避突击攻击力 2 倍", effectEn: "2x Rush attack after Flurry Rush" },
        { name: "骑士双手剑 ✨", nameEn: "Knight's Claymore ✨", atk: 32, dur: 30, effect: "残血心心 ≤ 1 时攻击力 2 倍", effectEn: "2x Attack at 1 heart or less" },
        { name: "士兵双手剑 ✨", nameEn: "Soldier's Claymore ✨", atk: 20, dur: 25, effect: "蓄力攻击耐力消耗减少", effectEn: "Reduced stamina for charge attacks" },
        { name: "旅人双手剑 ✨", nameEn: "Traveler's Claymore ✨", atk: 14, dur: 20, effect: "基础双手剑", effectEn: "Basic 2H claymore" }
      ],
      "Spear": [
        { name: "王族之枪 ✨", nameEn: "Royal Halberd ✨", atk: 13, dur: 50, effect: "完美闪避突击攻击力 2 倍", effectEn: "2x Rush attack after Flurry Rush" },
        { name: "骑士之枪 ✨", nameEn: "Knight's Halberd ✨", atk: 11, dur: 40, effect: "残血心心 ≤ 1 时攻击力 2 倍", effectEn: "2x Attack at 1 heart or less" },
        { name: "士兵之枪 ✨", nameEn: "Soldier's Spear ✨", atk: 10, dur: 35, effect: "蓄力攻击耐力消耗减少", effectEn: "Reduced stamina for charge attacks" },
        { name: "旅人之枪 ✨", nameEn: "Traveler's Spear ✨", atk: 7, dur: 30, effect: "基础长枪", effectEn: "Basic spear" }
      ]
    },
    "格鲁德地区": {
      "1H": [
        { name: "格鲁德匕首 ✨", nameEn: "Gerudo Scimitar ✨", atk: 17, dur: 14, effect: "余料建造素材攻击力 2 倍", effectEn: "2x fuse material attack power" },
        { name: "月光匕首 ✨", nameEn: "Moonlight Scimitar ✨", atk: 25, dur: 14, effect: "强韧格鲁德弯刀", effectEn: "Strong Gerudo scimitar" }
      ],
      "2H": [
        { name: "格鲁德双手剑 ✨", nameEn: "Gerudo Claymore ✨", atk: 23, dur: 14, effect: "余料建造素材攻击力 2 倍", effectEn: "2x fuse material attack power" },
        { name: "斩风刀 ✨", nameEn: "Eightfold Longblade ✨", atk: 25, dur: 25, effect: "蓄力释放真空风刃", effectEn: "Creates wind slashes on charge" }
      ],
      "Spear": [
        { name: "格鲁德枪 ✨", nameEn: "Gerudo Spear ✨", atk: 10, dur: 16, effect: "余料建造素材攻击力 2 倍", effectEn: "2x fuse material attack power" }
      ]
    },
    "拉聂尔地区": {
      "1H": [
        { name: "卓拉之剑 ✨", nameEn: "Zora Sword ✨", atk: 19, dur: 27, effect: "淋水状态攻击力 2 倍", effectEn: "2x Attack power when wet" }
      ],
      "2H": [
        { name: "卓拉双手剑 ✨", nameEn: "Zora Longsword ✨", atk: 23, dur: 30, effect: "淋水状态攻击力 2 倍", effectEn: "2x Attack power when wet" }
      ],
      "Spear": [
        { name: "卓拉之枪 ✨", nameEn: "Zora Spear ✨", atk: 11, dur: 40, effect: "淋水状态攻击力 2 倍", effectEn: "2x Attack power when wet" }
      ]
    },
    "海布拉地区": {
      "1H": [
        { name: "飞燕剑 ✨", nameEn: "Feathered Edge ✨", atk: 18, dur: 35, effect: "利特族快剑，挥舞极快", effectEn: "Rito fast sword, quick swing" },
        { name: "骑士之剑 ✨", nameEn: "Knight's Broadsword ✨", atk: 18, dur: 27, effect: "残血心心 ≤ 1 时攻击力 2 倍", effectEn: "2x Attack at 1 heart or less" }
      ],
      "2H": [
        { name: "斩风羽剑 ✨", nameEn: "Feathered Edge 2H ✨", atk: 24, dur: 27, effect: "挥动产生狂风", effectEn: "Generates wind gusts" },
        { name: "骑士双手剑 ✨", nameEn: "Knight's Claymore ✨", atk: 32, dur: 30, effect: "残血心心 ≤ 1 时攻击力 2 倍", effectEn: "2x Attack at 1 heart or less" }
      ],
      "Spear": [
        { name: "飞燕枪 ✨", nameEn: "Feathered Spear ✨", atk: 14, dur: 35, effect: "利特族突击长枪", effectEn: "Rito piercing spear" },
        { name: "骑士之枪 ✨", nameEn: "Knight's Halberd ✨", atk: 11, dur: 40, effect: "残血心心 ≤ 1 时攻击力 2 倍", effectEn: "2x Attack at 1 heart or less" }
      ]
    },
    "奥尔汀地区": {
      "1H": [
        { name: "劈石棒 ✨", nameEn: "Cobble Crusher ✨", atk: 20, dur: 30, effect: "粉碎矿石与岩石特化", effectEn: "Specialized for ore & rocks" }
      ],
      "2H": [
        { name: "碎岩剑 ✨", nameEn: "Boulder Breaker Base ✨", atk: 38, dur: 40, effect: "重型粉碎双手剑，破石利器", effectEn: "Heavy blunt claymore, crushing force" },
        { name: "巨石碎棒 ✨", nameEn: "Stone Smasher ✨", atk: 24, dur: 30, effect: "强力破岩钝器", effectEn: "Powerful rock-smashing club" }
      ],
      "Spear": [
        { name: "劈石枪 ✨", nameEn: "Drillshaft ✨", atk: 14, dur: 35, effect: "螺旋钻头长枪，采矿极快", effectEn: "Drill-tip spear for mining" }
      ]
    },
    "费罗尼地区": {
      "1H": [
        { name: "戒心小刀 ✨", nameEn: "Eightfold Blade ✨", atk: 15, dur: 26, effect: "背刺偷袭伤害 8 倍", effectEn: "8x Sneakstrike attack power" },
        { name: "森民之剑 ✨", nameEn: "Forest Dweller's Sword ✨", atk: 16, dur: 27, effect: "附加果实/蘑菇可循环爆发使用", effectEn: "Reusable burst with attached fruits/mushrooms" }
      ],
      "2H": [
        { name: "戒心长刀 ✨", nameEn: "Eightfold Longblade ✨", atk: 25, dur: 25, effect: "蓄力释放真空斩波", effectEn: "Creates wind slashes on charge" },
        { name: "森民双手剑 ✨", nameEn: "Forest Dweller's Claymore ✨", atk: 22, dur: 27, effect: "附加果实/蘑菇可循环爆发使用", effectEn: "Reusable burst with attached fruits/mushrooms" }
      ],
      "Spear": [
        { name: "森民之枪 ✨", nameEn: "Forest Dweller's Spear ✨", atk: 16, dur: 35, effect: "附加果实/蘑菇可循环喷射使用", effectEn: "Reusable spray with attached fruits/mushrooms" }
      ]
    },
    "哈特尔地区": {
      "1H": [
        { name: "王族之剑 ✨", nameEn: "Royal Broadsword ✨", atk: 24, dur: 35, effect: "完美闪避突击攻击力 2 倍", effectEn: "2x Rush attack after Flurry Rush" },
        { name: "戒心小刀 ✨", nameEn: "Eightfold Blade ✨", atk: 15, dur: 26, effect: "背刺偷袭伤害 8 倍", effectEn: "8x Sneakstrike attack power" },
        { name: "士兵之剑 ✨", nameEn: "Soldier's Broadsword ✨", atk: 16, dur: 23, effect: "蓄力攻击耐力消耗减少", effectEn: "Reduced stamina for charge attacks" }
      ],
      "2H": [
        { name: "王族双手剑 ✨", nameEn: "Royal Claymore ✨", atk: 34, dur: 40, effect: "完美闪避突击攻击力 2 倍", effectEn: "2x Rush attack after Flurry Rush" },
        { name: "戒心长刀 ✨", nameEn: "Eightfold Longblade ✨", atk: 25, dur: 25, effect: "蓄力释放真空斩波", effectEn: "Creates wind slashes on charge" },
        { name: "士兵双手剑 ✨", nameEn: "Soldier's Claymore ✨", atk: 20, dur: 25, effect: "蓄力攻击耐力消耗减少", effectEn: "Reduced stamina for charge attacks" }
      ],
      "Spear": [
        { name: "王族之枪 ✨", nameEn: "Royal Halberd ✨", atk: 13, dur: 50, effect: "完美闪避突击攻击力 2 倍", effectEn: "2x Rush attack after Flurry Rush" },
        { name: "森民之枪 ✨", nameEn: "Forest Dweller's Spear ✨", atk: 16, dur: 35, effect: "附加果实可循环喷射使用", effectEn: "Reusable spray with attached fruits/mushrooms" }
      ]
    }
  }
};
