/* TOTKmap 任务卡片改造 —— 真实浏览器验收（M5）
 * 验收点：
 *   1. 新脚本是否加载（task-save.js / task-done.js）
 *   2. questDone 在真实存档下能否算出完成态
 *   3. 卡片渲染：任务原文折叠、完成勾、标记完成按钮、追踪按钮、右上角复制
 *   4. 标记完成 → 勾出现 / 取消 → 勾消失（反向操作）
 *   5. 追踪 → 关卡片后流程线仍在地图上（追踪持久化）
 *   6. localStorage 持久化：reload 后手动态还在
 *   7. 控制台零报错
 */
const { chromium } = require('playwright-core')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = `http://127.0.0.1:${process.env.PORT || 8899}/index.html`

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

  const errs = []
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message))
  page.on('console', m => {
    const t = m.text()
    if (m.type() === 'error' && !/ERR_CONNECTION|404|Failed to load resource|net::/.test(t)) {
      errs.push('CERR: ' + t)
    }
  })

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)

  const R = {}

  /* ---- 1. 模块加载 ---- */
  R['1_模块'] = await page.evaluate(() => ({
    taskSave: typeof window.TOTK_TASK_SAVE,
    taskSaveCount: window.TOTK_TASK_SAVE ? Object.keys(window.TOTK_TASK_SAVE).length : 0,
    taskDone: typeof window.TaskDone,
    taskFlow: typeof window.TaskFlow,
    taskCard: typeof window.TaskCard,
    taskData: window.TaskData ? window.TaskData.tasks.length : 0,
    questDoneFn: typeof (window.TOTKSaveParser && window.TOTKSaveParser.questDone),
    doneHash: window.TOTKSaveParser ? window.TOTKSaveParser.questDoneHash() : null
  }))

  /* ---- 2. 拿真实存档喂给解析器（把 ArrayBuffer 传进去） ---- */
  const savPath = process.argv[2]
  if (savPath) {
    const fs = require('fs')
    const b64 = fs.readFileSync(savPath).toString('base64')
    R['2_存档解析'] = await page.evaluate(async (b64) => {
      const bin = atob(b64)
      const buf = new ArrayBuffer(bin.length)
      const u8 = new Uint8Array(buf)
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
      const parsed = window.TOTKSaveParser.parse(buf)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      const qd = window.TOTKSaveParser.questDone(parsed, window.TOTK_TASK_SAVE)
      const keys = Object.keys(qd)
      const doneKeys = keys.filter(k => qd[k].done)
      /* 阶段反查是否正确（不该有 stage='' 的） */
      const noStage = keys.filter(k => !qd[k].stage)
      window.TaskDone.applySave(qd)
      return {
        ok: true,
        version: parsed.version,
        任务数: keys.length,
        已完成数: doneKeys.length,
        已完成: doneKeys.slice(0, 10),
        阶段反查失败数: noStage.length,
        存档态样例: keys.slice(0, 3).map(k => ({ key: k, stage: qd[k].stage, done: qd[k].done }))
      }
    }, b64)
  }

  /* ---- 3. 打开一个「有 key 且存档里已完成」的任务卡片 ---- */
  await page.evaluate(() => {
    const D = window.TaskData
    // 找一个有坐标的、非空 key 的任务
    window.__t = D.tasks.find(t => t.key && t.gx != null && t.onMap) || D.tasks[0]
    window.TaskCard.open(window.__t, { clientX: 400, clientY: 300 })
  })
  await page.waitForTimeout(900)

  R['3_卡片结构'] = await page.evaluate(() => {
    const card = document.getElementById('taskCard')
    if (!card) return { 有卡片: false }
    const cs = getComputedStyle(card)
    return {
      有卡片: !card.classList.contains('hidden'),
      position: cs.position,
      display: cs.display,
      任务名: (card.querySelector('.tk-name') || {}).textContent,
      右上角复制: !!card.querySelector('#tkCopy'),
      复制在标题行: !!card.querySelector('.tk-title-acts #tkCopy'),
      完成勾元素: !!card.querySelector('.tk-done-tick'),
      标记完成按钮: !!card.querySelector('#tkDone'),
      追踪按钮: !!card.querySelector('#tkTrack'),
      底部按钮文字: Array.from(card.querySelectorAll('.tk-actions .btn')).map(b => b.textContent),
      有任务原文折叠: !!card.querySelector('.tk-fold details'),
      折叠标题: (card.querySelector('.tk-fold summary') || {}).textContent,
      折叠默认展开: (function () {
        const d = card.querySelector('.tk-fold details')
        return d ? d.open : null
      })(),
      攻略要点: !!card.querySelector('.tk-sec-t'),
      高度: card.getBoundingClientRect().height
    }
  })

  /* ---- 4b. 打开一个「存档里已完成」的任务，验证不可取消态 ---- */
  await page.evaluate(() => {
    const D = window.TaskData
    const doneKey = Object.keys(window.TOTK_TASK_SAVE).find(k =>
      window.TaskDone.isDone(k) && window.TaskDone.status(k).src === 'save')
    window.__td = D.byKey(doneKey)
    if (window.__td) window.TaskCard.open(window.__td, { clientX: 400, clientY: 300 })
  })
  await page.waitForTimeout(800)
  R['4b_存档已完成的任务'] = await page.evaluate(() => {
    if (!window.__td) return { 说明: '该存档没有已完成任务（正常，取决于游戏进度）' }
    const b = document.getElementById('tkDone')
    return {
      任务名: window.__td.name,
      按钮文案: b ? b.textContent : null,
      按钮禁用: b ? b.disabled : null,
      右上角完成勾: !!document.querySelector('.tk-done-tick'),
      勾样式: (function () {
        const t = document.querySelector('.tk-done-tick')
        if (!t) return null
        const cs = getComputedStyle(t)
        return { display: cs.display, 背景: cs.backgroundColor, 宽: cs.width, 高: cs.height }
      })(),
      有进度行: (function () {
        const rows = Array.from(document.querySelectorAll('.tk-mrow'))
        return rows.some(r => (r.querySelector('.tk-mk') || {}).textContent === '进度')
      })(),
      进度行文案: (function () {
        const rows = Array.from(document.querySelectorAll('.tk-mrow'))
        for (const r of rows) {
          if ((r.querySelector('.tk-mk') || {}).textContent === '进度') {
            return (r.querySelector('.tk-mv') || {}).textContent
          }
        }
        return null
      })()
    }
  })

  /* ---- 4. 标记完成 → 勾出现（用一个未完成任务） ---- */
  await page.evaluate(() => {
    const D = window.TaskData
    window.__t = D.tasks.find(t => t.key && t.gx != null && t.onMap && !window.TaskDone.isDone(t.key)) || D.tasks[0]
    window.TaskCard.open(window.__t, { clientX: 400, clientY: 300 })
  })
  await page.waitForTimeout(800)
  R['4_点标记完成前'] = await page.evaluate(() => ({
    按钮文案: (document.getElementById('tkDone') || {}).textContent,
    按钮禁用: (document.getElementById('tkDone') || {}).disabled,
    完成勾: !!document.querySelector('.tk-done-tick')
  }))

  const btnBox = await page.evaluate(() => {
    const b = document.getElementById('tkDone')
    if (!b || b.disabled) return { disabled: true }
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })
  if (btnBox && btnBox.x) {
    await page.mouse.click(btnBox.x, btnBox.y)
    await page.waitForTimeout(700)
  }
  R['4_标记完成后'] = await page.evaluate(() => {
    const card = document.getElementById('taskCard')
    const key = window.__t.key
    return {
      按钮已禁用: !!(document.getElementById('tkDone') || {}).disabled,
      按钮文案: (document.getElementById('tkDone') || {}).textContent,
      完成勾出现: !!card.querySelector('.tk-done-tick'),
      勾的样式: (function () {
        const t = card.querySelector('.tk-done-tick')
        if (!t) return null
        const cs = getComputedStyle(t)
        return { display: cs.display, 背景: cs.backgroundColor, 宽: cs.width }
      })(),
      TaskDone状态: window.TaskDone.status(key),
      localStorage: !!localStorage.getItem(window.TaskDone.LS_KEY)
    }
  })

  /* ---- 5. 反向操作：取消完成 ---- */
  const btnBox2 = await page.evaluate(() => {
    const b = document.getElementById('tkDone')
    if (!b || b.disabled) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 禁用: b.disabled }
  })
  if (btnBox2) {
    await page.mouse.click(btnBox2.x, btnBox2.y)
    await page.waitForTimeout(700)
  }
  R['5_取消完成后'] = await page.evaluate(() => ({
    按钮文案: (document.getElementById('tkDone') || {}).textContent,
    完成勾消失: !document.querySelector('.tk-done-tick'),
    TaskDone状态: window.TaskDone.status(window.__t.key)
  }))

  /* ---- 6. 追踪：关卡片后流程线是否保留 ---- */
  const trkBox = await page.evaluate(() => {
    const b = document.getElementById('tkTrack')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })
  if (trkBox) {
    await page.mouse.click(trkBox.x, trkBox.y)
    await page.waitForTimeout(800)
  }
  R['6_追踪开启'] = await page.evaluate(() => {
    const btn = document.getElementById('tkTrack')
    return {
      按钮文案: btn ? btn.textContent : null,
      节点数在地图上: document.querySelectorAll('.tkf-node').length,
      isTracking: window.TaskFlow ? window.TaskFlow.isTracking(window.__t.key) : null
    }
  })

  /* 关卡片（Esc，走 keydown 路径，最容易漏） */
  await page.keyboard.press('Escape')
  await page.waitForTimeout(700)
  R['6b_关卡片后'] = await page.evaluate(() => ({
    卡片隐藏: document.getElementById('taskCard').classList.contains('hidden'),
    流程线节点还在: document.querySelectorAll('.tkf-node').length,
    仍在追踪: window.TaskFlow ? window.TaskFlow.isTracking() : null
  }))

  /* ---- 7. 重新打开点追踪应关闭 ---- */
  await page.evaluate(() => {
    window.TaskCard.open(window.__t, { clientX: 400, clientY: 300 })
  })
  await page.waitForTimeout(700)
  const trkBox2 = await page.evaluate(() => {
    const b = document.getElementById('tkTrack')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), 文案: b.textContent }
  })
  R['7_重开卡片'] = { 追踪按钮文案: trkBox2 ? trkBox2.文案 : null }
  if (trkBox2) {
    await page.mouse.click(trkBox2.x, trkBox2.y)
    await page.waitForTimeout(700)
  }
  R['7b_再点追踪后'] = await page.evaluate(() => ({
    流程线节点: document.querySelectorAll('.tkf-node').length,
    仍在追踪: window.TaskFlow ? window.TaskFlow.isTracking() : null
  }))

  /* ---- 8. 手动标记 + reload 持久化 ---- */
  const tkey = await page.evaluate(() => window.__t ? window.__t.key : '')
  await page.evaluate(() => { window.TaskDone.markDone(window.__t.key) })
  await page.waitForTimeout(400)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4500)
  R['8_reload后'] = await page.evaluate((k) => ({
    手动标记仍在: window.TaskDone.isDone(k),
    状态来源: window.TaskDone.status(k).src,
    localStorage有值: !!localStorage.getItem(window.TaskDone.LS_KEY)
  }), tkey)

  /* ---- 9. 遍历全部任务渲染，查 undefined/null 泄漏 ---- */
  R['9_全量渲染'] = await page.evaluate(() => {
    const bad = []
    window.TaskData.tasks.forEach(t => {
      try {
        const h = window.TaskCard.buildHtml ? window.TaskCard.buildHtml(t) : ''
        if (/undefined|NaN|\[object Object\]/.test(h)) {
          bad.push({ key: t.key, 命中: (h.match(/undefined|NaN|\[object Object\]/) || [])[0] })
        }
      } catch (e) { bad.push({ key: t.key, 异常: e.message }) }
    })
    return { 异常任务数: bad.length, 示例: bad.slice(0, 5) }
  })

  /* ---- 10. 截图：分别拍存档已完成态与普通态的卡片 ---- */
  await page.evaluate(() => {
    const D = window.TaskData
    const doneKey = Object.keys(window.TOTK_TASK_SAVE).find(k => window.TaskDone.isDone(k))
    window.TaskCard.open(D.byKey(doneKey), { clientX: 700, clientY: 400 })
  })
  await page.waitForTimeout(900)
  await page.screenshot({ path: 'verify-task-card-done.png' })

  await page.evaluate(() => {
    const D = window.TaskData
    const t = D.tasks.find(x => x.key && x.gx != null && x.onMap && !window.TaskDone.isDone(x.key) && x.guide && (x.guide.note || x.guide.start))
    window.TaskCard.open(t || D.tasks[0], { clientX: 700, clientY: 400 })
  })
  await page.waitForTimeout(900)
  await page.screenshot({ path: 'verify-task-card-normal.png' })

  R['错误'] = errs
  console.log(JSON.stringify(R, null, 1))
  await browser.close()
})().catch(e => { console.error('FATAL', e); process.exit(1) })