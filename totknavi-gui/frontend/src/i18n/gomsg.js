// gomsg.js — Go 端固定消息的中英映射（GUI 双语第三层：后端消息）
//
// 背景：Go 后端部分返回值直接展示给用户（保存结果 / 更新检查 / 核心启动 /
// 清除目标 / 坐标校准）。固定文案在此做英文映射——中文界面原样返回（零转换），
// 英文界面替换为 MSG_EN / PREFIX_EN。带动态参数的消息（如 err.Error()）在 Go 侧
// 已配 ErrorEn 字段（见 coordsResp），前端按语言取 errorEn || error，不走本表。
import { isEnglish } from './index'

// 精确匹配（整条消息一致才替换）
const MSG_EN = {
  '已保存': 'Saved',
  '无法连接 GitHub，请检查网络': 'Cannot connect to GitHub, please check your network',
  '已请求清除目标（地图同步取消）': 'Target clear requested (map sync cancelled)',
  '找不到核心程序 totknavi-core.exe（应放在本程序同目录）': 'Core program totknavi-core.exe not found (should sit next to this program)',
  '当前平台不支持坐标校准（仅 Eden）': 'Coordinate calibration is not supported on this platform (Eden only)',
  '平台未就绪，请先启动定位': 'Platform not ready, start locating first',
  '另一路坐标搜索进行中，请稍候': 'Another coordinate search is in progress, please wait',
  '定位扫描进行中，请 10 秒后重试': 'A locating scan is in progress, retry in 10 seconds',
  'Eden 进程未附加': 'Eden process not attached',
}

// 前缀匹配（消息 = 中文前缀 + 动态参数；替换前缀、保留参数尾巴）
const PREFIX_EN = {
  '写入清除请求失败': 'Failed to write clear request',
}

// 把一条 Go 消息转成当前界面语言（中文界面原样返回）
export function goMsg(text) {
  if (!text || !isEnglish()) return text
  if (MSG_EN[text]) return MSG_EN[text]
  for (const zh of Object.keys(PREFIX_EN)) {
    if (text.startsWith(zh)) return PREFIX_EN[zh] + text.slice(zh.length)
  }
  return text
}
