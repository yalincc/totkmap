/* ============================================================
 * 任务板块 · M5 · 完成状态管理层（TOTKMAP V2.1）
 * ------------------------------------------------------------
 * 职责：统一管理 285 个任务的「已完成」标记，两个来源：
 *   1) 存档态 —— 从 progress.sav 读出的真实游戏进度（权威）
 *   2) 手动态 —— 用户点「标记完成」写进 localStorage（兜底/补充）
 *
 * ★ 为什么两个来源要分开存：
 *   存档是游戏真实进度，权威性最高 —— 每次重新加载存档都应覆盖手动态。
 *   但存档里没有的条目（key=null 的攻略孤儿条目、用户想提前标记的支线）
 *   只能靠 localStorage。所以展示时取并集，冲突时存档优先。
 *
 * 存档机制详见 TOTK任务存档同步机制-调研结论.md：
 *   键 = hash('Step_'+任务key)，值 = 阶段名哈希，等于 hash('Complete') 即完成。
 * ============================================================ */
(function (global) {
  'use strict';

  var LS_MANUAL = 'totkmap_task_done_v1';
  var TASK_DATA = global.TaskData || null;

  /* ---------- 状态 ---------- */
  var saveState = {};    /* key -> {done, stage, idx, total}  来自存档 */
  var manual = {};       /* key -> true                      来自 localStorage */
  var listeners = [];

  /* ---------- localStorage ---------- */
  function loadManual() {
    manual = {};
    try {
      var raw = global.localStorage.getItem(LS_MANUAL);
      if (!raw) return;
      var obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        Object.keys(obj).forEach(function (k) {
          if (obj[k]) manual[k] = true;
        });
      }
    } catch (e) { /* 隐私模式 / 配额满：静默降级为纯存档态 */ }
  }

  function persistManual() {
    try {
      global.localStorage.setItem(LS_MANUAL, JSON.stringify(manual));
    } catch (e) { /* 存不进去也不该炸，内存里照常生效 */ }
  }

  /* ---------- 对外查询 ---------- */

  /* 该任务是否已完成（存档 OR 手动） */
  function isDone(key) {
    if (!key) return false;
    if (saveState[key] && saveState[key].done) return true;
    return !!manual[key];
  }

  /* 详细状态：给卡片显示用
     { done, src:'save'|'manual'|'', stage, idx, total } */
  function status(key) {
    var s = saveState[key];
    if (s && s.done) {
      return { done: true, src: 'save', stage: s.stage, idx: s.idx, total: s.total };
    }
    if (manual[key]) return { done: true, src: 'manual', stage: '', idx: -1, total: 0 };
    if (s) return { done: false, src: 'save', stage: s.stage, idx: s.idx, total: s.total };
    return { done: false, src: '', stage: '', idx: -1, total: 0 };
  }

  /* 统计：面板标题用。scope 传 TASKS 数组时只数可上图任务 */
  function stats(list) {
    var arr = list || (TASK_DATA ? TASK_DATA.tasks : []);
    var n = 0;
    arr.forEach(function (t) {
      if (isDone(t.key)) n++;
    });
    return { done: n, total: arr.length };
  }

  /* ---------- 写操作 ---------- */

  /* 切换完成态。返回切换后的状态。
     ⚠️ 存档里已完成的，不允许取消 —— 那是游戏真实进度，
        强行取消会和下次加载存档打架。 */
  function toggle(key) {
    if (!key) return status(key);
    /* ⚠️ 同理必须判 done：只要任务出现在存档里，status().src 就是 'save'，
       但只有 done 为真时才代表「游戏里已完成」，才不允许取消。 */
    if (saveState[key] && saveState[key].done) {
      notify();
      return status(key);
    }
    if (manual[key]) delete manual[key];
    else manual[key] = true;
    persistManual();
    notify();
    return status(key);
  }

  function markDone(key) {
    if (!key) return;
    if (saveState[key] && saveState[key].done) return;
    manual[key] = true;
    persistManual();
    notify();
  }

  function markUndone(key) {
    if (!key) return;
    delete manual[key];
    persistManual();
    notify();
  }

  /* 全部清掉手动标记（存档态不动） */
  function clearManual() {
    manual = {};
    persistManual();
    notify();
  }

  /* ---------- 存档接入 ---------- */

  /* 从 TOTKSaveParser.questDone() 的结果刷新存档态。
     parsed 可以为 null（未加载存档）→ 只清存档态，手动态保留。 */
  function applySave(questMap) {
    saveState = questMap || {};
    notify();
  }

  /* 是否有存档数据（用于决定面板上显示哪种提示） */
  function hasSave() {
    return Object.keys(saveState).length > 0;
  }

  /* ---------- 订阅 ---------- */
  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }
  function notify() {
    listeners.forEach(function (fn) {
      try { fn(); } catch (e) { /* 单个订阅者出错不影响其他 */ }
    });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    loadManual();
    /* TaskData 是单独 script，加载顺序可能在本模块之后 → 等一下 */
    if (!TASK_DATA) {
      setTimeout(function () {
        TASK_DATA = global.TaskData;
      }, 0);
    }
    notify();
  }

  /* 手动态导出/导入（给「导出进度」类功能用） */
  function exportManual() {
    return JSON.stringify(manual);
  }
  function importManual(str) {
    try {
      var obj = JSON.parse(str);
      manual = {};
      Object.keys(obj || {}).forEach(function (k) {
        if (obj[k]) manual[k] = true;
      });
      persistManual();
      notify();
    } catch (e) { /* 坏数据不导入，保持原状 */ }
  }

  global.TaskDone = {
    init: init,
    isDone: isDone,
    status: status,
    stats: stats,
    toggle: toggle,
    markDone: markDone,
    markUndone: markUndone,
    clearManual: clearManual,
    applySave: applySave,
    hasSave: hasSave,
    onChange: onChange,
    exportManual: exportManual,
    importManual: importManual,
    LS_KEY: LS_MANUAL
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);