/* ============================================================
 * TOTKMAP 浏览器端验收 · M3.1 官方分步清洗专项
 * ------------------------------------------------------------
 * 验收目标（对应 2026-10-06 修复）：
 *   1. 卡片官方分步的编号与文字必须逐条对得上，不出现空号
 *   2. 同一任务里不能出现两条一字不差的重复步骤
 *   3. 页面不得出现 U+FFFF / 私用区 / 控制字符等脏字符
 *   4. 全量扫一遍所有任务卡片的分步 DOM，编号连续、无空li
 *   5. 无官方词条的任务（Mercenary_HyrulePlain_Bloody 等）
 *      要显示明确说明，不能给一个空的编号架子
 *
 * 用法（★ http.server 必须和本脚本在同一条命令里，否则进程被回收）：
 *   cd app && python -m http.server 8899 --bind 127.0.0.1 > /tmp/h.log 2>&1 &
 *   SRV=$!; sleep 3
 *   cd <node workspace> && NODE_PATH=<workspace>/node_modules node verify_m3_1_steps.js
 *   kill $SRV
 * ============================================================ */
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:8899/index.html';

/* 脏字符判定：U+FFFF/FFFE/FFFD、私用区(U+CD00-U+F8FF)、除\n\t 外的控制字符 */
const isDirty = (s) => [...s].some((c) => {
  const o = c.codePointAt(0);
  return o === 0xFFFF || o === 0xFFFE || o === 0xFFFD ||
         (o >= 0xCD00 && o <= 0xCFFF) ||   /* 韩文音节区残留 */
         (o >= 0xE000 && o <= 0xF8FF) ||   /* 私用区 */
         (o < 0x20 && c !== '\n' && c !== '\t');
});

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

  /* ---------- 0. 数据层断言（不依赖 DOM，最硬的证据） ---------- */
  const dataChk = await page.evaluate(() => {
    /* ★ 用码点判断，不能用字符类正则：
       私用区是 U+E000-U+F8FF，而 U+F8FF 之前还压着大量
       CJK 兼容汉字（U+FAxx 等），字面量字符类容易把正常汉字圈进去。 */
    const isDirty = (s) => [...s].some((c) => {
      const o = c.codePointAt(0);
      return o === 0xFFFF || o === 0xFFFE || o === 0xFFFD ||
             (o >= 0xCD00 && o <= 0xCFFF) ||   /* 韩文音节区残留（촀 = U+CD00） */
             (o >= 0xE000 && o <= 0xF8FF) ||   /* 私用区 */
             (o < 0x20 && c !== '\n' && c !== '\t');
    });
    const P = window.TOTK_TASK_PLAN || [];
    const out = {
      total: P.length,
      noStepsUI: 0, emptyStep: 0, dupInTask: 0, dirtyStep: 0,
      gapMark: 0, zeroButNotNull: 0,
      samples: {},
    };
    for (const t of P) {
      if (!Array.isArray(t.stepsUI)) { out.noStepsUI++; continue; }
      for (const s of t.stepsUI) {
        if (!s.text || !s.text.trim()) out.emptyStep++;
        if (isDirty(s.text)) out.dirtyStep++;
        if (s.text.includes('（数量）')) out.gapMark++;
      }
      const seen = new Set();
      for (const s of t.stepsUI) {
        if (seen.has(s.text)) { out.dupInTask++; break; }
        seen.add(s.text);
      }
      if (t.stepsUI.length === 0 && t.nSteps > 0) out.zeroButNotNull++;
    }
    const one = P.find(t => t.key === 'Connect_FirstIsland');
    if (one) out.samples.Connect_FirstIsland = {
      nSteps: one.nSteps, nStepsUI: one.nStepsUI,
      texts: one.stepsUI.map(s => s.text.replace(/\n/g, ' / ')),
    };
    const mer = P.find(t => t.key === 'Mercenary_HyrulePlain_Bloody');
    if (mer) out.samples.Mercenary = {
      nSteps: mer.nSteps, nStepsUI: mer.nStepsUI,
      hasStepText: mer.hasStepText, onMap: mer.onMap,
    };
    return out;
  });

  /* ---------- 1. 勾选全部四个任务分类 ---------- */
  for (const c of ['Main', 'ImportantMini', 'Sub', 'Other']) {
    await page.click(`#catalogList .tk-cat[data-tkcat="${c}"]`);
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(1200);

  /* ---------- 2. 遍历所有任务点，逐个开卡片验分步 DOM ---------- */
  const dots = await page.$$('.tk-dot-wrap');
  const domIssues = [];
  let checkedCards = 0, cardsWithSteps = 0, totalStepLi = 0, dirtyDom = 0;
  let dupDots = 0, openFail = 0;
  const openFailSamples = [];
  const seenNames = new Set();

  for (let i = 0; i < dots.length; i++) {
    /* 去重：任务点没有 data-name，用 title（=任务名，见 taskIconDot）标识。
       同坐标多任务会被 Leaflet 折叠，DOM 里只留一个点，重复点到同一个卡片。*/
    const nm = (await dots[i].getAttribute('title')) || ('idx' + i);
    if (seenNames.has(nm)) { dupDots++; continue; }
    seenNames.add(nm);

    /* ★ 用 JS 直接派发点击，不用 playwright 的 click()：
       卡片是 fixed 定位，可能盖住后面的任务点导致 click 超时
       （实测 236 个点里 95 个被挡）。这里模拟真实用户点圆点即可。 */
    await page.evaluate((el) => {
      el.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, view: window,
        clientX: el.getBoundingClientRect().left + 9,
        clientY: el.getBoundingClientRect().top + 9
      }));
    }, dots[i]);
    await page.waitForTimeout(110);

    const r = await page.evaluate(() => {
      const card = document.getElementById('taskCard');
      if (!card || card.classList.contains('hidden')) return null;
      const nameEl = card.querySelector('.tk-name');
      const lis = Array.from(card.querySelectorAll('.tk-steps .tk-step'));
      return {
        name: nameEl ? nameEl.textContent.trim() : '',
        secTitles: Array.from(card.querySelectorAll('.tk-sec-t')).map(e => e.textContent.trim()),
        nos: lis.map(li => {
          const n = li.querySelector('.tk-step-no');
          return n ? n.textContent.trim() : '';
        }),
        txs: lis.map(li => {
          const x = li.querySelector('.tk-step-tx');
          return x ? x.textContent.trim() : '';
        }),
        meta: (() => {
          const rows = Array.from(card.querySelectorAll('.tk-mrow'));
          const m = rows.find(r => (r.querySelector('.tk-mk') || {}).textContent === '步骤');
          return m ? m.querySelector('.tk-mv').textContent.trim() : '';
        })(),
        note: (() => {
          const n = card.querySelector('.tk-note');
          return n ? n.textContent.trim() : '';
        })(),
        none: (() => {
          const n = card.querySelector('.tk-none');
          return n ? n.textContent.trim() : '';
        })(),
      };
    });
    if (!r) {
      openFail++;
      if (openFail <= 5) {
        const st = await page.evaluate(() => {
          const c = document.getElementById('taskCard');
          return { hidden: !c || c.classList.contains('hidden'),
                   hasBody: !!(c && c.querySelector('.tk-name')) };
        });
        openFailSamples.push(nm + ' | cardHidden=' + st.hidden + ' 有名字=' + st.hasBody);
      }
      await page.waitForTimeout(150);
      continue;
    }
    checkedCards++;

    if (r.nos.length) cardsWithSteps++;
    totalStepLi += r.nos.length;

    /* 2a编号必须从1 连续递增 —— 错位的直接证据 */
    for (let k = 0; k < r.nos.length; k++) {
      if (r.nos[k] !== String(k + 1)) {
        domIssues.push(`${r.name}: 编号不连续 第${k + 1}项显示"${r.nos[k]}"`);
      }
    }
    /* 2b 每一步都必须有文字 —— 空号就是老bug */
    for (let k = 0; k < r.txs.length; k++) {
      if (!r.txs[k]) domIssues.push(`${r.name}: 第${r.nos[k]}步无文字`);
    }
    /* 2c 同一卡片内不得有完全重复的两步 */
    const s2 = new Set();
    for (const t of r.txs) {
      if (s2.has(t)) { domIssues.push(`${r.name}: 卡内出现重复步骤「${t.slice(0, 18)}…」`); break; }
      s2.add(t);
    }
    /* 2d DOM 上不能有脏字符 */
    for (const t of r.txs) {
      if (isDirty(t)) { dirtyDom++; domIssues.push(`${r.name}: 步骤含脏字符`); break; }
    }
    /* 2e 有分步时必须显示官方分步分区 */
    if (r.nos.length && !r.secTitles.some(s => s.includes('官方分步'))) {
      domIssues.push(`${r.name}: 有步骤但缺「官方分步」分区`);
    }
    /* 2f 无官方词条的任务要如实说明，不能是空架子 */
    if (!r.nos.length && r.secTitles.some(s => s.includes('官方分步')) && !r.none) {
      domIssues.push(`${r.name}: 显示官方分步分区但内容为空`);
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
  }

  /* ---------- 3. 定点复核：老问题的两个案例 ---------- */
  const focus = {};
  for (const key of ['Connect_FirstIsland', 'Mercenary_HyrulePlain_Bloody']) {
    focus[key] = await page.evaluate((k) => {
      const D = window.TaskData;
      const t = D && D.byKey ? D.byKey(k) : null;
      if (!t) return { found: false };
      return {
        found: true, name: t.name,
        nSteps: t.nSteps, nStepsUI: t.nStepsUI, hasStepText: t.hasStepText,
        stepsUI: (t.stepsUI || []).map(s => s.text.replace(/\n/g, ' / ')),
      };
    }, key);
  }

  await browser.close();

  /* ---------- 报告 ---------- */
  const L = (k, v) => console.log('  ' + k.padEnd(22, '.') + ' ' + v);
  console.log('\n════M3.1 官方分步清洗验收 ════\n');
  console.log('【数据层】');
  L('task-plan 总数', dataChk.total);
  L('缺 stepsUI 字段', dataChk.noStepsUI);
  L('空文字步骤', dataChk.emptyStep);
  L('同任务内重复步骤', dataChk.dupInTask);
  L('含脏字符步骤', dataChk.dirtyStep);
  L('（数量）标注步骤', dataChk.gapMark + '（预期 3）');
  /* 13 = 12 个官方词条文件不存在（nameSrc=key）+ 1 个正文只有控制字符
     （Rito_MedoArmor「沉睡于山中秘泉的秘宝」，MSBT 里就 两个字节）。
     注意与 dry 输出的「无可展示分步 14个」区分：那个多算的是 nSteps=0 的
     「一发入魂！？」，它本来就没有步骤，不该进这个断言。 */
  L('0步但nSteps>0', dataChk.zeroButNotNull + '（预期 13：12无词条+1纯控制字符）');

  console.log('\n【DOM 层】');
  L('DOM 任务点总数', dots.length);
  L('title 去重后', seenNames.size + (dupDots ? '（折叠重复 ' + dupDots + '）' : ''));
  /* 已知既有缺口（非本次修复引入）：「一发入魂！？」是 src=guide 的纯攻略条目，
     tasks.js 里 key=null（ROM 里查不到），地图点能画但点开无卡片。
     这类攻略孤儿任务全库仅 1 条，M4 之后应统一处理。 */
  L('打开失败', openFail + (openFail ? '（已知缺口: ' + openFailSamples.join(' ; ') + '）' : ''));
  L('成功打开卡片', checkedCards);
  L('含分步的卡片', cardsWithSteps);
  L('分步 <li> 总数', totalStepLi);
  L('DOM 脏字符', dirtyDom);
  L('DOM 问题', domIssues.length === 0 ? '0 全部通过' : domIssues.length);

  console.log('\n【定点复核】');
  for (const k of Object.keys(focus)) {
    const f = focus[k];
    console.log('  --- ' + k + ' ---');
    if (!f.found) { console.log('    未找到'); continue; }
    console.log(`    name=${f.name}  nSteps=${f.nSteps} nStepsUI=${f.nStepsUI} hasStepText=${f.hasStepText}`);
    (f.stepsUI || []).forEach((t, i) => console.log(`      ${i + 1}. ${t.slice(0, 96)}`));
    if (!f.stepsUI.length) console.log('      （无官方分步，卡片应显示说明）');
  }

  if (domIssues.length) {
    console.log('\n【问题明细（前 20）】');
    domIssues.slice(0, 20).forEach(s => console.log('  ✗ ' + s));
  }
  if (errs.length) {
    console.log('\n【控制台错误】');
    [...new Set(errs)].slice(0, 10).forEach(s => console.log('  ! ' + s));
  }

  /* 打开失败只允许「一发入魂！？」这 1 条已知缺口，其余都要为 0 */
  const KNOWN_OPEN_FAIL = 1;
  const pass = dataChk.noStepsUI === 0 && dataChk.emptyStep === 0 &&
               dataChk.dupInTask === 0 && dataChk.dirtyStep === 0 &&
               dataChk.gapMark === 3 && dataChk.zeroButNotNull === 13 &&
               domIssues.length === 0 && dirtyDom === 0 && errs.length === 0 &&
               openFail <= KNOWN_OPEN_FAIL;
  console.log('\n结果：' + (pass ? '✅ 全部通过' : '❌ 有失败项') + '\n');
  process.exit(pass ? 0 : 1);
})();
