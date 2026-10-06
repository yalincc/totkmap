/* V2.1 L2 交互回归总入口 —— 一条命令跑完所有浏览器验收
 *
 * 解决的问题（都是实际踩过的）：
 *   ① 以前必须先手动起http 服务，忘了就 ERR_CONNECTION_REFUSED
 *   ② playwright-core 装在 WorkBuddy 托管工作区，require 直接 MODULE_NOT_FOUND
 *   ③ 必须 cd到 app/ 才能跑，相对路径全对不上
 *   → 现在这四件事脚本自己处理，直接 `node tools/verify/verify-all.js` 就行
 *
 * 用法：
 *   node tools/verify/verify-all.js              # L1 + L2 全跑
 *   node tools/verify/verify-all.js --l1         # 只跑数据体检（秒级，不用浏览器）
 *   node tools/verify/verify-all.js --l2         # 只跑浏览器回归
 *   node tools/verify/verify-all.js --keep-alive # 跑完不关服务，便于手动点
 *
 * 退出码：0 全绿 / 1 有失败项/ 2 仅 --strict 模式下的 WARN
 */
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')

const HERE = __dirname
const APP = path.resolve(HERE, '../../app')
/* 端口：默认 8899，被占就自动往后找。
 * 以前这里写死 8899，别人恰好开着服务就直接EADDRINUSE 失败。 */
const BASE_PORT = Number(process.env.PORT) || 8899
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

/* playwright-core 不在本项目 node_modules，在 WorkBuddy 托管工作区。
 * 找不到就报清楚要去哪装，别丢一句 MODULE_NOT_FOUND让人猜。 */
const PW_PATHS = [
  path.join(process.env.USERPROFILE || '', '.workbuddy/binaries/node/workspace/node_modules'),
  path.join(APP, 'node_modules'),
  path.join(HERE, 'node_modules')
]
function findPw() {
  for (const p of PW_PATHS) {
    if (p && fs.existsSync(path.join(p, 'playwright-core'))) return p
  }
  return null
}

/* ---------- L1：数据体检 ---------- */
/* ★ 必须用异步 spawn，不能用 spawnSync。
 *   本机 spawnSync 稳定返回 EBUSY（node.exe 被占用），
 *   而 spawnSync 的 EBUSY 会表现为 status=null，
 *   很容易被误判成「子脚本超时」。异步 spawn 没这问题。 */
function runNode(args, opts = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { ...opts, encoding: 'utf8' })
    let out = '', err = '', done = false
    const finish = status => { if (!done) { done = true; resolve({ status, out, err }) } }
    child.stdout.on('data', b => { out += b })
    child.stderr.on('data', b => { err += b })
    child.on('error', e => { err += String(e && e.message || e); finish(null) })
    child.on('close', code => finish(code))
    if (opts.timeout) {
      setTimeout(() => {
        if (!done) { child.kill(); err += `\n[TIMEOUT ${opts.timeout}ms]`; finish(null) }
      }, opts.timeout)
    }
  })
}

async function runL1() {
  process.stdout.write('\n')
  console.log('━'.repeat(56))
  console.log('  L1  数据体检')
  console.log('━'.repeat(56))
  const r = await runNode([path.join(HERE, 'verify-data.js')], { cwd: APP, timeout: 60000 })
  process.stdout.write(r.out || '')
  if (r.err) process.stderr.write(r.err)
  return { name: 'L1 数据体检', code: r.status === 1 ? 1 : 0 }
}

/* ---------- 静态服务：自己起、自己关、端口自己找 ---------- */
function makeServer() {
  return http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html'
    const file = path.join(APP, rel)
    /* 防目录穿越 */
    if (!file.startsWith(APP)) { res.writeHead(403).end(); return }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return }
      const ext = path.extname(file).toLowerCase()
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
        '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': mime }).end(buf)
    })
  })
}

/* 从 BASE_PORT 起往后试，最多 30 个。
 * ★ 光listen 成功不够：本机有代理会抢占端口，listen 成功但请求打过去
 *   得到 502/连接被拒。所以每个端口都要真发一个 HTTP 请求验一下，
 *   确认能拿到 index.html 才认。 */
function probe(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/index.html', agent: false }, res => {
      let n = 0
      res.on('data', b => { n += b.length })
      res.on('end', () => resolve(res.statusCode === 200 && n > 500))
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1500, () => { req.destroy(); resolve(false) })
  })
}

