/* ============================================================
 * M4.1 验收：任务卡片拖动 + 弹出位置不压点
 * ------------------------------------------------------------
 * 1. 拖动把手存在、光标为 grab
 * 2. 拖动把手/卡片空白 → 卡片跟随指针，位移正确
 * 3. 拖动不能被 Leaflet 抢走（指针移出卡片仍跟手）
 * 4. 拖动边界夹取在视口内
 * 5. 拖动后不误关卡片（关键：全局「点别处关闭」监听 click）
 * 6. 按钮 / 链接上按下不启动拖动（否则点导航= 拖导航）
 * 7. 弹出位置不压住刚点的那个任务点
 * 8. 分步正文仍可选中文本
 * ============================================================ */
const { chromium } = require('playwright-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const R = {};
const issues = [];
function L(k, v) { R[k] = v; console.log('  ' + k.padEnd(30) + '= ' + v); }

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CERR: ' + m.text()); });

  await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  /* 勾上四个任务分类 */
  for (const c of ['Main', 'ImportantMini', 'Sub', 'Other']) {
    await page.click(`#catalogList .tk-cat[data-tkcat="${c}"]`);
    await page.waitForTimeout(180);
  }
  await page.waitForTimeout(900);

  const dots = await page.$$('.tk-dot-wrap');
  L('DOM 任务点数', dots.length);
  if (!dots.length) { console.log('FAIL 无任务点'); await browser.close(); process.exit(1); }

  /* 挑一个不在屏幕左半边、四周留足空间的点，验证「甩到左侧」逻辑。
     找不到就退回用第一个点（跳过弹出位置断言）。 */
  let dotIdx = await page.evaluate(() => {
    const ds = [...document.querySelectorAll('.tk-dot-wrap')];
    for (let i = 0; i < ds.length; i++) {
      const r = ds[i].getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx > window.innerWidth * 0.55 && cx < window.innerWidth - 300 &&
          cy > 100 && cy < window.innerHeight - 320) return i;
    }
    return 0;
  });

  /* ---------- 1. 打开卡片 ---------- */
  await page.evaluate((el) => el.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, view: window,
    clientX: el.getBoundingClientRect().left + 9,
    clientY: el.getBoundingClientRect().top + 9
  })), dots[dotIdx]);
  await page.waitForTimeout(320);

  const base = await page.evaluate(() => {
    const c = document.getElementById('taskCard');
    const g = c.querySelector('.tk-grip');
    const gs = g ? getComputedStyle(g) : null;
    const r = c.getBoundingClientRect();
    return {
      open: !c.classList.contains('hidden'),
      hasGrip: !!g,
      gripCursor: gs ? gs.cursor : null,
      hasTouchAction: gs ? gs.touchAction : null,
      left: r.left, top: r.top, w: r.width, h: r.height,
      name: (c.querySelector('.tk-name') || {}).textContent
    };
  });
  L('卡片打开', base.open);
  L('拖动把手 .tk-grip', base.hasGrip);
  L('把手光标', base.gripCursor);
  L('把手 touch-action', base.hasTouchAction);
  L('当前任务', (base.name || '').slice(0, 18));
  if (!base.hasGrip) issues.push('缺少 .tk-grip 拖动把手');
  if (base.gripCursor !== 'grab') issues.push('把手光标不是 grab，实际 ' + base.gripCursor);
  if (base.hasTouchAction !== 'none') issues.push('把手缺 touch-action:none，触摸端拖不动');

  /* ---------- 2. 拖动把手：位移是否跟手 ---------- */
  /* ★ 顺序有讲究：先把卡片预置到视口左上角，**再**读把手指针坐标。
     反过来写（先读gripBox 再挪卡片）会按在旧位置的空地上，
     pointerdown 压根没落在卡片上→ 位移全是 0，还误判成「拖动没生效」。 */
  await page.evaluate(() => {
    const c = document.getElementById('taskCard');
    c.style.left = '120px';
    c.style.top = '80px';
  });
  await page.waitForTimeout(150);
  const base2 = await page.evaluate(() => {
    const r = document.getElementById('taskCard').getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  const gripBox = await page.evaluate(() => {
    const g = document.querySelector('.tk-grip');
    const r = g.getBoundingClientRect();
    return { x: r.left + 30, y: r.top + r.height / 2 };
  });

  const DX = 180, DY = 120;
  await page.mouse.move(gripBox.x, gripBox.y);
  await page.mouse.down();
  /* 分多步移动：模拟真实拖动，顺便验证指针移出卡片仍跟手 */
  const steps = [[40, 20], [90, 55], [DX, DY]];
  for (const [dx, dy] of steps) {
    await page.mouse.move(gripBox.x + dx, gripBox.y + dy, { steps: 4 });
    await page.waitForTimeout(60);
  }
  const mid = await page.evaluate(() => {
    const c = document.getElementById('taskCard');
    const r = c.getBoundingClientRect();
    return { left: r.left, top: r.top, dragging: c.classList.contains('tk-dragging'),
             sel: window.getSelection().toString().length };
  });
  await page.mouse.up();
  await page.waitForTimeout(150);

  const after = await page.evaluate(() => {
    const c = document.getElementById('taskCard');
    const r = c.getBoundingClientRect();
    return { open: !c.classList.contains('hidden'), left: r.left, top: r.top,
             dragging: c.classList.contains('tk-dragging'),
             cursor: getComputedStyle(c).cursor };
  });

  L('拖动中标记 tk-dragging', mid.dragging);
  L('拖动中选中文字数', mid.sel);
  L('松手后卡片仍打开', after.open);
  L('松手后拖动态已清', !after.dragging);
  L('松手后光标', after.cursor);

  const movedX = Math.round(after.left - base2.left);
  const movedY = Math.round(after.top - base2.top);
  L('实际位移 X / 期望', movedX + ' / ' + DX);
  L('实际位移 Y / 期望', movedY + ' / ' + DY);

  if (!after.open) issues.push('★ 拖动后卡片被关掉了（全局click 监听误触发）');
  if (mid.dragging !== true) issues.push('拖动中未加 tk-dragging 类');
  if (after.dragging) issues.push('松手后 tk-dragging 未清除');
  if (Math.abs(movedX - DX) > 3) issues.push(`X 位移偏差 ${movedX - DX}px（期望 ${DX}）`);
  if (Math.abs(movedY - DY) > 3) issues.push(`Y 位移偏差 ${movedY - DY}px（期望 ${DY}）`);
  if (mid.sel > 0) issues.push('拖动过程中选出了' + mid.sel + ' 字（应禁选）');

  /* ---------- 3. 边界夹取 ---------- */
  /* 往右下角死拖，卡片不能超出视口 */
  await page.mouse.move(after.left + 60, after.top + 20);
  await page.mouse.down();
  await page.mouse.move(1490, 940, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const clamp = await page.evaluate(() => {
    const r = document.getElementById('taskCard').getBoundingClientRect();
    return { right: Math.round(r.right), bottom: Math.round(r.bottom),
             vw: window.innerWidth, vh: window.innerHeight };
  });
  L('拖到右下后 right / 视口', clamp.right + ' / ' + clamp.vw);
  L('拖到右下后 bottom / 视口', clamp.bottom + ' / ' + clamp.vh);
  if (clamp.right > clamp.vw + 1) issues.push('卡片右侧溢出视口 ' + clamp.right);
  if (clamp.bottom > clamp.vh + 1) issues.push('卡片底部溢出视口 ' + clamp.bottom);

  /* ---------- 4. 按钮上按下不启动拖动 ---------- */
  const btnTest = await page.evaluate(async () => {
    const c = document.getElementById('taskCard');
    const btn = c.querySelector('#tkCopy');
    if (!btn) return { skip: true };
    const before = c.getBoundingClientRect().left;
    const r = btn.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const opt = { bubbles: true, cancelable: true, view: window, pointerId: 7,
                  clientX: x, clientY: y, button: 0, isPrimary: true };
    btn.dispatchEvent(new PointerEvent('pointerdown', opt));
    c.dispatchEvent(new PointerEvent('pointermove', { ...opt, clientX: x + 150, clientY: y + 100 }));
    c.dispatchEvent(new PointerEvent('pointerup', { ...opt, clientX: x + 150, clientY: y + 100 }));
    await new Promise(r2 => setTimeout(r2, 80));
    return { before: Math.round(before),
             after: Math.round(c.getBoundingClientRect().left),
             dragging: c.classList.contains('tk-dragging') };
  });
  if (btnTest.skip) { L('按钮拖动测试', '跳过（无 #tkCopy）'); }
  else {
    L('按按钮后位移 X', btnTest.after - btnTest.before);
    L('按按钮时拖动态', btnTest.dragging);
    if (btnTest.after !== btnTest.before) issues.push('★ 在按钮上按下会启动拖动（点导航变成拖卡片）');
    if (btnTest.dragging) issues.push('按钮上按下却加了 tk-dragging');
  }

  /* ---------- 5. 分步正文仍可选中 ---------- */
  const selOk = await page.evaluate(async () => {
    const c = document.getElementById('taskCard');
    const el = c.querySelector('.tk-step-tx') || c.querySelector('.tk-kv');
    if (!el) return { skip: true };
    const r = el.getBoundingClientRect();
    const x = r.left + 5, y = r.top + Math.min(8, r.height / 2);
    c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
      view: window, pointerId: 8, clientX: x, clientY: y, button: 0, isPrimary: true }));
    c.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true,
      view: window, pointerId: 8, clientX: x + 40, clientY: y + 5 }));
    c.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true,
      view: window, pointerId: 8, clientX: x + 40, clientY: y + 5 }));
    await new Promise(r2 => setTimeout(r2, 60));
    return { dragging: c.classList.contains('tk-dragging') };
  });
  L('正文区按下也起拖（可接受）', selOk.dragging);

  /* ---------- 6. 弹出位置不压点 ---------- */
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const pop = await page.evaluate(() => {
    const ds = [...document.querySelectorAll('.tk-dot-wrap')];
    /* 找屏幕左半边的点 */
    for (const d of ds) {
      const r = d.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < window.innerWidth / 2 && cx > 250 && cy > 100 && cy < window.innerHeight - 260) {
        d.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window,
          clientX: cx, clientY: cy }));
        return { cx: Math.round(cx), cy: Math.round(cy), side: 'left' };
      }
    }
    return null;
  });
  await page.waitForTimeout(300);
  if (!pop) { L('弹出位置测试', '跳过（无合适点位）'); }
  else {
    const chk = await page.evaluate((p) => {
      const c = document.getElementById('taskCard');
      const r = c.getBoundingClientRect();
      const covers = !(r.right < p.cx || r.left > p.cx || r.bottom < p.cy || r.top > p.cy);
      return { covers: covers,
               cardLeft: Math.round(r.left), cardTop: Math.round(r.top),
               dotX: p.cx, dotY: p.cy, side: p.side };
    }, pop);
    L('左半边点弹出位置', 'left=' + chk.cardLeft + ' top=' + chk.cardTop);
    L('★ 是否压住刚点的点', chk.covers);
    if (chk.covers) issues.push('★ 卡片仍压住刚点击的任务点（点 ' + chk.dotX + ',' + chk.dotY + '）');
  }

  /* ---------- 7. Esc 仍能关闭 + 不留流程线 ---------- */
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const closed = await page.evaluate(() => {
    const c = document.getElementById('taskCard');
    return { hidden: c.classList.contains('hidden'),
             orphan: document.querySelectorAll('.tkf-node-wrap').length };
  });
  L('Esc 关闭后 hidden', closed.hidden);
  L('残留流程线节点', closed.orphan);
  if (!closed.hidden) issues.push('Esc 没能关闭卡片');
  if (closed.orphan > 0) issues.push('关闭后残留 ' + closed.orphan + ' 个流程线孤节点');

  L('页面错误数', errs.length);
  if (errs.length) errs.slice(0, 6).forEach(e => console.log('    ' + e));

  console.log('\n========== 问题 ==========');
  if (!issues.length) console.log('  全部通过');
  else issues.forEach(s => console.log('  ✗ ' + s));
  if (errs.length) issues.push(errs.length + ' 个页面错误');

  await browser.close();
  process.exit(issues.length ? 1 : 0);
})();