/* 左纳乌制造机产出表（V2.8 批次，2026-10-28）
 * ============================================================
 * 覆盖 markers.js cat 65/89/111 共 31 台：
 *   - 30 台真「左纳乌装置制造机」：p = [装置key, 概率%]（按概率降序）
 *   - 1 台特例 2003「电池制造机」= 监视堡垒电池格兑换魔像（cell:1），
 *     它不是扭蛋制造机，坐标 (-220,+188) 与监视堡垒魔像 (-217,+194) 精确匹配
 *     （Prima 口径），社区 4 源（zeldawiki/Polygon/ProGameGuides/HardcoreGamer）
 *     的制造机总表均无此点。
 *
 * 数据来源与配对方法（tools/ 一次性脚本已删，过程见工作日志）：
 *   - 道具池/概率：zeldawiki.wiki Device Dispenser 全表（唯一带概率的源），
 *     与 Polygon / ProGameGuides / HardcoreGamer 交叉核对；Wellspring 一台
 *     Polygon 为离群值（Balloon/Mirror/Spring），取其余三源一致的
 *     Fan/HoverStone/Wing/Battery/Stabilizer。
 *   - 坐标配对：31 台全部与社区表一一闭合，最差 21m（Kakariko），
 *     其余 1~52m；并用 actors.jsonl.gz 落点体检 31/31 有实体（零翻转）。
 *     坐标口径：marker m.y=X（东正）、m.x=内部Z（北负）；社区攻略为
 *     UI 口径（北正）= -m.x。
 *   - 装置官方中文名：huijiwiki 左纳乌装置词条（火龙头/雷龙头/光线头/
 *     放水栓/浮游石/不倒翁/追踪平台车…），英文名为游戏原文。
 */
window.TOTK_DISPENSER_INFO = {
  /* ---- 地表（cat 65）---- */
  '2097': {p:[['stabilizer',35],['balloon',25],['bigwheel',20],['fan',20]]},          /* 卡卡利科村 */
  '2095': {p:[['bigwheel',30],['stake',25],['spring',15],['pot',15],['battery',15]]},  /* 迪格多多索桥 */
  '2037': {p:[['steering',20],['smallwheel',20],['fan',15],['balloon',15],['bigwheel',15],['rocket',15]]}, /* 阿卡莱湖畔/哈德森工地 */
  '2003': {cell:1},                                                                     /* 监视堡垒电池格魔像（特例） */
  /* ---- 地底（cat 89）---- */
  '3536': {p:[['bigwheel',20],['steering',20],['wing',15],['rocket',15],['smallwheel',15],['constructhead',15]]}, /* 左腿仓库 */
  '2641': {p:[['bigwheel',40],['battery',30],['pot',15],['steering',15]]},             /* 死神山大地底 */
  /* ---- 天空（cat 111）---- */
  '2279': {p:[['hoverstone',35],['timebomb',25],['homing',25],['hydrant',15]]},        /* 阿卡莱废矿 */
  '2278': {p:[['homing',30],['stake',20],['constructhead',20],['cart',15],['cannon',15]]}, /* 索卡拉群岛 */
  '2103': {p:[['fan',40],['pot',40],['flame',20]]},                                    /* 初始空岛·南 */
  '2102': {p:[['wing',35],['fan',30],['pot',20],['flame',15]]},                        /* 初始空岛·东 */
  '2631': {p:[['smallwheel',30],['light',25],['rocket',25],['timebomb',20]]},          /* 南海拉鲁群岛 */
  '2636': {p:[['steering',30],['smallwheel',30],['cannon',30],['light',20]]},          /* 奈克鲁玛群岛 */
  '2275': {p:[['homing',20],['beam',20],['flame',20],['frost',20],['timebomb',20]]},   /* 左纳乌精炼岛 */
  '2635': {p:[['hydrant',40],['bigwheel',20],['battery',20],['fan',20]]},              /* 南奥尔汀群岛 */
  '2276': {p:[['shock',35],['fan',35],['pot',15],['battery',15]]},                     /* 雷兽诸岛 */
  '2277': {p:[['wing',25],['cart',25],['fan',25],['steering',25]]},                    /* 龙头岛 */
  '2630': {p:[['steering',30],['sled',20],['mirror',20],['beam',15],['stake',15]]},    /* 东格鲁德群岛 */
  '2207': {p:[['sled',25],['shock',20],['frost',20],['stake',20],['stabilizer',15]]},  /* 观星岛 */
  '2632': {p:[['battery',30],['light',25],['constructhead',25],['flame',20]]},         /* 勇气岛 */
  '2119': {p:[['light',30],['steering',30],['shock',20],['homing',20]]},               /* 北海拉鲁群岛 */
  '2057': {p:[['sled',30],['wing',25],['fan',15],['cart',15],['light',15]]},           /* 东海布拉群岛 */
  '2175': {p:[['rocket',30],['flame',30],['timebomb',25],['pot',15]]},                 /* 西海布拉群岛 */
  '2104': {p:[['balloon',30],['timebomb',25],['pot',25],['fan',20]]},                  /* 试胆岛 */
  '2634': {p:[['cart',30],['wing',30],['fan',20],['beam',20]]},                        /* 拉聂尔群岛 */
  '2201': {p:[['spring',30],['hydrant',25],['steering',25],['beam',20]]},              /* 勇者岛 */
  '2633': {p:[['hoverstone',35],['stabilizer',20],['fan',15],['wing',15],['battery',15]]}, /* 水之源岛 */
  '2637': {p:[['frost',30],['battery',30],['wing',20],['mirror',20]]},                 /* 南拉聂尔群岛 */
  '2273': {p:[['mirror',35],['wing',20],['balloon',15],['spring',15],['hoverstone',15]]}, /* 光照岛 */
  '2274': {p:[['wing',30],['smallwheel',25],['mirror',25],['frost',20]]},              /* 塔邦挞群岛 */
  '2118': {p:[['spring',40],['cannon',20],['wing',20],['timebomb',20]]},               /* 北奈克鲁玛群岛 */
  '2246': {p:[['constructhead',20],['cart',20],['balloon',20],['stabilizer',20],['hydrant',20]]} /* 西奈克鲁玛群岛 */
};
