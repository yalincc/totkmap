// 中文语言包（默认源，与现有界面文案逐条一致——切换中文必须零视觉变化）
// 进度类别名（progress.*）= core progressCounts 的 key 英译基准，与 progress_totk2.go 对齐
// 注意：regions.js 的 913 个区域名是数据层，不做翻译（英文界面区域名显示中文）
export default {
  title: {
    main: 'TOTKNavi 定位导航',
    nav: 'TOTKNavi'
  },
  header: {
    settings: '设置',
    about: '关于',
    minimize: '最小化',
    close: '关闭'
  },
  sync: {
    waiting: '等待坐标流',
    syncing: '坐标流同步中',
    attached: '已附加 pid={pid}，定位中...',
    waitingProcess: '等待模拟器进程...',
    ready: '就绪'
  },
  // 手机镜像就绪状态（状态栏 appReadyText）
  mirror: {
    noUrl: '未检测到镜像地址',
    ready: '镜像已就绪',
    noIndex: '目录存在但缺 index.html',
    notFound: '未找到 app/ 目录',
    unknown: '状态未知'
  },
  steps: {
    ready: '就绪',
    locating: '定位中',
    verifying: '验证移动',
    locked: '已锁定'
  },
  state: {
    ready: '就绪',
    waitingProcess: '等待模拟器进程...',
    locating: '定位中...',
    knownUnconfirmed: '⚡ 秒锁 · 待移动确认',
    lockedUnconfirmed: '已锁定 · 待移动确认',
    verified: '已验证 · 跟随中'
  },
  layer: {
    '18': '地上',
    '19': '地下',
    '20': '天空'
  },
  source: {
    known: '⚡ 秒锁',
    chain: '🔗 指针链',
    scan: '扫描',
    probe: '探针换组',
    consensus: '共识恢复',
    locating: '定位中'
  },
  emu: {
    auto: '自动探测',
    ryujinx: 'Ryujinx',
    eden: 'Eden',
    pickTitle: '选择模拟器（改后需重启定位）'
  },
  buttons: {
    openMap: '打开网页地图',
    start: '开始定位',
    locating: '正在定位中',
    browse: '浏览',
    openDir: '打开目录',
    save: '保存',
    checking: '检查中...',
    cancel: '取消',
    confirm: '确认继续',
    later: '稍后',
    download: '下载',
    clear: '清屏',
    checkUpdate: '检查更新',
    exportDiag: '导出诊断包'
  },
  locate: {
    liveCoords: '实时同步坐标',
    offset: '偏移量',
    axisZ: 'Z 高度',
    currentLayer: '所在图层',
    calibration: '坐标校准',
    calWhenFail: '定位失败时使用',
    submit: '提交校准',
    calHint: '填写游戏内角色坐标，校准扫描内存约 5-20s',
    placeholder: '如 {v}',
    localProgress: '本地解析进度',
    categoryCount: '{n} / 20 类',
    waitingProgress: '等待读取存档...（需先开始定位）',
    noneProgress: '暂无存档数据'
  },
  precheck: {
    title: '⚠ 坐标差异较大',
    descPre: '你填的坐标与当前锁定位置相差',
    currentLock: '当前锁定',
    yourInput: '你填的',
    tip1: '· 确认读的是游戏右下角实时坐标（不打开地图），三位数字按 X / Y / Z 顺序',
    tip2: '· 红点位置明显不对（锁定可能不准）→ 点"确认继续"',
    tip3: '· 只是打错字 → 点"取消"回去改'
  },
  cal: {
    needInput: '✗ 坐标校准：请填写游戏内坐标（X Y Z）',
    submitting: '↻ 坐标校准：提交中…（扫描内存约 5-20s）',
    failed: '✗ 坐标校准失败：{err}',
    missDefault: '未命中，请保持站桩重试',
    locked: '✓ 坐标校准已锁定 {addr}{cp}',
    copies: '（匹配 {n} 个副本）',
    timeout: '校准超时：core 未响应（请确认已开始定位后重试）',
    submitFailed: '提交失败'
  },
  emuSwitch: '⚠ 模拟器已切换：请停止后重新开始定位生效',
  log: {
    title: '实时日志',
    none: '暂无日志',
    filter: '过滤...',
    shown: '{s} / {t}'
  },
  settings: {
    title: '设置',
    ryuPath: 'Ryujinx 存档路径：',
    edenPath: 'Eden 存档路径：',
    workDir: '工作目录（xnavi.exe 的日志 / known / status.json 所在）：',
    exeDir: 'exe 同目录（与 xnavi.exe 一起）',
    pathAuto: '留空自动探测',
    tls: '手机防息屏（Https）',
    tlsWarn: '【手机没装 CA 证书，不要勾选！】',
    saved: '已保存',
    pathOk: '✓ 路径有效',
    pathBad: '路径不存在（core 将回退自动探测）',
    language: '语言',
    langSystem: '跟随系统',
    langZh: '中文',
    langEn: 'English'
  },
  about: {
    title: '关于',
    subtitle: 'TOTKNavi · 王国之泪 (TOTK) 定位导航程序',
    version: '版本',
    map: '地图',
    github: 'GitHub',
    readOnly: '只读内存，不注入，不修改游戏。',
    latest: '已是最新版本',
    latestVer: '✓ 已是最新版 v{v}',
    checkFailed: '✗ {msg}'
  },
  update: {
    available: '有新版本可用',
    current: '当前',
    latest: '最新'
  },
  progress: {
    skyview: '鸟望台',
    tears: '龙之泪',
    shrines: '神庙',
    lightroots: '树根',
    koroks: '克洛格',
    koroksCarry: '双倍克洛格',
    bubbuls: '魔犹伊遗失物',
    treasureMaps: '残旧的地图',
    sageWills: '贤者的遗志',
    schemas: '设计图石板',
    addison: '卡邦达立牌',
    hinoxes: '独眼巨人',
    taluses: '岩石巨人',
    moldugas: '莫尔德拉吉克',
    flux: '方块魔像',
    frox: '巨霸伽马',
    gleethok: '古栗欧克',
    chasms: '地洞入口',
    caves: '洞穴入口',
    wells: '井'
  },
  // Go 端固定消息的映射基准（见 gomsg.js；这里放 key 便于两包对照）
  go: {
    pickDirTitle: '选择存档目录（可选，默认自动探测）'
  }
}
