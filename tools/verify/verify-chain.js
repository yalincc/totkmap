/* V2.1M6 验收：任务链 / 系列在卡片里的表现
 * 关注点：① 链条序号对不对 ② 格子的完成态对不对 ③ 跳转能点吗
 *        ④ 「官方步骤/官方分步」重复渲染修掉了吗 ⑤ 无中文名的可读化
 * 用法：node verify-chain.js   （需先起 http://127.0.0.1:8899）
 *★ 端口可被环境变量覆盖：PORT=8900 node verify-chain.js
 *   平时直接跑 verify-all.js 就行，它自己起服务。
 */
const { chromium } = require('playwright-core')
const PORT = process.env.PORT || 8899

const CASES = {
  六环链中间: 'MonsterFigures02',      // 6 环链的第 3 环
  六环链末环: 'MonsterFigures05',      // 应显示 6/6
  三点蘑菇: 'MushroomSisters_2',       // 3 环链的中间环
  PhotoSpot系列: 'PhotoSpot_Challenge_01', // 15 条系列（不成链）
  长主线11点: 'HyruleCastleIncident' // 11 个流程点，但不成任务链
}
/* ★ 「无中文名可读化」用例已从 CASES 移除（2026-10-07）。
 *   过程值得记：这个用例的样本被换过两次，每次都是因为样本被删——
 *     ① 原样本 Mercenary_Akkare_Bloody（「为〇〇带来和平」补录重复版）
 *     ② 换成 FindSunaNui2（全库最后一条 nameSrc='key'）
 *     ③ FindSunaNui2 也被删了（校对确认 139 条官方名单里没有它）
 *   全库现在**没有** nameSrc='key' 的任务，靠样本无法继续验证这个逻辑。
 *   → 改成直接测 prettyKey() 函数本身，见下方「无中文名可读化」段。
 *   教训：验收样本写死具体 key，数据一删就断。函数级测试更稳。 */

;(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true
  })
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  const errs = []
  const NOISE = /ERR_CONNECTION_REFUSED|127\.0\.0\.1:8766|favicon|404/
  page.on('pageerror', e => { if (!NOISE.test(e.message)) errs.push('PAGEERROR ' + e.message) })
  page.on('console', m => { if (m.type() === 'error' && !NOISE.test(m.text())) errs.push('CONSOLE ' + m.text()) })

await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4000)

/* ★ 必须先清掉手动标记：否则读到的是上一轮测试的残留，
   「已完成格」起始值就不对了，断言会得出错误结论。 */
