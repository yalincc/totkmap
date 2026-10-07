#!/usr/bin/env node
/* 生成「任务卡片校对清单」—— 交给 DS 老师逐条核对
 *
 * 用法：
 *   node tools/export_card_review.js                 # 全部 253条
 *   node tools/export_card_review.js --layer 19      # 只导地底层
 *   node tools/export_card_review.js --group 迷你挑战
 *   node tools/export_card_review.js --problem      # 只导「有疑点」的
 *   node tools/export_card_review.js --key FindWhiteHorse,HourseInnChallenge004
 *   node tools/export_card_review.js --out 校对清单.md
 *
 * 输出是 Markdown：每条任务一节，含我们数据里**所有**字段（游戏 UI 口径），
 * 末尾留「DS 结论」空行供填写。
 */
const fs = require('fs')
const path = require('path')

const APP = path.resolve(__dirname, '..', 'app')
/* ★ 必须用 Function + 参数隔离作用域：
 *   task-plan.js 里有 `const P` / `const L` / `const out` 等变量，
 *   直接 eval(src) 会和本脚本的同名变量互相覆盖（踩过：
 *   本脚本的 problems() 里的 push 变成 undefined，症状是
 *   「x.push is not a function」——完全看不出是作用域冲突）。
 *   window 也要通过参数传进去 —— Function 构造的函数体里
 *   拿不到模块作用域里的 global.window。 */
global.window = {}
const loadTasks = new Function(
  'window',
  `${fs.readFileSync(path.join(APP, 'data', 'task-plan.js'), 'utf8')}\n;return window.TOTK_TASK_PLAN;`
)
const P = loadTasks(global.window) || []

const argv = process.argv.slice(2)
function opt(name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}
const has = name => argv.includes(name)

/* ---------- 判据 ---------- */
const LAYER_CN = { 18: '地表', 19: '地底', 20: '天空' }
const TYPE_CN = { quest: '任务', flag: '条件' }
function gcoord(t) {
  if (t.gx == null || t.gz == null) return '无坐标'
  const x = Math.round(t.gx)
  const z = Math.round(-t.gz)
  const h = t.hasHeight && t.gy != null ? Math.round(t.gy - 106) : null
  return `X ${x} · Z ${z}` + (h != null ? ` · 高度 ${h}` : ' · 高度未知')
}
function rawCoord(t) {
  if (t.gx == null) return '（无）'
  return `gx=${t.gx} gy=${t.gy} gz=${t.gz}`
}
/* ---------- 可疑判据：给 DS 优先核这些 ----------
 * ★ 分两级（2026-10-07 改）：
 *   高危 = 可能是**数据错了**，值得 DS 逐条核
 *   提示 = 已知欠账（NPC/地点中文名缺失），全域存在，不算个案
 * 一开始把两者混在一起，结果 253 条**全部**带疑点标记，
 * 等于没标记 —— DS 会直接放弃。 */
function problems(t) {
  const list_problems = []
  if (!t || typeof t !== 'object') return list_problems
  const steps = Array.isArray(t.stepsUI) ? t.stepsUI : []

  /* ---- 高危：可能真的错了 ---- */
  if (!steps.length) list_problems.push('★ 无官方步骤（stepsUI 为空）')
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {}
    const len = String(s.text || '').length
    /* 短于25 字的几乎都是被游戏变量占位符截断（物品名/数量），
       官方句子读起来是半截 —— 值得问 DS 完整原文是什么。 */
    if (len < 25) list_problems.push(`★ 官方步骤过短(${len} 字，疑被占位符截断)`)
  }
  if (t.nameSrc === 'key') list_problems.push('★ 无官方中文名（显示的是英文 key）')
  if (t.gx != null && t.gz != null && Math.abs(t.gx) < 1 && Math.abs(t.gz) < 1) {
    list_problems.push('★ 坐标是 (0,0) —— 会被当成海拉鲁城堡中心，实质无效')
  }
  if (t.hasHeight === false && (t.flowPts || []).length) {
    list_problems.push('★ 有流程点但主坐标缺高度（卡片显示「高度未知」）')
  }
  /* 攻略 note 里出现「打倒/消灭/击败…」但官方步骤里没有这些词 ——
     已知会出现「后续任务内容被串进来」（样本 3）。启发式，只作提示。 */
  const note = String((t.guide || {}).note || '')
  const joined = steps.map(x => String((x || {}).text || '')).join(' ')
  if (note && /(打倒|消灭|击败|讨伐|讨伐队)/.test(note)
      && !/(打倒|消灭|击败|讨伐)/.test(joined)) {
    list_problems.push('★ 攻略note 提到战斗，但官方步骤里没有 —— 可能把后续任务串进来了')
  }
  if (t.posSrc === 'rom' && (t.flowPts || []).length > 1) {
    list_problems.push('★ 坐标取自 ROM 流程点（非攻略标点），位置可能与玩家视角差一段')
  }

  /* ---- 提示：已知欠账，不算个案 ---- */
  if (!t.npcCn && t.npc) list_problems.push('提示 NPC 无中文名（全库 221 条，待补）')
  if (!t.locCn && t.loc) list_problems.push('提示 地点无中文名（全库 241 条，待补）')
  if (!(t.guide && t.guide.start)) list_problems.push('提示 攻略缺「如何接取」')
  if (!(t.reqs || []).length) list_problems.push('提示 无前置信息（可能真没有，也可能没收录）')
  return list_problems
}

