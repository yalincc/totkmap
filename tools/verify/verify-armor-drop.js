/* M6.1 验收：任务卡片「本任务可获得」防具区
 * 关注点：
 *   ① armors.js 真被加载了（不加这脚本的话 TOTK_ARMORS 是 undefined，反查全空）
 *   ② 反查命中数对不对，且**低置信度噪声没混进来**
 *      （「卓拉领地的希多」不该挂上「卓拉铠甲」——纯地名巧合）
 *   ③ 「铠甲蘑菇」「铠甲鲷鱼」这类菜名不该被当防具
 *   ④ 图标真的加载出来了（不是 0×0 破图）
 *   ⑤ 有防具的任务显示这一区，没防具的不显示空壳
 *   ⑥ 套装 3 件聚成一条，不占三行
 *   ⑦ 不影响既有 M5/M6 结构
 * 用法：node verify-armor-drop.js    （端口走 PORT，默认 8899）
 */
const { chromium } = require('playwright-core')
const PORT = process.env.PORT || 8899
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

/* [任务key, 期望的套装名数组（空数组=不该有防具区）]
 * ★ 期望值写的是 armors.js 里的官方 set 名，别凭印象写。
 *   例：汀空套装的 set 名就叫「汀空的」（带"的"），这是官方叫法不是 bug。 */