await page.evaluate(() => { localStorage.clear() })
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4000)

  const R = {}

  for (const [label, key] of Object.entries(CASES)) {
    R[label] = await page.evaluate(async (k) => {
      const t = window.TaskData.byKey(k)
      if (!t) return { 找不到: true }
      window.TaskCard.open(t, null)
      await new Promise(r => setTimeout(r, 350))
      const card = document.querySelector('#taskCard')
      const chain = card.querySelector('.tk-chain')
      const secs = [...card.querySelectorAll('.tk-sec-t')].map(e => e.textContent.replace(/\s+/g, ' ').trim())
      return {
        名称: t.name,
        有链条区: !!chain,
        链条标题: chain ? (chain.querySelector('.tk-chain-h')?.textContent.replace(/\s+/g, ' ').trim() || '') : null,
        格子数: chain ? chain.querySelectorAll('.tk-ch-c').length : 0,
        当前格序号: chain ? [...chain.querySelectorAll('.tk-ch-c')].findIndex(e => e.classList.contains('cur')) + 1 : 0,
        已完成格: chain ? chain.querySelectorAll('.tk-ch-c.done').length : 0,
        是系列条: !!(chain && chain.classList.contains('tk-series')),
        分区列表: secs,
        /* ★ 修重复渲染后，「官方分步」这个分区名不该再出现 */
        有重复的官方分步区: secs.some(s => s.includes('官方分步')),
        有前置区: secs.some(s => s.indexOf('前置') === 0),
        前置里混了同链前驱: (() => {
          const rel = window.TaskData.relationsOf(k)
          if (!rel || !rel.chain) return false
          const pre = [...card.querySelectorAll('.tk-sec-t')].find(e => e.textContent.indexOf('前置') === 0)
          if (!pre) return false
          const inChainNames = rel.chain.list.map(x => x.name)
          const links = [...pre.parentElement.querySelectorAll('.tk-link')].map(a => a.textContent.trim())
          return links.some(n => inChainNames.includes(n))
        })(),
        卡片高度: Math.round(card.getBoundingClientRect().height)
      }
    }, key)
    await page.evaluate(() => window.TaskCard.close())
    await page.waitForTimeout(150)
  }

  /* 无中文名可读化：直接测 prettyKey()，不再依赖具体样本
   * （样本已被删光，见 CASES 处的注释） */
  R['无中文名可读化'] = await page.evaluate(() => {
    const D = window.TaskData
    if (!D || typeof D.prettyKey !== 'function') {
      return { prettyKey已导出: false }
    }
    /* 期望值必须与 KEY_WORD_HINT 表（task-data.js:51）里真实登记的词一致。
     * ★ 我第一版凭想象编了「怪物图鉴02」「工坊成员」这类中文，
     *   结果 4 条全红 —— 函数只做「词间分隔 + 表内词翻译」，
     *   表里没有的词原样保留（设计如此：凭空猜中文地名会误导玩家）。
     *   教训：写断言要先读实现，别照着「应该是什么样」猜。*/
    /* ★ 两种分隔符别搞混（我第一版就搞错了）：
     *   段内翻译用「·」无空格 —— MonsterFigures02 → 怪物收藏品·02
     *   段间分隔用「 · 」带空格 —— Mercenary_Akkare_Bloody → 佣兵 · Akkare · Bloody
     * 因为分词是按 _ 切的，段内是「一个词译成中文」，段间是「多个词并列」。 */
    const cases = [
      /* 表内词：整段命中 → 译成中文 + 保留数字后缀（段内用 ·） */
      ['MonsterFigures02', '怪物收藏品·02'],
      ['MushroomSisters_2', '蘑菇姐妹 · 2'],
      /* 下划线分词：每段各自查表（段间用 · 且带空格） */
      ['Mercenary_Akkare_Bloody', '佣兵 · Akkare · Bloody'],
      /* 前缀匹配（Rito 开头） */
      ['Rito_Something', '里特 · Something'],
      /* 表里没有的词 → 原样返回，不瞎猜 */
      ['BuildinguildMember', 'BuildinguildMember'],
      /* 空值不炸 */
      ['', '']
    ]
    const out = cases.map(([raw, want]) => {
      const got = String(D.prettyKey(raw))
      return { 输入: raw, 期望: want, 实际: got, 通过: got === want }
    })
    return {
      prettyKey已导出: true,
      用例: out,
      全通过: out.every(x => x.通过),
      库内无nameSrc为key的任务: D.tasks.filter(t => t.nameSrc === 'key').length
    }
  })

  /* 跳转：从链条格点进去，卡片应换成目标任务 */
  R['链条跳转'] = await page.evaluate(async () => {
    const t = window.TaskData.byKey('MonsterFigures02')
    window.TaskCard.open(t, null)
    await new Promise(r => setTimeout(r, 350))
    const cells = [...document.querySelectorAll('#taskCard .tk-ch-c')]
    const before = document.querySelector('#taskCard .tk-name')?.textContent.trim()
    /* 点最后一个格子（应该是第6 环） */
    const target = cells[cells.length - 1]
    const want = target.getAttribute('data-tk-goto')
    target.click()
    await new Promise(r => setTimeout(r, 400))
    const after = document.querySelector('#taskCard .tk-name')?.textContent.trim()
    return {
      跳转前: before,
      目标格: want,
      跳转后: after,
      跳对了: before !== after,
      跳后链条序号: (document.querySelector('#taskCard .tk-chain-h')?.textContent.match(/第\s*(\d+)\s*\/\s*(\d+)/) || []).slice(1)
    }
  })

  /* ★ 链条格完成态要跟随「标记完成」实时变化——
     这是链条区的核心价值，标完不变就跟没做一样。
     ★ 必须点**真实按钮**而不是调 TaskDone.markDone()：
       走 API 会绕过按钮的 redraw()，测的是另一条路径。 */
