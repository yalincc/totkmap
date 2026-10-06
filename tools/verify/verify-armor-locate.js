/* M6.7 验收：跳转定位 + 商店防具聚合
 *
 * 关注点：
 *   ① gotoMarker：地图是否真的动了（中心点变了）、marker 有没有闪烁高亮
 *   ② 目标分类未勾选时会自动勾上（否则飞到一片空白）
 *   ③ 跨图层跳转：先切层再勾选（state.selected 是当前层的引用，顺序错了就白勾）
 *   ④ 点「同套部件」→ 地图飞过去 + 卡片切过去
 *   ⑤ 点「关联任务」→ 地图飞过去 + 任务卡片打开
 *   ⑥ 商店聚合：防具店标点能列出店内防具；单件卡有「去哪买」
 *   ⑦ 聚合不重复：已有逐件标点的（格鲁德小镇那 11 件）不该再被塞进店
 *   ⑧ 归店距离阈值：怪物面罩（距店 2063）不该被硬塞
 *
 * 用法：node verify-armor-locate.js   （端口走 PORT，默认 8899）
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
  /* 清掉所有勾选，确保能验「自动勾选」那条 */
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)

  const R = {}

  /* ---- 0. 前置：取一个真实的防具标点 ---- */
  R['0_样本'] = await page.evaluate(() => {
    const M = window.TOTK_MARKERS, C = window.TOTK_CATALOGS
    const AE = window.ArmorEnhance
    const armIds = C.filter(c => c && c.group === '位置' && /^防具/.test(c.name)).map(c => c.id)
    const shopIds = C.filter(c => c && c.group === '位置' && c.name === '防具店').map(c => c.id)
    const pt = M.find(m => armIds.indexOf(m.cat) >= 0 && AE.match((m.name || '').trim()))
    return {
      防具标点: pt ? { id: pt.id, name: pt.name, layer: pt.layer, cat: pt.cat, x: pt.x, y: pt.y } : null,
      店数: shopIds.length,
      聚合: Object.keys(AE.shopGoods()).map(k => {
        const g = AE.shopGoods()[k]
        return { 店: g.shop.name, 坐标: [Math.round(g.shop.x), Math.round(g.shop.y)], 件数: g.items.length }
      }),
      归店总数: Object.keys(AE.shopGoods()).reduce((s, k) => s + AE.shopGoods()[k].items.length, 0)
    }
  })

  const pt0 = R['0_样本'].防具标点
  if (!pt0) {
    console.log(JSON.stringify(R, null, 1))
    console.log('\n' + JSON.stringify({ 错误: [], 失败项: ['找不到防具标点样本'], 摘要: '无法运行' }, null, 1))
    await browser.close()
    return
  }

  /* ---- 1. gotoMarker 基础行为（直接调，验地图真的动了） ---- */
  R['1_gotoMarker'] = await page.evaluate(async (p) => {
    const S = window.TOTK.state, MP = window.TOTK.map
    const before = { center: MP.getCenter(), zoom: MP.getZoom() }
    /* 目标分类应该是未勾选状态（localStorage 刚清空） */
    const wasSelected = !!S.selected[p.cat]
    window.TOTK_APP.gotoArmor && null
    /* 直接触发内部跳转：用 gotoMarker 的对外等价物 */
    const AE = window.ArmorEnhance
    const pt = AE.markerById(p.id)
    if (!pt) return { 找不到标点: true }
    /* 走真实入口 gotoArmor（bindArmorEnhance 是在 openDetail 时绑的，
       后插进DOM 的按钮拿不到事件，别用手动插按钮的办法测）。
       gotoArmor 内部会 findTaskMarker 式的按名反查 + gotoMarker。 */
    const A = (window.TOTK_ARMORS || []).find(a => a.name === p.name)
    if (!A) return { 找不到防具记录: true }
    window.TOTK_APP.gotoArmor(A.key)
    await new Promise(r => setTimeout(r, 1400))   /* 等flyTo 动画 */
    const after = { center: MP.getCenter(), zoom: MP.getZoom() }
    const d = Math.hypot(after.center.lat - before.center.lat, after.center.lng - before.center.lng)
    const el = document.querySelector('.mk-locate-flash')
    return {
      目标: p.name,
      目标分类: p.cat,
      跳转前是否已勾选: wasSelected,
      现在已勾选: !!S.selected[p.cat],
      地图移动距离: Math.round(d),
      缩放: after.zoom,
      有闪烁高亮: !!el,
      卡片还开着: !document.getElementById('exploreCard').classList.contains('hidden')
    }
  }, pt0)

  /* ---- 2. 点「同套部件」→ 地图飞过去 ---- */
  R['2_同套跳转'] = await page.evaluate(async () => {
    const M = window.TOTK_MARKERS, C = window.TOTK_CATALOGS
    const AE = window.ArmorEnhance
    const S = window.TOTK.state, MP = window.TOTK.map
    const armIds = C.filter(c => c && c.group === '位置' && /^防具/.test(c.name)).map(c => c.id)
    /* 找一件「有同套部件且同套另一件也有地图标点」的 */
    const pt = M.filter(m => {
      if (armIds.indexOf(m.cat) < 0) return false
      const h = AE.match((m.name || '').trim())
      if (!h || !h.armor) return false
      const sibs = AE.match.siblings ? [] : [];
      const names = M.filter(x => armIds.indexOf(x.cat) >= 0)
        .map(x => (x.name || '').trim());
      const set = (window.TOTK_ARMORS || []).filter(a => a.setId === h.armor.setId && a.key !== h.armor.key);
      return set.length > 0 && set.some(a => names.indexOf(a.name) >= 0);
    })[0]
    if (!pt) return { 跳过: '没有同套且都有标点的样本' }
    window.TOTK.openDetail(pt, null)
    await new Promise(r => setTimeout(r, 400))
    const btn = document.querySelector('#ecArmor .ae-sib[data-go-armor]')
    if (!btn) return { 跳过: '该件没有同套按钮' }
    const 点的是 = btn.textContent.trim()
    const before = MP.getCenter()
    btn.click()
    await new Promise(r => setTimeout(r, 1300))
    const after = MP.getCenter()
    const d = Math.hypot(after.lat - before.lat, after.lng - before.lng)
    const nameEl = document.querySelector('#ecArmor .ae-n')
    return {
      起点: pt.name,
      点的是,
      地图移动: Math.round(d),
      有高亮: !!document.querySelector('.mk-locate-flash'),
      现在显示: nameEl ? nameEl.textContent : null,
      切过去了: nameEl ? nameEl.textContent === 点的是 : false
    }
  })

  /* ---- 3. 点「关联任务」→ 地图飞过去 ---- */
  R['3_关联任务跳转'] = await page.evaluate(async () => {
    const M = window.TOTK_MARKERS, C = window.TOTK_CATALOGS
    const AE = window.ArmorEnhance
    const S = window.TOTK.state, MP = window.TOTK.map
    const armIds = C.filter(c => c && c.group === '位置' && /^防具/.test(c.name)).map(c => c.id)
    const pt = M.filter(m => {
      if (armIds.indexOf(m.cat) < 0) return false
      const h = AE.match((m.name || '').trim())
      return h && h.armor && h.armor.reqTasks && h.armor.reqTasks.length
    })[0]
    if (!pt) return { 跳过: '没有带关联任务的样本' }
    window.TOTK.openDetail(pt, null)
    await new Promise(r => setTimeout(r, 400))
    const btn = document.querySelector('#ecArmor .ae-task')
    if (!btn) return { 跳过: '没有关联任务按钮' }
    const 任务名 = btn.textContent.trim()
    const before = MP.getCenter()
    btn.click()
    await new Promise(r => setTimeout(r, 1300))
    const after = MP.getCenter()
    const d = Math.hypot(after.lat - before.lat, after.lng - before.lng)
    const tc = document.getElementById('taskCard')
    return {
      任务名,
      地图移动: Math.round(d),
      有高亮: !!document.querySelector('.mk-locate-flash'),
      任务卡片打开: tc && !tc.classList.contains('hidden'),
      说明: d === 0 ? '地图没动（该任务在地图上可能没有标点）' : '已定位'
    }
  })

  /* ---- 4. 防具店标点：店内清单 ---- */
  R['4_商店聚合'] = await page.evaluate(async () => {
    const M = window.TOTK_MARKERS, C = window.TOTK_CATALOGS
    const AE = window.ArmorEnhance
    const shopIds = C.filter(c => c && c.group === '位置' && c.name === '防具店').map(c => c.id)
    const shops = M.filter(m => shopIds.indexOf(m.cat) >= 0)
    const goods = AE.shopGoods()
    /* 挑一个真有归到货的店 */
    const withGoods = shops.filter(s => goods[s.id] && goods[s.id].items.length)
    if (!withGoods.length) return { 跳过: '没有归到货的店' }
    const s = withGoods[0]
    window.TOTK.openDetail(s, null)
    await new Promise(r => setTimeout(r, 600))
    const box = document.getElementById('ecArmor')
    const pieces = [...box.querySelectorAll('.ae-piece')]
    return {
      店: s.name,
      店坐标: [Math.round(s.x), Math.round(s.y)],
      模式: box.firstElementChild ? box.firstElementChild.getAttribute('data-mode') : null,
      列出件数: pieces.length,
      期望件数: goods[s.id].items.length,
      条目: pieces.map(p => p.textContent.replace(/\\d+$/, '').trim()),
      图标全加载: pieces.filter(p => p.querySelector('img'))
        .every(p => p.querySelector('img').naturalWidth > 0),
      有价格: pieces.some(p => p.querySelector('.ae-price'))
    }
  })

  /* ---- 5. 单件卡有「去哪买」 ---- */
  R['5_去哪买'] = await page.evaluate(async () => {
    const AE = window.ArmorEnhance
    /* 找一件已归店的 */
    const goods = AE.shopGoods()
    let key = null, 店 = null
    Object.keys(goods).forEach(k => {
      if (!key && goods[k].items.length) { key = goods[k].items[0].key; 店 = goods[k].shop.name }
    })
    if (!key) return { 跳过: '没有归店样本' }
    const A = window.TOTK_ARMORS.find(a => a.key === key)
    const box = document.createElement('div')
    box.innerHTML = AE.blockFor(A.name)
    document.body.appendChild(box)
    await new Promise(r => setTimeout(r, 400))
    const el = box.firstElementChild
    const r = {
      防具: A.name,
      期望店: 店,
      有去哪买行: /去哪买/.test(el.textContent),
      有跳转按钮: !!el.querySelector('[data-goto-pt]'),
      按钮文字: (el.querySelector('[data-goto-pt]') || {}).textContent,
      去哪买: (() => {
        const rs = [...el.querySelectorAll('.ae-row')]
        const row = rs.find(x => (x.querySelector('.ae-l') || {}).textContent === '去哪买')
        return row ? (row.querySelector('.ae-v') || {}).textContent : null
      })()
    }
    el.remove()
    return r
  })

  /* ---- 6. 归店阈值：不硬塞远距离的 ---- */
  R['6_阈值'] = await page.evaluate(() => {
    const AE = window.ArmorEnhance
    const goods = AE.shopGoods()
    const names = []
    Object.keys(goods).forEach(k => goods[k].items.forEach(a => names.push(a.name)))
    /* 怪物面罩距最近的店 2063 单位，阈值 200 → 绝不该出现 */
    const 怪物面罩 = names.filter(n => /面罩/.test(n) && /莫力布林|蜥蜴战士|莱尼尔|霍拉布林/.test(n))
    /* 格鲁德小镇那 11 件已有逐件标点 → 绝不该被塞进店 */
    const 格鲁德 = names.filter(n => /热沙|宝石|耳坠|沙地靴|雪地靴/.test(n))
    return {
      归店总数: names.length,
      归店清单: names,
      错误归入的面罩: 怪物面罩,
      重复归入的格鲁德件: 格鲁德
    }
  })

  /* ---- 汇总 ---- */
  const fails = []
  const g1 = R['1_gotoMarker'] || {}
  if (g1.找不到标点 || g1.没有按钮) fails.push('gotoMarker 测试装置有问题')
  else {
    if (g1.地图移动距离 < 1) fails.push(`点跳转后地图没动（移动 ${g1.地图移动距离}px）`)
    if (!g1.现在已勾选) fails.push(`跳转后目标分类 ${g1.目标分类} 仍没勾上（会飞到空白）`)
    if (!g1.有闪烁高亮) fails.push('目标 marker 没有闪烁高亮')
  }

  const g2 = R['2_同套跳转'] || {}
  if (!g2.跳过) {
    if (g2.地图移动 < 1) fails.push(`点同套部件后地图没动（${g2.点的是}，移动 ${g2.地图移动}px）`)
    if (!g2.有高亮) fails.push('同套跳转没有高亮')
    if (!g2.切过去了) fails.push(`同套跳转后卡片没切（现显示 ${g2.现在显示}）`)
  }

  const g3 = R['3_关联任务跳转'] || {}
  if (!g3.跳过 && g3.任务名) {
    if (!g3.任务卡片打开) fails.push('关联任务没打开任务卡片')
    /* 地图动没动取决于该任务在地图上有没有标点，不做硬断言，只提示 */
  }

  const g4 = R['4_商店聚合'] || {}
  if (!g4.跳过) {
    if (g4.模式 !== 'shop') fails.push(`防具店模式应为 shop，实际 ${g4.模式}`)
    if (!g4.列出件数) fails.push('防具店卡片没列出任何商品')
    if (g4.列出件数 !== g4.期望件数) fails.push(`列出 ${g4.列出件数} 件，应为 ${g4.期望件数} 件`)
    if (!g4.图标全加载) fails.push('店内商品图标没加载')
  }

  const g5 = R['5_去哪买'] || {}
  if (!g5.跳过) {
    if (!g5.有去哪买行) fails.push(`单件卡（${g5.防具}）没有「去哪买」行`)
    if (!g5.有跳转按钮) fails.push('「去哪买」没有可点按钮')
  }

  const g6 = R['6_阈值'] || {}
  if (g6.错误归入的面罩 && g6.错误归入的面罩.length) {
    fails.push(`怪物面罩被错误归入防具店：${g6.错误归入的面罩.join(' ')}（距店2063单位，超阈值）`)
  }
  if (g6.重复归入的格鲁德件 && g6.重复归入的格鲁德件.length) {
    fails.push(`已有逐件标点的被重复塞进店：${g6.重复归入的格鲁德件.join(' ')}`)
  }
  if (g6.归店总数 !== 15) fails.push(`归店 ${g6.归店总数} 件，应为 15`)

  console.log(JSON.stringify(R, null, 1))
  console.log('\n' + JSON.stringify({
    错误: [...new Set(errs)].slice(0, 5),
    失败项: fails,
    归店: g6.归店总数,
    摘要: '地图定位/自动勾选/闪烁高亮/同套跳转/关联任务跳转/商店聚合/阈值不硬塞'
  }, null, 1))

  await browser.close()
})()