const { chromium } = require('playwright-core')
const PORT = process.env.PORT || 8899
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
;(async () => {
  const b = await chromium.launch({ executablePath: CHROME, headless: true })
  const p = await b.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 })
  await p.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(5000)
  await p.evaluate(() => localStorage.clear())
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(5000)
  const r = await p.evaluate(async () => {
    const M = window.TOTK_MARKERS, C = window.TOTK_CATALOGS
    const AE = window.ArmorEnhance
    const ids = C.filter(c => c.group === '位置' && /^防具/.test(c.name)).map(c => c.id)
    const names = M.filter(x => ids.includes(x.cat)).map(x => (x.name || '').trim())
    const pt = M.filter(m => {
      if (ids.indexOf(m.cat) < 0) return false
      const h = AE.match((m.name || '').trim())
      if (!h || !h.armor) return false
      const set = (window.TOTK_ARMORS || []).filter(a => a.setId === h.armor.setId && a.key !== h.armor.key)
      return set.length && set.some(a => names.indexOf(a.name) >= 0)
    })[0]
    window.TOTK.openDetail(pt, null)
    await new Promise(r => setTimeout(r, 400))
    const btn = document.querySelector('#ecArmor .ae-sib[data-go-armor]')
    btn.click()
    await new Promise(r => setTimeout(r, 3000))   /* 动画中 */
    const mid = {}
    const f = document.querySelector('.mk-locate-flash')
    if (f) {
      const cs = getComputedStyle(f)
      mid['动画中_transform'] = cs.transform
      mid['动画中_尺寸'] = [Math.round(f.getBoundingClientRect().width), Math.round(f.getBoundingClientRect().height)]
    }
    return { 起点: pt.name, 点的是: btn.textContent.trim(), ...mid }
  })
  await p.screenshot({ path: 'flash-a.png' })
  /* 等动画结束，看描边态 */
  const r2 = await p.evaluate(async () => {
    await new Promise(r => setTimeout(r, 2800))
    const el = document.querySelector('.mk-locate-mark')
    if (!el) return { 有描边态: false }
    const cs = getComputedStyle(el)
    return {
      有描边态: true,
      outline: cs.outlineWidth + ' ' + cs.outlineColor,
      filter: cs.filter.slice(0, 60),
      transform: cs.transform,
      尺寸: [Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height)]
    }
  })
  await p.screenshot({ path: 'flash-b.png' })
  console.log(JSON.stringify({ ...r, ...r2 }, null, 1))
  await b.close()
})()
