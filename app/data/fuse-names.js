/* 余料附着专用中文名对照表（场景物体 / 左纳乌实体 / 特殊武器变体）
 *
 * 为什么独立建表：
 *   1. mat-names.js 只收录背包道具（左纳乌是 _Capsule_），equip-names.js 只收录常规装备；
 *   2. 实际余料建造附着在武器/盾上的物体可能是左纳乌实体（无 _Capsule_）或场景物体（Obj_/AsbObj_/FldObj_）；
 *   3. 统一收口到本表后，后续补充任何英文内部名只需往此表加一行，不在业务逻辑里打补丁。
 */
window.FUSE_NAMES = {
  /* 左纳乌实体（对应各胶囊） */
  "SpObj_BalloonEnvelope_A_01": "热气球",
  "SpObj_Beamos_A_01": "光线头",
  "SpObj_Cannon_A_01": "大炮",
  "SpObj_Cart_A_01": "平台车",
  "SpObj_Chaser_A_01": "追踪平台车",
  "SpObj_ControlStick_A_01": "操纵杆",
  "SpObj_CookSet_A_01": "便携锅",
  "SpObj_ElectricBoxGenerator_A_01": "雷龙头",
  "SpObj_EnergyBank_A_01": "备用电池",
  "SpObj_EnergyBank_A_02": "大容量电池",
  "SpObj_FastWheel_A_01": "小轮胎",
  "SpObj_FastWheel_B_01": "大轮胎",
  "SpObj_FlameThrower_A_01": "火龙头",
  "SpObj_FlashLight_A_01": "灯",
  "SpObj_FloatingStone_A_01": "浮游石",
  "SpObj_GolemHead_A_01": "魔像的头部",
  "SpObj_LiftGeneratorWing_A_01": "翼",
  "SpObj_LiftableWaterPump_A_01": "放水栓",
  "SpObj_LightMirror_A_01": "镜子",
  "SpObj_Pile_A_01": "桩",
  "SpObj_Rocket_A_01": "火箭",
  "SpObj_SlipBoard_A_01": "滑橇",
  "SpObj_SnowMachine_A_01": "冰龙头",
  "SpObj_SpringPiston_A_01": "弹簧",
  "SpObj_TiltingDoll_A_01": "不倒翁",
  "SpObj_TimerBomb_A_01": "计时炸弹",
  "SpObj_WindGenerator_A_01": "风扇机",

  /* 常见场景/神庙可附着物体 */
  "AsbObj_WoodSail_A_02_ForAttachment": "木帆",
  "AsbObj_WoodSail_A_02": "木帆",
  "AsbObj_WoodBoard_A_01": "木板",
  "AsbObj_MetalBoard_A_01": "铁板",
  "AsbObj_MetalPole_A_01": "铁棒",
  "AsbObj_RockParts_C_L_01": "大岩石块",
  "AsbObj_RockParts_C_S_01": "岩石块",
  "AsbObj_SharpRock_A_S_01": "尖锐岩石",
  "Obj_SpikeBall_A": "铁球",
  "Obj_SpikeBall_B": "带刺铁球",
  "Obj_SpikeBall_B_01": "带刺铁球",
  "Obj_SpikeBall_C": "大铁球",
  "Obj_BoxIron_A_M_01": "铁箱",
  "Obj_Barrel_A_01": "木桶",
  "Obj_BarrelBomb_A_01": "炸药桶",
  "Obj_LiftRock_A_01": "岩石",
  "FldObj_EnemyLookout_Wood_01": "木板",

  /* 特殊武器/盾变体 */
  "Weapon_Sword_070_Broken": "腐朽的大师之剑",
  "Weapon_Sword_071": "大师之剑（序章）",
  "Weapon_Sword_071_Broken": "腐朽的大师之剑（序章）"
};