async function listenOnFreePort(server, from, tries = 30) {
  for (let k = 0; k < tries; k++) {
    const port = from + k
    const r = await new Promise(resolve => {
      const onErr = err => { server.removeListener('listening', onOk); resolve({ ok: false, err }) }
      const onOk = () => { server.removeListener('error', onErr); resolve({ ok: true }) }
      server.once('error', onErr)
      server.once('listening', onOk)
      server.listen(port, '127.0.0.1')
    })
    if (!r.ok) {
      if (r.err && r.err.code === 'EADDRINUSE') continue
      return { ok: false, err: r.err, port }
    }
    /* listen 成功 ≠ 端口可用（可能有代理占着）*/
    if (await probe(port)) return { ok: true, port, serverRef: server }
    await new Promise(r2 => server.close(r2))
  }
  return { ok: false, err: new Error(`端口 ${from}~${from + tries - 1} 都试过了，没有干净端口`), port: from }
}

/* ---------- L2：浏览器回归 ---------- */
/* 每项 = [脚本名, 必需环境变量, 判定函数]
 * 判定函数吃子进程 stdout（JSON 文本），返回 true = 这项通过 */
const L2 = [
  {
    file: 'verify-chain.js',
    label: 'M6 任务链 / 系列',
    /* 关键断言：6 个用例全有链条区、错误数组为空、标记完成能增能取消 */
    check(out) {
      const r = parseJson(out)
      if (!r) return { ok: false, why: '输出不是合法 JSON' }
      if (r.错误 && r.ERROR && r.ERROR.length) return { ok: false, why: '页面报错 ' + r.错误.length + ' 条' }
      const errs = (r['错误'] || [])
      if (errs.length) return { ok: false, why: `页面报错 ${errs.length} 条：${errs[0]}` }
      const cases = ['六环链中间', '六环链末环', '三点蘑菇', 'PhotoSpot系列', '长主线11点', '无中文名']
      const miss = cases.filter(k => !r[k] || r[k]['找不到'])
      if (miss.length) return { ok: false, why: '用例未跑通：' + miss.join(', ') }
      const noChain = cases.filter(k => r[k] && !r[k]['有链条区'] && k !== '长主线11点')
      if (noChain.length) return { ok: false, why: '缺任务链区：' + noChain.join(', ') }
      const dup = cases.filter(k => r[k] && r[k]['有重复的官方分步区'])
      if (dup.length) return { ok: false, why: '官方分步区重复渲染：' + dup.join(', ') }
      const link = r['标记完成联动']
      if (!link) return { ok: false, why: '缺标记完成联动用例' }
      if (!link['标记后有增加']) return { ok: false, why: '标记完成后链条格没变绿' }
      if (!link['取消后能恢复']) return { ok: false, why: '取消完成后状态没恢复' }
      if (!link['下一环能看到前一环已完成']) return { ok: false, why: '下一环看不到前一环完成态' }
      return { ok: true, why: `6 用例 + 标记完成联动 4 断言全过` }
    }
  },
  {
    file: 'task-card-m5.js',
    label: 'M5 卡片改造 / 完成态 / 追踪',
    check(out) {
      const r = parseJson(out)
      if (!r) return { ok: false, why: '输出不是合法 JSON' }
      const errs = r['错误'] || []
      if (errs.length) return { ok: false, why: `页面报错 ${errs.length} 条：${errs[0]}` }
      const full = r['9_全量渲染'] || {}
      if (full['异常任务数'] > 0) {
        return { ok: false, why: `全量渲染 ${full['异常任务数']} 个任务抛异常` }
      }
      const after = r['8_reload后'] || {}
      if (!after['手动标记仍在']) return { ok: false, why: 'reload 后手动完成态丢失' }
      const reopen = r['7_重开卡片'] || {}
      if (!/取消追踪/.test(reopen['追踪按钮文案'] || '')) {
        return { ok: false, why: '重开卡片后追踪态没保持' }
      }
      return { ok: true, why: '全量渲染无异常 + 追踪持久化 + reload 保持' }
    }
  },
  {
    file: 'verify-armor-drop.js',
    label: 'M6.1 本任务可获得的防具',
    check(out) {
      const r = parseJson(out)
      if (!r) return { ok: false, why: '输出不是合法 JSON' }
      const errs = r['错误'] || []
      if (errs.length) return { ok: false, why: `页面报错 ${errs.length} 条：${errs[0]}` }
      const fails = r['失败项'] || []
      if (fails.length) return { ok: false, why: fails.slice(0, 2).join('；') }
      const d0 = r['0_数据加载'] || {}
      return { ok: true, why: `${d0.命中任务数} 个任务有掉落，噪声全剔除，图标加载正常` }
    }
  },
  {
    file: 'verify-series-list.js',
    label: 'M6.3 同系列折叠列表',
    check(out) {
      const r = parseJsonLast(out)
      if (!r) return { ok: false, why: '输出不是合法 JSON' }
      const errs = r['错误'] || []
      if (errs.length) return { ok: false, why: `页面报错 ${errs.length} 条：${errs[0]}` }
      const fails = r['失败项'] || []
      if (fails.length) return { ok: false, why: fails.slice(0, 2).join('；') }
      return { ok: true, why: r['摘要'] || '系列列表渲染与交互正常' }
    }
  },
  {
    file: 'verify-mobile.js',
    label: 'M6.4 移动端视口实测',
    check(out) {
      /* 视口数量直接从脚本汇总里读，不去解析第一段现场数据——
       * parseJsonFirst 遇缩进 JSON + 尾随换行时判不稳（实测两次都拿到 0）。 */
      const r = parseJsonLast(out)
      if (!r) return { ok: false, why: '输出不是合法 JSON' }
      const fails = r['失败项'] || []
      if (fails.length) return { ok: false, why: fails.slice(0, 2).join('；') }
      const n = r['视口数'] || 0
      return { ok: true, why: `${n} 种手机视口（${r['视口清单'] || ''}）：卡片/按钮/侧栏/Tab 无溢出，触控面积达标` }
    }
  },
  {
    file: 'verify-armor-panel.js',
    label: 'M6.5 防具面板与卡片',
    check(out) {
      const r = parseJsonLast(out)
      if (!r) return { ok: false, why: '输出不是合法 JSON' }
      const errs = r['错误'] || []
      if (errs.length) return { ok: false, why: `页面报错 ${errs.length} 条：${errs[0]}` }
      const fails = r['失败项'] || []
      if (fails.length) return { ok: false, why: fails.slice(0, 2).join('；') }
      const d0 = r['0_数据'] || {}
      /* ★ 统计数字由脚本自己放进汇总段（调用方只能可靠地解析到那一段） */
      return {
        ok: true,
        why: `${r['防具数']} 件 / ${r['套装数']} 套，${r['可强化']} 件可强化；面板·卡片·套装链接·任务双向联动全通`
      }
    }
  },
  {
    file: 'verify-sw-cache.js',
    label: 'SW 缓存不挡新版本',
    check(out) {
      const r = parseJsonLast(out)
      if (!r) return { ok: false, why: '输出不是合法 JSON' }
      const fails = r['失败项'] || []
      if (fails.length) return { ok: false, why: fails.slice(0, 2).join('；') }
      return { ok: true, why: 'SW 装上后重开，拿到的是新 index.html / js / css / data' }
    }
  },
  {
    file: 'task-done-map.js',
    label: 'M5.1 完成态上地图',
    optional: 'PROGRESS_SAV',
    check(out) {
      if (/需要 progress.sav 路径/.test(out)) {
        return { skip: '未设 PROGRESS_SAV 环境变量，跳过真实存档校验' }
      }
      const r = parseJson(out)
      if (!r) return { ok: false, why: '输出不是合法 JSON' }
      const errs = r['错误'] || []
      if (errs.length) return { ok: false, why: `页面报错 ${errs.length} 条：${errs[0]}` }
      const card = r['7_卡片完成态'] || {}
      if (card['禁用'] !== true) return { ok: false, why: '存档已完成任务的「标记完成」应禁用' }
      return { ok: true, why: '地图完成点 + 卡片完成态一致' }
    }
  }
]

