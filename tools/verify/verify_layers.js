/* ============================================================
 * TOTKMAP 浏览器端验收 · 三层跨层行为
 * ------------------------------------------------------------
 * 验证任务板块在 地上(18) / 地下(19) / 天空(20) 三层都能：
 *   独立勾选 → 画出对应数量的点 → 切到别层再切回来，勾选意图仍在
 *
 * 用法（★ http.server 与本脚本必须同一条命令）：
 *   cd app && python -m http.server 8899 --bind 127.0.0.1 > /tmp/h.log 2>&1 &
 *   SRV=$!; sleep 3
 *   cd <node workspace> && NODE_PATH=<workspace>/node_modules node verify_layers.js
 *   kill $SRV
 * ============================================================ */
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:8899/index.html';

/* 各地层的预期点数（与 task-plan.js 统计一致，变了要同步改这里）
 *
 * ★ 2026-10-07 更新：口径从「单层计数」改为「多点任务所有涉及层都显示」，
 *   地底/天空的任务数因此变多（跨层任务会在多个层各出现一次）。
 *   数字取自 build_task_plan.py 的 inLayer() 统计，且这里数的是
 *   `.tk-dot-wrap` —— 即**可上图**的点数（onMap=true），比任务总数少 1（地表）。
 *     地表 236 条任务 / 235 可上图 · 地底 7/7 · 天空 21/21 · 三层去重 253
 *   旧的 236/3/15 是「一层只算第一个流程点」时代的断言，已过期。 */
/* 各地层的预期点数（= task-plan.js 里 onMap=true 的任务数，变了要同步改这里）
 *
 * 2026-10-07 更新：天空层 21 → 22。
 *   「未知的天空巨人」是**跨层任务**（layers=[18,20]）：
 *   战斗在西海布拉天空诸岛（天空层），交差在海拉鲁城堡（地表层）。
 *   见 build_task_plan.py 的 MANUAL_LAYERS。
 *   脚本数的是 `.tk-dot-wrap`（实际渲染出来的点= 可上图数），所以是 22 不是 21。 */
const EXPECT = { 18: 235, 19: 7, 20: 22 };

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && t.indexOf('ERR_CONNECTION') < 0 && t.indexOf('404') < 0) errs.push(t);
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

  const R = {};

  /* 逐层：切过去 → 把该层所有分类都勾上 → 数点 → 记录 */
  async function selectAll(layer) {
    await page.click(`#layerSwitch button[data-layer="${layer}"]`);
    await page.waitForTimeout(1500);
    /* ★ 只点「当前没高亮」的分类。
       若不加这个判断，重复跑本脚本时第二次点等于「取消勾选」，
       会出现「回到地上层点数 0」的假失败。 */
    const cats = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#catalogList .tk-cat'))
        .filter(e => !e.classList.contains('active'))
        .map(e => e.getAttribute('data-tkcat')));
    for (const c of cats) {
      await page.click(`#catalogList .tk-cat[data-tkcat="${c}"]`);
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(800);
    return page.evaluate(() => ({
      层: window.TOTK.state.layer,
      分类: Array.from(document.querySelectorAll('#catalogList .tk-cat')).map(e => e.querySelector('.cat-name').textContent),
      勾上数: document.querySelectorAll('#catalogList .tk-cat.active').length,
      点数: document.querySelectorAll('.tk-dot-wrap').length
    }));
  }

  for (const layer of [18, 19, 20]) {
    const r = await selectAll(layer);
    R['层' + layer] = {
      分类: r.分类, 勾上数: r.勾上数,
      点数: r.点数, 预期: EXPECT[layer], 符合: r.点数 === EXPECT[layer]
    };
  }

  /* 跨层往返：18 → 20 → 18，点数应恢复成地表的可上图点数 */
  await selectAll(18);
  await page.click('#layerSwitch button[data-layer="20"]');
  await page.waitForTimeout(1400);
  R['中途天空层'] = await page.evaluate(() => document.querySelectorAll('.tk-dot-wrap').length);
  await page.click('#layerSwitch button[data-layer="18"]');
  await page.waitForTimeout(1400);
  R['回到地上层'] = await page.evaluate(() => ({
    点数: document.querySelectorAll('.tk-dot-wrap').length,
    高亮: document.querySelectorAll('#catalogList .tk-cat.active').length
  }));
  R['往返符合'] = R['回到地上层'].点数 === EXPECT[18] && R['回到地上层'].高亮 > 0;

  R['错误'] = errs.length ? errs : '无';
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });