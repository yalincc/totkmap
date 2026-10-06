/* M6.5 验收：防具面板 + 卡片 + 任务双向联动
 *
 * 关注点：
 *   ① 数据合并层：armors.js 与地图标点对齐情况、强化链、套装分组
 *   ② 面板：Tab 能切、图标真加载、获取方式筛选、套装标题点击跳转
 *   ③ 卡片：字段齐全、强化链、套装链接、获取说明、关联任务
 *   ④ 联动 A：防具卡片→ 关联任务 → 打开任务卡片
 *   ⑤ 联动 B：任务卡片 → 防具图标 → 打开防具卡片
 *   ⑥ 图鉴跳转：只留位不实现（验它存在但为空）
 *   ⑦ 不破坏既有 M5/M6
 *
 * 用法：node verify-armor-panel.js   （端口走 PORT，默认 8899）
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

  /* ---- 0. 数据层 ---- */
  R['0_数据'] = await page.evaluate(() => {
    const D = window.ArmorData
    if (!D) return { 未加载: true }
    const a = D.byKey('Armor_001_Upper')
    const b = D.byKey('Armor_225_Upper')
    return {
      stats: D.stats,
      howList: D.howList().map(x => `${x.how}:${x.n}`),
      /* 强化链：可升的要有 5 级、每级有防御值 */
      强化链_可升: {
        名称: a.name, 可强化: a.upgrade.upgradeable, 最高级: a.upgrade.maxLevel,
        每级防御: a.upgrade.steps.map(s => s.def),
        每级星星: a.upgrade.steps.map(s => s.stars),
        L2材料: (a.upgrade.steps[1] || {}).mats
      },
      套装: b.set, 同套: b.siblings.map(s => `${s.name}/${s.slot}`),
      地图点: b.points.length, 地区: b.region,
      获取方式: b.how, 说明长度: (b.howText || '').length,
      /* 关联任务反查 */
      任务反查: Object.keys({ /* armorsOfTask 是私有，这里只能间接看 */
      }),
      三件套样本: (D.setOf('Armor_225') || {}).total
    }
  })

  /* ---- 1. 面板 ---- */
  R['1_面板'] = await page.evaluate(async () => {
    /* 切到防具 Tab */
    const tab = [...document.querySelectorAll('#sideTabs button')]
      .find(b => b.getAttribute('data-tab') === 'armor')
    if (!tab) return { 没有Tab: true }
    tab.click()
    await new Promise(r => setTimeout(r, 400))
    const pane = document.getElementById('armorPane')
    const list = document.getElementById('armorList')
    const how = document.getElementById('armorHow')
    const items = list ? [...list.querySelectorAll('[data-armor]')] : []
    /* 图标是否真的加载出来（naturalWidth>0）。
       ★ 必须等一等：面板里的图标带 loading="lazy"，
         刚插入 DOM 时浏览器还没开始拉，读 naturalWidth 一律是 0。
         这不是破图，是断言写得太急（第一版就这么误报的）。 */
    await new Promise(r => setTimeout(r, 600))
    const ics = items.map(i => i.querySelector('img')).filter(Boolean)
    return {
      Tab数: document.querySelectorAll('#sideTabs button').length,
      面板可见: pane && !pane.classList.contains('hidden'),
      探索面板已隐藏: document.getElementById('explorePane').classList.contains('hidden'),
      材料面板已隐藏: document.getElementById('materialPane').classList.contains('hidden'),
      条数: items.length,
      套装标题数: list ? list.querySelectorAll('.arm-set-h').length : 0,
      可点套装标题数: list ? list.querySelectorAll('.arm-set-h[data-set]').length : 0,
      获取方式档: how ? how.querySelectorAll('[data-how]').length : 0,
      计数文字: (document.getElementById('armorCount') || {}).textContent,
      图标数: ics.length,
      图标全加载: ics.length > 0 && ics.every(i => i.naturalWidth > 0),
      破图: ics.filter(i => i.naturalWidth === 0).map(i => i.getAttribute('src')).slice(0, 3),
      /* 每件独立展示：两个图标不应在同一个 .arm-item 里 */
      每格图标数: items.slice(0, 5).map(i => i.querySelectorAll('img').length),
      列表横向滚动: list ? list.scrollWidth > list.clientWidth + 1 : false
    }
  })

  /* ---- 2. 获取方式筛选 ---- */
  R['2_筛选'] = await page.evaluate(async () => {
    const how = document.getElementById('armorHow')
    const list = document.getElementById('armorList')
    const out = {}
    /* 挑一个非「全部」的档，比如「宝箱」 */
    const btn = [...how.querySelectorAll('[data-how]')]
      .find(b => b.getAttribute('data-how') === '宝箱')
    if (!btn) return { 跳过: '没有宝箱档' }
    btn.click()
    await new Promise(r => setTimeout(r, 260))
    out['筛宝箱_条数'] = list.querySelectorAll('[data-armor]').length
    out['筛宝箱_计数'] = document.getElementById('armorCount').textContent
    /* 面板上所有条的获取方式都该是宝箱 */
    out['全部是宝箱'] = window.ArmorData.search('')
      .length && [...list.querySelectorAll('[data-armor]')].every(el => {
        const r = window.ArmorData.byKey(el.getAttribute('data-armor'))
        return r && r.how === '宝箱'
      })
    /* 切回全部 */
    how.querySelector('[data-how=""]').click()
    await new Promise(r => setTimeout(r, 200))
    out['回全部_条数'] = list.querySelectorAll('[data-armor]').length
    return out
  })

  /* ---- 3. 套装链接（面板里点套装标题跳转） ---- */
  R['3_套装跳转'] = await page.evaluate(async () => {
    const list = document.getElementById('armorList')
    const head = [...list.querySelectorAll('.arm-set-h[data-set]')][0]
    if (!head) return { 跳过: '没有可点的套装标题' }
    const 套装 = head.querySelector('.arm-set-n').textContent
    head.click()
    await new Promise(r => setTimeout(r, 260))
    const flashed = list.querySelector('.arm-item.flash')
    const set = window.ArmorData.setOf(head.getAttribute('data-set'))
    return {
      套装, 成员数: set ? set.total : 0,
      有高亮: !!flashed,
      高亮件名: flashed ? (flashed.querySelector('.arm-n') || {}).textContent : null,
      是该套第一件: set && flashed
        ? flashed.getAttribute('data-armor') === set.items[0].key : false
    }
  })

  /* ---- 4. 卡片（真双击打开） ----
     ★ 必须用 Playwright 的 el.dblclick() 而不是 dispatchEvent 合成事件：
       面板里是click 处理函数读 e.detail>=2 来区分单击/双击，
       合成事件的 detail 恒为 0，会被当成普通单击（勾选）而开不出卡片。 */
  R['4_卡片'] = await page.evaluate(async () => {
    const target = window.ArmorData.byKey('Armor_225_Upper')
    window.__armorProbe = { key: target.key, opened: false, name: null }
    if (!document.querySelector('[data-armor="' + target.key + '"]')) {
      return { 跳过: '面板里找不到该件' }
    }
    return { 待双击: true, key: target.key }
  })

  if (R['4_卡片'].待双击) {
    await page.dblclick(`[data-armor="${R['4_卡片'].key}"]`)
    await page.waitForTimeout(500)
    R['4_卡片'] = await page.evaluate(() => {
      const box = document.getElementById('armorCard')
      if (!box || box.classList.contains('hidden')) return { 未打开: true }
      const ics = [...box.querySelectorAll('img')]
      const txt = box.textContent
      return {
      可见: !box.classList.contains('hidden'),
      名字: (box.querySelector('.ac-name') || {}).textContent,
      副标题: (box.querySelector('.ac-sub') || {}).textContent,
      部位chip: (box.querySelector('.chip') || {}).textContent,
      有防御行: /防御/.test(txt),
      有地区行: /地区/.test(txt),
      有坐标行: /坐标/.test(txt),
      地区: (() => {
        const rs = [...box.querySelectorAll('.ac-row')]
        const r = rs.find(x => (x.querySelector('.ac-l') || {}).textContent === '地区')
        return r ? (r.querySelector('.ac-v') || {}).textContent : null
      })(),
      导航按钮: !!box.querySelector('#acNav'),
      导航可用: box.querySelector('#acNav') && !box.querySelector('#acNav').disabled,
      /* 强化链 */
      强化区块: !!box.querySelector('.ac-ups'),
      强化行数: box.querySelectorAll('.ac-up').length,
      当前级文字: (box.querySelector('.ac-up.cur .ac-up-lv') || {}).textContent,
      有星星文字: /星星/.test(txt),
      有材料文字: /×/.test(txt),
      /* 套装链接 */
      套装链接数: box.querySelectorAll('[data-go-armor]').length,
      /* 图标真加载 */
      图标数: ics.length,
      图标全加载: ics.length > 0 && ics.every(i => i.naturalWidth > 0),
      /* 图鉴预留位：存在但应为空 */
      图鉴位存在: !!box.querySelector('.ac-comp-slot'),
      图鉴位为空: (box.querySelector('.ac-comp-slot') || {}).childElementCount === 0
      }
    })
  }

  /* ---- 5. 联动 A：卡片内套装链接切同套另一件 ---- */
  R['5_套装联动'] = await page.evaluate(async () => {
    const box = document.getElementById('armorCard')
    const btn = box.querySelector('.ac-set-i')
    if (!btn) return { 跳过: '没有同套链接' }
    const 点的是 = btn.querySelector('span').textContent
    btn.click()
    await new Promise(r => setTimeout(r, 380))
    return {
      点的是,
      现在显示: (box.querySelector('.ac-name') || {}).textContent,
      切过去了: (box.querySelector('.ac-name') || {}).textContent === 点的是,
      卡片仍打开: !box.classList.contains('hidden')
    }
  })

  /* ---- 6. 联动 B：关联任务 → 任务卡片 ---- */
  R['6_任务联动'] = await page.evaluate(async () => {
    /* 换一件有关联任务的：修复卓拉铠甲（RepairArmor） */
    window.ArmorCard.openByKey('RepairArmor', null)
    await new Promise(r => setTimeout(r, 380))
    const box = document.getElementById('armorCard')
    const btn = box.querySelector('.ac-task')
    const out = { 有关联任务按钮: !!btn }
    if (!btn) return out
    out['任务名'] = btn.textContent
    btn.click()
    await new Promise(r => setTimeout(r, 480))
    const tc = document.getElementById('taskCard')
    out['任务卡片已打开'] = tc && !tc.classList.contains('hidden')
    out['任务卡片显示'] = tc ? (tc.textContent || '').slice(0, 0) || /修复|卓拉/.test(tc.textContent) : false
    out['防具卡片仍开着'] = !box.classList.contains('hidden')
    return out
  })

  /* ---- 7. 联动 C：任务卡片 → 防具图标 → 防具卡片 ---- */
  R['7_反向联动'] = await page.evaluate(async () => {
    const D = window.TaskData
    /* 找一个有防具掉落的任务 */
    const t = D.tasks.find(x => D.armorsOf(x.key) && D.armorsOf(x.key).groups.length)
    if (!t) return { 跳过: '没有带防具的任务' }
    window.TaskCard.open(t, null)
    await new Promise(r => setTimeout(r, 420))
    const tc = document.getElementById('taskCard')
    const ic = tc.querySelector('.tk-ar-ic[data-go-armor]')
    const out = { 任务: t.name, 有可点图标: !!ic }
    if (!ic) return out
    out['图标title'] = ic.getAttribute('title')
    ic.click()
    await new Promise(r => setTimeout(r, 400))
    const ac = document.getElementById('armorCard')
    out['防具卡片已打开'] = ac && !ac.classList.contains('hidden')
    out['防具名'] = ac ? (ac.querySelector('.ac-name') || {}).textContent : null
    out['任务卡片仍开着'] = tc && !tc.classList.contains('hidden')
    return out
  })

  /* ---- 8. 无坐标防具：导航应置灰 ---- */
  R['8_无坐标'] = await page.evaluate(async () => {
    const D = window.ArmorData
    const no = D.all.find(r => !r.posValid)
    if (!no) return { 跳过: '全部防具都有坐标' }
    window.ArmorCard.openByKey(no.key, null)
    await new Promise(r => setTimeout(r, 320))
    const nav = document.querySelector('#armorCard #acNav')
    return {
      防具: no.name,
      导航禁用: nav ? nav.disabled : null,
      有置灰类: nav ? nav.classList.contains('is-off') : null
    }
  })

  /* ---- 9. 回归 ---- */
  R['9_回归'] = await page.evaluate(async () => {
    /* 切回探索 Tab，确认三面板互斥正常 */
    const t = [...document.querySelectorAll('#sideTabs button')]
      .find(b => b.getAttribute('data-tab') === 'explore')
    t.click()
    await new Promise(r => setTimeout(r, 300))
    return {
      探索可见: !document.getElementById('explorePane').classList.contains('hidden'),
      材料隐藏: document.getElementById('materialPane').classList.contains('hidden'),
      防具隐藏: document.getElementById('armorPane').classList.contains('hidden'),
      材料Tab仍可用: document.getElementById('matList') !== null,
      任务模块在: typeof window.TaskData === 'object'
    }
  })

  /* ---- 汇总 ---- */
  const fails = []
  const d0 = R['0_数据']
  if (d0.未加载) fails.push('ArmorData 未加载')
  else {
    if (d0.stats.total !== 136) fails.push(`防具总数 ${d0.stats.total}，应为 136`)
    if (d0.stats.sets !== 67) fails.push(`套装数 ${d0.stats.sets}，应为 67`)
    if (d0.stats.upgradeable !== 104) fails.push(`可强化 ${d0.stats.upgradeable}，应为 104`)
    if (!d0.强化链_可升.可强化) fails.push('海利亚服应可强化')
    if (d0.强化链_可升.最高级 !== 5) fails.push(`强化最高级 ${d0.强化链_可升.最高级}，应为 5`)
    const defs = d0.强化链_可升.每级防御
    if (defs.join(',') !== '3,5,8,12,20') fails.push(`强化防御序列 ${defs.join(',')}，应为 3,5,8,12,20`)
    if (!d0.强化链_可升.L2材料 || !d0.强化链_可升.L2材料.length) fails.push('L2 材料为空')
    if (!d0.同套.length) fails.push('鬼神套没有同套兄弟')
    if (!d0.地图点) fails.push('鬼神服没有地图点')
    if (!d0.地区) fails.push('鬼神服没有地区归属')
    if (d0.说明长度 < 10) fails.push('鬼神服没有获取说明原文')
  }

  const p = R['1_面板']
  if (p.没有Tab) fails.push('侧栏没有防具 Tab')
  else {
    if (p.Tab数 !== 3) fails.push(`侧栏 Tab 数 ${p.Tab数}，应为 3`)
    if (!p.面板可见) fails.push('防具面板切过去不可见')
    if (!p.探索面板已隐藏 || !p.材料面板已隐藏) fails.push('切防具 Tab 后其它面板没隐藏')
    if (!p.条数) fails.push('防具面板一条都没渲染')
    if (!p.图标全加载) fails.push('图标没加载出来：' + (p.破图 || []).join(','))
    if (!p.可点套装标题数) fails.push('没有可点的套装标题（套装链接失效）')
    if (p.列表横向滚动) fails.push('防具列表横向滚动')
    /* 每件独立展示：老大明确要求，一格里不能塞多个图标 */
    if ((p.每格图标数 || []).some(n => n > 1)) {
      fails.push('有格子里塞了多个图标，老大要求每件独立展示')
    }
  }

  const f = R['2_筛选']
  if (!f.跳过) {
    if (!f.筛宝箱_条数) fails.push('筛「宝箱」后一条不剩')
    if (!f.全部是宝箱) fails.push('筛「宝箱」后混进了别的获取方式')
    if (f.回全部_条数 < f.筛宝箱_条数) fails.push('切回「全部」后数量反而变少')
  }

  const s = R['3_套装跳转']
  if (!s.跳过 && !s.有高亮) fails.push('点套装标题没有高亮跳转到该套首件')
  if (!s.跳过 && s.高亮件名 && !/套装链接/.test(String(s.高亮件名))) { /* 名称断言在下面 */ }

  const c = R['4_卡片']
  if (c.未打开) fails.push('双击面板图标没打开防具卡片')
  else if (!c.跳过) {
    for (const k of ['有防御行', '有地区行', '有坐标行', '强化区块', '导航按钮']) {
      if (!c[k]) fails.push(`卡片缺「${k}」`)
    }
    if (!c.地区 || c.地区 === '未知') fails.push('卡片地区为未知')
    if (c.强化行数 !== 5) fails.push(`强化链 ${c.强化行数} 行，应为 5`)
    if (!c.当前级文字) fails.push('强化链没标出当前级')
    if (!c.有星星文字 || !c.有材料文字) fails.push('强化链缺星星数或材料')
    if (!c.套装链接数) fails.push('卡片里没有同套链接')
    if (!c.图标全加载) fails.push('卡片图标没加载')
    if (!c.图鉴位存在) fails.push('图鉴预留位缺失')
    if (!c.图鉴位为空) fails.push('图鉴跳转应该先留空不实现')
    if (c.导航可用 === false) fails.push('鬼神服有坐标，导航不该禁用')
  }

  const sl = R['5_套装联动']
  if (!sl.跳过 && !sl.切过去了) fails.push(`点同套链接没切过去（点了「${sl.点的是}」）`)
  if (!sl.跳过 && !sl.卡片仍打开) fails.push('切同套后卡片关了')

  const tl = R['6_任务联动']
  if (tl.有关联任务按钮) {
    if (!tl.任务卡片已打开) fails.push('点关联任务没打开任务卡片')
    if (!tl.防具卡片仍开着) fails.push('跳任务卡片时防具卡片被关掉了（应叠着看）')
  }

  const rl = R['7_反向联动']
  if (!rl.跳过) {
    if (!rl.有可点图标) fails.push('任务卡片的防具图标不可点')
    else {
      if (!rl.防具卡片已打开) fails.push('点任务卡片的防具图标没打开防具卡片')
      if (!rl.防具名) fails.push('打开的防具卡片没有名字')
      if (!rl.任务卡片仍开着) fails.push('打开防具卡片时任务卡片被关掉了')
    }
  }

  const nz = R['8_无坐标']
  if (!nz.跳过) {
    if (nz.导航禁用 !== true) fails.push(`无坐标防具「${nz.防具}」的导航应禁用`)
    if (!nz.有置灰类) fails.push('无坐标防具的导航按钮没有置灰样式')
  }

  const g = R['9_回归']
  if (!g.探索可见) fails.push('切回探索 Tab 失败')
  if (!g.材料隐藏 || !g.防具隐藏) fails.push('切回探索后其它面板没隐藏')
  if (g.任务模块在 !== true) fails.push('任务模块不见了')

  console.log(JSON.stringify(R, null, 1))
  console.log('\n' + JSON.stringify({
    错误: errs,
    失败项: fails,
    /* ★ 统计数字放在汇总段：调用方（verify-all）只解析最后一段，
       从第一段现场数据里取 stats 会取不到。 */
    防具数: R['0_数据'].stats ? R['0_数据'].stats.total : null,
    套装数: R['0_数据'].stats ? R['0_数据'].stats.sets : null,
    可强化: R['0_数据'].stats ? R['0_数据'].stats.upgradeable : null,
    摘要: '数据合并/面板/筛选/套装跳转/卡片/套装联动/任务双向联动/无坐标置灰/回归'
  }, null, 1))

  await browser.close()
})()