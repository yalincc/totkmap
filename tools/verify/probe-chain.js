/* V2.1M6 摸底：系列任务 / 长链条任务在卡片里的实际表现
 * 目的不是测「对不对」，是测「玩家看不看得出这是个链条」。
 * 用法：node probe-chain.js   （需先起 http://127.0.0.1:8899）
 */
const { chromium } = require('playwright-core')

const KEYS = {
  长链条6环: 'MonsterFigures02',      // 只属于我的怪物收藏品2（前1后1）
  四地区调查: 'ResearchLanayru',      // 淤泥缠身（前置=主线，多点）
  PhotoSpot: 'PhotoSpot_Challenge_01', // 15条系列其中一条
  三点蘑菇: 'MushroomSisters_2',      // 照亮洞窟的蘑菇2（3点L1）
  最长主线: 'HyruleCastleIncident'   // 海拉鲁城堡的异变（11点，最长流程）
}

;(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true
  })
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  const errs = []
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message))

  await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)

  const out = {}

  for (const [label, key] of Object.entries(KEYS)) {
    const r = await page.evaluate(async (k) => {
      const D = window.TaskData
      const t = D.tasks.find(x => x.key === k)
      if (!t) return { 找不到: true }
      // 打开卡片
      window.TaskCard.open(t, { latlng: { lat: 0, lng: 0 }, containerPointToLayerPoint: () => ({ x: 400, y: 300 }) })
      await new Promise(r => setTimeout(r, 400))
      const card = document.querySelector('#taskCard')
      const secTitles = [...document.querySelectorAll('#taskCard .tk-sec-t')]
        .map(e => e.textContent.replace(/\s+/g, ' ').trim())
      return {
        名称: t.name,
        tier: t.tier,
        流程点: (t.flowPts || []).length,
        卡片分区: secTitles,
        有无系列标识: secTitles.some(s => /系列|链条|阶段|第.*环|全系列/.test(s)),
        前置区: !!document.querySelector('#taskCard .tk-list a[data-tk-goto]'),
        卡片高度: card ? Math.round(card.getBoundingClientRect().height) : null,
        /* 关键问题：玩家能不能一眼看出「这任务有前驱和后继」 */
        首屏可见分区: secTitles.length ? secTitles.slice(0, 2) : []
      }
    }, key)
    out[label] = r
    // 关卡片
    await page.evaluate(() => window.TaskCard.close())
    await page.waitForTimeout(200)
  }

  /* 系列任务的横向关系：同前缀任务之间在界面上有没有任何关联 */
  out['系列横向关联'] = await page.evaluate(() => {
    const D = window.TaskData
    const all = D.tasks
    const photo = all.filter(x => (x.key || '').startsWith('PhotoSpot'))
    const first = photo[0]
    window.TaskCard.open(first, { latlng: { lat: 0, lng: 0 }, containerPointToLayerPoint: () => ({ x: 400, y: 300 }) })
    const has = {
      // 卡片里有没有列出同系列其他任务
      列出同系列: document.querySelector('#taskCard')?.textContent.includes('装点森林驿站的画作'),
      数据层能否查到同系列: (function () {
        try { return typeof D.seriesOf === 'function' ? D.seriesOf(first.key).length : '无 seriesOf 接口' } catch (e) { return '异常: ' + e.message }
      })()
    }
    window.TaskCard.close()
    return { 系列条数: photo.length, ...has }
  })

  /* 链条完整度：能否从任意一环walk到链尾 */
  out['链条连通性'] = await page.evaluate(() => {
    const D = window.TaskData
    const all = D.tasks
    const byKey = {}; all.forEach(t => { if (t.key) byKey[t.key] = t })
    // 从 MonsterFigures02 出发向前后走
    const chain = []
    let cur = byKey['MonsterFigures02']
    while (cur) {
      chain.push(cur.name)
      const prev = (cur.reqs || []).find(r => r.linkable && byKey[r.key])
      if (!prev) break
      cur = byKey[prev.key]
    }
    return { 怪物收藏品链: chain.reverse() }
  })

  await page.evaluate(() => { const t = window.TaskData.byKey('MonsterFigures02'); window.TaskCard.open(t, null) })
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'probe-chain-card.png' })
  out['错误'] = errs
  console.log(JSON.stringify(out, null, 1))
  await browser.close()
})().catch(e => { console.error('FATAL', e); process.exit(1) })