const CASES = [
  ['RepairArmor', ['卓拉']],                    // 同名实指，high
  ['TreasureOfLamda_FierceDeity', ['鬼神']],   // 套装 3 件
  ['Connect_AkkareMaze', ['异次元恶灵']],       // 攻略 reward 精确命中
  ['TreasureOfLamda_Dream', ['织梦之勇者']],
  ['TreasureOfLamda_Gerudo', ['汀空的']],
  /* 萨格诺帽子确实是「萨格诺的秘密」的掉落（armors.js conf=high）。
     同一任务的 guide.reward 里另有「铠甲蘑菇*10」——那是菜名，
     要验的是它没被当成防具列进来（见下面的「没有蘑菇条目」）。 */
  ['Hateno_SecretLifeOfSagono', ['萨格诺']],
  ['SageOfZora', []],      // ★ 噪声：地名撞「卓拉」，必须没有
  ['ZoraStatue_Picture', []], // ★ 同上
  ['Uotori_RevivePlan', []],  // ★ 「铠甲鲷鱼*3」是菜名
  ['AisyaRescue', []]      // 无关任务，本来就没有
]

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

  /* ---- 0. 前置：armors.js 到底加载了没 ---- */
  R['0_数据加载'] = await page.evaluate(() => ({
    armorsLoaded: Array.isArray(window.TOTK_ARMORS),
    armorCount: (window.TOTK_ARMORS || []).length,
    armorsOf可用: typeof (window.TaskData || {}).armorsOf === 'function',
    命中任务数: (window.TaskData ? window.TaskData.tasks : [])
      .filter(t => window.TaskData.armorsOf(t.key)).length
  }))

  /* ---- 1~6. 逐个任务看卡片 ---- */
  R['逐任务'] = {}
  for (const [key, expectSets] of CASES) {
    R['逐任务'][key] = await page.evaluate(async ([k, expect]) => {
      const t = window.TaskData.byKey(k)
      if (!t) return { 找不到: true }
      window.TaskCard.open(t, null)
      await new Promise(r => setTimeout(r, 320))
      const box = document.querySelector('#taskCard')
      const ar = box && box.querySelector('.tk-ar')
      const res = {
        任务名: t.name,
        期望套装: expect,
        有防具区: !!ar,
        实际套装: ar ? [...ar.querySelectorAll('.tk-ar-n')].map(e => e.textContent.trim()) : [],
        分组数: ar ? ar.querySelectorAll('.tk-ar-g').length : 0,
        部位说明: ar ? [...ar.querySelectorAll('.tk-ar-s')].map(e => e.textContent.trim()) : [],
        标题后缀: ar ? (ar.querySelector('.tk-ar-h .tk-src') || {}).textContent : null
      }
      /* 图标必须真的加载出来（naturalWidth>0 才算成功） */
      const ics = ar ? [...ar.querySelectorAll('img.tk-ar-ic')] : []
      res['图标数'] = ics.length
      res['图标全加载'] = ics.length > 0 && ics.every(i => i.naturalWidth > 0)
      res['图标尺寸异常'] = ics.filter(i => i.naturalWidth === 0).map(i => i.getAttribute('src'))
      /* 高度不能塌成一条缝（样式没生效的信号） */
      res['区高度'] = ar ? Math.round(ar.getBoundingClientRect().height) : 0
      return res
    }, [key, expectSets])
  }

  /* ---- 6b. 菜名断言：直接查防具区里有没有蘑菇/鲷鱼这类东西 ----
     「铠甲蘑菇*10」「铠甲鲷鱼*3」都带「铠甲」字样，最容易被误当成防具。
     不能只在任务级断言（因为这些任务本来就有真掉落），
     得逐条看落进防具区的名字。 */
  R['6b_菜名不进防具'] = await page.evaluate(async () => {
    const out = []
    const BAD = /蘑菇|鲷鱼|稠鱼/
    for (const t of window.TaskData.tasks) {
      const a = window.TaskData.armorsOf(t.key)
      if (!a) continue
      for (const g of a.groups) {
        for (const it of g.items) {
          if (BAD.test(it.name)) out.push(`${t.key} → ${it.name}`)
        }
      }
    }
    return { 菜名混入数: out.length, 样例: out.slice(0, 5) }
  })
  if (R['6b_菜名不进防具'].菜名混入数 > 0) {
    fails.push('菜名被当成防具：' + R['6b_菜名不进防具'].样例.join(', '))
  }

  /* ---- 7. 既有结构没被破坏 ---- */
  R['7_回归'] = await page.evaluate(async () => {
    window.TaskCard.open(window.TaskData.byKey('MonsterFigures02'), null)
    await new Promise(r => setTimeout(r, 350))
    const box = document.querySelector('#taskCard')
    return {
      链条区还在: !!box.querySelector('.tk-chain'),
      底部按钮数: box.querySelectorAll('.tk-actions button').length,
      导航按钮: !!box.querySelector('#tkNav'),
      追踪按钮: !!box.querySelector('#tkTrack'),
      完成按钮: !!box.querySelector('#tkDone')
    }
  })

  /* ---- 汇总判定 ---- */
  const fails = []
  const d0 = R['0_数据加载']
  if (!d0.armorsLoaded) fails.push('armors.js 没加载')
  if (!d0.armorsOf可用) fails.push('armorsOf 不存在')
  if (!d0.命中任务数) fails.push('反查命中 0 个任务')

  for (const [key, expect] of CASES) {
    const r = R['逐任务'][key]
    if (r.找不到) { fails.push(`${key}: 找不到任务`); continue }
    if (expect.length === 0) {
      if (r.有防具区) fails.push(`${key}: 噪声未剔除，出现了「${r.实际套装}」`)
      continue
    }
    if (!r.有防具区) { fails.push(`${key}: 该显示防具区但没显示`); continue }
    if (r.实际套装.join() !== expect.join()) {
      fails.push(`${key}: 套装不符，期望 ${expect} 实际 ${r.实际套装}`)
    }
    if (!r.图标全加载) fails.push(`${key}: 图标没加载出来 ${r.图标尺寸异常 || ''}`)
    if (r.区高度 < 40) fails.push(`${key}: 防具区高度异常 ${r.区高度}px（样式可能没生效）`)
  }

  /* 套装应聚成一条，不该三行 */
  const dream = R['逐任务']['TreasureOfLamda_Dream']
  if (dream && dream.分组数 > 1) fails.push(`TreasureOfLamda_Dream: ${dream.分组数} 组，应聚成 1 组`)

  R['失败项'] = fails
  R['错误'] = errs
  R['结论'] = fails.length || errs.length ? 'FAIL' : 'PASS'

  console.log(JSON.stringify(R, null, 1))
  await page.screenshot({ path: 'verify-armor-drop.png' })
  await browser.close()
  process.exit(fails.length || errs.length ? 1 : 0)
})().catch(e => { console.error('FATAL', e); process.exit(1) })
