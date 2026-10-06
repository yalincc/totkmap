/* 验收：file:// 直接打开能不能跑（老大平时就是这么看改动的）
 *
 * 关键前提：Service Worker **只允许在 https 或 localhost 下注册**，
 * file:// 下 navigator.serviceWorker 根本不存在 → 缓存那条路不成立。
 * 但 file:// 还有别的坑（脚本加载、CORS、模块类型），必须实测。
 *
 * 注意：脚本用 file:// 加载时，页面 origin 是 null，
 *   部分 fetch / XHR 会直接被拦，动态 import 也会失败。
 */
const { chromium } = require('playwright-core')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = 'file:///E:/WorkSpace/TOTKmap/app/index.html'

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errs = [], warns = [], reqFail = []
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message.slice(0, 200)))
  page.on('console', m => {
    const t = m.text()
    /* 定位服务没启动时 Chrome 仍会打这条 console error，
       它是「xnavi 没开」的状态，不是页面缺陷。
       ★ 别指望报错文本里带端口号（实测不带）——
         Chrome 只写 "Failed to load resource"，
         端口在 location() 里。所以两个条件都查。 */
    const loc = m.location && m.location()
    const isLocErr = /Failed to load resource|ERR_CONNECTION_REFUSED/.test(t)
      && !!loc && /127\.0\.0\.1:8766|:8766/.test(loc.url)
    if (m.type() === 'error' && !isLocErr) errs.push('CONSOLE ' + t.slice(0, 200))
    else if (m.type() === 'warning') warns.push(t.slice(0, 120))
  })
  page.on('requestfailed', r => reqFail.push(r.url().split('/').pop() + ' ← ' +
    (r.failure() || {}).errorText))

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)

  const R = {}
  R['1_基础环境'] = await page.evaluate(() => ({
    origin: location.origin,
    protocol: location.protocol,
    /* 这条最关键：file:// 下有没有 SW */
    有ServiceWorker: 'serviceWorker' in navigator,
    SW已激活: navigator.serviceWorker ? !!navigator.serviceWorker.controller : false
  }))

  R['2_脚本加载'] = await page.evaluate(() => ({
    核心模块: {
      TOTK: typeof window.TOTK,
      TOTK_APP: typeof window.TOTK_APP,
      TaskData: typeof window.TaskData,
      TaskCard: typeof window.TaskCard,
      ArmorEnhance: typeof window.ArmorEnhance,
      强化数据: typeof window.TOTK_ARMOR_UPGRADE,
      TOTK_ARMORS: typeof window.TOTK_ARMORS,
      TOTK_MARKERS: typeof window.TOTK_MARKERS,
      TOTK_CATALOGS: typeof window.TOTK_CATALOGS,
      TOTK_AREAS: typeof window.TOTK_AREAS,
      Leaflet: typeof window.L
    },
    /* 图标资源能不能加载（file:// 下图片是可以的，但要确认数量） */
    地图图标数: document.querySelectorAll('img').length
  }))

  R['3_地图与面板'] = await page.evaluate(() => {
    const el = document.querySelector('#map')
    const lst = document.querySelector('#catalogList')
    return {
      地图容器: !!el,
      地图高度: el ? Math.round(el.getBoundingClientRect().height) : 0,
      瓦片数: document.querySelectorAll('.leaflet-tile').length,
      探索面板内容长度: lst ? lst.textContent.trim().length : 0,
      侧栏Tab: [...document.querySelectorAll('#sideTabs button')]
        .map(b => b.getAttribute('data-tab')),
      资源面板行数: document.querySelectorAll('#catalogList .group-item, #catalogList .catalog-item').length
    }
  })

  R['4_防具增强'] = await page.evaluate(async () => {
    if (typeof window.ArmorEnhance !== 'object') return { 模块未加载: true }
    const M = window.TOTK_MARKERS, C = window.TOTK_CATALOGS
    const AE = window.ArmorEnhance
    const ids = C.filter(c => c && c.group === '位置' && /^防具/.test(c.name)).map(c => c.id)
    /* 优先挑带关联任务的样本（能顺带验任务跳转那条路） */
    const withTask = M.filter(m => {
      const h = AE.match((m.name || '').trim())
      return ids.indexOf(m.cat) >= 0 && h && h.armor && h.armor.reqTasks && h.armor.reqTasks.length
    })
    const pt = withTask[0] || M.filter(m => {
      const h = AE.match((m.name || '').trim())
      return ids.indexOf(m.cat) >= 0 && h && h.armor
    })[0]
    if (!pt) return { 跳过: '找不到单件样本' }
    window.TOTK.openDetail(pt, null)
    await new Promise(r => setTimeout(r, 700))
    const box = document.getElementById('ecArmor')
    const ics = [...box.querySelectorAll('.ae-ic')]
    return {
      stats: AE.stats(),
      标点名: pt.name,
      防具Tab已撤: !document.querySelector('#sideTabs button[data-tab="armor"]'),
      侧栏Tab数: document.querySelectorAll('#sideTabs button').length,
      旧面板已删: !document.getElementById('armorPane'),
      旧卡片已删: !document.getElementById('armorCard'),
      区块有内容: !!box.innerHTML.trim(),
      模式: box.firstElementChild ? box.firstElementChild.getAttribute('data-mode') : null,
      图标数: ics.length,
      图标全加载: ics.length ? ics.every(i => i.naturalWidth > 0) : false,
      关联任务数: box.querySelectorAll('.ae-task').length,
      同套数: box.querySelectorAll('.ae-sib').length
    }
  })

  R['5_非防具不占位'] = await page.evaluate(async () => {
    const M = window.TOTK_MARKERS, C = window.TOTK_CATALOGS
    const shrine = M.find(m => {
      const c = C.filter(x => x.id === m.cat)[0]
      return c && !/^防具/.test(c.name) && c.group === '位置'
    })
    if (!shrine) return { 跳过: '没有非防具样本' }
    window.TOTK.openDetail(shrine, null)
    await new Promise(r => setTimeout(r, 500))
    const box = document.getElementById('ecArmor')
    return {
      标点名: shrine.name,
      区块空: !box.innerHTML.trim(),
      不占位: getComputedStyle(box).display === 'none',
      区块高: Math.round(box.getBoundingClientRect().height)
    }
  })

  R['6_任务板块'] = await page.evaluate(async () => {
    if (typeof window.TaskData !== 'object') return { 模块未加载: true }
    const D = window.TaskData
    const t = D.byKey('TreasureOfLamda_FierceDeity')
    window.TaskCard.open(t, null)
    await new Promise(r => setTimeout(r, 450))
    const box = document.getElementById('taskCard')
    return {
      '任务数': D.tasks.length,
      '卡片打开': box && !box.classList.contains('hidden'),
      '有防具区': !!(box && box.querySelector('.tk-ar')),
      '有系列区': !!(box && box.querySelector('.tk-series')),
      '图标加载': (() => {
        const i = box && box.querySelector('.tk-ar-ic')
        return i ? i.naturalWidth > 0 : null
      })()
    }
  })

  console.log(JSON.stringify(R, null, 1))
  console.log('\n--- 失败请求 ---')
  console.log(reqFail.length ? reqFail.slice(0, 10).join('\n') : '（无）')
  console.log('\n--- 页面错误 ---')
  console.log(errs.length ? [...new Set(errs)].slice(0, 10).join('\n') : '（无）')

  /* ---- 汇总 ---- */
  const fails = []
  const b = R['2_脚本加载'] || {}
  for (const [k, v] of Object.entries(b.核心模块 || {})) {
    if (v === 'undefined') fails.push(`${k} 未加载（file:// 下脚本可能被拦）`)
  }
  const m = R['3_地图与面板'] || {}
  if (!m.地图容器) fails.push('地图容器不存在')
  if (!m.瓦片数) fails.push('地图瓦片 0 张——瓦片加载失败（可能是 file:// 路径或瓦片缺失）')
  if (!m.探索面板内容长度) fails.push('探索面板空的（分类列表没渲染）')

  const a = R['4_防具增强'] || {}
  if (a.模块未加载) fails.push('ArmorEnhance 未加载')
  else if (!a.跳过) {
    if (!a.防具Tab已撤) fails.push('防具 Tab 还在（应该撤掉了）')
    if (!a.旧面板已删) fails.push('armorPane 还在')
    if (!a.旧卡片已删) fails.push('独立 armorCard 还在')
    if (a.侧栏Tab数 !== 2) fails.push(`侧栏 Tab 数 ${a.侧栏Tab数}，应为 2`)
    if (!a.区块有内容) fails.push('点防具标点后防具区块是空的')
    if (!a.图标全加载) fails.push('防具区块图标没加载')
    if (!a.关联任务数) fails.push('没有关联任务按钮')
  }

  const nz = R['5_非防具不占位'] || {}
  if (!nz.跳过) {
    if (!nz.区块空) fails.push(`非防具标点「${nz.标点名}」也出现防具区块`)
    if (nz.区块高 > 0) fails.push(`非防具时防具区块高 ${nz.区块高}px，应为 0`)
  }

  const t = R['6_任务板块'] || {}
  if (t.模块未加载) fails.push('TaskData 未加载')
  else {
    if (!t['卡片打开']) fails.push('任务卡片打不开')
    if (!t['图标加载']) fails.push('任务卡片里的防具图标没加载')
  }

  /* 只把「非定位服务」的请求失败算作缺陷。
 * 定位服务（live-python/xnavi）没启动时 pos?t=... 连不上是**正常状态**，
 * 不该算页面有问题——否则没开 xnavi 就永远红一片。 */
  const realFails = reqFail.filter(u => !/^pos\?t=/.test(u))
  if (realFails.length) fails.push(`有 ${realFails.length} 个非定位请求失败：${realFails[0]}`)

  console.log('\n' + JSON.stringify({
    错误: [...new Set(errs)].slice(0, 5),
    失败项: fails,
    摘要: 'file:// 直开：脚本加载 / 地图瓦片 / 防具增强 / 任务卡片'
  }, null, 1))

  await browser.close()
})()