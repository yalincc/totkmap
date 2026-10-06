/* V2.1 L1 数据体检 —— 纯 Node，零依赖，秒级
 *
 * 关注：任务数据完整性。每层改动后跑一次，别靠肉眼看 259 条。
 * 用法：
 *   node verify-data.js            # 人读报告
 *   node verify-data.js --json     # 机器读（给 CI / verify-all 用）
 *   node verify-data.js --strict   # 有任何 warn 也算失败（卡口用）
 *
 * 退出码：0 = 全绿；1 = 有 ERROR；2 = --strict 下有 WARN
 *
 * 分级原则：
 *   ERROR = 一定会让界面出错（key 缺失、坐标非法、steps 结构坏）
 *   WARN  = 界面能兜住但数据不完整（无中文名、无坐标、分类过粗）
 *   INFO  = 覆盖率类，不算问题（无攻略 / 无 NPC）
 */
const path = require('path')

const APP = path.resolve(__dirname, '../../app')
global.window = {}
require(path.join(APP, 'data/task-plan.js'))
const TASKS = global.window.TOTK_TASK_PLAN

/* ---------- 体检规则表 ----------
 * level: error | warn | info
 * fix:   出现缺口时该怎么办（给人看的行动指引，不是自动修复）
 */
const RULES = [
  {
    id: 'key', title: '任务 key（存档同步的唯一锚点）', level: 'error',
    test: t => !t.key,
    why: 'key 缺失 = progress.sav 里找不到对应变量 = 完成态永远同步不上',
    fix: '查tools/build_task_save.py 的合并逻辑；这类必须人工定夺，别自动生成'
  },
  {
    id: 'key-dup', title: 'key 重复', level: 'error',
    test: null, group: true, pick: ts => {
      const seen = new Map()
      ts.forEach(t => { if (t.key) (seen.get(t.key) || seen.set(t.key, []).get(t.key)).push(t) })
      return [...seen.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ key: k, n: v.length }))
    },
    why: '同 key 会互相覆盖，面板和存档都会算错',
    fix: '回到上游合并重复记录（参考 merge_ippyujin.py 的做法）'
  },
  {
    id: 'coord-zero', title: '坐标落在 (0,0) 却声称有效', level: 'error',
    /*判据不是「坐标是不是 0,0」，而是「0,0 的坐标有没有被当成有效」。
     * 因为 (0,0) 本身是海拉鲁城堡中心——某些任务真的在那附近，
     * 但绝大多数是上游没兜住脏值。危险的不是脏值，是脏值被当真。 */
    test: t => t.posValid && Math.abs(t.gx) < 1 && Math.abs(t.gz) < 1,
    why: 'posValid=true 会让卡片给出导航按钮，把人传到海拉鲁城中心',
    fix: 'build_task_plan.py 的 _onMap 判定已加 (0,0) 排除；若仍报，检查上游 tasks.js 的 posValid'
  },
  {
    id: 'steps', title: '官方 steps 结构异常', level: 'error',
    test: t => !Array.isArray(t.steps) || !t.steps.length,
    why: '卡片「任务原文」区会空掉',
    fix: '重跑 tools/clean_steps.py'
  },
  {
    id: 'stepsui', title: '有 steps 但没 stepsUI（未清洗）', level: 'error',
    test: t => Array.isArray(t.steps) && t.steps.length && !Array.isArray(t.stepsUI),
    why: '会把空壳步骤和动态占位符直接显示给用户',
    fix: '重跑 tools/clean_steps.py 生成 stepsUI'
  },
  {
    id: 'name-cn', title: '无官方中文名（nameSrc=key）', level: 'warn',
    test: t => t.nameSrc === 'key',
    why: '卡片只能显示可读化兜底（如「佣兵 · Akkare · Bloody」），不是官方名',
    fix: '联网查官方中文名补进 tasks.js；查不到就保留兜底并在此登记'
  },
  {
    id: 'nocoord', title: '无有效坐标（上不了地图）', level: 'warn',
    /* ★ 排除已标注 noPlaceReason 的任务：
     *   有 6 条本来就该没有坐标（4 条 ROM 内部事件 + 井内拍照 + 剧情碎片），
     *   它们不是缺陷。不排除的话这个 WARN 会永远挂在报告里，
     *   让人以为还有 bug 没修完 —— 长期挂着假警报的体检等于没有体检。*/
    test: t => !t.posValid && !t.noPlaceReason,
    why: '卡片无导航按钮，地图无任务点',
    fix: '若该任务本就没有固定地点（如剧情对话），在 build_task_plan.py 的 NO_PLACE_REASON 里标注原因'
  },
  {
    id: 'nocoord-known', title: '无坐标但已标注原因（正常）', level: 'info',
    test: t => !t.posValid && !!t.noPlaceReason,
    why: '这些任务本来就没有固定地点，不上图是正确的',
    fix: '无需处理'
  },
  {
    id: 'cat-thin', title: '分类为「其他」（筛选粒度过粗）', level: 'warn',
    test: t => (t.group || '其他') === '其他',
    why: '占位分类，用户按分类筛任务时一大半任务挤在一起',
    fix: 'V2.2 考虑按 oldCat/kindCn 拆子类（老大已决定暂不拆，仅登记）'
  },
  {
    id: 'no-guide', title: '无攻略（纯官方原文）', level: 'info',
    test: t => !t.guide,
    why: '卡片只平铺官方内容，没有 L2 攻略的开启/注意/奖励',
    fix: '可选增强，不算缺陷'
  },
  {
    id: 'no-npc', title: '无 NPC 中文名', level: 'info',
    test: t => !t.npcCn,
    why: '卡片不显示 NPC 归属',
    fix: 'ROM 侧没抽 Npc_* → 中文名映射，可另开一轮补'
  }
]