/* ---------- 过滤 ---------- */
let list = P.slice()
if (opt('--layer')) {
  const L = Number(opt('--layer'))
  list = list.filter(t => (t.layers || [t.layer]).indexOf(L) >= 0)
}
if (opt('--group')) list = list.filter(t => t.group === opt('--group'))
if (opt('--key')) {
  const ks = opt('--key').split(',').map(s => s.trim())
  list = list.filter(t => ks.indexOf(t.key) >= 0)
}
if (has('--problem')) {
  /* ★ 只留高危（★）。原来用 problems().length>0，结果 253 条全中
     （因为「NPC 无中文名」这类欠账几乎每条都有）→ 等于没筛。 */
  list = list.filter(t => problems(t).some(x => x.charAt(0) === '★'))
}
list.sort((a, b) => (a.sort != null ? a.sort : 1e9) - (b.sort != null ? b.sort : 1e9))

/* ---------- 输出 ---------- */
const L = []
L.push('# TOTKmap 任务卡片校对清单')
L.push('')
L.push('> **给 DS 老师**：下面是 TOTKmap（TOTK 地图工具）任务板块的完整数据。')
L.push('> 麻烦逐条核对**游戏里的实际情况**与这里是否一致。')
L.push('> 每条末尾有「疑点」清单，分两级：')
L.push('> - **★ 高危**：可能是数据错了，**建议优先核这些**')
L.push('> - 提示：已知欠账（如 NPC/地点中文名缺失，全域存在），不必逐条看')
L.push('')
L.push('## 阅读说明')
L.push('')
L.push('**坐标怎么读**')
L.push('')
L.push('我们内部存的是游戏世界坐标，玩家在游戏 UI 看到的是换算后的值：')
L.push('')
L.push('| 游戏 UI | 我们的值 | 关系 |')
L.push('|---|---|---|')
L.push('| X（东西，东为正） | `gx` | 一致 |')
L.push('| Z（南北，**北为正**） | `gz` | **取反**（我们北为负） |')
L.push('| 高度 | `gy` | **减 106**（系统性基准差） |')
L.push('')
L.push('所以下面每条都给了两行：**「游戏UI」是卡片上显示给玩家的**（已换算），')
L.push('**「内部值」是原始数据**。你对着游戏念的数字应该与「游戏UI」那行一致。')
L.push('')
L.push('**几个字段的含义**')
L.push('')
L.push('| 字段 | 含义 | 备注 |')
L.push('|---|---|---|')
L.push('| `stepsUI` | **官方步骤**（ROM 原文） | 最高优先级。有些句子被游戏变量占位符截断了（见疑点）|')
L.push('| `guide.*` | 社区攻略整理 | **可能出错**。已发现一条把后续任务的内容串过来了 |')
L.push('| `reqs` | 前置条件 | `quest`=另一条任务，`flag`=游戏内部条件标记 |')
L.push('| `npc` / `npcCn` | NPC | `npcCn`（中文名）**大量缺失**，是已知欠账 |')
L.push('| `sort` | ROM 里的分类编号 | `<100`=主剧情 / `100-999`=情节 / `1000-4999`=神庙 / `>=5000`=迷你 |')
L.push('')
L.push('---')
L.push('')
L.push(`**共 ${list.length} 条**${has('--problem') ? '（只导了有疑点的）' : ''}`)
L.push('')