R['标记完成联动'] = await page.evaluate(async () => {
    const t = window.TaskData.byKey('MonsterFigures02')
    window.TaskCard.open(t, null)
    await new Promise(r => setTimeout(r, 350))
    const before = document.querySelectorAll('#taskCard .tk-ch-c.done').length
    /* 点「标记完成」按钮 */
    const btn = document.querySelector('#tkDone')
    const btnText = btn ? btn.textContent.trim() : null
    btn.click()
    await new Promise(r => setTimeout(r, 500))
    const afterSelf = document.querySelectorAll('#taskCard .tk-ch-c.done').length
    const btnAfter = document.querySelector('#tkDone')?.textContent.trim()
    /* 当前格应同时带 done+cur（保留「我在看哪环」的信息） */
    const curIsDone = !!document.querySelector('#taskCard .tk-ch-c.cur.done')
    /* 打开下一环，前一环应显示已完成 */
    window.TaskCard.open(window.TaskData.byKey('MonsterFigures03'), null)
    await new Promise(r => setTimeout(r, 400))
    const doneInNext = document.querySelectorAll('#taskCard .tk-ch-c.done').length
    /* 点取消，确认能恢复 */
    window.TaskCard.open(t, null)
    await new Promise(r => setTimeout(r, 300))
    document.querySelector('#tkDone').click()
    await new Promise(r => setTimeout(r, 500))
    const afterUndo = document.querySelectorAll('#taskCard .tk-ch-c.done').length
    return {
      初始已完成格: before,
      按钮初始文案: btnText,
      按钮点击后文案: btnAfter,
      标记自己后: afterSelf,
      当前格带双态: curIsDone,
      下一环看到已完成格: doneInNext,
      取消后: afterUndo,
      标记后有增加: afterSelf > before,
      下一环能看到前一环已完成: doneInNext >= 1,
      取消后能恢复: afterUndo === before
    }
  })

  /* 卡片不能超出视口（底部按钮要能点到） */
  R['卡片在视口内'] = await page.evaluate(async () => {
    window.TaskCard.open(window.TaskData.byKey('HyruleCastleIncident'), null)
    await new Promise(r => setTimeout(r, 400))
    const c = document.querySelector('#taskCard')
    const r = c.getBoundingClientRect()
    const btns = [...c.querySelectorAll('.tk-actions .btn')]
    const lastBtn = btns[btns.length - 1]?.getBoundingClientRect()
    return {
      卡片底部: Math.round(r.bottom),
      视口高: window.innerHeight,
      卡片未超视口: r.bottom <= window.innerHeight + 1,
      最后一个按钮可见: lastBtn ? lastBtn.bottom <= window.innerHeight + 1 : null,
      按钮数: btns.length,
      可滚动: c.scrollHeight > c.clientHeight
    }
  })

  R['错误'] = errs
  console.log(JSON.stringify(R, null, 1))

  /* 截图：6 环链 + 系列两个代表 */
  await page.evaluate(() => window.TaskCard.open(window.TaskData.byKey('MonsterFigures02'), null))
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'verify-chain.png' })
  await page.evaluate(() => window.TaskCard.open(window.TaskData.byKey('PhotoSpot_Challenge_01'), null))
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'verify-series.png' })
  await browser.close()
})().catch(e => { console.error('FATAL', e); process.exit(1) })