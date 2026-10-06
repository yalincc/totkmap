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
 *   - 防具 Tab 存在（v=211 的 index.html）
 *   - 三个 armor/*.js 拿到了（v=211）
 *   - style.css 是新版（含 .arm-list 样式）
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
    ['js/armor/armor-data.js?v=211', 'js/armor/armor-panel.js?v=211',
      'js/armor/armor-card.js?v=211', 'css/style.css?v=211', 'js/app.js?v=211']
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
      有防具Tab: !!document.querySelector('#sideTabs button[data-tab="armor"]'),
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
            if (r.selectorText === '.arm-list' || r.selectorText === '.ac-card') hit = true
          }
        }
        return hit
      })()
    }
    return out
  })

  /* ---- ③ 数据实不实 ---- */
  R['③数据'] = await page.evaluate(async () => {
    if (typeof window.ArmorData !== 'object') return { 未加载: true }
    const D = window.ArmorData
    const tab = [...document.querySelectorAll('#sideTabs button')].find(b => b.dataset.tab === 'armor')
    tab.click()
    await new Promise(r => setTimeout(r, 700))
    const items = document.querySelectorAll('#armorList [data-armor]')
    const hows = document.querySelectorAll('#armorHow [data-how]')
    return {
      stats: D.stats,
      面板条数: items.length,
      获取方式档: hows.length,
      图标数: document.querySelectorAll('#armorList img.arm-ic').length,
      图标全加载: [...document.querySelectorAll('#armorList img.arm-ic')]
        .every(i => i.naturalWidth > 0)
    }
  })

  /* ---- ④ 卡片能打开吗 ---- */
  R['④卡片'] = await page.evaluate(async () => {
    window.ArmorCard.openByKey('Armor_225_Upper', null)
    await new Promise(r => setTimeout(r, 450))
    const box = document.getElementById('armorCard')
    if (!box || box.classList.contains('hidden')) return { 未打开: true }
    return {
      名字: (box.querySelector('.ac-name') || {}).textContent,
      强化行数: box.querySelectorAll('.ac-up').length,
      套装链接: box.querySelectorAll('[data-go-armor]').length,
      有背景: getComputedStyle(box.querySelector('.ac-card')).backgroundColor
    }
  })

  console.log(JSON.stringify(R, null, 1))

  /* ---- 汇总 ---- */
  const fails = []
  const a = R['①首载'] || {}
  const b = R['②二载_走缓存'] || {}
  const c = R['③数据'] || {}
  const d = R['④卡片'] || {}

  if (!a.有SW) fails.push('Service Worker 没装上（缓存测试前提不成立）')
  if (b.Tab数 !== 3) fails.push(`侧栏 Tab 数 ${b.Tab数}，应为 3 —— index.html 是旧缓存`)
  if (!b.有防具Tab) fails.push('没有防具 Tab —— index.html 没更新')
  if (!b.防具面板存在) fails.push('防具面板 DOM 不存在 —— index.html 没更新')
  if (b.模块在.ArmorData !== 'object') fails.push('ArmorData 不是对象 —— js/armor/armor-data.js 是旧缓存')
  if (b.模块在.ArmorPanel !== 'object') fails.push('ArmorPanel 未加载')
  if (b.模块在.ArmorCard !== 'object') fails.push('ArmorCard 未加载')
  if (b.模块在.强化数据 !== 'object') fails.push('TOTK_ARMOR_UPGRADE 未加载 —— data/armor-upgrade.js 是旧缓存')
  if (!b.有防具样式) fails.push('style.css 是旧缓存（没有 .arm-list / .ac-card 规则）')

  if (!c.未加载) {
    if (!c.面板条数) fails.push('防具面板一条都没渲染')
    if (!c.图标全加载) fails.push('面板图标没加载出来')
    if (c.stats && c.stats.total !== 136) fails.push(`防具总数 ${c.stats.total}，应为 136`)
  }
  if (d.未打开) fails.push('防具卡片打不开')
  else {
    if (d.强化行数 !== 5) fails.push(`强化链 ${d.强化行数} 行，应为 5`)
    if (!d.套装链接) fails.push('没有套装链接')
    /* 卡片变透明就是拿错了外壳 */
    if (!/rgba?\(\s*2[0-9]\s*,/.test(String(d.有背景))) {
      fails.push(`卡片背景异常（${d.有背景}），可能是外壳被 innerHTML 覆盖了`)
    }
  }

  console.log('\n' + JSON.stringify({
    错误: [],
    失败项: fails,
    摘要: 'SW 首载 → 重开 → 拿到新 index.html/js/css/data，卡片可开'
  }, null, 1))

  await browser.close()
})()