list.forEach((t, i) => {
  const pb = problems(t)
  L.push(`## ${i + 1}. ${t.name}`)
  L.push('')
  L.push(`\`key\` = \`${t.key}\`  ·  \`sort\` = ${t.sort != null ? t.sort : '(无)'}  ·  来源 = ${t.posSrc || '-'} / ${t.src || '-'}`)
  L.push('')
  L.push('| 项 | 我们数据 |')
  L.push('|---|---|')
  L.push(`| 分类 | ${t.group}${pb.length ? '' : ''}（游戏档：${sortToGroup(t.sort)}）|`)
  L.push(`| 图层 | ${(t.layers || [t.layer]).map(x => LAYER_CN[x] || x).join(' + ')}（tier=${t.tier}）|`)
  L.push(`| **游戏 UI 坐标** | **${gcoord(t)}** |`)
  L.push(`| 内部坐标 | ${rawCoord(t)} |`)
  L.push(`| NPC | ${t.npc || '(无)'}${t.npcCn ? ' → ' + t.npcCn : ' → **(缺中文名)**'} |`)
  L.push(`| 地点 | ${t.loc || '(无)'}${t.locCn ? ' → ' + t.locCn : ' → **(缺中文名)**'} |`)
  L.push('')
  L.push('**官方步骤（ROM 原文，优先级最高）**')
  L.push('')
  if ((t.stepsUI || []).length) {
    t.stepsUI.forEach((s, k) => {
      L.push(`${k + 1}. ${(s.text || '(空)').replace(/\n/g, ' ')}`)
    })
  } else {
    L.push('（无）')
  }
  L.push('')
  const g = t.guide || {}
  L.push('**社区攻略（可能出错）**')
  L.push('')
  L.push('| 攻略字段 | 内容 |')
  L.push('|---|---|')
  L.push(`| 如何接取 | ${g.start || '(空)'} |`)
  L.push(`| 注意事项 | ${g.note || '(空)'} |`)
  L.push(`| 任务奖励 | ${(g.reward || []).join('、') || '(空)'} |`)
  L.push(`| 前置任务 | ${(g.requires || []).join('、') || '(空)'} |`)
  L.push('')
  L.push('**我们采用的前置 / 解锁**')
  L.push('')
  L.push('- 前置：' + ((t.reqs || []).length
    ? t.reqs.map(r => r.type === 'quest'
      ? `${r.reqName}${(r.src === 'guide' ? '（攻略补入）' : '')}`
      : `${r.reqName || r.flag}（条件）`).join('；')
    : '(无)'))
  L.push('- 解锁：' + ((t.unlockList || []).length
    ? t.unlockList.map(u => u.reqName).join('；')
    : '(无)'))
  L.push('')
  if (pb.length) {
    const hiOnly = pb.filter(x => x.charAt(0) === '★')
    L.push(hiOnly.length
      ? '**⚠ 高危疑点（建议优先核）**'
      : '**提示（已知欠账，不必逐条看）**')
    L.push('')
    const show = hiOnly.length ? hiOnly : pb
    show.forEach(x => L.push(`- ${x.replace(/^★\s*/, '**').replace(/$/, '**')}`))
    L.push('')
  }
  L.push('**DS 结论**（游戏里实际是怎样的？哪里不对？）')
  L.push('')
  L.push('>')
  L.push('')
  L.push('---')
  L.push('')
})

function sortToGroup(sort) {
  if (sort == null) return '未收录'
  if (sort < 100) return '主剧情挑战'
  if (sort < 1000) return '情节挑战'
  if (sort < 5000) return '神庙挑战'
  return '迷你挑战'
}

const outFile = opt('--out') || path.resolve(__dirname, '..', '任务卡片校对清单.md')
fs.writeFileSync(outFile, L.join('\n'), 'utf8')
console.log('已写出 ' + outFile)
const hi = list.filter(t => problems(t).some(x => x.charAt(0) === '★')).length
console.log('共 ' + list.length + ' 条，其中 **' + hi + ' 条有高危疑点**（★ 开头），建议 DS 优先核')
console.log('大小 ' + (fs.statSync(outFile).size / 1024).toFixed(1) + ' KB')
