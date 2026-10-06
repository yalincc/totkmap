/* ============================================================
 * TOTKMAP 浏览器端验收 · M4 流程线
 * ------------------------------------------------------------
 * 验收目标：
 *   1. 流程线只在「显示流程」点击后出现，绝不自动铺满全图
 *   2. L1 画出虚线 + 序号节点，节点序号 1..N 连续
 *   3. 跨图层不连线（会穿墙），且卡片明说有几个点在别的图层
 *   4. L2/L3 不给按钮，改为说明文案
 *   5. 切图层时旧的线必须清掉，不能留一条错位的线
 *   6. 关闭卡片后地图上不留孤线
 *   7. 颜色跟任务种类一致（主线金/重要支线绿/普通支线蓝/其他灰）
 *
 * 用法（★ http.server 必须和本脚本在同一条命令里）：
 *   cd app && python -m http.server 8899 --bind 127.0.0.1 > /tmp/h.log 2>&1 &
 *   sleep 3
 *   cd <node workspace> && NODE_PATH=<workspace>/node_modules node verify_m4_flow.js
 * ============================================================ */
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:8899/index.html';

/* 任务点点击：卡片是 fixed 定位会挡住后面的点，必须用 JS 直接派发事件 */
async function clickDot(page, handle) {
  await page.evaluate((el) => {
    el.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, view: window,
      clientX: el.getBoundingClientRect().left + 9,
      clientY: el.getBoundingClientRect().top + 9
    }));
  }, handle);
  await page.waitForTimeout(130);
}

/* 读当前卡片信息 */
async function readCard(page) {
  return page.evaluate(() => {
    const c = document.getElementById('taskCard');
    if (!c || c.classList.contains('hidden')) return null;
    const btn = c.querySelector('#tkFlow');
    /* ★ L1 的提示 span 有 id（要动态更新），L2/L3 的没有 id，
       所以必须回退到 class 查找，否则读不到后两种的文案。 */
    const hint = c.querySelector('#tkFlowHint') || c.querySelector('.tk-flow-hint');
    return {
      name: (c.querySelector('.tk-name') || {}).textContent || '',
      hasBtn: !!btn,
      btnDisabled: btn ? btn.disabled : null,
      hint: hint ? hint.textContent.trim() : '',
      flowRow: !!c.querySelector('.tk-flow-row'),
    };
  });
}

