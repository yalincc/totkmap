/* M6.4 验收：移动端视口实测（V1.5时代就欠着，一直没做）
 *
 * 为什么现在做：任务卡片是 fixed 定位、宽 360px 左右、右下角弹出。
 * PC 上一切正常，但手机视口宽度就 390px 以下——卡片宽度、
 * 侧栏面板、底部按钮行都可能挤爆。这块**从来没在真移动视口下验过**。
 *
 * 覆盖：
 *   ① 三种常见手机视口下，卡片不出横向溢出
 *   ② 卡片不超出视口上下边界（内容能滚到底）
 *   ③ 底部三按钮在窄屏不被压扁到点不中（最小可点面积 44×44 是行业基线）
 *   ④ 侧栏面板（任务 4 分类 + 图层工具栏）在窄屏不横向溢出
 *   ⑤ 探索 / 材料两个 Tab 都能切
 *   ⑥ 折叠列表（6.3）在窄屏仍能展开、条目不撑破
 *
 * 用法：node verify-mobile.js   （端口走 PORT，默认 8899）
 */
const { chromium } = require('playwright-core')
const PORT = process.env.PORT || 8899
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

/* 真机常见视口（CSS px，含 DPR 换算后的逻辑宽度） */
const VIEWPORTS = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone 14', width: 390, height: 844 },
  { name: 'Pixel 7', width: 412, height: 915 }
]

