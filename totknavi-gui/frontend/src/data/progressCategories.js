// progressCategories.js — 本地解析进度的 21 类别名映射
//
// key = core status.json progressCounts 的中文类名（数据层，不翻译）；
// 展示名走 i18n progress.* 路径（英文界面显示游戏官方英文译名）。
// 与 i18n 两包的 progress 节、core progress_totk2.go 的 21 类一一对应。
import { i18n } from '../i18n'

// i18n key（不是文案）：两类包各有一份文案
const KEY_TO_I18N = {
  '鸟望台': 'skyview',
  '龙之泪': 'tears',
  '神庙': 'shrines',
  '树根': 'lightroots',
  '克洛格': 'koroks',
  '双倍克洛格': 'koroksCarry',
  '魔犹伊遗失物': 'bubbuls',
  '残旧的地图': 'treasureMaps',
  '贤者的遗志': 'sageWills',
  '设计图石板': 'schemas',
  '卡邦达立牌': 'addison',
  '宝箱': 'chests',
  '独眼巨人': 'hinoxes',
  '岩石巨人': 'taluses',
  '莫尔德拉吉克': 'moldugas',
  '方块魔像': 'flux',
  '巨霸伽马': 'frox',
  '古栗欧克': 'gleethok',
  '地洞入口': 'chasms',
  '洞穴入口': 'caves',
  '井': 'wells',
}

// 固定顺序的 21 个 key（与 core progressCounts 的全量类对齐）
export const PROGRESS_CATEGORY_KEYS = Object.keys(KEY_TO_I18N)

// 按当前界面语言取类别展示名；core 新增未知类时原样回落（不丢数据）
export function progressLabel(key) {
  const p = KEY_TO_I18N[key]
  return p ? i18n.global.t(`progress.${p}`) : key
}
