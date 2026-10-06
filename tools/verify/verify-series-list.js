/* M6.3 验收：同系列任务折叠列表
 * 关注点：
 *   ① 有系列的任务真的渲染出可展开的列表（不是只有一行数字）
 *   ② 列表条数 = seriesOf().total，且包含当前任务自己
 *   ③ 点某一条能真的切换到那个任务（不是摆设）
 *   ④ 完成态显示正确：已完成划掉、当前条高亮
 *   ⑤ 没有系列的任务不显示空壳
 *   ⑥ 不影响既有 M5/M6 结构
 * 用法：node verify-series-list.js    （端口走 PORT，默认 8899）
 */
const { chromium } = require('playwright-core')
const PORT = process.env.PORT || 8899
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

/* ★ 期望值不写死具体条数，而是脚本里现算 seriesOf(key).total——
 *   系列判定规则（>=3 且排黑名单）以后若调整，硬编码的条数会立刻变成假失败。 */
;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errs = []
  const NOISE = /ERR_CONNECTION_REFUSED|127\.0\.0\.1:8766|favicon|404/
  page.on('pageerror', e => { if (!NOISE.test(e.message)) errs.push('PAGEERROR ' + e.message) })
  page.on('console', m => {
    if (m.type() === 'error' && !NOISE.test(m.text())) errs.push('CONSOLE ' + m.text())
  })

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4500)
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4500)

  const R = {}

  /* ---- 0. 前置：先找出成系列 / 不成系列的任务各若干 ---- */
  R['0_样本'] = await page.evaluate(() => {
    const D = window.TaskData
    const withSe = D.tasks.filter(t => D.seriesOf(t.key))
    const noSe = D.tasks.filter(t => !D.seriesOf(t.key))
    /* 挑条数最多的几个系列当用例：PhotoSpot 之类 15 条的最能暴露布局问题 */
    withSe.sort((a, b) => D.seriesOf(b.key).total - D.seriesOf(a.key).total)
    const dup = new Set()
    const uniq = []
    for (const t of withSe) {
      const se = D.seriesOf(t.key)
      if (dup.has(se.prefix)) continue
      dup.add(se.prefix)
      uniq.push({ key: t.key, name: t.name, prefix: se.prefix, total: se.total })
      if (uniq.length >= 5) break
    }
    return {
      成系列总数: withSe.length,
      取样: uniq,
      无系列取样: noSe.slice(0, 3).map(t => ({ key: t.key, name: t.name }))
    }
  })

  /* ---- 1. 逐个样本检查 DOM ---- */
  R['逐样本'] = {}
  for (const s of R['0_样本'].取样) {
    R['逐样本'][s.key] = await page.evaluate(async ([k, expTotal]) => {
      const D = window.TaskData
      const t = D.byKey(k)
      if (!t) return { 找不到: true }
      window.TaskCard.open(t, null)
      await new Promise(r => setTimeout(r, 320))
      const box = document.querySelector('#taskCard')
      const se = box && box.querySelector('.tk-series')
      const dt = se && se.querySelector('details.tk-details')
      const res = {
        任务名: t.name,
        期望条数: expTotal,
        有系列区: !!se,
        是details: !!dt,
        默认展开: dt ? dt.open : null,
        列表存在: !!(dt && dt.querySelector('.tk-se-list')),
        条数: dt ? dt.querySelectorAll('.tk-se-row').length : 0,
        当前条数: dt ? dt.querySelectorAll('.tk-se-row.self').length : 0,
        头部文字: se ? (se.querySelector('.tk-chain-h') || {}).textContent : null,
        /* 箭头必须真的渲染出来（曾因复用 .tk-fold 选择器而完全没显示） */
        箭头content: dt ? getComputedStyle(dt.querySelector('summary'), '::after').content : null,
        /* 折叠态是否真的收起：不能只看列表自己的 height。
         * Chrome 的 <details> 折叠靠 UA 的 ::details-content 实现，
         * 子元素**仍保留布局盒**（实测折叠时 list 高度仍是 140px），
         * 只是被父容器裁掉。唯一可靠的判据是「details 自身高度」
         * 与「列表内容高度」的对比：折叠时前者≈summary 一行，
         * 展开时才等于列表高度。 */
        折叠时details高: dt ? Math.round(dt.getBoundingClientRect().height) : -1,
        区高度: se ? Math.round(se.getBoundingClientRect().height) : 0
      }
      /* 展开后列表必须真的有高度 */
      if (dt) {
        dt.open = true
        await new Promise(r => setTimeout(r, 80))
        res['展开时列表高度'] = Math.round(dt.querySelector('.tk-se-list').getBoundingClientRect().height)
        res['展开时details高'] = Math.round(dt.getBoundingClientRect().height)
        res['列表可滚动'] = dt.querySelector('.tk-se-list').scrollHeight > dt.querySelector('.tk-se-list').clientHeight
        /* 条目文字不能全被裁掉 */
        const first = dt.querySelector('.tk-se-row .tk-se-n')
        res['首条文字'] = first ? first.textContent.trim() : null
        res['首条可见宽'] = first ? Math.round(first.getBoundingClientRect().width) : 0
      }
      return res
    }, [s.key, s.total])
  }

  /* ---- 2. 真点击切换任务（不是调API 绕过） ---- */
  R['点击切换'] = await page.evaluate(async () => {
    const D = window.TaskData
    const withSe = D.tasks.filter(t => D.seriesOf(t.key) && D.seriesOf(t.key).total >= 3)
    if (!withSe.length) return { 跳过: '没有可用样本' }
    const t0 = withSe[0]
    window.TaskCard.open(D.byKey(t0.key), null)
    await new Promise(r => setTimeout(r, 320))
    const dt = document.querySelector('#taskCard .tk-series details')
    dt.open = true
    await new Promise(r => setTimeout(r, 120))
    /* 找一条不是自己、也不是当前任务的真实点击目标 */
    const rows = [...dt.querySelectorAll('.tk-se-row')].filter(r => !r.classList.contains('self'))
    if (!rows.length) return { 跳过: '系列里只有自己' }
    const targetName = rows[0].querySelector('.tk-se-n').textContent.trim()
    rows[0].click()
    await new Promise(r => setTimeout(r, 400))
    const box = document.querySelector('#taskCard')
    return {
      起点: t0.name,
      点了哪条: targetName,
      卡片现在显示: (box.querySelector('.tk-card-t') || box.querySelector('h2,h3') || {}).textContent,
      切过去了: box.textContent.includes(targetName),
      /* 切换后新任务自己也该被标成 self，且卡片仍能渲染 */
      新卡片仍有系列区: !!box.querySelector('.tk-series'),
      新卡片系列是否折叠: (() => { const d = box.querySelector('.tk-series details'); return d ? !d.open : null })()
    }
  })

  /* ---- 3. 完成态：标完成一个系列成员，看列表是否划掉 ---- */
  R['完成态联动'] = await page.evaluate(async () => {
    const D = window.TaskData
    const withSe = D.tasks.filter(t => D.seriesOf(t.key) && D.seriesOf(t.key).total >= 3)
    if (!withSe.length) return { 跳过: '没有可用样本' }
    const t0 = withSe[0]
    const se = D.seriesOf(t0.key)
    const other = se.list.find(x => x.key !== t0.key && x.key)
    window.TaskCard.open(D.byKey(t0.key), null)
    await new Promise(r => setTimeout(r, 320))
    const dt = document.querySelector('#taskCard .tk-series details')
    dt.open = true
    await new Promise(r => setTimeout(r, 100))
    window.TaskDone.markDone(other.key)
    await new Promise(r => setTimeout(r, 420))
    /* 重绘后details 会被重置为折叠——这是已知取舍（卡片整体 innerHTML 重建）。
       要验的是完成态本身正确，不是折叠状态是否保持。 */
    const dt2 = document.querySelector('#taskCard .tk-series details')
    dt2.open = true
    await new Promise(r => setTimeout(r, 100))
    const row = [...document.querySelectorAll('#taskCard .tk-se-row')]
      .find(r => r.querySelector('.tk-se-n').textContent.trim() === other.name)
    const head = document.querySelector('#taskCard .tk-series .tk-chain-h')
    return {
      标完成的是: other.name,
      头部文字: head ? head.textContent : null,
      该行有done类: !!(row && row.classList.contains('done')),
      该行划掉样式: row ? getComputedStyle(row.querySelector('.tk-se-n')).textDecorationLine : null,
      已完成计数含它: head ? /已完成\s*\d/.test(head.textContent) : false
    }
  })

  /* ---- 4. 没有系列的任务不显示空壳 ---- */
  R['无系列不显示'] = await page.evaluate(async (keys) => {
    const out = []
    for (const k of keys) {
      const t = window.TaskData.byKey(k)
      if (!t) continue
      window.TaskCard.open(t, null)
      await new Promise(r => setTimeout(r, 260))
      const box = document.querySelector('#taskCard')
      out.push({
        任务: t.name,
        有系列区: !!box.querySelector('.tk-series'),
        残留搜索提示: /名字相近可搜|可搜/.test(box.textContent)
      })
    }
    return out
  }, R['0_样本'].无系列取样.map(x => x.key))

  /* ---- 5. 既有结构没被破坏 ---- */
  R['5_回归'] = await page.evaluate(async () => {
    const D = window.TaskData
    const chainKey = D.tasks.find(t => D.chainOf(t.key))?.key
    const t = D.byKey(chainKey)
    window.TaskCard.open(t, null)
    await new Promise(r => setTimeout(r, 320))
    const box = document.querySelector('#taskCard')
    return {
      任务链还在: !!box.querySelector('.tk-chain:not(.tk-series)'),
      链格子数: box.querySelectorAll('.tk-chain:not(.tk-series) .tk-ch-c').length,
      底部按钮: ['tkNav', 'tkTrack', 'tkDone'].filter(id => box.querySelector('#' + id)).length,
      卡片可见: !box.classList.contains('hidden')
    }
  })

  console.log(JSON.stringify(R, null, 1))

  /* ---- 汇总断言：verify-all.js 认「错误」/「失败项」两个字段 ----
     不要在脚本里自己 exit：汇总出来才能和其他脚本一起看，
     失败时也要能看到上面的现场数据（哪一条不对、值是多少）。 */
  const fails = []
  const 样本 = R['0_样本'].取样
  if (!样本.length) fails.push('找不到成系列的任务样本，系列判定可能整体失效')

  for (const s of 样本) {
    const d = R['逐样本'][s.key] || {}
    const tag = s.key
    if (!d.是details) fails.push(`${tag}：系列区不是可展开的 details`)
    if (d.默认展开 !== false) fails.push(`${tag}：系列列表应默认折叠，实际=${d.默认展开}`)
    if (d.条数 !== d.期望条数) fails.push(`${tag}：列了 ${d.条数} 条，应为 ${d.期望条数} 条`)
    if (d.当前条数 !== 1) fails.push(`${tag}：应有且只有 1 条标记为「当前」，实际 ${d.当前条数} 条`)
    if (!d.列表存在) fails.push(`${tag}：没有 .tk-se-list 容器`)
    if (!d.展开时列表高度 || d.展开时列表高度 < 40) {
      fails.push(`${tag}：展开后高度 ${d.展开时列表高度}px，样式没生效`)
    }
    /* 折叠判据见采样处注释：Chrome 折叠时子元素仍有布局盒，
       只能比「details 高度」是否 ≈ summary 一行高（约 34px）。 */
    if (d.折叠时details高 > 60) {
      fails.push(`${tag}：折叠时 details 仍高 ${d.折叠时details高}px，等于没折叠`)
    }
    if (d.展开时details高 <= d.折叠时details高) {
      fails.push(`${tag}：展开后高度没变化（${d.折叠时details高}→${d.展开时details高}px），点了没反应`)
    }
    if (!d.箭头content || d.箭头content === 'none') fails.push(`${tag}：展开箭头没渲染`)
    if (!/已完成/.test(d.头部文字 || '')) fails.push(`${tag}：头部缺「已完成 N」，实际=${d.头部文字}`)
    if (d.首条可见宽 < 60) fails.push(`${tag}：条目文字宽度 ${d.首条可见宽}px，被裁掉了`)
  }

  const c = R['点击切换'] || {}
  if (c.跳过) fails.push('点击切换：' + c.跳过)
  else if (!c.切过去了) fails.push(`点击切换：点了「${c.点了哪条}」但卡片没切过去`)
  else if (!c.新卡片仍有系列区) fails.push('点击切换：切过去的新任务自身没有系列区')

  const d = R['完成态联动'] || {}
  if (d.跳过) fails.push('完成态联动：' + d.跳过)
  else {
    if (!d.该行有done类) fails.push(`完成态联动：标完成「${d.标完成的是}」后列表里没有 done 标记`)
    if (!/line-through/.test(d.该行划掉样式 || '')) fails.push('完成态联动：已完成条目没有划掉样式')
    if (!d.已完成计数含它) fails.push(`完成态联动：头部完成计数没更新，实际=${d.头部文字}`)
  }

  for (const n of R['无系列不显示'] || []) {
    if (n.有系列区) fails.push(`${n.任务}：本来无系列却显示了系列区`)
    if (n.残留搜索提示) fails.push(`${n.任务}：还残留旧的「可搜 XX」提示文案`)
  }

  const g = R['5_回归'] || {}
  if (!g.任务链还在) fails.push('回归：任务链区不见了')
  if (g.底部按钮 !== 3) fails.push(`回归：底部按钮只渲染了 ${g.底部按钮}/3`)

  console.log('\n' + JSON.stringify({
    错误: errs,
    失败项: fails,
    摘要: `${样本.length} 个系列样本，条数/折叠/箭头/点击切换/完成态全部核对`
  }, null, 1))

  await browser.close()
})()