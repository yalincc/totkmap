/* ============================================================
 * TOTKMAP 浏览器端验收 · M3 完整版（11 项）
 * ------------------------------------------------------------
 * 用法（★ http.server 必须和本脚本放在同一条命令里，否则进程被回收）：
 *   cd app && python -m http.server 8899 --bind 127.0.0.1 > /tmp/h.log 2>&1 &
 *   SRV=$!; sleep 3
 *   cd <node workspace> && NODE_PATH=<workspace>/node_modules node verify_m3_final.js
 *   kill $SRV
 *
 * 依赖：playwright-core（已在托管 node workspace）+ 本机 Chrome
 * 外网瓦片会报 ERR_CONNECTION_REFUSED，属正常，已过滤。
 * ============================================================ */
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:8899/index.html';
const OUT = 'E:/WorkSpace/GameTools/.workbuddy/memory/';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && t.indexOf('ERR_CONNECTION') < 0 && t.indexOf('404') < 0) errs.push('CERR: ' + t);
    if (t.indexOf('[任务板块]') >= 0) errs.push('MODWARN: ' + t);
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  const R = {};

  /* 1 · 面板注入 */
  R['1_面板'] = await page.evaluate(() => ({
    分组标题: Array.from(document.querySelectorAll('#catalogList .group-title')).map(e => e.textContent.trim()),
    任务分类: Array.from(document.querySelectorAll('#catalogList .tk-cat')).map(e =>
      e.querySelector('.cat-name').textContent + '(' + e.querySelector('.cat-count').textContent + ')'),
    原分类数: document.querySelectorAll('#catalogList .cat-item:not(.tk-cat)').length
  }));

  /* 2 · 勾选四个分类 */
  for (const c of ['Main', 'ImportantMini', 'Sub', 'Other']) {
    await page.click(`#catalogList .tk-cat[data-tkcat="${c}"]`);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(700);
  R['2_勾选全部'] = await page.evaluate(() => {
    const cls = { main: 0, imp: 0, sub: 0, oth: 0 };
    document.querySelectorAll('.tk-dot-wrap').forEach(d => {
      const k = d.querySelector('.tk-dot'); if (!k) return;
      for (const n of ['main', 'imp', 'sub', 'oth']) if (k.classList.contains('tk-' + n)) cls[n]++;
    });
    return { 总点数: document.querySelectorAll('.tk-dot-wrap').length, 分类分布: cls };
  });
  await page.screenshot({ path: OUT + 'shot_m3_all.png' });

  /* 3 · 取消勾选 */
  await page.click('#catalogList .tk-cat[data-tkcat="Other"]');
  await page.click('#catalogList .tk-cat[data-tkcat="Sub"]');
  await page.waitForTimeout(700);
  R['3_取消两个'] = await page.evaluate(() => ({
    总点数: document.querySelectorAll('.tk-dot-wrap').length,
    高亮: Array.from(document.querySelectorAll('#catalogList .tk-cat.active')).map(e => e.getAttribute('data-tkcat'))
  }));

  /* 4 · 真实鼠标点击开卡片 */
  const dot = await page.evaluate(() => {
    for (const d of document.querySelectorAll('.tk-dot-wrap')) {
      const r = d.getBoundingClientRect();
      if (r.left > 350 && r.left < 1400 && r.top > 100 && r.top < 800) {
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
    }
    return null;
  });
  if (dot) { await page.mouse.click(dot.x, dot.y); await page.waitForTimeout(800); }
  R['4_点开卡片'] = await page.evaluate(() => {
    const c = document.getElementById('taskCard');
    if (!c || c.classList.contains('hidden')) return { 打开: false };
    const cur = window.TaskCard.current();
    /* ★ 必须查 computed style：M3曾出现「DOM 正常但 CSS 未注入」，
       class 与 hidden 都对，卡片却完全不可见。 */
    const cs = getComputedStyle(c);
    return {
      打开: true, 任务名: cur.name, 分组: cur.group, 档位: cur.tier, 官方名: cur.hasName,
      定位: cs.position, zIndex: cs.zIndex,
      分区: Array.from(c.querySelectorAll('.tk-sec-t')).map(e => e.textContent.trim()),
      元信息: Array.from(c.querySelectorAll('.tk-mrow')).map(e => e.textContent.trim()),
      分步条数: c.querySelectorAll('.tk-step').length,
      按钮: Array.from(c.querySelectorAll('.tk-actions .btn')).map(e => e.textContent.trim())
    };
  });
  await page.screenshot({ path: OUT + 'shot_m3_card.png' });

  /* 5 · 任务链跳转 */
  R['5_任务链跳转'] = await page.evaluate(async () => {
    const D = window.TaskData;
    const t = D.tasks.find(x => x.reqs && x.reqs.some(r => r.linkable));
    if (!t) return { 跳过: '没有可点前置的任务' };
    window.TaskCard.open(t, null);
    await new Promise(r => setTimeout(r, 250));
    const a = document.querySelector('#taskCard .tk-link');
    if (!a) return { 任务: t.name, 问题: '没渲染出链接' };
    const target = a.getAttribute('data-tk-goto');
    a.click();
    await new Promise(r => setTimeout(r, 250));
    const now = window.TaskCard.current();
    return { 从: t.name, 点的前置: target, 跳到: now ? now.name : null, 成功: now ? now.name === target : false };
  });

  /* 6 · 文本洁净 + 渲染无泄漏 */
  R['6_文本洁净'] = await page.evaluate(() => {
    const D = window.TaskData;
    const bad = D.tasks.filter(t =>
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(JSON.stringify(t)) || JSON.stringify(t).includes('【'));
    let leaked = 0;
    D.tasks.forEach(t => {
      window.TaskCard.open(t, null);
      const h = document.getElementById('taskCardBody').innerHTML;
      if (h.indexOf('undefined') >= 0 || h.indexOf('>null<') >= 0 || h.indexOf('NaN') >= 0) leaked++;
    });
    window.TaskCard.close();
    return { 脏文本任务数: bad.length, 渲染泄漏任务数: leaked };
  });

  /* 7 · 无官方名任务挂灰标 */
  R['7_无官方名标注'] = await page.evaluate(() => {
    const D = window.TaskData;
    const noName = D.tasks.filter(t => !t.hasName);
    window.TaskCard.open(noName[0], null);
    const hasChip = !!document.querySelector('#taskCard .tk-noname');
    const title = document.querySelector('#taskCard .tk-name').textContent;
    window.TaskCard.close();
    return { 无官方名任务数: noName.length, 样例: noName[0].name, 显示标题: title, 有灰标: hasChip };
  });

  /* 8 · gy 缺失显示「高度未知」 */
  R['8_高度缺失'] = await page.evaluate(() => {
    const D = window.TaskData;
    const noH = D.tasks.find(t => t.onMap && (!t.hasHeight || t.gy == null));
    if (!noH) return { 跳过: '全部有高度' };
    window.TaskCard.open(noH, null);
    const txt = document.getElementById('taskCardBody').innerHTML;
    window.TaskCard.close();
    return { 任务: noH.name, 显示高度未知: txt.indexOf('高度未知') >= 0 };
  });

  /* 9 · 切层往返 */
  await page.click('#layerSwitch button[data-layer="20"]'); await page.waitForTimeout(1200);
  const sky = await page.evaluate(() => ({ 层: window.TOTK.state.layer, 点数: document.querySelectorAll('.tk-dot-wrap').length }));
  await page.click('#layerSwitch button[data-layer="18"]'); await page.waitForTimeout(1200);
  const back = await page.evaluate(() => ({
    层: window.TOTK.state.layer,
    高亮: Array.from(document.querySelectorAll('#catalogList .tk-cat.active')).map(e => e.getAttribute('data-tkcat')),
    点数: document.querySelectorAll('.tk-dot-wrap').length
  }));
  R['9_切层往返'] = { 天空层: sky, 回地上: back };

  /* 10 · 刷新后保持 */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  R['10_刷新保持'] = await page.evaluate(() => ({
    高亮: Array.from(document.querySelectorAll('#catalogList .tk-cat.active')).map(e => e.getAttribute('data-tkcat')),
    点数: document.querySelectorAll('.tk-dot-wrap').length
  }));

  /* 11 · 原有分组标题（M0 地雷不能复发） */
  R['11_原有分组'] = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#catalogList .group-title')).map(e => e.textContent.trim()));

  R['错误'] = errs;
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });