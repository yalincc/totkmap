/* ============================================================
 * TOTKmap 国际化引擎（i18n）
 * 零第三方依赖、轻量级原生单例、中/英双语切换与优雅 Fallback
 * 参考对标 BOTWmap v1.7.0 双语体系
 * ============================================================ */
'use strict';

const I18N = (() => {
  const STORAGE_KEY = 'totkmap.lang.v1';
  let curLang = 'zh';
  const listeners = [];

  function init() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'en' || saved === 'zh') {
        curLang = saved;
      }
    } catch (e) {}
    if (document.documentElement) {
      document.documentElement.lang = curLang === 'en' ? 'en' : 'zh-CN';
    }
  }

  function getLang() {
    return curLang;
  }

  function t(key, fallback) {
    if (!key) return '';
    const dict = (window.TOTK_I18N && window.TOTK_I18N[curLang]) || {};
    if (dict[key] !== undefined && dict[key] !== null) return dict[key];
    const zhDict = (window.TOTK_I18N && window.TOTK_I18N.zh) || {};
    if (zhDict[key] !== undefined && zhDict[key] !== null) return zhDict[key];
    return fallback !== undefined ? fallback : key;
  }

  // 大组与分类中英映射
  function catOf(name) {
    if (!name) return '';
    if (curLang === 'en') {
      const key = 'cat.' + name;
      const translated = t(key, null);
      if (translated) return translated;
      if (window.TOTK_NAMES_EN && window.TOTK_NAMES_EN[name]) return window.TOTK_NAMES_EN[name];
    }
    return name;
  }

  function groupOf(name) {
    if (!name) return '';
    if (curLang === 'en') {
      const key = 'group.' + name;
      const translated = t(key, null);
      if (translated) return translated;
    }
    return name;
  }

  // 点位名称（支持神庙/树根/鸟望台/克洛格正则/复合名拆分）
  function nameOf(item) {
    if (!item) return '';
    var rawName = String((typeof item === 'string') ? item : (item.name || item.title || item.full || '')).trim();
    if (!rawName) return '';

    if (curLang === 'en') {
      // 0. 优先查权威标点字典（全图 2,996 标点 100% 精确官方映射）
      if (item && item.id && window.TOTK_MARKERS_EN && window.TOTK_MARKERS_EN[item.id]) {
        return window.TOTK_MARKERS_EN[item.id];
      }
      if (typeof item === 'number' && window.TOTK_MARKERS_EN && window.TOTK_MARKERS_EN[item]) {
        return window.TOTK_MARKERS_EN[item];
      }

      // 1. 如果对象本身自带 en
      if (item.en) return item.en;

      // 1.1 鸟望台模糊与错别字优先兜底
      if (rawName.indexOf('鸟望台') >= 0) {
        if (rawName.indexOf('卡尔加') >= 0 || rawName.indexOf('卡鲁加') >= 0 || rawName.indexOf('罗斯普利') >= 0) {
          return 'Rospro Pass Skyview Tower';
        }
        var cleanTower = rawName.replace(/\s+/g, '');
        if (window.TOTK_NAMES_EN && window.TOTK_NAMES_EN[cleanTower]) return window.TOTK_NAMES_EN[cleanTower];
      }

      // 1.2 神庙带后缀处理（如 "欧塔卡卡神庙 从洞窟进" -> "Otak Shrine"）
      if (rawName.indexOf('神庙') >= 0) {
        var sm = rawName.match(/([^\s（(]+神庙)/);
        if (sm && window.TOTK_NAMES_EN && window.TOTK_NAMES_EN[sm[1]]) {
          return window.TOTK_NAMES_EN[sm[1]];
        }
      }

      // 2. 克洛格特殊规则（覆盖单人与双倍/运输呀哈哈）
      if (rawName.indexOf('克洛格') >= 0 || rawName.indexOf('呀哈哈') >= 0 || (item.cat && (item.cat === 73 || item.cat === 96 || item.cat === 118 || item.cat === 130 || item.cat === 145 || item.cat === 160))) {
        const isCarry = rawName.indexOf('双倍') >= 0 || rawName.indexOf('运输') >= 0 || (item.cat && (item.cat === 130 || item.cat === 145 || item.cat === 160));
        const m = rawName.match(/No\.?\s*(\d+)/i) || rawName.match(/#(\d+)/) || rawName.match(/(\d+)$/);
        const num = m ? (' #' + m[1]) : (item.id ? (' #' + item.id) : '');
        return isCarry ? ('Carry Korok' + num) : ('Korok Seed' + num);
      }

      // 3. 宝箱特殊前缀与圆括号提取
      if (rawName.indexOf('宝箱') >= 0) {
        if (rawName === '宝箱' || rawName === '埋起来的宝箱') return 'Treasure Chest';
        if (rawName.indexOf('莱尼尔弓') >= 0) return 'Treasure Chest: Lynel Bow';
        if (rawName.startsWith('宝箱-')) {
          var sub = rawName.slice(3).trim();
          var subEn = window.TOTK_NAMES_EN && window.TOTK_NAMES_EN[sub] ? window.TOTK_NAMES_EN[sub] : nameOf(sub);
          return 'Treasure Chest: ' + subEn;
        }
        var mChest = rawName.match(/宝箱[（\(]([^)）]+)[)）]/);
        if (mChest) {
          var inside = mChest[1].trim();
          var insideEn = window.TOTK_NAMES_EN && window.TOTK_NAMES_EN[inside] ? window.TOTK_NAMES_EN[inside] : nameOf(inside);
          return 'Treasure Chest: ' + insideEn;
        }
      }

      // 4. Boss 怪物地名前缀剥离匹配（莱尼尔、西诺克斯、岩石巨人等）
      const bossTypes = [
        ['蓝鬃莱尼尔', 'Blue-Maned Lynel'], ['白鬃人马', 'White-Maned Lynel'], ['白鬃莱尼尔', 'White-Maned Lynel'],
        ['白银人马', 'Silver Lynel'], ['白银莱尼尔', 'Silver Lynel'], ['红鬃莱尼尔', 'Red-Maned Lynel'],
        ['莱尼尔', 'Lynel'], ['人马', 'Lynel'],
        ['蓝色西诺克斯', 'Blue Hinox'], ['黑色西诺克斯', 'Black Hinox'], ['骷髅西诺克斯', 'Stalnox'],
        ['蓝色独眼巨人', 'Blue Hinox'], ['黑色独眼巨人', 'Black Hinox'], ['骷髅独眼巨人', 'Stalnox'], ['骷颅独眼巨人', 'Stalnox'],
        ['西诺克斯', 'Hinox'], ['独眼巨人', 'Hinox'],
        ['夜光岩石巨人', 'Luminous Stone Talus'], ['夜光石巨人', 'Luminous Stone Talus'],
        ['稀有岩石巨人', 'Rare Stone Talus'], ['熔岩巨人', 'Igneo Talus'], ['熔岩石巨人', 'Igneo Talus'],
        ['冰岩石巨人', 'Frost Talus'], ['冰岩巨人', 'Frost Talus'],
        ['岩家巨人', 'Stone Talus'], ['岩石巨人', 'Stone Talus'],
        ['黑曜巨霸伽马', 'Obsidian Frox'], ['白苍巨霸伽马', 'Blue-White Frox'], ['巨霸伽马', 'Frox'],
        ['火焰古栗欧克', 'Flame Gleeok'], ['冰冻古栗欧克', 'Frost Gleeok'], ['雷电古栗欧克', 'Thunder Gleeok'],
        ['古栗欧克王', 'King Gleeok'], ['古力欧克之王', 'King Gleeok'], ['古栗欧克', 'Gleeok'], ['古力欧克', 'Gleeok'],
        ['初级方块魔像', 'Flux Construct I'], ['中级方块魔像', 'Flux Construct II'], ['特级方块魔像', 'Flux Construct III'],
        ['方块魔像（上等）', 'Flux Construct III'], ['方块魔像（中等）', 'Flux Construct II'], ['方块魔像', 'Flux Construct'],
        ['岩八爪鱼', 'Rock Octorok'], ['岩八爪怪', 'Rock Octorok'], ['八爪鱼', 'Octorok'], ['八爪怪', 'Octorok'],
        ['莫尔德拉吉克', 'Molduga']
      ];
      for (let i = 0; i < bossTypes.length; i++) {
        if (rawName.indexOf(bossTypes[i][0]) >= 0) {
          return bossTypes[i][1];
        }
      }

      // 5. 查官方英文字典
      if (window.TOTK_NAMES_EN) {
        if (window.TOTK_NAMES_EN[rawName]) return window.TOTK_NAMES_EN[rawName];

        // 兼容复合名称（如 "大妖精之泉-大妖精 弥佳" 或 "鸟望台-监视堡垒"）
        if (rawName.indexOf('-') > 0) {
          const parts = rawName.split('-');
          const lastPart = parts[parts.length - 1].trim();
          if (window.TOTK_NAMES_EN[lastPart]) return window.TOTK_NAMES_EN[lastPart];
          const p0 = window.TOTK_NAMES_EN[parts[0].trim()] || catOf(parts[0].trim());
          const p1 = window.TOTK_NAMES_EN[lastPart] || catOf(lastPart);
          if (p0 && p1) return p0 + ' - ' + p1;
          if (p1) return p1;
          if (p0) return p0;
        }

        // 兼容括号（如 "方块魔像（上等）"）
        const brMatch = rawName.match(/^(.*?)[（\(](.*?)[）\)]$/);
        if (brMatch) {
          const base = brMatch[1].trim();
          const sub = brMatch[2].trim();
          const baseEn = window.TOTK_NAMES_EN[base] || base;
          const subEn = window.TOTK_NAMES_EN[sub] || sub;
          return baseEn + ' (' + subEn + ')';
        }
      }

      return item.name_en || rawName;
    }

    return rawName;
  }

  // 区域翻译
  function regionOf(str) {
    if (!str) return '';
    if (curLang === 'en' && window.TOTK_NAMES_EN && window.TOTK_NAMES_EN[str]) {
      return window.TOTK_NAMES_EN[str];
    }
    return str;
  }

  // 塔域翻译
  function towerOf(str) {
    if (!str) return '';
    if (curLang === 'en') {
      var res = nameOf(str);
      if (res && res !== str) return res;
      var withTower = str.endsWith('鸟望台') ? str : (str + '鸟望台');
      return nameOf(withTower);
    }
    return str;
  }

  // 试炼名称（劳鲁的祝福、战斗的教导等）
  function trialOf(str) {
    if (!str) return '';
    if (curLang === 'en') {
      if (/祝福$/.test(str)) return "Rauru's Blessing";
      if (/教导/.test(str)) return "Combat Training";
      if (/一身赤裸/.test(str)) return "Proving Grounds";
      if (/上升之力/.test(str)) return "The Power to Rise";
      if (/组合之力/.test(str)) return "The Power to Combine";
      if (/连接之力/.test(str)) return "The Power to Attach";
      if (/回溯之力/.test(str)) return "The Power to Rewind";
      if (/通天之力/.test(str)) return "The Power to Ascend";
      if (window.TOTK_NAMES_EN && window.TOTK_NAMES_EN[str]) return window.TOTK_NAMES_EN[str];
    }
    return str;
  }

  function descOf(item) {
    if (!item) return '';
    if (curLang === 'en') {
      return item.desc_en || item.hint_en || item.en || item.desc || item.hint || '';
    }
    return item.desc || item.hint || '';
  }

  // 更新 DOM 中的静态文案
  function updateDOM() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const k = el.getAttribute('data-i18n');
      if (k) {
        const val = t(k, null);
        if (val !== null) el.textContent = val;
      }
    });
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
      const k = el.getAttribute('data-i18n-html');
      if (k) {
        const val = t(k, null);
        if (val !== null) el.innerHTML = val;
      }
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const k = el.getAttribute('data-i18n-title');
      if (k) {
        const val = t(k, null);
        if (val !== null) el.setAttribute('title', val);
      }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const k = el.getAttribute('data-i18n-placeholder');
      if (k) {
        const val = t(k, null);
        if (val !== null) el.setAttribute('placeholder', val);
      }
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => {
      const k = el.getAttribute('data-i18n-aria');
      if (k) {
        const val = t(k, null);
        if (val !== null) el.setAttribute('aria-label', val);
      }
    });
    document.querySelectorAll('[data-i18n-alt]').forEach(el => {
      const k = el.getAttribute('data-i18n-alt');
      if (k) {
        const val = t(k, null);
        if (val !== null) el.setAttribute('alt', val);
      }
    });
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function setLang(lang) {
    if (lang !== 'zh' && lang !== 'en') return;
    curLang = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {}
    if (document.documentElement) {
      document.documentElement.lang = curLang === 'en' ? 'en' : 'zh-CN';
    }
    updateDOM();
    listeners.forEach(fn => {
      try { fn(curLang); } catch (e) { console.error('i18n listener error:', e); }
    });
  }

  // 15 座鸟望台精炼官方英文解谜提示
  const TOWER_NOTES_EN = {
    "拉贝拉湿地带鸟望台": "Build a shelter with boards over the thorns, then burn them with fire to access the entrance.",
    "拉聂尔山鸟望台": "Cold high-altitude area. Prepare cold resistance clothing and use a hot-air balloon or flying machine to reach the entrance.",
    "撒哈斯拉平原鸟望台": "Enter the cave below the tower, clear the rocks, defeat the Bubbulfrog, then use Ascend into the tower and remove the two sticks blocking the door.",
    "泡泡拉高地鸟望台": "Go down the well north of the tower, talk to the trapped person, use Ascend to return outside, find the southern cave entrance, step on the floor switch to rescue him, then return to the tower.",
    "格鲁德峡谷鸟望台": "The elevator is broken. Place iron blocks on the elevator lift to counterweight and pull the repair worker up.",
    "格鲁德高地鸟望台": "The tower entrance is buried in snow. Find the cave entrance to the rear-right, go deep inside, place boards between the four pillars, and use Ascend into the tower.",
    "海拉鲁平原鸟望台": "Defeat the surrounding enemy camp. Use Ascend behind the Moblin to ambush, and use Recall on spiked balls rolled down by enemies.",
    "监视堡垒鸟望台": "Starter tower at Lookout Landing. Can be activated directly without puzzles.",
    "卓拉台地鸟望台": "The entrance is blocked by sludge. Fuse a Splash Fruit to an arrow and shoot the sludge to clean it.",
    "乌尔利山鸟望台": "An Aerocuda is flying nearby holding the terminal console. Shoot it down with an arrow + Keese Eyeball, grab the console and place it back.",
    "奥尔汀峡谷鸟望台": "Climb onto a fallen sky rock near the tower, use Recall on the rock to launch into the sky, then glide down through the open roof.",
    "德依布朗遗迹鸟望台": "Use Rockets combined with floating platforms to ascend into the sky, then glide onto the tower roof and move the blockage away.",
    "拉布拉山鸟望台": "Surrounded by deep water. Use nearby construction lumber to build a bridge across the water to reach the tower.",
    "茨茨齐齐雪原鸟望台": "Cold snowfield tower. Bring cold resistance clothing; build a scaffold with wooden boards or glide from the Wind Temple.",
    "卡尔加玲鸟望台": "Burn the thorns blocking the entrance with fire. Cold resistance clothing recommended."
  };

  function towerNoteOf(towerName, chineseNote) {
    if (!towerName) return chineseNote || '';
    if (curLang === 'en') {
      var clean = towerName.replace(/\s+/g, '').replace(/鸟望台$/, '');
      for (var k in TOWER_NOTES_EN) {
        var cleanK = k.replace(/\s+/g, '').replace(/鸟望台$/, '');
        if (clean.indexOf(cleanK) >= 0 || cleanK.indexOf(clean) >= 0) {
          return TOWER_NOTES_EN[k];
        }
      }
    }
    return chineseNote || '';
  }

  // 简明神庙位置短语
  function placeOf(str) {
    if (!str) return '';
    if (curLang === 'en') {
      if (str.includes('平原')) return 'On the surface plains';
      if (str.includes('树林') || str.includes('森林')) return 'In the forest';
      if (str.includes('洞窟') || str.includes('洞穴')) return 'Inside the cave';
      if (str.includes('井')) return 'Inside the well';
      if (str.includes('空岛') || str.includes('天空')) return 'On the sky island';
      if (str.includes('雪山') || str.includes('雪原')) return 'In the snowy mountains';
      if (str.includes('沙漠')) return 'In the Gerudo Desert';
      if (str.includes('地底') || str.includes('地下')) return 'In the Depths';
      if (str.includes('海滩') || str.includes('海边')) return 'On the beach';
      if (str.includes('火山') || str.includes('熔岩')) return 'Near Death Mountain volcano';
      if (str.includes('山顶') || str.includes('山岳')) return 'On the mountain peak';
    }
    return str;
  }

  init();

  return {
    getLang,
    setLang,
    t,
    catOf,
    groupOf,
    nameOf,
    descOf,
    regionOf,
    towerOf,
    trialOf,
    towerNoteOf,
    placeOf,
    updateDOM,
    onChange
  };
})();

window.I18N = I18N;