/* ---------- 执行 ---------- */
const results = RULES.map(rule => {
  if (rule.group) {
    const hits = rule.pick(TASKS)
    return { rule, count: hits.length, items: hits }
  }
  const hits = TASKS.filter(rule.test)
  return {
    rule,
    count: hits.length,
    items: hits.slice(0, 40).map(t => ({
      key: t.key, name: t.name, posSrc: t.posSrc,
      nStepsUI: t.nStepsUI, cat: t.cat, kindCn: t.kindCn, oldCat: t.oldCat
    }))
  }
})

const byLevel = lv => results.filter(r => r.rule.level === lv && r.count > 0)
const errors = byLevel('error')
const warns = byLevel('warn')
const infos = byLevel('info')

/* ---------- 概览统计 ---------- */
const stat = f => TASKS.filter(f).length
const overview = {
  总数: TASKS.length,
  有官方中文名: stat(t => t.nameSrc !== 'key'),
  有有效坐标: stat(t => t.posValid),
  上得了地图: stat(t => t.onMap),
  有攻略: stat(t => !!t.guide),
  成链: stat(t => t.tier === 'L1' || t.tier === 'L2'),
  /* ★ 用 group 而非 catCn：迷你挑战单列（2026-10-07）后界面分类看group，
       catCn 是从 ROM cat 推的，会把 120 条迷你挑战算进「其他」。 */
      分类分布: TASKS.reduce((a, t) => { const k = t.group || '(无)'; a[k] = (a[k] || 0) + 1; return a }, {}),
  攻略分类分布: TASKS.reduce((a, t) => {
    const k = t.guide ? '有攻略' : '纯官方'; a[k] = (a[k] || 0) + 1; return a
  }, {})
}

/* ---------- 输出 ---------- */
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    ok: errors.length === 0,
    overview,
    results: results.filter(r => r.count > 0).map(r => ({
      id: r.rule.id, level: r.rule.level, title: r.rule.title,
      count: r.count, why: r.rule.why, fix: r.rule.fix, items: r.items
    }))
  }, null, 2))
} else {
  const LBL = { error: '[ERROR]', warn: '[WARN] ', info: '[INFO] ' }
  console.log('=== V2.1 任务数据体检 ===')
  console.log(`总数 ${overview.总数}｜中文名 ${overview.有官方中文名}｜坐标 ${overview.有有效坐标}｜上图 ${overview.上得了地图}｜攻略 ${overview.有攻略}`)
  console.log('分类 ' + JSON.stringify(overview.分类分布) + '｜攻略 ' + JSON.stringify(overview.攻略分类分布))
  console.log('')
  const show = arr => arr.forEach(r => {
    console.log(`${LBL[r.rule.level]} ${r.rule.title}：${r.count} 条`)
    console.log(`        原因：${r.rule.why}`)
    console.log(`        处理：${r.rule.fix}`)
    if (r.items.length) {
      r.items.slice(0, 12).forEach(i => console.log(`          - ${i.key}${i.name ? '| ' + i.name : ''}`))
      if (r.count > 12) console.log(`          …… 另 ${r.count - 12} 条`)
    }
  })
  show(errors); show(warns); show(infos)
  if (!errors.length && !warns.length) console.log('[OK] 无ERROR 无 WARN')
  console.log(`\n结论：${errors.length} 个 ERROR，${warns.length} 个 WARN，${infos.length} 个 INFO（INFO 仅供参考）`)
}

process.exit(errors.length ? 1 : (process.argv.includes('--strict') && warns.length ? 2 : 0))