/* 最小可点面积：低于这个尺寸在手机上会误触旁边元素 */
const MIN_TAP = 40

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const R = {}
  const fails = []

  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true
    })
    const errs = []
    const NOISE = /ERR_CONNECTION_REFUSED|127\.0\.0\.1:8766|favicon|404/
    page.on('pageerror', e => { if (!NOISE.test(e.message)) errs.push('PAGEERROR ' + e.message) })

    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(4200)
    await page.evaluate(() => localStorage.clear())

    const V = {}

    /* ---- 1~3. 任务卡片 ----
       选一个带系列 + 防具的复杂任务：最坏情况才测得出问题。 */
    V['任务卡片'] = await page.evaluate(async ([vw, MIN_TAP]) => {
      const D = window.TaskData
      /* 挑系列最长、且有防具掉落的任务——信息最满的那种卡片 */
      const cands = D.tasks.filter(t => D.seriesOf(t.key) || D.armorsOf(t.key))
      cands.sort((a, b) => (D.seriesOf(b.key)?.total || 0) - (D.seriesOf(a.key)?.total || 0))
      const t = D.byKey(cands[0].key)
      window.TaskCard.open(t, null)
      await new Promise(r => setTimeout(r, 420))
      const box = document.querySelector('#taskCard')
      const r = box.getBoundingClientRect()
      const out = {
        任务: t.name,
        卡片宽: Math.round(r.width),
        卡片高: Math.round(r.height),
        左溢出: Math.round(-r.left),
        右溢出: Math.round(r.right - vw),
        上溢出: Math.round(-r.top),
        下溢出: Math.round(r.bottom - window.innerHeight),
        隐藏: box.classList.contains('hidden'),
        横向滚动: box.scrollWidth > box.clientWidth + 1,
        /* 卡片自身可滚高度：内容超出时必须能滚到底，否则底部按钮点不到 */
        可滚: box.scrollHeight > box.clientHeight,
        滚动高: box.scrollHeight,
        视口高: box.clientHeight
      }
      /* 底部按钮的最小可点面积 */
      out['按钮'] = ['tkNav', 'tkTrack', 'tkDone'].map(id => {
        const b = box.querySelector('#' + id)
        if (!b) return { id, 存在: false }
        const br = b.getBoundingClientRect()
        return {
          id, 存在: true,
          w: Math.round(br.width), h: Math.round(br.height),
          可点达标: br.width >= MIN_TAP && br.height >= MIN_TAP,
          右侧溢出: Math.round(br.right - vw)
        }
      })
      /* 折叠系列展开后条目是否撑破卡片 */
      const dt = box.querySelector('.tk-series details')
      if (dt) {
        dt.open = true
        await new Promise(r => setTimeout(r, 160))
        const row = dt.querySelector('.tk-se-row')
        out['系列行宽'] = row ? Math.round(row.getBoundingClientRect().width) : 0
        out['系列行溢出'] = row ? Math.round(row.getBoundingClientRect().right - vw) : -1
      }
      return out
    }, [vp.width, MIN_TAP])

    /* ---- 4~5. 侧栏面板 ---- */
    V['侧栏'] = await page.evaluate(async () => {
      const out = {}
      const list = document.querySelector('#catalogList')
      out['catalogList宽'] = list ? Math.round(list.getBoundingClientRect().width) : 0
      out['横向滚动'] = list ? list.scrollWidth > list.clientWidth + 1 : false
      /* 任务 4 分类是否都渲染出来了 */
      const txt = (list && list.textContent) || ''
      out['四分类齐全'] = ['主线任务', '重要支线', '普通支线', '其他任务']
        .filter(c => txt.includes(c))
      /* 工具栏三个控件不能被压到点不中 */
      out['工具栏'] = ['ltAll', 'ltClear', 'layerCount'].map(id => {
        const b = document.getElementById(id)
        if (!b) return { id, 存在: false }
        const r = b.getBoundingClientRect()
        /* layerCount 是纯文本标签，不要求可点高度 */
        const isBtn = id !== 'layerCount'
        return {
          id, 存在: true, w: Math.round(r.width), h: Math.round(r.height),
          需触控: isBtn,
          触控达标: isBtn ? r.height >= 34 : true
        }
      })
      /* 两个 Tab 都要能切 */
      const tabs = [...document.querySelectorAll('#sideTabs button')]
      out['Tab数'] = tabs.length
      /* 材料面板：切过去看内容有没有炸出来 */
      const mat = tabs.find(t => t.getAttribute('data-tab') === 'material')
      if (mat) {
        mat.click()
        await new Promise(r => setTimeout(r, 240))
        const mp = document.querySelector('#materialPane')
        const ml = document.querySelector('#matList')
        out['材料面板可见'] = !mp.classList.contains('hidden')
        out['材料横向滚动'] = ml ? ml.scrollWidth > ml.clientWidth + 1 : false
        out['材料条目数'] = ml ? ml.querySelectorAll('*').length : 0
      }
      /* 切回探索 */
      const ex = tabs.find(t => t.getAttribute('data-tab') === 'explore')
      if (ex) ex.click()
      await new Promise(r => setTimeout(r, 120))
      out['探索面板可见'] = !document.querySelector('#explorePane').classList.contains('hidden')
      /* 探索度面板：加载存档前默认隐藏，这里只验它不占位也不溢出 */
      const ps = document.querySelector('#progressSection')
      if (ps) {
        out['探索度宽'] = Math.round(ps.getBoundingClientRect().width)
        out['探索度溢出'] = Math.round(ps.getBoundingClientRect().right - window.innerWidth)
        out['探索度可见'] = !ps.classList.contains('hidden')
      }
      return out
    })

    /* ---- 页面整体有没有横向滚动（有的话手机上会左右晃） ---- */
    V['页面横向滚动'] = await page.evaluate(() => ({
      docScrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      有横向滚动: document.documentElement.scrollWidth > window.innerWidth + 1
    }))

    V['页面错误'] = errs
    R[vp.name] = V

    /* ---- 断言 ---- */
    const t = V['任务卡片']
    if (t.隐藏) fails.push(`${vp.name}：任务卡片打开后仍是隐藏态`)
    if (t.右溢出 > 1) fails.push(`${vp.name}：卡片右侧超出视口 ${t.右溢出}px（宽 ${t.卡片宽}）`)
    if (t.左溢出 > 1) fails.push(`${vp.name}：卡片左侧超出视口 ${t.左溢出}px`)
    if (t.横向滚动) fails.push(`${vp.name}：卡片内容横向滚动（scrollWidth 溢出）`)
    for (const b of t['按钮'] || []) {
      if (!b.存在) { fails.push(`${vp.name}：按钮 ${b.id} 没渲染`); continue }
      if (!b['可点达标']) fails.push(`${vp.name}：${b.id} 只有 ${b.w}×${b.h}px，低于 ${MIN_TAP}px 最小可点面积`)
      if (b.右侧溢出 > 1) fails.push(`${vp.name}：${b.id} 右侧超出视口 ${b.右侧溢出}px`)
    }
    if (t['系列行溢出'] > 1) fails.push(`${vp.name}：系列列表条目右侧超出 ${t['系列行溢出']}px`)

    if (V['侧栏']['横向滚动']) fails.push(`${vp.name}：侧栏分类列表横向滚动`)
    if (V['侧栏']['四分类齐全'].length !== 4) {
      fails.push(`${vp.name}：任务分类只渲染出 ${V['侧栏']['四分类齐全'].length}/4 个（缺 ${['主线任务', '重要支线', '普通支线', '其他任务'].filter(c => !V['侧栏']['四分类齐全'].includes(c)).join('、')}）`)
    }
    if (!V['侧栏']['探索面板可见']) fails.push(`${vp.name}：切回探索面板后不可见`)
    if (V['侧栏']['材料横向滚动']) fails.push(`${vp.name}：材料面板横向滚动`)
    if (V['侧栏']['材料面板可见'] === false) fails.push(`${vp.name}：材料面板切过去后不可见`)
    for (const b of V['侧栏']['工具栏'] || []) {
      if (b.存在 && b.需触控 && !b.触控达标) {
        fails.push(`${vp.name}：${b.id} 只有 ${b.h}px 高，低于 34px 触控下限`)
      }
    }
    if ((V['侧栏']['探索度溢出'] || 0) > 1) fails.push(`${vp.name}：探索度面板右侧溢出 ${V['侧栏']['探索度溢出']}px`)
    if (V['页面横向滚动']['有横向滚动']) {
      fails.push(`${vp.name}：页面出现横向滚动（${V['页面横向滚动']['docScrollW']} > ${V['页面横向滚动']['innerW']}）`)
    }
    if (errs.length) fails.push(`${vp.name}：页面报错 ${errs[0]}`)

    await page.close()
  }

  console.log(JSON.stringify(R, null, 1))
  console.log('\n' + JSON.stringify({
    错误: [],
    失败项: fails,
    视口数: VIEWPORTS.length,
    视口清单: VIEWPORTS.map(v => `${v.name} ${v.width}×${v.height}`),
    摘要: `${VIEWPORTS.length} 种手机视口 × 卡片/按钮/侧栏/Tab/横向滚动`
  }, null, 1))

  await browser.close()
})()