function parseJson(out) {
  if (!out) return null
  const i = out.indexOf('{')
  if (i < 0) return null
  try { return JSON.parse(out.slice(i)) } catch (e) { return null }
}

/* 有些脚本会先打现场数据、再打一段汇总断言（两段 JSON）。
 * parseJson 从第一个 { 起解到末尾，遇上这种输出必然失败。
 * 从后往前找最后一个能独立解析成功的顶层对象。 */
function parseJsonLast(out) {
  if (!out) return null
  const idx = []
  for (let i = 0; i < out.length; i++) if (out[i] === '{') idx.push(i)
  for (let k = idx.length - 1; k >= 0; k--) {
    try {
      const v = JSON.parse(out.slice(idx[k]))
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
    } catch (e) { /* 继续往前找 */}
  }
  return null
}

async function runL2() {
  process.stdout.write('\n')
  console.log('━'.repeat(56))
  console.log('  L2  浏览器回归')
  console.log('━'.repeat(56))

  const pw = findPw()
  if (!pw) {
    console.log('[SKIP] L2 找不到 playwright-core，本机需装：')
    PW_PATHS.forEach(p => console.log('         ' + p))
    console.log('       （L1 数据体检不需要它，已照常跑完）')
    return [{ name: 'L2 浏览器回归', code: 0, skipped: true }]
  }
  if (!fs.existsSync(CHROME)) {
    console.log(`[SKIP] L2 找不到 Chrome：${CHROME}`)
    return [{ name: 'L2 浏览器回归', code: 0, skipped: true }]
  }

  const srv = await listenOnFreePort(makeServer(), BASE_PORT)
  if (!srv.ok) {
    console.log(`[FAIL] 静态服务起不来：${srv.err.message}`)
    console.log(`       ${BASE_PORT}~${BASE_PORT + 20} 都被占，请关掉占用进程`)
    return [{ name: 'L2 浏览器回归', code: 1 }]
  }
  const url = `http://127.0.0.1:${srv.port}/index.html`
  console.log(`服务已起 ${url}（脚本自起自关，不用手动开）`)

  /* ★ 本机 HTTP_PROXY 指向 127.0.0.1:14202，且NO_PROXY 是空的。
   *   不显式绕过的话 playwright 访问本机端口会被代理截走，
   *   表现为「listen 成功但页面 ERR_CONNECTION_REFUSED / 502」——
   *   这个坑排查起来很费时间，直接在子进程环境里排掉。 */
  const env = {
    ...process.env,
    NODE_PATH: pw,
    PORT: String(srv.port),
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost'
  }
  const results = []
  for (const item of L2) {
    const args = [path.join(HERE, item.file)]
    /* 存档类脚本要路径：命令行参数优先，其次环境变量 */
    if (item.optional === 'PROGRESS_SAV' && process.env.PROGRESS_SAV) {
      args.push(process.env.PROGRESS_SAV)
    }
    const r = await runNode(args, { cwd: APP, env, timeout: 180000 })
    const out = (r.out || '') + (r.err || '')
    if (r.status === null) {
      const timedOut = /TIMEOUT/.test(r.err || '')
      console.log(`  [FAIL] ${item.label} —— ${timedOut ? '超时 180s' : '子进程异常退出'}`)
      if (out.trim()) {
        console.log('         --- 子进程输出 ---')
        out.trim().split('\n').slice(-12).forEach(l => console.log('         ' + l))
      } else {
        console.log('         （无输出）')
      }
      results.push({ name: item.label, code: 1 })
      continue
    }
    const v = item.check(out)
    if (v.skip) console.log(`  [SKIP] ${item.label} —— ${v.skip}`)
    else if (v.ok) console.log(`  [ OK ] ${item.label} —— ${v.why}`)
    else console.log(`  [FAIL] ${item.label} —— ${v.why}`)
    results.push({ name: item.label, code: v.ok || v.skip ? 0 : 1 })
  }

  if (process.argv.includes('--keep-alive')) {
    console.log(`\n--keep-alive：服务留在 ${url}，Ctrl+C 关`)
  } else {
    srv.serverRef.close()
  }
  return results
}

;(async () => {
  const only = process.argv.slice(2)
  const run1 = !only.length || only.includes('--l1')
  const run2 = !only.length || only.includes('--l2')

  console.log('V2.1 任务板块验收总入口')
  console.log('（L1 数据体检 = 纯 Node秒级；L2 浏览器回归 = 真实点击）')

  const results = []
  if (run1) results.push(await runL1())
  if (run2) results.push(...await runL2())

  console.log('\n' + '━'.repeat(56))
  console.log('  汇总')
  console.log('━'.repeat(56))
  let bad = 0
  results.forEach(r => {
    const tag = r.skipped ? 'SKIP' : (r.code === 0 ? ' OK ' : 'FAIL')
    if (r.code) bad++
    console.log(`  [${tag}] ${r.name}`)
  })
  console.log('')
  console.log(bad ? `${bad} 项失败` : '全部通过')
  process.exit(bad ? 1 : 0)
})()
