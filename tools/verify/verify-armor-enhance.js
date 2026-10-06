/* M6.6 验收：防具信息增强（不新增 Tab，在探索卡片上补信息）
 *
 * ★ 这轮的方向修正是关键：M6.5 我另开了一个「防具」Tab 做图标网格，
 *   老大指出防具在地图上本来就有图标、点图标就打开探索卡片，
 *   应该「在原有防具卡片上完善信息」。
 *
 * 关注点：
 *   ① 地图防具标点能否被增强模块识别（名字全等 / 套装统称 / 无匹配）
 *   ② 单件模式：图标+部位/防御+售价/强化摘要/同套/关联任务/说明
 *   ③ 套装统称模式：列出同套成员
 *   ④ 非防具标点（神庙/塔/材料点）**不出现防具区块**，且卡片外观不变
 *   ⑤ 强化摘要要短（不铺 5 行材料），图鉴外链只留位不实现
 *   ⑥ 关联任务 → 打开任务卡片
 *   ⑦ 同套部件 → 跳到该件的地图标点
 *   ⑧ 任务卡片的防具图标 → 跳到地图标点（不再另开卡片）
 *   ⑨ 没有防具 Tab 了（侧栏仍是 2 个）
 *
 * 用法：node verify-armor-enhance.js   （端口走 PORT，默认 8899）
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
  await page.waitForTimeout(4500)
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4500)

  const R = {}

  /* ---- 0. 前置 ---- */
  R['0_环境'] = await page.evaluate(() => {
    const C = window.TOTK_CATALOGS || []
    const M = window.TOTK_MARKERS || []
    const armorCats = C.filter(c => c && c.group === '位置' && /^防具/.test(c.name))
    const ids = armorCats.map(c => c.id)
    const pts = M.filter(m => ids.indexOf(m.cat) >= 0)
    /* 按增强模块分类：单件 / 套装统称 / 无匹配 */
    const AE = window.ArmorEnhance
    const byMode = { one: [], set: [], miss: [] }
    pts.forEach(p => {
      const h = AE.match((p.name || '').trim())
      if (!h) byMode.miss.push(p.name)
      else if (h.armor) byMode.one.push(p.name)
      else byMode.set.push(p.name)
    })
    return {
      防具分类: armorCats.map(c => `L${c.layer}:${c.name}=${c.count}`),
      标点总数: pts.length,
      ArmorEnhance已加载: typeof AE === 'object',
      单件: byMode.one.length,
      套装统称: byMode.set.length,
      无匹配: byMode.miss.length,
      无匹配清单: byMode.miss.slice(0, 8),
      侧栏Tab数: document.querySelectorAll('#sideTabs button').length,
      有防具Tab: !!document.querySelector('#sideTabs button[data-tab="armor"]'),
      有防具面板: !!document.getElementById('armorPane'),
      有旧防具卡片: !!document.getElementById('armorCard'),
      有增强容器: !!document.getElementById('ecArmor')
    }
  })

  /* ---- 1. 抽一个单件标点看卡片 ---- */
  R['1_单件'] = await page.evaluate(async () => {
    const M = window.TOTK_MARKERS || []
    const C = window.TOTK_CATALOGS || []
    const AE = window.ArmorEnhance
    const ids = C.filter(c => c && c.group === '位置' && /^防具/.test(c.name)).map(c => c.id)
    /* 挑一件「可强化 + 有同套 + 有关联任务」的，最能暴露问题 */
    const cands = M.filter(m => {
      if (ids.indexOf(m.cat) < 0) return false
      const h = AE.match((m.name || '').trim())
      return h && h.armor && h.armor.reqTasks && h.armor.reqTasks.length
        && AE.upgradeOf(h.armor).upgradeable
    })
    if (!cands.length) return { 跳过: '没有同时满足条件的样本' }
    const pt = cands[0]
    if (!pt) return { 跳过: '没有同时满足条件的样本' }
    const ptName = pt.name
    const html = AE.blockFor(ptName)
    const box = document.createElement('div')
    box.innerHTML = html
    const el = box.firstElementChild
    if (!el) return { 跳过: '没渲染出区块' }
    document.body.appendChild(el)
    /* ★ 必须等图加载完再读 naturalWidth —— 刚插入 DOM 的那一刻
       浏览器还在拉资源，读出来必然是 0，看着像破图。 */
    await new Promise(r => setTimeout(r, 600))
    const txt = el.textContent
    const r = el.getBoundingClientRect()
    const out = {
      标点名: pt.name,
      模式: el.getAttribute('data-mode'),
      有图标: !!el.querySelector('.ae-ic'),
      图标加载: (() => {
        const i = el.querySelector('.ae-ic')
        return i ? i.naturalWidth > 0 : false
      })(),
      有名字: !!el.querySelector('.ae-n'),
      有部位套装: !!el.querySelector('.ae-s'),
      有防御行: /防御/.test(txt),
      有售价行: /售价/.test(txt),
      有强化行: /强化/.test(txt),
      强化摘要够短: txt.length < 400,
      强化提到满级: /满级|不可强化/.test(txt),
      有满级箭头: !!el.querySelector('.ae-arrow'),
      同套数: el.querySelectorAll('.ae-sib').length,
      关联任务数: el.querySelectorAll('.ae-task').length,
      有说明: /说明/.test(txt),
      图鉴位存在: !!el.querySelector('.ae-comp-slot'),
      图鉴位为空: (el.querySelector('.ae-comp-slot') || {}).childElementCount === 0,
      区块高: Math.round(r.height),
      文字长度: txt.length
    }
    el.remove()
    return out
  })

  /* ---- 2. 套装统称 ---- */
  R['2_套装统称'] = await page.evaluate(async () => {
    const M = window.TOTK_MARKERS || []
    const C = window.TOTK_CATALOGS || []
    const AE = window.ArmorEnhance
    const ids = C.filter(c => c && c.group === '位置' && /^防具/.test(c.name)).map(c => c.id)
    const pt = M.filter(m => {
      if (ids.indexOf(m.cat) < 0) return false
      const h = AE.match((m.name || '').trim())
      return h && !h.armor
    })[0]
    if (!pt) return { 跳过: '没有套装统称样本' }
    const box = document.createElement('div')
    box.innerHTML = AE.blockFor(pt.name)
    const el = box.firstElementChild
    document.body.appendChild(el)
    await new Promise(r => setTimeout(r, 300))
    const r = {
      标点名: pt.name,
      模式: el.getAttribute('data-mode'),
      成员数: el.querySelectorAll('.ae-piece').length,
      成员图标全加载: [...el.querySelectorAll('.ae-piece img')].every(i => i.naturalWidth > 0),
      区块高: Math.round(el.getBoundingClientRect().height)
    }
    el.remove()
    return r
  })

  /* ---- 3. 真实点击地图标点 → 卡片带防具区块 ---- */
  R['3_点标点'] = await page.evaluate(async () => {
    const M = window.TOTK_MARKERS || []
    const C = window.TOTK_CATALOGS || []
    const AE = window.ArmorEnhance
    const ids = C.filter(c => c && c.group === '位置' && /^防具/.test(c.name)).map(c => c.id)
    const pt = M.filter(m => {
      if (ids.indexOf(m.cat) < 0) return false
      const h = AE.match((m.name || '').trim())
      return h && h.armor
    })[0]
    if (!pt) return { 跳过: '没有单件样本' }
    /* 走 app.js 的正规入口 openDetail，而不是直接调 blockFor */
    window.TOTK.openDetail(pt, null)
    await new Promise(r => setTimeout(r, 420))
    const card = document.getElementById('exploreCard')
    const box = document.getElementById('ecArmor')
    return {
      标点名: pt.name,
      卡片打开: !card.classList.contains('hidden'),
      chip: (document.querySelector('#ecChip') || {}).textContent,
      区块有内容: !!(box && box.innerHTML.trim()),
      模式: box && box.firstElementChild ? box.firstElementChild.getAttribute('data-mode') : null,
      /* exploreCard 的原有字段必须都还在 */
      原有字段完好: {
        区域: !!document.getElementById('ecRegion').closest('.ec-row'),
        塔域: !!document.getElementById('ecTower').closest('.ec-row'),
        坐标: !!document.getElementById('ecCoord').closest('.ec-row'),
        导航按钮: !!document.getElementById('ecNav'),
        自动导航按钮: !!document.getElementById('ecAuto'),
        标记完成按钮: !!document.getElementById('ecDone'),
        复制按钮: !!document.getElementById('ecCopy')
      }
    }
  })

  /* ---- 4. 非防具标点不该出现防具区块 ---- */
  R['4_非防具'] = await page.evaluate(async () => {
    const M = window.TOTK_MARKERS || []
    /* 挑一个神庙（非防具分类） */
    const shrine = M.find(m => {
      const c = (window.TOTK_CATALOGS || []).filter(x => x.id === m.cat)[0]
      return c && !/^防具/.test(c.name) && c.group === '位置'
    })
    if (!shrine) return { 跳过: '没有非防具样本' }
    window.TOTK.openDetail(shrine, null)
    await new Promise(r => setTimeout(r, 380))
    const box = document.getElementById('ecArmor')
    const card = document.getElementById('exploreCard')
    return {
      标点名: shrine.name,
      卡片打开: !card.classList.contains('hidden'),
      防具区块空: !box || !box.innerHTML.trim(),
      /* :empty 生效 → display:none，不占任何高度 */
      区块不占位: box ? getComputedStyle(box).display === 'none' : true,
      区块高: box ? Math.round(box.getBoundingClientRect().height) : 0
    }
  })

  /* ---- 5. 关联任务 → 任务卡片 ---- */
  R['5_关联任务'] = await page.evaluate(async () => {
    const M = window.TOTK_MARKERS || []
    const C = window.TOTK_CATALOGS || []
    const AE = window.ArmorEnhance
    const ids = C.filter(c => c && c.group === '位置' && /^防具/.test(c.name)).map(c => c.id)
    const pt = M.filter(m => {
      if (ids.indexOf(m.cat) < 0) return false
      const h = AE.match((m.name || '').trim())
      return h && h.armor && h.armor.reqTasks && h.armor.reqTasks.length
    })[0]
    if (!pt) return { 跳过: '没有带关联任务的样本' }
    window.TOTK.openDetail(pt, null)
    await new Promise(r => setTimeout(r, 400))
    const btn = document.querySelector('#ecArmor .ae-task')
    if (!btn) return { 跳过: '区块里没有关联任务按钮' }
    const 任务名 = btn.textContent
    btn.click()
    await new Promise(r => setTimeout(r, 480))
    const tc = document.getElementById('taskCard')
    return {
      任务名,
      任务卡片已打开: tc && !tc.classList.contains('hidden'),
      任务卡片含该名: tc ? tc.textContent.includes(任务名) : false,
      探索卡片仍开着: !document.getElementById('exploreCard').classList.contains('hidden')
    }
  })

  /* ---- 6. 同套部件 → 跳地图标点 ---- */
  R['6_同套跳转'] = await page.evaluate(async () => {
    const M = window.TOTK_MARKERS || []
    const C = window.TOTK_CATALOGS || []
    const AE = window.ArmorEnhance
    const ids = C.filter(c => c && c.group === '位置' && /^防具/.test(c.name)).map(c => c.id)
    /* 任意一个单件样本（用来验同套跳转） */
    const pt = M.filter(m => {
      if (ids.indexOf(m.cat) < 0) return false
      const h = AE.match((m.name || '').trim())
      return h && h.armor
    })[0]
    if (!pt) return { 跳过: '没有样本' }
    window.TOTK.openDetail(pt, null)
    await new Promise(r => setTimeout(r, 400))
    const btn = document.querySelector('#ecArmor .ae-sib')
    if (!btn) return { 跳过: '该件没有同套按钮' }
    const 点的是 = btn.textContent
    btn.click()
    await new Promise(r => setTimeout(r, 480))
    const nameEl = document.querySelector('#ecArmor .ae-n')
    return {
      起点: pt.name,
      点的是,
      现在显示: nameEl ? nameEl.textContent : null,
      切过去了: nameEl ? nameEl.textContent === 点的是 : false,
      卡片仍开着: !document.getElementById('exploreCard').classList.contains('hidden')
    }
  })

  /* ---- 7. 任务卡片防具图标 → 跳地图标点 ---- */
  R['7_任务卡片联动'] = await page.evaluate(async () => {
    const D = window.TaskData
    const t = D.tasks.find(x => D.armorsOf(x.key) && D.armorsOf(x.key).groups.length)
    if (!t) return { 跳过: '没有带防具的任务' }
    window.TaskCard.open(t, null)
    await new Promise(r => setTimeout(r, 420))
    const ic = document.querySelector('#taskCard .tk-ar-ic[data-go-armor]')
    if (!ic) return { 跳过: '任务卡片没有可点的防具图标' }
    const key = ic.getAttribute('data-go-armor')
    ic.click()
    await new Promise(r => setTimeout(r, 520))
    const ec = document.getElementById('exploreCard')
    const box = document.getElementById('ecArmor')
    return {
      任务: t.name,
      点的防具key: key,
      /* 要么跳到了标点（探索卡片开着且带防具区块），
         要么给出「地图上没单独标点」的提示（商店防具就是这样） */
      探索卡片开着: ec && !ec.classList.contains('hidden'),
      防具区块有内容: !!(box && box.innerHTML.trim()),
      toast: (document.getElementById('toast') || {}).textContent || ''
    }
  })

  /* ---- 汇总 ---- */
  const fails = []
  const e = R['0_环境'] || {}
  if (!e.ArmorEnhance已加载) fails.push('ArmorEnhance 未加载')
  if (e.有防具Tab) fails.push('侧栏还有防具 Tab（应该撤掉了）')
  if (e.有防具面板) fails.push('还有 armorPane（应该撤掉了）')
  if (e.有旧防具卡片) fails.push('还有独立 armorCard（应该撤掉了）')
  if (!e.有增强容器) fails.push('exploreCard 里没有 #ecArmor 容器')
  if (e.侧栏Tab数 !== 2) fails.push(`侧栏 Tab 数 ${e.侧栏Tab数}，应为 2（探索 + 材料）`)
  if (!e.标点总数) fails.push('地图上一个防具标点都找不到')
  if (e.单件 === 0) fails.push('单件匹配数为 0 —— 名字匹配器坏了')

  const s1 = R['1_单件']
  if (!s1.跳过) {
    for (const k of ['有图标', '有名字', '有部位套装', '有防御行', '有售价行', '有强化行', '有说明']) {
      if (!s1[k]) fails.push(`单件卡缺「${k}」（样本 ${s1.标点名}）`)
    }
    if (!s1.图标加载) fails.push('单件卡图标没加载')
    if (!s1.强化摘要够短) fails.push(`强化区文字 ${s1.文字长度} 字，太长了应该外链 totk-site`)
    if (!s1.强化提到满级) fails.push('强化行没提满级防御')
    if (!s1.有满级箭头) fails.push('没显示满级防御箭头')
    if (!s1.同套数) fails.push('没有同套部件链接')
    if (!s1.关联任务数) fails.push('没有关联任务按钮')
    if (!s1.图鉴位存在) fails.push('图鉴外链位缺失')
    if (!s1.图鉴位为空) fails.push('图鉴跳转应先留空不实现')
  }

  const s2 = R['2_套装统称']
  if (!s2.跳过) {
    if (s2.模式 !== 'set') fails.push(`套装统称模式应为 set，实际 ${s2.模式}`)
    if (!s2.成员数) fails.push(`套装统称「${s2.标点名}」没列出成员`)
    if (!s2.成员图标全加载) fails.push('套装成员图标没加载')
  }

  const s3 = R['3_点标点']
  if (!s3.跳过) {
    if (!s3.卡片打开) fails.push('点地图防具标点没打开探索卡片')
    if (!s3.区块有内容) fails.push(`点标点后防具区块是空的（${s3.标点名}）`)
    const f = s3.原有字段完好 || {}
    for (const [k, v] of Object.entries(f)) {
      if (!v) fails.push(`exploreCard 原有字段「${k}」被破坏了`)
    }
  }

  const s4 = R['4_非防具']
  if (!s4.跳过) {
    if (!s4.防具区块空) fails.push(`非防具标点「${s4.标点名}」也出现了防具区块`)
    if (!s4.区块不占位) fails.push('非防具标点的防具区块仍占高度（:empty 没生效）')
    if (s4.区块高 > 0) fails.push(`非防具时区块高 ${s4.区块高}px，应该为 0`)
  }

  const s5 = R['5_关联任务']
  if (!s5.跳过 && s5.任务名) {
    if (!s5.任务卡片已打开) fails.push(`点关联任务「${s5.任务名}」没打开任务卡片`)
    if (!s5.任务卡片含该名) fails.push('任务卡片内容不是那个任务')
    if (!s5.探索卡片仍开着) fails.push('跳任务卡片时探索卡片被关掉了')
  }

  const s6 = R['6_同套跳转']
  if (!s6.跳过 && !s6.跳过) {
    if (!s6.切过去了) fails.push(`点同套部件「${s6.点的是}」没切过去（现在显示 ${s6.现在显示}）`)
    if (!s6.卡片仍开着) fails.push('同套跳转后卡片被关掉了')
  }

  const s7 = R['7_任务卡片联动']
  if (!s7.跳过 && !s7.任务) {
    if (!s7.探索卡片开着 && !/没有单独标点/.test(s7.toast)) {
      fails.push('点任务卡片的防具图标，既没跳标点也没给提示')
    }
  }

  console.log(JSON.stringify(R, null, 1))
  console.log('\n' + JSON.stringify({
    错误: [...new Set(errs)].slice(0, 5),
    失败项: fails,
    单件: e.单件,
    套装统称: e.套装统称,
    无匹配: e.无匹配,
    摘要: '标点识别 / 单件卡 / 套装统称 / 非防具不占位 / 关联任务 / 同套跳转 / 任务卡片联动'
  }, null, 1))

  await browser.close()
})()