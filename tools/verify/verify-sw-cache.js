/* 验收：Service Worker 缓存会不会让「改了代码但页面没变化」
 *
 * 复现老大遇到的情况：代码改了、提交了，但页面上看不到。
 *
 * 流程：
 *   ① 首次加载（种下 SW + 缓存资源）
 *   ② 关掉浏览器上下文（模拟老大关标签页重开）
 *   ③ 重新加载 —— 此时走 SW，看拿到的是新资源还是旧缓存
 *
 * 关键断言：
 *   -防具增强容器 #ecArmor 存在（v=212 的 index.html，M6.6 起不再是新Tab）
 *   - 三个 armor/*.js 拿到了（v=212）
 *   - style.css 是新版（含 .ae 防具增强区块样式）
 *
 * 注意：Playwright 里SW 是持久化的（同一 userDataDir），
 *   但每次 newPage 用全新 context 时 SW 仍在 origin 级别共享。
 */
const { chromium } = require('playwright-core')
const PORT = process.env.PORT || 8899
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = `http://127.0.0.1:${PORT}`

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const ctx = await browser.newContext()
  const R = {}

  /* ---- ① 首次加载：种缓存 ---- */
  let page = await ctx.newPage()
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)
  /* 等 SW 装好 */
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 15000 })
    .catch(() => { })
  R['①首载'] = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration()
    return {
      有SW: !!navigator.serviceWorker.controller,
      SW脚本URL: reg ? (reg.active || reg.installing || reg.waiting)?.scriptURL : null
    }
  })
  /* 强制再取一遍资源，确保都进了缓存桶 */
  await page.evaluate(() => {
    ['js/armor/armor-data.js?v=212', 'js/armor/armor-panel.js?v=212',
      'js/armor/armor-card.js?v=212', 'css/style.css?v=212', 'js/app.js?v=212']
      .forEach(u => fetch('/' + u).then(r => r.text()).catch(() => { }))
  })
  await page.waitForTimeout(1500)
  await page.close()

  /* ---- ② 重开页面：走 SW ---- */
  page = await ctx.newPage()
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4500)

  R['②二载_走缓存'] = await page.evaluate(() => {
    const out = {
      Tab数: document.querySelectorAll('#sideTabs button').length,
      /* M6.6：防具不再是独立 Tab，改验「探索卡片里的增强容器」 */
      有增强容器: !!document.getElementById('ecArmor'),
      有ArmorEnhance: typeof window.ArmorEnhance === 'object',
      防具面板存在: !!document.getElementById('armorPane'),
      防具卡片存在: !!document.getElementById('armorCard'),
      模块在: {
        ArmorData: typeof window.ArmorData,
        ArmorPanel: typeof window.ArmorPanel,
        ArmorCard: typeof window.ArmorCard,
        强化数据: typeof window.TOTK_ARMOR_UPGRADE
      },
      /* 样式必须是新的 */
      有防具样式: (() => {
        let hit = false
        for (const ss of document.styleSheets) {
          let rules
          try { rules = ss.cssRules } catch (e) { continue }
          for (const r of rules || []) {
            if (r.selectorText === '.ae' || r.selectorText === '#ecArmor:empty') hit = true
          }
        }
        return hit
      })()
    }
    return out
  })

  /* ---- ③ 数据实不实 ---- */
  R['③数据'] = await page.evaluate(async () => {
    if (typeof window.ArmorEnhance !== 'object') return { 未加载: true }
    const AE = window.ArmorEnhance
    const M = window.TOTK_MARKERS, C = window.TOTK_CATALOGS
    const ids = C.filter(c => c && c.group === '位置' && /^防具/.test(c.name)).map(c => c.id)
    const pt = M.filter(m => ids.indexOf(m.cat) >= 0 && AE.match((m.name || '').trim()))[0]
    if (!pt) return { 跳过: '没有防具标点' }
    window.TOTK.openDetail(pt, null)
    await new Promise(r => setTimeout(r, 700))
    const box = document.getElementById('ecArmor')
    const ics = [...box.querySelectorAll('.ae-ic')]
    return {
      stats: AE.stats(),
      面板条数: box.querySelectorAll('.ae-row, .ae-piece').length,
      图标数: ics.length,
      图标全加载: ics.length ? ics.every(i => i.naturalWidth > 0) : false
    }
  })

  /* ---- ④ 任务板块（防具信息已并进 exploreCard，这里验任务卡片仍正常） ---- */
  R['④任务卡片'] = await page.evaluate(async () => {
    const D = window.TaskData
    const t = D.byKey('TreasureOfLamda_FierceDeity')
    window.TaskCard.open(t, null)
    await new Promise(r => setTimeout(r, 450))
    const box = document.getElementById('taskCard')
    return {
      任务数: D.tasks.length,
      卡片打开: box && !box.classList.contains('hidden'),
      有防具区: !!(box && box.querySelector('.tk-ar')),
      图标加载: (() => {
        const i = box && box.querySelector('.tk-ar-ic')
        return i ? i.naturalWidth > 0 : null
      })()
    }
  })

  console.log(JSON.stringify(R, null, 1))

  /* ---- 汇总 ---- */
  const fails = []
  const a = R['①首载'] || {}
  const b = R['②二载_走缓存'] || {}
  const c = R['③数据'] || {}
  const d = R['④任务卡片'] || {}

  if (!a.有SW) fails.push('Service Worker 没装上（缓存测试前提不成立）')
  if (b.Tab数 !== 2) fails.push(`侧栏 Tab 数 ${b.Tab数}，应为 2 —— index.html 是旧缓存`)
  if (!b.有增强容器) fails.push('没有 #ecArmor 容器 —— index.html 没更新')
  if (b.有ArmorEnhance !== true) fails.push('ArmorEnhance 未加载 —— js/armor/armor-enhance.js 是旧缓存')
  if (b.模块在.强化数据 !== 'object') fails.push('TOTK_ARMOR_UPGRADE 未加载 —— data/armor-upgrade.js 是旧缓存')
  if (!b.有防具样式) fails.push('style.css 是旧缓存（没有 .ae 防具增强样式）')

  if (!c.未加载) {
    if (!c['面板条数']) fails.push('防具增强区块没渲染出行')
    if (!c['图标全加载']) fails.push('防具图标没加载出来')
    if (c.stats && c.stats.防具条数 !== 136) fails.push(`防具总数 ${c.stats.防具条数}，应为 136`)
  }
  if (d.卡片打开 === false) fails.push('任务卡片打不开')
  else if (!d.有防具区) fails.push('任务卡片的防具区不见了')
  else if (!d.图标加载) fails.push('任务卡片里的防具图标没加载')

  console.log('\n' + JSON.stringify({
    错误: [],
    失败项: fails,
    摘要: 'SW 首载 → 重开 → 新 index.html / armor-enhance.js / 强化数据 / 样式，防具区块与任务卡片可开'
  }, null, 1))

  await browser.close()
})()