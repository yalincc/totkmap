/* V2.1M5.1 验收：任务完成态上地图
 * 验的是「真浏览器里地图上的任务点有没有跟着完成态变」——
 * 静态检查看不出来，signature 不带完成态这种bug 只有跑起来才暴露。
 * 用法：node task-done-map.js <progress.sav 路径>   （需先起 http://127.0.0.1:8899）
 */
const { chromium } = require('playwright-core')
const path = require('path')

const SAVE = process.argv[2]
if (!SAVE) { console.error('需要 progress.sav 路径'); process.exit(1) }

const EXEC = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = 'http://127.0.0.1:8899/index.html'

;(async () => {
  const browser = await chromium.launch({ executablePath: EXEC, headless: true })
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  const errs = []
  /* live-python(8766) 没起是预期状态（那是 xnavi 同步服务，不是本板块依赖），
     过滤掉这类噪音，否则真bug 会被埋掉。 */
  const NOISE = /ERR_CONNECTION_REFUSED|127\.0\.0\.1:8766|favicon/
  page.on('pageerror', e => { if (!NOISE.test(e.message)) errs.push('PAGEERROR ' + e.message) })
  page.on('console', m => {
    if (m.type() === 'error' && !NOISE.test(m.text())) errs.push('CONSOLE ' + m.text())
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)

  const R = {}

  /* ---- 0. 前置：任务模块加载了吗 ---- */
  R['0_模块就绪'] = await page.evaluate(() => ({
    TaskPanel: !!window.TaskPanel,
    TaskDone: !!window.TaskDone,
    任务点总数: document.querySelectorAll('.tk-dot').length
  }))

  /* ---- 1. 打开任务分类，让任务点上地图 ---- */
  await page.evaluate(() => {
    // 勾上全部任务分类
    document.querySelectorAll('#catalogList .tk-cat').forEach(el => {
      if (!el.classList.contains('active')) el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  })
  await page.waitForTimeout(1500)
  R['1_勾全分类后任务点'] = await page.evaluate(() => document.querySelectorAll('.tk-dot').length)

  /* ---- 2. 标记一个任务完成，等防抖重绘 ---- */
  R['2_标记前'] = await page.evaluate(() => {
    const dot = document.querySelector('.tk-dot')
    window.__k = dot.getAttribute('data-tkkey')
    return {
      key: window.__k,
      有isDone: !!dot.classList.contains('is-done'),
      glyph: dot.textContent.trim()
    }
  })

  await page.evaluate(() => window.TaskDone.markDone(window.__k))
  await page.waitForTimeout(900)          /* 防抖 120ms + 渲染余量 */

  R['3_标记后同一DOM节点'] = await page.evaluate(() => {
    /* 关键：render() 是全量重建，DOM 节点会换新。
       所以不能拿旧节点比对，要按 data-tkkey 重新查。 */
    const dot = document.querySelector('.tk-dot[data-tkkey="' + window.__k + '"]')
    return {
      节点还在: !!dot,
      有isDone: dot ? dot.classList.contains('is-done') : null,
      glyph: dot ? dot.textContent.trim() : null,
      透明度: dot ? getComputedStyle(dot).opacity : null,
      tooltip带勾: dot ? !!dot.parentElement.querySelector('.tk-tip') : null
    }
  })

  /* ---- 4. 未完成的任务不能被误标---- */
  R['4_未完成点无勾'] = await page.evaluate(() => {
    const others = [...document.querySelectorAll('.tk-dot:not(.is-done)')]
    return { 未完成点数: others.length, 全部无勾: others.every(d => d.textContent.trim() !== '✓') }
  })

  /* ---- 5. 取消完成后要恢复 ---- */
  await page.evaluate(() => window.TaskDone.markUndone(window.__k))
  await page.waitForTimeout(900)
  R['5_取消完成'] = await page.evaluate(() => {
    const dot = document.querySelector('.tk-dot[data-tkkey="' + window.__k + '"]')
    return { 勾已消失: dot ? !dot.classList.contains('is-done') : null, glyph: dot ? dot.textContent.trim() : null }
  })

  /* ---- 6. 真实存档灌入 ---- */
  await page.evaluate(async (b64) => {
    const bin = atob(b64)
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    const file = new File([u8], 'progress.sav')
    const dt = new DataTransfer()
    dt.items.add(file)
    const inp = document.querySelector('#saveFileInput') || document.querySelector('input[type=file]')
    if (inp) { inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })) }
  }, require('fs').readFileSync(SAVE).toString('base64'))
  await page.waitForTimeout(6000)

  R['6_载入存档后'] = await page.evaluate(() => {
    /* 存档里完成的可能分布在不同图层，地图只画当前图层，
       所以「地图勾数 ≤ 存档完成数」是正常的，差值不是 bug。
       这里显式记下来，别让后来人误判。 */
    const saveDone = window.TaskDone.stats().done
    const mapDone = document.querySelectorAll('.tk-dot.is-done').length
    return {
      存档完成数: saveDone,
      地图打勾点数: mapDone,
      差值合理: mapDone <= saveDone,
      面板计数: (document.querySelector('.tk-group .tk-count') || {}).textContent
    }
  })

  /* ---- 7. 存档已完成的任务，点开卡片应显示不可取消 ---- */
  R['7_卡片完成态'] = await page.evaluate(() => {
    const dot = document.querySelector('.tk-dot.is-done')
    if (!dot) return { 跳过: '地图上没有已完成的点' }
    dot.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return new Promise(res => setTimeout(() => {
      const b = document.querySelector('#tkDone')
      res({
        按钮文案: b ? b.textContent.trim() : null,
        禁用: b ? b.disabled : null,
        右上角有勾: !!document.querySelector('.tk-done-tick')
      })
    }, 700))
  })

  R['错误'] = errs
  console.log(JSON.stringify(R, null, 1))
  await page.screenshot({ path: 'verify-done-map.png' })
  await browser.close()
})().catch(e => { console.error('FATAL', e); process.exit(1) })
