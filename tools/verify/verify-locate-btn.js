/* M6.8 验收：坐标旁定位按钮 + 任务卡片防具点击回归
 *
 * 关注点：
 *   ① 定位按钮存在、在坐标右边、点它地图真的飞过去 + 加光圈
 *   ② 无坐标的标点不显示该按钮（不占位）
 *   ③ 定位按钮不依赖 xnavi（服务不开也能用）—— 纯前端 flyTo
 *   ④ 定位按钮 vs 底部「导航」：两个都在，语义不同，不互相覆盖
 *   ⑤ 回归：任务卡片的防具图标用**真实鼠标**能点开
 *      ★ 必须用 p.mouse.move/down/up，不能用 element.click()——
 *        后者不走 pointerdown/mousedown 链，绕开了 makeDraggable 的
 *        releasePointerCapture，测不出「点了没反应」这个 bug。
 *   ⑥ 回归：任务卡片本身还能拖动（别为了修点击把拖动搞坏）
 *   ⑦ 非防具标点（神庙/塔）也有定位按钮 —— 需求说的是「卡片上的坐标旁边」
 *
 * 用法：node verify-locate-btn.js   （端口走 PORT，默认 8899）
 */
const { chromium } = require('playwright-core')
const PORT = process.env.PORT || 8899
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

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
  await page.waitForTimeout(5000)
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)

  const MP = () => page.evaluate(() => {
    const c = window.TOTK.map.getCenter()
    return [Math.round(c.lat), Math.round(c.lng)]
  })

  const R = {}

  /* ---- 0. 前置 ---- */
  R['0_环境'] = await page.evaluate(() => {
    const M = window.TOTK_MARKERS, C = window.TOTK_CATALOGS
    const armIds = C.filter(c => c && c.group === '位置' && /^防具/.test(c.name)).map(c => c.id)
    return {
      有定位按钮: !!document.getElementById('ecLocate'),
      防具标点数: M.filter(m => armIds.indexOf(m.cat) >= 0).length,
      LIVENAV在否: typeof window.LIVENAV
    }
  })

  /* ---- 1~4. 定位按钮：防具标点 ---- */
  R['1_防具标点'] = await page.evaluate(async () => {
    const M = window.TOTK_MARKERS, C = window.TOTK_CATALOGS
    const AE = window.ArmorEnhance
    const armIds = C.filter(c => c && c.group === '位置' && /^防具/.test(c.name)).map(c => c.id)
    const pt = M.filter(m => {
      const h = AE.match((m.name || '').trim())
      return armIds.indexOf(m.cat) >= 0 && h && h.armor
    })[0]
    if (!pt) return { 跳过: '没有防具标点' }
    /* 从很远的地方打开，好验证「点定位会飞过去」 */
    window.TOTK.map.setView([0, 0], 3)
    window.TOTK.openDetail(pt, null)
    await new Promise(r => setTimeout(r, 500))
    const btn = document.getElementById('ecLocate')
    if (!btn) return { 没有按钮: true }
    const b = btn.getBoundingClientRect()
    /* 按钮要落在坐标那一行里（不是浮在别处） */
    const coordRow = document.getElementById('ecCoordRow').getBoundingClientRect()
    return {
      标点名: pt.name,
      按钮可见: b.width > 0 && b.height > 0,
      按钮在坐标行内: b.top >= coordRow.top - 4 && b.bottom <= coordRow.bottom + 4,
      按钮尺寸: [Math.round(b.width), Math.round(b.height)],
      在坐标文字右边: b.left > (document.getElementById('ecCoord').getBoundingClientRect().right - 4),
      坐标文字: document.getElementById('ecCoord').textContent,
      底部导航按钮也在: !!document.getElementById('ecNav')
    }
  })

  /* ---- 2. 点定位 → 地图飞过去 + 光圈 ---- */
  R['2_点定位'] = await page.evaluate(async () => {
    const MPx = window.TOTK.map
    const before = MPx.getCenter()
    document.getElementById('ecLocate').click()
    await new Promise(r => setTimeout(r, 1600))
    const after = MPx.getCenter()
    return {
      移动距离: Math.round(Math.hypot(after.lat - before.lat, after.lng - before.lng)),
      目标中心: [Math.round(after.lat), Math.round(after.lng)],
      缩放: MPx.getZoom(),
      有光圈: !!document.querySelector('.mk-locate-ring'),
      卡片仍开着: !document.getElementById('exploreCard').classList.contains('hidden')
    }
  })

  /* ---- 3. 无坐标标点不显示按钮 ---- */
  R['3_无坐标'] = await page.evaluate(async () => {
    const M = window.TOTK_MARKERS
    const noPos = M.find(m => m.x == null || m.y == null)
    if (!noPos) return { 跳过: '全部标点都有坐标' }
    window.TOTK.openDetail(noPos, null)
    await new Promise(r => setTimeout(r, 400))
    const btn = document.getElementById('ecLocate')
    return {
      标点名: noPos.name,
      按钮隐藏: !btn || btn.style.display === 'none' || !btn.offsetWidth,
      按钮禁用: btn ? btn.disabled : null
    }
  })

  /* ---- 4. 非防具标点（神庙）也有定位按钮 ---- */
  R['4_神庙'] = await page.evaluate(async () => {
    const M = window.TOTK_MARKERS, C = window.TOTK_CATALOGS
    const sh = M.find(m => {
      const c = C.filter(x => x.id === m.cat)[0]
      return c && c.name === '神庙'
    })
    if (!sh) return { 跳过: '没有神庙样本' }
    window.TOTK.openDetail(sh, null)
    await new Promise(r => setTimeout(r, 400))
    const btn = document.getElementById('ecLocate')
    const before = window.TOTK.map.getCenter()
    const bb = btn.getBoundingClientRect()
    /* 真实鼠标点（绕过 actionability 检查） */
    return {
      标点名: sh.name,
      按钮可见: bb.width > 0,
      中心: [Math.round(bb.left + bb.width / 2), Math.round(bb.top + bb.height / 2)],
      当前中心: [Math.round(before.lat), Math.round(before.lng)]
    }
  })
  if (R['4_神墓'] === undefined && R['4_神庙'] && R['4_神庙'].中心) {
    const c = R['4_神庙'].中心
    await page.mouse.move(c[0], c[1])
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(1500)
    R['4_神庙']['点后地图移动'] = Math.round(Math.hypot(
      ...(await MP()).map((v, i) => v - R['4_神庙'].当前中心[i])
    ))
    R['4_神庙']['有光圈'] = await page.evaluate(() => !!document.querySelector('.mk-locate-ring'))
  }

  /* ---- 5~6. 任务卡片防具图标：真实鼠标点击回归 ---- */
  const t5 = await page.evaluate(async () => {
    const D = window.TaskData
    const t = D.tasks.find(x => D.armorsOf(x.key) && D.armorsOf(x.key).groups.length)
    window.TaskCard.open(t, null)
    await new Promise(r => setTimeout(r, 500))
    const ic = document.querySelector('#taskCard .tk-ar-ic[data-go-armor]')
    if (!ic) return { 跳过: '没有防具图标' }
    const b = ic.getBoundingClientRect()
    return {
      任务: t.name,
      key: ic.getAttribute('data-go-armor'),
      中心: [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)],
      命中栈顶: (() => {
        const e = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2))
        return e ? e.tagName + '.' + (typeof e.className === 'string' ? e.className.slice(0, 20) : '') : '(null)'
      })()
    }
  })
  if (!t5.跳过) {
    /* ★ 真实鼠标序列 —— 不能用 element.click()：
     *   element.click() 不走 pointerdown → makeDraggable.start() →
     *   end() 里的 releasePointerCapture 链，绕开了那个 bug。
     *   这正是我上轮误判「点击正常」的原因。 */
    await page.mouse.move(t5.中心[0], t5.中心[1])
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(1600)
    const r5 = await page.evaluate(() => ({
      探索打开: !document.getElementById('exploreCard').classList.contains('hidden'),
      防具区块: (document.getElementById('ecArmor').textContent || '').trim().slice(0, 40),
      任务卡片仍开着: !document.getElementById('taskCard').classList.contains('hidden'),
      地图中心: (() => { const c = window.TOTK.map.getCenter(); return [Math.round(c.lat), Math.round(c.lng)] })()
    }))
    R['5_任务卡片点击'] = { ...t5, ...r5 }
  }

  /* ---- 6. 任务卡片拖动没被搞坏 ---- */
  R['6_拖动回归'] = await page.evaluate(async () => {
    window.TaskCard.open(window.TaskData.tasks[0], null)
    await new Promise(r => setTimeout(r, 400))
    const card = document.getElementById('taskCard')
    const r1 = card.getBoundingClientRect()
    return {
      卡片位置: [Math.round(r1.left), Math.round(r1.top)],
      有tkDrag标记: !!card.__tkDrag
    }
  })
  const drag = R['6_拖动回归']
  if (!drag.跳过) {
    /* 按标题区域（非交互元素）拖动 */
    await page.mouse.move(drag.卡片位置[0] + 170, drag.卡片位置[1] + 12)
    await page.mouse.down()
    await page.mouse.move(drag.卡片位置[0] + 250, drag.卡片位置[1] + 60, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    R['6_拖动回归']['拖后位置'] = await page.evaluate(() => {
      const r = document.getElementById('taskCard').getBoundingClientRect()
      return [Math.round(r.left), Math.round(r.top)]
    })
    R['6_拖动回归']['拖动生效'] =
      R['6_拖动回归']['拖后位置'][0] !== drag.卡片位置[0]
      || R['6_拖动回归']['拖后位置'][1] !== drag.卡片位置[1]
  }

  /* ---- 汇总 ---- */
  const fails = []
  const e0 = R['0_环境'] || {}
  if (!e0.有定位按钮) fails.push('#ecLocate 按钮不存在')

  const g1 = R['1_防具标点'] || {}
  if (!g1.跳过 && !g1.没有按钮) {
    if (!g1.按钮可见) fails.push('定位按钮不可见')
    if (!g1.按钮在坐标行内) fails.push('定位按钮没落在坐标那一行里')
    if (!g1.在坐标文字右边) fails.push('定位按钮不在坐标文字右边')
    if (!g1.底部导航按钮也在) fails.push('底部「导航」按钮不见了（两个按钮应并存，语义不同）')
  }

  const g2 = R['2_点定位'] || {}
  if (g2.移动距离 !== undefined) {
    if (g2.移动距离 < 1) fails.push(`点定位后地图没动（${g2.移动距离}px）`)
    if (!g2.有光圈) fails.push('点定位后没有光圈')
    if (!g2.卡片仍开着) fails.push('点定位把卡片关了（应保持开着）')
  }

  const g3 = R['3_无坐标'] || {}
  if (!g3.跳过 && !g3.按钮隐藏) fails.push('无坐标标点也显示了定位按钮')

  const g4 = R['4_神庙'] || {}
  if (!g4.跳过 && !g4.按钮可见) fails.push('神庙卡片没有定位按钮')
  if (g4.点后地图移动 !== undefined && g4.点后地图移动 < 1) {
    fails.push('神庙卡片点定位后地图没动')
  }

  const g5 = R['5_任务卡片点击'] || {}
  if (!g5.跳过) {
    if (!g5.探索打开) {
      fails.push(`任务卡片防具图标真实点击没反应（${g5.key}）—— ` +
        `releasePointerCapture 重定向 click target？`)
    }
    if (!g5.防具区块) fails.push('跳过去后防具区块是空的')
    if (!g5.任务卡片仍开着) fails.push('跳过去后任务卡片被关了')
  }

  const g6 = R['6_拖动回归'] || {}
  if (!g6.跳过 && !g6.拖动生效) fails.push('任务卡片拖动失效（为修点击把拖动搞坏了？）')
  if (!g6.跳过 && !g6.有tkDrag标记) fails.push('makeDraggable 没装上')

  console.log(JSON.stringify(R, null, 1))
  console.log('\n' + JSON.stringify({
    错误: [...new Set(errs)].slice(0, 5),
    失败项: fails,
    摘要: '定位按钮位置/飞行/光圈/无坐标隐藏/非防具可用 · 任务卡片真实点击与拖动回归'
  }, null, 1))

  await browser.close()
})()