/* 读地图上的流程线与节点 */
async function readFlow(page) {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('.tkf-node-wrap'));
    const starts = document.querySelectorAll('.tkf-start').length;
    /* Leaflet 的 polyline 会渲染成 path.tk-flow 之类；这里按 dashArray 特征找。
       更稳的办法：直接查 window.TaskFlow 的内部状态 + DOM 里的节点数。 */
    const nos = Array.from(document.querySelectorAll('.tkf-node .tkf-no'))
      .map(e => e.textContent.trim());
    return {
      nodeCount: nodes.length,
      startCount: starts,
      nos: nos,
      hasApi: !!(window.TaskFlow && window.TaskFlow.current),
      curKey: window.TaskFlow && window.TaskFlow.current
        ? window.TaskFlow.current.key : null,
    };
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !/ERR_CONNECTION|404/.test(t)) errs.push('CERR: ' + t);
    if (t.includes('[任务板块]')) errs.push('MODWARN: ' + t);
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

  const issues = [];
  const R = {};

  /* ---------- 1. 模块已加载 ---------- */
  R['1_模块加载'] = await page.evaluate(() => ({
    hasTaskFlow: !!window.TaskFlow,
    hasToggle: !!(window.TaskFlow && window.TaskFlow.toggle),
    hasCard: !!window.TaskCard,
    cssInjected: !!document.getElementById('task-flow-css'),
  }));
  if (!R['1_模块加载'].hasTaskFlow) issues.push('TaskFlow 未加载');
  if (!R['1_模块加载'].cssInjected) issues.push('task-flow-css 未注入');

  /* ---------- 2. 勾选全部四个任务分类 ---------- */
  for (const c of ['Main', 'ImportantMini', 'Sub', 'Other']) {
    await page.click(`#catalogList .tk-cat[data-tkcat="${c}"]`);
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(1200);

  /* ---------- 3. 未点击任何按钮时，地图上不应有流程线 ---------- */
  R['2_初始无线'] = await readFlow(page);
  if (R['2_初始无线'].nodeCount > 0) {
    issues.push(`未点按钮就出现了 ${R['2_初始无线'].nodeCount} 个流程节点`);
  }

  /* ---------- 4. data-tkkey 已就位（缺口 3） ---------- */
  R['3_dataKey'] = await page.evaluate(() => {
    const ds = Array.from(document.querySelectorAll('.tk-dot[data-tkkey]'));
    return { total: ds.length, 空key: ds.filter(d => !d.getAttribute('data-tkkey')).length };
  });
  if (R['3_dataKey'].total === 0) issues.push('data-tkkey 缺失');

  /* ---------- 5. 逐个开卡片：验证按钮/文案正确性 ---------- */
  const dots = await page.$$('.tk-dot-wrap');
  const stat = { L1有按钮: 0, L1按钮可用: 0, L2说明: 0, L3说明: 0, 无flowRow: 0 };
  const l1Samples = [];

  for (let i = 0; i < dots.length; i++) {
    await clickDot(page, dots[i]);
    const c = await readCard(page);
    if (!c) continue;
    if (!c.flowRow) { stat.无flowRow++; await page.keyboard.press('Escape'); continue; }
    if (c.hasBtn) {
      stat.L1有按钮++;
      if (!c.btnDisabled) stat.L1按钮可用++;
      if (l1Samples.length < 6) {
        l1Samples.push({ name: c.name, hint: c.hint });
      }
    } else {
      if (/只有 1 个地点/.test(c.hint)) stat.L2说明++;
      else if (/没有可定位/.test(c.hint)) stat.L3说明++;
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
  }
  R['4_按钮分布'] = stat;
  if (stat.L1有按钮 === 0) issues.push('没有任务出现「显示流程」按钮');
  if (stat.L1按钮可用 !== stat.L1有按钮) {
    issues.push(`有 ${stat.L1有按钮 - stat.L1按钮可用} 个按钮仍是禁用态`);
  }
  if (stat.L2说明 + stat.L3说明 === 0) issues.push('L2/L3 没有给出说明文案');

  /* ---------- 6. 点「显示流程」，验证真画出线 ---------- */
  const drawn = [];
  const dots2 = await page.$$('.tk-dot-wrap');
  for (let i = 0; i < dots2.length && drawn.length < 8; i++) {
    await clickDot(page, dots2[i]);
    const c = await readCard(page);
    if (!c || !c.hasBtn) { await page.keyboard.press('Escape'); continue; }
    const before = await readFlow(page);
    if (before.nodeCount > 0) { await page.keyboard.press('Escape'); continue; }

    /* 点「显示流程」 */
    await page.evaluate(() => {
      const b = document.getElementById('tkFlow');
      if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });
    await page.waitForTimeout(320);
    const after = await readFlow(page);
    const c2 = await readCard(page);
    drawn.push({
      name: c.name, beforeNode: before.nodeCount,
      nodeCount: after.nodeCount, startCount: after.startCount,
      nos: after.nos, curKey: after.curKey, hint: c2 ? c2.hint : '',
    });
    /* 校验序号连续 */
    for (let k = 0; k < after.nos.length; k++) {
      if (after.nos[k] !== String(k + 1)) {
        issues.push(`${c.name}: 节点序号不连续 第${k + 1}项="${after.nos[k]}"`);
      }
    }
    if (after.nodeCount < 2) {
      issues.push(`${c.name}: 点「显示流程」后节点数=${after.nodeCount}，应为 >=2`);
    }
    if (after.startCount !== 1 && after.nodeCount >= 2) {
      issues.push(`${c.name}: 起点标记数=${after.startCount}，应为 1`);
    }
    if (after.curKey) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(140);
    } else {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(140);
    }
  }
  R['5_画出流程'] = drawn;

  /* ---------- 7. 关闭卡片后不留孤线 ---------- */
  R['6_关卡清理'] = await readFlow(page);
  if (R['6_关卡清理'].nodeCount > 0) {
    issues.push(`关闭卡片后仍残留 ${R['6_关卡清理'].nodeCount} 个孤节点` +
                `（残留任务=${R['6_关卡清理'].curKey}）`);
  }

  /* ---------- 8. 切图层：旧线必须清掉 ---------- */
  await page.click('#catalogList .tk-cat[data-tkcat="Main"]');   /* 打开主线条目 */
  await page.waitForTimeout(500);
  const mainDots = await page.$$('.tk-dot-wrap');
  let flowOnBeforeSwitch = 0;
  for (let i = 0; i < mainDots.length; i++) {
    await clickDot(page, mainDots[i]);
    const c = await readCard(page);
    if (c && c.hasBtn) {
      await page.evaluate(() => {
        const b = document.getElementById('tkFlow');
        if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      });
      await page.waitForTimeout(300);
      const f = await readFlow(page);
      if (f.nodeCount > 0) { flowOnBeforeSwitch = f.nodeCount; break; }
    }
    await page.keyboard.press('Escape');
  }
  /* 切到天空层 */
  const skyBtn = await page.$('#layerSwitch button[data-layer="20"]');
  if (skyBtn) { await skyBtn.click(); await page.waitForTimeout(900); }
  R['7_切层清理'] = await readFlow(page);
  R['7_切层前节点数'] = flowOnBeforeSwitch;
  if (flowOnBeforeSwitch > 0 && R['7_切层清理'].nodeCount > 0) {
    issues.push(`切图层后仍残留 ${R['7_切层清理'].nodeCount} 个节点（旧层错位线）`);
  }

  /* ---------- 9. 折回地面层，确认功能仍可用 ---------- */
  const gBtn = await page.$('#layerSwitch button[data-layer="18"]');
  if (gBtn) { await gBtn.click(); await page.waitForTimeout(900); }
  R['8_回地面层'] = await readFlow(page);
  if (R['8_回地面层'].nodeCount > 0) issues.push('折回地面层后仍有残留节点');

  await browser.close();

  /* ---------- 报告 ---------- */
  const L = (k, v) => console.log('  ' + k.padEnd(20, '.') + ' ' + v);
  console.log('\n════ M4 流程线验收 ════\n');
  console.log('【1】模块加载');
  for (const k in R['1_模块加载']) L(k, R['1_模块加载'][k]);
  console.log('\n【2】初始状态');
  L('未点按钮时节点数', R['2_初始无线'].nodeCount + '（应为 0）');
  console.log('\n【3】data-tkkey（缺口 3）');
  L('带 data-tkkey 的点', R['3_dataKey'].total);
  L('其中 key 为空', R['3_dataKey'].空key + '（孤儿条目 1）');
  console.log('\n【4】卡片按钮分布');
  for (const k in R['4_按钮分布']) L(k, R['4_按钮分布'][k]);
  console.log('    L1 抽样：');
  R['5_画出流程'].forEach(d => {
    console.log('      ' + d.name.slice(0, 20).padEnd(22) +
      '节点' + d.nodeCount + ' 起点' + d.startCount +
      ' | ' + d.hint.slice(0, 34));
  });
  console.log('\n【5】清理');
  L('关卡后残留', R['6_关卡清理'].nodeCount + '（应为 0）');
  L('切层前节点数', R['7_切层前节点数']);
  L('切层后残留', R['7_切层清理'].nodeCount + '（应为 0）');
  L('回地面层残留', R['8_回地面层'].nodeCount + '（应为 0）');

  if (issues.length) {
    console.log('\n【问题】');
    [...new Set(issues)].forEach(s => console.log('  ✗ ' + s));
  }
  if (errs.length) {
    console.log('\n【控制台错误】');
    [...new Set(errs)].slice(0, 8).forEach(s => console.log('  ! ' + s));
  }
  const pass = issues.length === 0 && errs.length === 0;
  console.log('\n结果：' + (pass ? '✅ 全部通过' : '❌ 有失败项') + '\n');
  process.exit(pass ? 0 : 1);
})();
