/* Single source of truth for the KingAgent audit report.
 *
 * Every number and every finding in docs/audit/*.html comes from here, so a
 * figure can never drift between the overview and the detail page. Regenerate
 * the measured blocks with `node docs/audit/collect.mjs` — that script
 * overwrites AUDIT.metrics and AUDIT.charts below; the findings themselves
 * are hand-written because a human read the code to produce them.
 *
 * Measured 2026-09-30 against commit 457cc45.
 */
window.AUDIT = (function () {
  const SEV = {
    critical: { key: 'critical', label: 'حرج', order: 0 },
    high:     { key: 'high',     label: 'عالٍ', order: 1 },
    medium:   { key: 'medium',   label: 'متوسط', order: 2 },
    low:      { key: 'low',      label: 'منخفض', order: 3 },
  };

  const metrics = {
    commit: '457cc45',
    measuredOn: '2026-09-30',
    version: '0.5.6',

    project: {
      commits: 85,
      contributors: 4,
      firstCommit: '2026-09-12',
      lastCommit: '2026-09-24',
      srcFiles: 381,
      srcLines: 63074,
      srcMB: 4.3,
      coreFiles: 238,
      coreLines: 28613,
      mainFiles: 75,
      cssFiles: 11,
      cssLines: 4751,
      testFiles: 185,
      vendorMB: 1.4,
    },

    gates: {
      tests: { total: 2216, pass: 2202, fail: 0, skip: 14, ms: 121688 },
      lint: { errors: 0, warnings: 0 },
      coverage: { lines: 85.97, statements: 85.97, functions: 83.77, branches: 76.37 },
      coverageGate: { lines: 70, statements: 70, functions: 80, branches: 70 },
      auditVulns: { critical: 0, high: 3, moderate: 2, total: 5 },
    },

    coverageByDomain: {
      core: { files: 237, linesTotal: 40030, linesPct: 92.5 },
      main: { files: 75,  linesTotal: 12866, linesPct: 65.7 },
      total: { files: 312, linesTotal: 52896, linesPct: 85.97 },
    },

    /* Twelve main-process files carry zero line coverage. This is the number
     * that matters: main.js and browser-views.js are the two files holding the
     * critical findings in this report. */
    zeroCoverage: [
      { file: 'main.js',               lines: 1813, holds: 'CRITICAL #1,#2,#3 + HIGH #4,#5,#10' },
      { file: 'browser-views.js',      lines: 669,  holds: 'HIGH #9 sync freeze' },
      { file: 'preload.js',            lines: 363,  holds: 'the IPC surface itself' },
      { file: 'terminal.js',           lines: 49,   holds: 'MEDIUM #24 dead re-export' },
      { file: 'stt-local.js',          lines: 96,   holds: 'local Whisper path' },
      { file: 'acp-live.js',           lines: 60,   holds: 'CRITICAL #1' },
      { file: 'browser-preload.js',    lines: 40,   holds: 'tab preload' },
      { file: 'browser-overlay-preload.js', lines: 20, holds: 'overlay preload' },
      { file: 'unzip.js',              lines: 35,   holds: 'bundle extraction' },
      { file: 'window-capture.js',     lines: 21,   holds: 'screenshot path' },
      { file: 'usage-statusline.js',   lines: 21,   holds: 'status-line parsing' },
      { file: 'updater/index.js',      lines: 26,   holds: 'update entry' },
    ],

    rtl: {
      dirAttributes: 0,
      logicalCssProperties: 0,
      physicalCssDeclarations: 99,
      physicalJsDeclarations: 23,
      totalPhysical: 122,
      cssFilesWithPhysical: 9,
      jsFilesWithPhysical: 14,
      arabicFonts: 0,
      fontFaces: 5,
      latinOnlyFonts: 5,
      matchMediaCalls: 0,
    },

    fonts: [
      { family: 'Caveat',       file: 'caveat-latin.woff2',          weight: '500–700 var', arabic: false },
      { family: 'Courier Prime', file: 'courier-prime-400-latin.woff2', weight: '400',      arabic: false },
      { family: 'Courier Prime', file: 'courier-prime-700-latin.woff2', weight: '700',      arabic: false },
      { family: 'Courier Prime', file: 'courier-prime-400i-latin.woff2', weight: '400 italic', arabic: false },
      { family: 'Doto',         file: 'doto-latin.woff2',             weight: '600–900 var', arabic: false },
    ],

    a11y: {
      addEventListener: 110,
      removeEventListener: 11,
      listenerRatio: '10:1',
      onclickHandlers: 259,
      ariaLive: 1,
      roleAttributes: 24,
      tabindex: 10,
      ariaLabel: 28,
      focusTraps: 2,
      modalSurfaces: 17,
      divAsButton: 40,
      divAsButtonFiles: 11,
      deadButtonRoles: 3,
      outlineNone: 23,
      focusVisibleRules: 39,
      placeholderOnlyInputs: 12,
      toastCalls: 90,
      toastLiveRegion: false,
    },

    perf: {
      innerHTML: 119,
      getBoundingClientRect: 16,
      getComputedStyle: 7,
      offsetHeightReads: 3,
      rAF: 10,
      cancelRAF: 0,
      resizeObserver: 7,
      unthrottled: 5,
      forcedLayoutPerKeystroke: 2000,
      blockingConfirms: 5,
      catchSites: 31,
      awaitSites: 249,
      unguardedAsyncHandlers: 22,
      deadCodeFiles: ['session-sources.mjs (160 lines, exported, imported by nothing)'],
    },

    contrast: {
      tokens: [
        { name: '--muted',   paper: 3.82, operator: 6.86, glass: 4.60, graphite: 8.60, soft: 4.79, dusk: 4.66 },
        { name: '--muted-2', paper: 3.12, operator: 5.51, glass: 3.77, graphite: 5.61, soft: 4.01, dusk: 3.62 },
        { name: '--muted-3', paper: 2.96, operator: 4.60, glass: 3.17, graphite: 4.79, soft: 3.19, dusk: 2.89 },
        { name: '--faint',   paper: 2.42, operator: 3.14, glass: 1.91, graphite: 5.19, soft: 3.19, dusk: 2.38 },
      ],
      themes: ['paper', 'operator', 'glass', 'graphite', 'soft', 'dusk'],
      threshold: 4.5,
      failingSits: 87,
    },

    zIndex: {
      values: [1, 2, 3, 4, 6, 30, 40, 48, 60, 70, 120, 300, 1200],
      scale: false,
      bug: '.ctx-menu = 300 sits above .overlay = 60 — a context menu opened inside a sheet paints over its own modal',
    },

    deps: [
      { name: 'electron',         severity: 'high',     installed: '43.3.0',  fixed: '43.5.0',  direct: true,
        advisory: 'GHSA-j84w-jfhq-vhvj / GHSA-qmv3-fv6v-rmhq',
        note: 'Cross-origin protocol reads without corsEnabled — this is exactly what kingagent-doc relies on for isolation' },
      { name: 'undici',           severity: 'high',     installed: '≤6.28.0',  fixed: 'audit fix', direct: false,
        advisory: '7 advisories incl. TLS cert validation bypass (GHSA-w293-vg96-wgc3)', note: 'transitive, fix available' },
      { name: 'ip-address',       severity: 'moderate', installed: '≤10.7.0',  fixed: 'audit fix', direct: false,
        advisory: 'GHSA-j6r3-76f7-8jcv / GHSA-h3mg-xc3c-68pw', note: 'isInSubnet allowlist bypass + unbounded parse' },
      { name: 'fast-uri',         severity: 'moderate', installed: '3.0.0–3.1.7', fixed: 'audit fix', direct: false,
        advisory: 'GHSA-hrr3-gc8f-f4qj', note: 'percent-encoded host case normalisation' },
      { name: 'brace-expansion',  severity: 'moderate', installed: '—',        fixed: 'audit fix', direct: false,
        advisory: '3 DoS advisories', note: 'transitive' },
    ],

    core: {
      orchestrators: 2,
      coordinators: 2,
      distinctDepthLimits: [3, 3, 4, 3],
      distinctTaskTimeouts: ['15 min', '10 min', '5 min'],
      distinctPollIntervals: ['40 ms', '25 ms', '50 ms'],
      globalMutableVars: 1,
      exportsNeverImported: 309,
      functionsWithNoCallSite: 3,
      unboundedMaps: 5,
      providerCallsNoTimeout: 6,
      providerCallsTotal: 8,
      deadDefencesWithTests: ['screenResolvedAddress', 'screenRedirect', 'MAX_REDIRECTS', 'wrapUntrusted'],
      budgetCodesUnreachable: ['AGENT_TOKEN_BUDGET_EXCEEDED', 'AGENT_COST_BUDGET_EXCEEDED', 'AGENT_TASK_LIMIT_EXCEEDED', 'RUN_TOKEN_BUDGET_EXCEEDED', 'RUN_COST_BUDGET_EXCEEDED'],
      onlyRuntimeBound: 'while (guard++ < 150) + maxRuntimeMs 30 min',
      filesWithoutDirectTest: 112,
      filesWithDirectTest: 126,
    },
  };

  /* ---------------------------------------------------------------- findings */

  const F = (id, sev, domain, title, loc, impact, fix) =>
    ({ id, sev, domain, title, loc, impact, fix });

  const findings = [
    /* ---------------------------------------------------------- security */
    F('S1', 'critical', 'security',
      'acp:start ينفّذ أي أمر بلا قائمة سماح',
      'src/main/acp-live.js:15-31',
      'يشغّل spawn على أي command/args يرسلها الـ renderer. resolveSpawnProgram يستبدل الأسماء المجرّدة فقط، فأي مسار مطلق يمرّ كما هو. لا فحص للمرسل، ولا قائمة سماح، ولا بوابة موافقة — رغم أن ترويسة الملف تقول "PROTOTYPE (demo mode only)".',
      'اربط القناة بوضع العرض التجريبي، وافحص command مقابل قائمة صريحة من محوّلات الوكلاء المعروفة عبر knownBin() — لا تقبل مسارًا ولا args من الـ renderer.'),

    F('S2', 'critical', 'security',
      'term:create بنوع harness/run يفتح تنفيذًا حرًا',
      'src/main/main.js:1488-1489, 1523, 1608',
      'file = program بلا أي تحقق، وسلسلة command تُكتب حرفيًا في صدفة تسجيل الدخول. اختراق الـ renderer يعني تنفيذ أي ثنائي أو أي أمر صدفة.',
      'قيّد program على النتائج المعروفة أو قائمة سماح. لمسار run، مرّره عبر بوابة الموافقة أو اعترف صراحة أن الـ renderer موثوق — ثم اجعل حدود الثقة حقيقية (انظر S4 و S11).'),

    F('S3', 'critical', 'security',
      'agents:remove يحذف أي مجلد تحت $HOME',
      'src/main/main.js:830-831 → src/main/agent-remove.js:54-61',
      'binPath يأتي من الـ renderer، والحراسة الوحيدة isSafeRemovePath تتحقق من "مطلق وتحت $HOME" فقط. agentsRemove("claude", homedir+"/Documents") يمرّ بكل الفحوص ويمسح مستندات المستخدم عبر rm recursive.',
      'لا تقبل binPath من الـ renderer إطلاقًا: مرّر id فقط ودع الـ main يستنتج المسار من knownBin(id). أو تحقّق أن basename يطابق اسم الملف التنفيذي المسجّل وأن المسار ليس مجلدًا.'),

    F('S4', 'high', 'security',
      'file:save يكتب أي ملف بلا حارس جذر',
      'src/main/main.js:1181-1184',
      'fs.writeFileSync على مسار كامل من الـ renderer. معالجات fs:* المجاورة تستبدل الجذر بـ trustedRoot(e) صراحةً وتشرح لماذا ("الـ renderer ليس حدّ ثقة") — file:save يتجاوز هذا الانضباط كليًا.',
      'طبّق الحارس نفسه: مرّر الملف عبر inside(trustedRoot(e), file) قبل الكتابة.'),

    F('S5', 'high', 'security',
      'file:raw و file:read يقرآن أي ملف على القرص',
      'src/main/main.js:1153-1162, 1300-1312',
      'statSync + readFileSync على مسار مطلق من الـ renderer بلا فحص جذر. السقف موجود (2 ميغا و400 كيلوبايت) لكن المسار غير مقيّد. نافذة 2 ميغا تكفي لتسريب معظم المفاتيح.',
      'نفس احتواء trustedRoot المستخدَم في fs:*.'),

    F('S6', 'high', 'security',
      'Electron 43.3.0 داخل نطاق مصاب، وإعلان يُبطل حجّة العزل',
      'package.json (electron ^43.3.0) · src/main/main.js:63-79',
      'أربع ثغرات موثّقة، إحداها على النقطة: GHSA-j84w-jfhq-vhvj (7.4) تسمح بقراءات عبر الأصلية دون corsEnabled. المشروع يسجّل kingagent-doc بـ corsEnabled:false ويقدّم بايتات ملفات محلية عبر protocol.handle — والحجّة المعلنة في التعليق تستند تحديدًا إلى "جدار الأصلية".',
      'شغّل npm audit fix (أو ثبّت 43.5.0). وبشكل مستقل: لا تعتمد على جدار الأصلية كضابط أول — أبقِ connect-src \'none\' الضابط الحامل، وأعد التحقق على النسخة المرقّاة.'),

    F('S7', 'high', 'security',
      'services:connect ينفّذ مسارًا من الـ renderer عبر node',
      'src/main/main.js:877-891 → services-catalog.js:40 → mcp-check.js:9',
      'مدخل kie في الكتالوج يُدرج installDir غير المتحقق منه في مسار argv، ثم يُنفّذ في السطر التالي من نفس المعالج.',
      'اشترط أن يأتي installDir من dialog.showOpenDialog محفوظًا في الـ main، كما يفعل services:pickBundle في main.js:896-902.'),

    F('S8', 'high', 'security',
      'services:connectCustom يحوّل bundleDir إلى مسار قراءة ومسار تنفيذ لاحق',
      'src/main/main.js:932-935 → src/main/mcpb.js:33-40',
      'bundleDir يُستخدم بلا تحقق لقراءة manifest.json (استطلاع قراءة عشوائي)، ثم يُستبدل في المُدخل بـ __dirname ويُحفظ في connections.json — أي مسار تنفيذ يختاره المهاجم يصير دائمًا في إعدادات كل وكيل.',
      'تحقّق من bundleDir مقابل المجلدات التي أنشأها services:pickBundle فعليًا تحت ~/.kingagent/bundles/.'),

    F('S9', 'high', 'security',
      'استعلام Keychain متزامن بمهلة 25 ثانية على العملية الرئيسية',
      'src/main/browser-profiles.js:288 → browser-views.js:428,447',
      'execFileSync(\'security\', …, {timeout: 25000}) داخل mutateProfile على خيط Electron الرئيسي. نافذة Keychain لا يرد عليها المستخدم تُجمّد الواجهة كلها 25 ثانية.',
      'اجعلها execFile غير متزامن، أو اعرض dialog.showMessageBox أولًا ليصبح التنبيه متوقعًا. نفس الشكل في usage.js:219 (مهلة 4 ثوانٍ).'),

    F('S10', 'high', 'security',
      'shell.openExternal على نصوص غير مُطبَّعة',
      'src/main/main.js:356, 359, 629, 997',
      'أربعة مواضع تختبر /^https?:\\/\\//i ثم تسلّم السلسلة كاملة غير مقصوصة إلى openExternal. على ويندوز يصل الأمر إلى ShellExecute، وهي الفئة المتوثّقة لتجاوز عبر \\r\\n.',
      'حَلّل أولًا ثم أعد التسلسل: new URL(url) وتحقّق من البروتوكول، ومرّر u.href. update:open (main.js:757) يلتزم هذا — خُذ منه نموذجًا.'),

    F('S11', 'medium', 'security',
      'نموذج الثقة غير متّسق: trustedRoot على fs:* فقط',
      'main.js:1356-1364, 1276-1287, 1215-1262, 1128-1139, 863-992',
      'main.js:1324-1330 يشرح القاعدة ثم يطبّقها على fs:* فقط. dir:watch و pointer:write و library:* و services:* تثق بـ dir الخاصة بالـ renderer. النتيجة: كتابة AGENTS.md و CLAUDE.md في أي مجلد، ومراقبة recursive لأي مسار.',
      'طبّق trustedRoot(e) على dir:watch و pointer:write، واشترط projectPath === trustedRoot(e) في library:* و services:*.'),

    F('S12', 'medium', 'security',
      'titleWatch ينمو بلا حد عبر session:watch-title',
      'src/main/main.js:1693-1698 → 1684-1687 (الخريطة في 1635)',
      'المعالج لا يتحقق من وجود الجلسة، والخريطة بلا سقف. كل مدخل يُشغّل statSync + قراءة حتى 96 كيلوبايت أو استعلام SQLite كل 4 ثوانٍ إلى ما لا نهاية.',
      'ارفض المعرّفات غير الموجودة في termSessions، وضع سقفًا للخريطة كما يفعل browser-images.js:13.'),

    F('S13', 'medium', 'security',
      'deliberateKills يسرّب المدخلات عند فشل kill',
      'src/main/main.js:180-181 (إضافة) · 1601 (المسح الوحيد)',
      'الإضافة غير مشروطة ثم تُبتلع الاستثناءات بـ catch فارغ. التنظيف يحدث فقط في onExit؛ إن لم يُطلق kill أو لم يُطلق onExit يبقى المعرّف مدى العملية.',
      'احذف من المجموعة داخل catch، أو انقل الإضافة بعد نجاح kill().'),

    F('S14', 'medium', 'security',
      'مجموعة claimed في اكتشاف الوكلاء لا تتقلّص',
      'src/main/agent-resume.js:278, 302',
      'pending تُنظَّف في أربعة مواضع، claimed لا. نص واحد لكل جلسة وكيل مكتشفة، محفوظ مدى العملية.',
      'احذف المعرّف عند توقف اكتشاف البلاطة، محاكيًا دورة حياة pending.'),

    F('S15', 'medium', 'security',
      'pendingAuth لا يُحذف عند الموافقة',
      'src/main/agent-platform.js:269-274, 969-977',
      'pendingAuth.set(requestId, resolve) عند 971؛ معالج الاستجابة عند 272 ينادي pending لكن لا يحذف. تُسترد المدخلات بمهلة 60 ثانية فقط، وتكرار الطلب لنفس المعرّف يعيد نداء محلّل مستقر.',
      'const fn = map.get(id); if (fn) { map.delete(id); fn(approved); }'),

    F('S16', 'medium', 'security',
      'JSON.parse بلا سقف على ~/.claude.json',
      'src/main/usage.js:50-52 (الدالة) · 232 (الاستدعاء)',
      'الوحدة تملك حارس حجم (readJson يتخطّى ≥ 64 كيلوبايت) وclaudeRows يستخدمه — لكن claudeToken يستخدم readJsonFile بلا سقف على ملف يبلغ عشرات ومئات الميغابايت في الاستخدام الحقيقي.',
      'مرّر readJsonFile عبر حجام statSync نفسه.'),

    F('S17', 'medium', 'security',
      'stt:transcribe بلا سقف على حمولة الصوت',
      'src/main/main.js:1408-1412 → src/main/stt.js:257-267, 36-40',
      'clip.pcm يُبنى عبر structured clone ثم يُمشى في حلقة pcmToWav متزامنة بلا حد طول. كل مدخل ثنائي آخر في الملف له سقف (28 ميغا، 128 كيلوبايت، 5 ميغا)؛ هذا وحده بلا.',
      'ضع سقفًا على clip.pcm.length و clip.bytes.length في normalizeClip.'),

    F('S18', 'medium', 'security',
      'platform-shell: stderr بلا حد و $SHELL غير مُتحقق منه',
      'src/main/platform-shell.js:60, 23',
      'stdout مقيّد عند 2 ميغا بايت، stderr يتراكم بلا حد لعملية صاخبة. والبرنامج مأخوذ من process.env.SHELL مباشرة، فالبيئة تختار المفسّر لا سياسة المنصة.',
      'طبّق سقف 2 ميغا على stderr، واستخدم loginShell(platform).file بدل process.env.SHELL.'),

    F('S19', 'medium', 'security',
      '~70 معالج IPC في agent-platform لا تفحص المرسل',
      'src/main/agent-platform.js:181-186',
      'الغلاف handle() يتحقق من الحمولة (صحيح، وهو أيضًا يزيل المفاتيح غير المصرّحة) لكنه لا يفحص event إطلاقًا. قارن بوحدة المتصفح: browser-views.js:92-96 يتحقق من BrowserWindow.fromWebContents + مطابقة webContents + مطابقة mainFrame.',
      'أضف حارس mainWindow(event) داخل handle() — deepened defence, لا ثغرة حيّة الآن.'),

    F('S20', 'medium', 'security',
      'acp-live: رمي داخل حلقة الحدث بعد إغلاق النافذة',
      'src/main/acp-live.js:44-46, 48, 39',
      'كتلة catch تنادي wc.send — وهي نفس النداء الذي رمي للتو، فترمي هي أيضًا. معالج stderr ينادي wc.send بلا try/catch إطلاقًا. و buf ينمو بلا حد إن لم يحتوِ إخراج الطفل على سطر جديد.',
      'غلّف كل wc.send في emit واحد آمن، واربط buf كما يفعل run-done.js:102-103.'),

    F('S21', 'low', 'security',
      'خريطة procs في acp-live بلا تنظيف عند إغلاق النافذة',
      'src/main/acp-live.js:12, 35, 49-50',
      'المدخلات تُحذف فقط عند exit أو error من الطفل. طفل ي outlives نافذته يبقي العملية و webContents الممسوك مرتبطين. reapSessions في main.js:480-486 يعرف PTYs ولا يعرف عمليات ACP.',
      'اكسر دالة teardown مستقلة عن ipcMain وادعها من معالج w.on(\'closed\') في main.js:443.'),

    F('S22', 'low', 'security',
      'retained ومجلدات Playwright المؤقتة بلا تشذيب',
      'browser-images.js:10, 37 · browser-mcp.js:87',
      'retained ينمو فقط، و mkdtempSync ينشئ مجلدًا لكل مسار يبقى بعد خروج غير نظيف.',
      'شذّب retained بعمر أقصى عند الإقلاع، وضع tmp تحت جذر واحد لكل تشغيل.'),

    F('S23', 'low', 'security',
      'shortHome مكرّرة، ونسخة main.js فيها خطأ حقيقي',
      'main.js:859 مقابل agents-detect.js:241',
      'نسخة main.js تستخدم String.replace غير مثبّتة. مع home = /Users/alice فإن shortHome("/Users/alice-proj/agents.json") تُرجع "/Users/~-proj/agents.json" — مسار غير موجود يُعرض للمستخدم في ورقة "ما الملفات التي كُتبت".',
      'احذف نسخة main.js واستورد نسخة agents-detect.'),

    F('S24', 'low', 'security',
      'تصديرات ميتة (تحقّق بالبحث الكامل)',
      'usage.js:100, 392 · browser-profiles.js:21, 463 · terminal.js:19, 49',
      'customUsage معرّف ومصدَّر ولا يُستدعى من أي مكان — وهو المعالج الوحيد لخلاصة "محوّل يعداد يضبطه المستخدم"، أي ميزة نصف مبنية. filterImportableCookies كذلك. و terminal.js يعيد تصدير defaultTerminalShell دون استخدام بينما resolveShell يعيد تنفيذ القرار نفسه.',
      'احذفها، أو أكمل الميزة إن كانت مقصودة.'),

    F('S25', 'low', 'security',
      'مساعدات مكرّرة عبر الوحدات',
      'library.js:444 · connections.js:169 · pointer.js:196 · main.js:1297',
      'escapeRe متطابق بايتًا ببايت في ملفين؛ safeRead و safeReadText دالة واحدة في ملفين. main.js:1166-1172 يحاجّ صراحةً بأن "تجزئتين لنفس البايتات تتباعدان لحظة لمس أي منهما" — وهذا هو نفسه في صورة مصغّرة.',
      'استورد من موضع واحد.'),

    F('S26', 'low', 'security',
      'appUpdatedAt يعيد الإحصاء عند كل نداء',
      'src/main/main.js:723-731',
      'fs.statSync على الحزمة عند كل boot وكل update:status، و boot على مسار أول رسم.',
      'خزّن النتيجة بعد أول حل.'),

    /* --------------------------------------------------------- interface */
    F('U1', 'critical', 'interface',
      'الواجهة لا تدعم العربية إطلاقًا: لا dir ولا خط عربي',
      'src/renderer/index.html:1-25',
      'لا وسم <html> أصلًا — الملف يبدأ بـ meta charset. لا lang ولا dir، وكل النصوص إنجليزية مكتوبة بشكل صلب، والخطوط الأربعة المرفقة كلها لاتينية فقط. النص العربي يظهر بخط بديل من النظام بلا أي مكدّس يسمّي خطًا عربيًا.',
      'أضف <html lang="ar" dir="rtl"> (أو اجعله يقود من مفتاح إعدادات)، وأرفق خط نسخ (Noto Naskh / Cairo / Tajawal) بـ unicode-range: U+0600-06FF وضعه بعد الخط اللاتيني في كل مكدّس. أبقِ font-src \'self\' — الملف يسافر داخل vendor/fonts/ ولا حاجة لتغيير CSP.'),

    F('U2', 'critical', 'interface',
      '122 تصريحًا فيزيائيًا والاتجاه — لا يمكن قلب التخطيط',
      '99 في CSS عبر 9 ملفات · 23 في JS عبر 14 ملفًا',
      'أسوأ المواضع: workspace-library.mjs:293 و agent-platform.mjs:137 — تثبيت الشجرة على اليسار دائمًا. ثم 33 × margin-left:auto تقلب كل سطر اسم/حالة في RTL. ثم ارتساء النوافذ المنبثقة عبر style.left/style.right مع getBoundingClientRect().left. ومقبض التحجيم nwse-resize يقع على الجهة الخاطئة.',
      'كنسّة ميكانيكية واحدة: margin-left→margin-inline-start، left/right→inset-inline-*، text-align→start/end. ثم read-backs الخمسة لـ getComputedStyle. ثم مساعد axis واعٍ بـ dir للـ JS. ثم بوابة lint ترفض الخصائص الفيزيائية في CSS و mjs.'),

    F('U3', 'critical', 'interface',
      'مستمع click على document لكل بلاطة دردشة بلا إزالة',
      'src/renderer/acp-composer.mjs:137',
      'المسار: tile-shell.mjs:625 → acp-pane.mjs:167 → acp-composer.mjs:11. كل بلاطة ACP تضيف مستمعًا دائمًا على مستوى document، وإغلاقه يثبّت شجرة DOM منفصلة. افتح وأغلق 20 جلسة: 20 مستمعًا ميتًا يعمل عند كل نقرة في التطبيق.',
      'أرجع dispose() من createComposer ينادي removeEventListener، وخزّنه على rec واستدعِه من rec.disposeRo في acp-pane.mjs:324. الأفضل: اربط بـ host بدل document.'),

    F('U4', 'critical', 'interface',
      'setInterval/anime في session-sources مع واجهة Node داخل الـ renderer',
      'src/renderer/session-sources.mjs:155-158',
      'interval.unref?.() في السطر 156 لا وجود له في Chromium — وهو رقم لا كائن في الـ renderer. السطر يثبت أن الكود كُتب متوقعًا Node وصمت بلا فعل. يبقى الفاصل حيًّا بعد إغلاق اللوحة ويستمر نداء api.browserStatus() إلى ما لا نهاية، واشتراك onBrowserEvent غير قابل للإزالة.',
      'اربط الفاصل بسجل البلوحة، واحتفظ بدالة off التي تُهمَل حاليًا. احذف سطر unref. والأفضل: احذف الملف كله — راجع H19.'),

    F('U5', 'critical', 'interface',
      'تخطيط قسري متزامن لكل سطر في حاشية المحرر',
      'src/renderer/tile-content.mjs:352',
      'gutter.innerHTML يستدعي getBoundingClientRect() داخل دالة Array.from — كل نداء يُفرغ التخطيط المعلّق. على ملف من 2000 سطر: 2000 إعادة تخطيط قسري لكل sync()، و sync() تعمل عند كل ضغطة مفتاح (سطر 418)، ومن ResizeObserver، ومن applyMode.',
      'لا تقس الصفوف إطلاقًا: استخدم عدّاد CSS على مرآة لعدد الأسطر، أو اقرأ offsetHeight في تمرير واحد داخل requestAnimationFrame بعد priming read واحدة. ثم خفّف sync() خلف rAF الموجود أصلًا.'),

    F('U6', 'critical', 'interface',
      'MutationObserver على المستند كاملًا يدور في حلقة مع ميل الزجاج',
      'src/renderer/browser-pane.mjs:37 + app.js:1181-1198',
      'initGlassTilt يكتب --rx على .nav-card عند كل rAF أثناء حركة المؤشر، فتتغير خاصية style، فيطلق المراقب schedule()، فيستدعي layout() الذي يقرأ getClientRects + getBoundingClientRect لكل إطار متصفح ثم JSON.stringify للنتيجة كلها.',
      'لاحظ المراقب موجود لالتقاط تغييرات class التي تحرّك الهندسة. افصله: childList + class فقط، واحذف style و hidden من attributeFilter. هذه الكلمة الواحدة تكسر الارتباط. ثم ضيّق النطاق بدل documentElement.'),

    F('U7', 'high', 'interface',
      'grow() يفرض إعادة تخطيط عند كل ضغطة مفتاح في محرر الدردشة',
      'src/renderer/acp-composer.mjs:45',
      'input.style.height = "auto" ثم قراءة scrollHeight ثم كتابة ثانية — write→read→write كل حدث input. هThrash كلاسيكي على مسار الكتابة.',
      'const h = input.scrollHeight; requestAnimationFrame(() => { … }) — قياس مرة واحدة وكتابة في الإطار التالي.'),

    F('U8', 'high', 'interface',
      'off() لا تعمل إلا في مسار النجاح — ورفض sttPrepare يعطّل الزر للأبد',
      'src/renderer/settings-panes.mjs:237-243',
      'dl.disabled = true ثم const off = api.onSttProgress(...) ثم await api.sttPrepare() — إن رفض، لا يُنفَّذ off() ويبقى الزر معطّلًا.',
      'try { … } finally { off(); } وأعد تفعيل dl في catch.'),

    F('U9', 'high', 'interface',
      'ورقة overlay() هي ورقة كل النوافذ، وrole="dialog" في مكانين فقط من 17',
      'app.js:1388-1395 و app.js:1294-1331',
      'overlay() تبني الورقة العامة التي يستخدمها كل شيء تقريبًا، لكنها لا تضبط دورًا حواريًا أبدًا. wireHelpDialog (settings-panes.mjs:74-97) هو الموضع الوحيد الذي يضيف role/aria-modal/حصر التركيز، ويُنادى من موقعين فقط. غير المغطّى: Launcher، folder-first، agent-setup، agent-remove، الوكيل، create، peek، وكل أوراق browser، وكل أوراق mcp-setup الأربعة.',
      'انقل الـ 24 سطرًا من wireHelpDialog داخل overlay() في app.js:1388 واحذف موضعَي الاستدعاء — كل ورقة تحصل على حصر تركيز مجانًا.'),

    F('U10', 'high', 'interface',
      'role="slider" بلا aria-valuenow',
      'src/renderer/tile-shell.mjs:566-570',
      'ARIA غير صالح: قارئ الشاشة ينطق "slider" ثم لا شيء مفيد.Capability موجودة فعلًا عبر أسهم لوحة المفاتيح (322-332) لكنها غير معلنة.',
      'في applySpan (سطر 282) اضبط aria-valuenow / valuemin / valuemax / valuetext.'),

    F('U11', 'high', 'interface',
      'فاصل العرض المنقسم بالفأرة فقط',
      'src/renderer/tile-shell.mjs:246-262, 202',
      'div.pane-divider بلا tabindex ولا role ولا keydown، و getComputedStyle + clientWidth يُعادان كل mousemove دون rAF. tweezers: mousedown/mousemove بينما بقية التطبيق يستخدم Pointer Events.',
      'أضف role="separator" tabindex="0" aria-orientation="vertical"، وأضف معالجة أسهم لوحة المفاتيح مقلدةً wireGrip:322-332، ولفّ جسم mv بمزلاج requestAnimationFrame نفسه المستخدَم في markFit (671-676).'),

    F('U12', 'high', 'interface',
      'مرشّح المكتبة يعيد بناء الرصيف كاملًا عند كل ضغطة مفتاح',
      'src/renderer/workspace-library.mjs:979 (refreshRail 150-159)',
      'c.innerHTML = \'\' ثم إعادة بناء المكتبة كاملة لكل حرف — 139 عنصرًا بناء innerHTML متزامن كامل لكل حرف، مع قراءة تمرير قسرية وكتابة.',
      'حرّك .lib-search خارج الحاوية المعاد بناؤها، ورشّح الصفوف الموجودة في المكان (row.hidden = !match) وأعد البناء فقط حين تتغير مجموعة العناصر نفسها.'),

    F('U13', 'high', 'interface',
      'اختيار الوكيل ⌘K وورقة Create تهدمان النافذة عند كل ضغطة مفتاح',
      'src/renderer/launcher.mjs:773, 906',
      'input.oninput يستدعي renderOverlay() التي تفرّغ #overlay-root وتعيد إنشاء الورقة، ثم refocus عبر setTimeout(…, 30). التعليق عند 901-902 يعترف بإعادة البناء ويصلح الحالة لا الكلفة.',
      'رشّح صفوف #ap-list في المكان وأبقِ عقدة input؛ أعد البناء فقط حين تتغير عضوية pickerAgents().'),

    F('U14', 'high', 'interface',
      'خمس استدعاءات confirm() أصلية تجمّد الـ renderer',
      'panel-lifecycle.mjs:185, 263 · app.js:1338, 1384',
      'confirm() متزامن: لا rAF ولا رسم ولا composite. في تطبيق جوهره بلاطات PTY حية، جلسة Claude تدفّق المخرجات تتجمد مرئيًا، والنافذة لوحة نظام أصلي يتجاهلها كل السمات الست.',
      'وجّهها عبر overlay() مع ورقة تأكيد من زرّين. هذا يمنحها role="dialog" وحصر تركيز مجانًا (انظر U9).'),

    F('U15', 'high', 'interface',
      'مبدّل "show all / essentials" عنصر span غير قابل للوصول',
      'src/renderer/workspace-library.mjs:230-238',
      'لا role ولا tabindex ولا keydown — وهو التحكم الوحيد في ترويسة Workspace. غير قابل للوصول بلوحة المفاتيح. على بُعد 37 سطرًا، زر plus (243-255) يحصل على role + tabIndex + onkeydown كامل.',
      'أضف role="button" و tabIndex=0 وانسخ معالج Enter/Space الموجود أصلًا عند 252-255.'),

    F('U16', 'high', 'interface',
      'صفوف الجلسات بالفأرة فقط بينما صفوف الملفات قبلها بـ 20 سطرًا قابلة للوحة المفاتيح',
      'src/renderer/workspace-library.mjs:194-215 مقابل 174-187',
      'fileRow يفعل row.tabIndex=0 و role=button و aria-pressed و onkeydown صحيحًا. صف الجلسة .nav-card يحصل على dataset.id و onclick ولا شيء آخر. التنقّل الأساسي في الرصيف غير مرئي للوحة المفاتيح.',
      'استخرج أسطر fileRow الثلاثة إلى مساعدة activateOnKey(el, run) واستدعها لـ .nav-card أيضًا.'),

    F('U17', 'high', 'interface',
      'رصيف المكتبة كاملًا بالفأرة فقط',
      'src/renderer/workspace-library.mjs:924-999, 1030',
      'كل .agent-row وكل .lib-group وكل صف خدمة بلا role أو tabindex أو keydown. ثلاثة أسطر فوق (967-975) بطاقات .lib-new تحصل على tabindex="0" role="button" ومعالج Enter/Space.',
      'مساعدة activateOnKey من U16 مطبّقة على المواضع الأربعة.'),

    F('U18', 'high', 'interface',
      'ثلاثة عناصر role="button" tabindex="0" بلا معالج keydown',
      'src/renderer/launcher.mjs:811, 206',
      'أسوأ من إغفالها: مستخدم لوحة المفاتيح يصل بالـ Tab، يسمع "button"، يضغط Enter، ولا يحدث شيء (WCAG 2.1.1).',
      'أضف role="button" عند 206 وانسخ معالج tr.onkeydown المكتوب عند 824/829 إلى الاثنين.'),

    F('U19', 'high', 'interface',
      'fitCanvas يفرض تخطيطين متزامنين لكل بلاطة لكل ملاءمة',
      'src/renderer/tile-shell.mjs:721-735',
      'قراءة → كتابة → قراءة → كتابة. drainFits (677-681) يجمّع البلاطات في rAF واحد لكن ليس القراءة/الكتابة داخل البلاطة. سحب فوق مكتب بأربعة أطراف = 8 تخطيطات قسرية لكل إطار.',
      'مرّرتان في rAF: الأولى قراءة لكل بلاطة متّسخة، الثانية كتابة. markFit/drainFits أصلًا هو الو seam الصحيح.'),

    F('U20', 'high', 'interface',
      '22 معالج نقر غير متزامن بلا try/catch — رفض يُجمّد الواجهة',
      'launcher.mjs:345, 376 · tile-content.mjs:651,664,686,443,704 · settings-panes.mjs:31,493 · acp-pane.mjs:333 · mcp-setup.mjs:187,203,250,277,302 · وغيرها',
      '249 موضع await مقابل 31 catch. أمثلة محسوسة: ورقة الإزالة تبقى على "Working out what this would delete…" إلى الأبد؛ زر الحذف يبقى "Really move to Trash?"؛ زر المحرر يبقى disabled على "Lifting…"؛ mcp-setup.mjs فيه 5 await api.* و صفر .catch؛ acp-pane.mjs:331 IIFE بلا catch خارجي فالبلاطة لا تتصل ولا تشرح.',
      'إصلاحان نظاميان بسطر واحد يغطيان الأغلبية: workspace-library.mjs:460 — لفّ بـ Promise.resolve(it.run(e)).catch(toast)؛ launcher.mjs:1136 — نفس اللف لكل صفوف Quick Start. ثم امسح المواضع العشرين الباقية.'),

    F('U21', 'high', 'interface',
      'كود ميت بشكل مضلل: && false',
      'src/renderer/panel-lifecycle.mjs:280',
      'p.kind === \'editor\' && !p.dirty && false يجعل الشرط الثاني دائمًا false. البند الميت يُقرأ كنيّة غير مكتملة، والصيانة ستصلحه لاحقًا فيغلق محررات نظيفة — تغيير سلوك لم يطلبه أحد.',
      'احذف البند، أو نفّذه واختبره عن قصد.'),

    F('U22', 'high', 'interface',
      'حصر التركيز الوحيد مربوط بـ .title بلا فحص null',
      'src/renderer/settings-panes.mjs:74-97',
      'title.id = … على نتيجة قد تكون null — ورقة بلا .title ترمي داخل renderOverlay ولا تُركَّب أبدًا. كما أنه يشغّل getClientRects لكل عنصر عند كل تفعيل حصر (إعادة تخطيط قسرية).',
      'حارس if (!title) return. بعد نقله إلى overlay() حسب U9، اجعل overlay() يملك h2 مخفيًا بصريًا.'),

    F('U23', 'high', 'interface',
      'mountOrgView كود ميت، ونسخة أخرى منه سيّئة',
      'src/renderer/agent-org.mjs:294-326 · agent-platform.mjs:131-140',
      'mountOrgView — التنفيذ المتاح (أزرار حقيقية مع aria-current) — مصدَّر ومستورد من لا شيء في src/. بينما agent-platform.mjs:135-137 يرسم العرض نفسه سطرًا سطرًا مع style="padding-left:…" فيزيائي.',
      'احذف أحدهما. الأفضل: احذف النسخة السطرية واستخدم mountOrgView.'),

    F('U24', 'high', 'interface',
      'session-sources.mjs — 160 سطرًا كود ميت بالكامل',
      'src/renderer/session-sources.mjs',
      'createSessionSources مصدَّر ومستورد من لا شيء في src/renderer (تحقّق بالبحث). ويحتوي المنطق الحقيقي بما فيه تسرّب الفاصل في U4.',
      'احذف الملف أو وصّله. كود ميت فيه خلل معروف أسوأ من غيابه.'),

    F('U25', 'medium', 'interface',
      'ألوان مثبّتة تتجاهل السمات الست',
      'skills-pane.css:64 · research-panel.mjs:38-44 · agent-platform.mjs:70-84',
      '#9a3412 في skills-pane.css ليس مرتبطًا بالسماة — نفس الأحمر الداكن على paper و graphite معًا. و research-panel.mjs:38-44 و agent-platform.mjs:56-91 كتلتا style مكتوبتان template literals في JS، محقونتان بعد كل ملفات الأنماط، لا يمكن تنسيقهما إلا بتحرير JS.',
      'انقلهما إلى ملفات .css حقيقية مرتبطة بـ body[data-theme=…]، واستبدل كل hex برمز (--amber-ink و --red-body و --green-ok موجودة أصلًا في paper.css).'),

    F('U26', 'medium', 'interface',
      '87 موضعًا يفشل تباين WCAG AA',
      'paper.css (--muted 3.82 · --muted-3 2.96 · --faint 2.42) · glass (--faint 1.91)',
      '--faint يقود كل elements::placeholder، فصندوق بحث فارغ وصندوق دردشة فارغ كلاهما عند 1.9–2.4:1. الأحجام 9–11 بكسل حيث 4.5:1 إلزامي لا 3:1. و theme-graphite.css:17-19 أصلحت المسألة في graphite وحده.',
      'غمّق --faint و --muted-3 لكل سمة حتى ≥ 4.5:1 على --paper تلك السمة.'),

    F('U27', 'medium', 'interface',
      'toast هو قناة التغذية الراجعة الوحيدة وبلا aria-live',
      'src/renderer/app.js:1399 (التعريف) · 1076 (الجذر)',
      'div#toast-root بلا role ولا aria-live. كل نداءات toast الـ ~90 — فشل حفظ، نتائج تثبيت، تأكيدات حذف — غير مرئية لقارئ الشاشة. aria-live الوحيد في الـ renderer كله في browser-annotations.mjs:108.',
      'أضف role="status" aria-live="polite" aria-atomic="true" على #toast-root. سطر واحد يصلح ~90 إعلانًا.'),

    F('U28', 'medium', 'interface',
      'boot() بلا try/catch — فشل الإقلاع = نافذة بيضاء صامتة',
      'src/renderer/app.js:532-655',
      'IIFE غير متزامن في المستوى الأعلى بلا try/catch. إن رفض api.boot() (538) تخطّى كل شيء بعده بصمت: لا هيكل ولا سمة ولا استعادة.',
      'اللفّ الجسد بـ catch يعرض toast ويطبع الخطأ في الطرفية.'),

    F('U29', 'medium', 'interface',
      'ميل الزجاج بلا فحص prefers-reduced-motion',
      'src/renderer/app.js:1178-1200',
      'تحويل 3D عند كل pointermove بلا فحص، و matchMedia Calls في JS = 0 عبر التطبيق كله، بينما CSS يحرسها في 3 ملفات فقط من 11. نفس الأمر لـ scrollIntoView({behavior:"smooth"}) في موضعين.',
      'ثابت REDUCE واحد من matchMedia في مساعدة مشتركة، وبّط initGlassTilt على !REDUCE.matches.'),

    F('U30', 'medium', 'interface',
      'حلقة ResizeObserver ممكنة في syncSplitLayout',
      'src/renderer/tile-shell.mjs:209-212, 246-262',
      'يكتب --split ثلاث مرات لكل نداء، منها خاصية مخصّصة تغيّر التخطيط يراقبها المراقب نفسه الذي يحرّكها.',
      'اقرأ من entry.contentRect الذي يوفّره المراقب بدل clientWidth، ولا تكتب --split إلا حين تتغير القيمة فعلًا.'),

    F('U31', 'medium', 'interface',
      'applyChrome يكدّس مؤقتات غير متتبَّعة',
      'src/renderer/app.js:1207',
      'setTimeout(…, 60) لكل نداء بلا إلغاء السابق. ثلاثة تبديلات في 200 مللي ثانية تكدّس ثلاث عمليات إعادة حساب كاملة لسطح المكتب.',
      'clearTimeout(applyChrome.t) قبل كل setTimeout.'),

    F('U32', 'medium', 'interface',
      'resize يستدعي قراءات قسرية متزامنة عند كل حدث',
      'src/renderer/app.js:1115',
      'syncDeskColumns (getComputedStyle + clientWidth) و positionThemePop (getBoundingClientRect × 2) في كل حدث resize، بلا rAF. سحب نافذة يطلق resize بمعدل الشاشة. initGlassTilt في app.js:1188 يعرض النمط الصحيح قبل 70 سطرًا.',
      'مزلاج rAF واحد، تمامًا كما يفعل markFit في tile-shell.mjs:671-676.'),

    F('U33', 'medium', 'interface',
      'loadMacLibrary قد يترك macLoading عالقًا true للأبد',
      'src/renderer/workspace-library.mjs:764-778',
      'تبديل مجلد أثناء الفحص يرفع macGen، فيفعّل return مبكرًا، و then لا يُنفَّذ أبدًا. وحارس maybeLoadMac عند 760 يمنع كل محاولة لاحقة. الوكلاء والمهارات تحت ~/.claude لا يظهرون بصمت.',
      'انقل إعادة التعيين إلى finally، بلا شرط.'),

    F('U34', 'medium', 'interface',
      'input مُرسل بلا bubbles بينما العمليات نفسها ترسلها بها',
      'src/renderer/tile-content.mjs:841',
      'قارن tile-shell.mjs:854 و acp-pane.mjs:181, 218 — الثلاثة الأخرى تمرّر {bubbles:true}. الإملاء في بلاطة دردشة يُطلق حدثًا لا يصعد، فتفوته أي مستمع مُفوَّض.',
      'أضف {bubbles:true} عند 841.'),

    F('U35', 'medium', 'interface',
      'blockquote متداخل يعيد تحليل النص نفسه — O(n²)',
      'src/renderer/md.mjs:264',
      'push(`<blockquote>${renderMarkdown(q.join("\\n"), …)}</blockquote>`) يعيد التقسيم والتحليل عند كل مستوى. مستند باقتباسات عميقة يحلّل النص نفسه مرارًا. ولا dir="auto" على blockquote ولا p.',
      'دع blockPass يستدعي نفسه (يدعم startIdx/opts.sub أصلًا) بدل renderMarkdown العامة. أضف dir="auto" على p و blockquote و li.'),

    F('U36', 'medium', 'interface',
      'toLocaleTimeString(\'en-US\') مثبّت بجانب تاريخ بلغة النظام',
      'src/renderer/settings-panes.mjs:356',
      'التاريخ بلغة النظام ✔ والوقت ليس. على نظام عربي ينتج تاريخ بخط عربي بجانب "6:55 pm". التعليق يقول إن hour12 مقصود — الحل إسقاط \'en-US\' وفرض hourCycle: \'h23\' بدل فرض اللغة كلها.',
      'toLocaleTimeString(undefined, {hour:"2-digit", minute:"2-digit", hourCycle:"h23"}).'),

    F('U37', 'medium', 'interface',
      'حرب تخصيص في browser.css بـ !important',
      'src/renderer/browser.css:19, 62',
      '5 من أصل 15 !important في التطبيق، اثنان منها يكرّران تعريف .browser-check عند تخصيصين مختلفين وعلى كلاهما !important — فـ :62 يفوز بمجرد امتلاكه صنفًا أكثر.',
      'ادمجهما في تعريف واحد.'),

    F('U38', 'medium', 'interface',
      'catch (_) {} يبتلع كل فشل استعادة — بلاطة تختفي بصمت',
      'src/renderer/panel-lifecycle.mjs:102',
      'وهذا هو كل معنى الاستعادة. كل مسار فشل آخر في التطبيق يعرض toast.',
      'سجّل نوع البلاطة والملف، واعرض عددًا مرة واحدة بعد الحلقة.'),

    F('U39', 'medium', 'interface',
      'رفض canClose يجعل البلاطة غير قابلة للإغلاق',
      'src/renderer/panel-lifecycle.mjs:261',
      'بلا .catch. إن رفض canClose خرجت closePanel وبقيت البلاطة؛ والنقر على ✕ مرة أخرى يكرر الأمر. لا سبيل للمستخدم لإغلاق اللوح.',
      '.catch(() => closePanel(id, {…opts, silent:true})) أو على الأقل toast يشرح السبب.'),

    F('U40', 'medium', 'interface',
      'swapDesk يعود بصمت عندما يحتجز متصفح عملًا غير محفوظ',
      'src/renderer/launcher.mjs:1207',
      'تبديل المجلد لا يفعل شيئًا بلا أي indication. في كل مكان آخر من التطبيق يُشرح الرفض.',
      'أضف toast يشرح السبب.'),

    F('U41', 'medium', 'interface',
      'مؤقتات غير متتبَّعة تمسك DOM منفصلًا',
      'tile-shell.mjs:548 · app.js:1417 · agent-platform-boot.mjs:29',
      'setTimeout لكل تركيب بلاطة (600 مللي ثانية) و demo seed (500) و 8 ثوانٍ للتمهيد. و cancelAnimationFrame = 0 عبر الـ renderer رغم 10 طلبات rAF — fitFrame و frame لا يُلغيان على التفكيك.',
      'خزّن المؤقت على rec وامسحه في دوال التفكيك.'),

    F('U42', 'low', 'interface',
      'أسلوب مصغّر غير متّسق في ملفات مفتاحية',
      'browser-pane.mjs · session-sources.mjs · agent-platform.mjs · tile-content.mjs:415-421, 834-885 · panel-lifecycle.mjs:27, 104',
      'سطر من 90 حرفًا وسط تعليقات فقرة متقنة، و CSS في template literals. هذا أقوى إشارة على كود غير مراجَع في التدقيق، ويتطابقcorrClusters حيث تتكدس الأخطاء.',
      'شغّل منسّقًا على الـ renderer وراجع الفرق.'),

    F('U43', 'low', 'interface',
      'تعبيران منتظمان متطابقان تقريبًا بطول 700 حرف',
      'src/renderer/md.mjs:22, 72',
      'INLINE و INLINE_R بترتيب مجموعات يجب أن يبقى متزامنًا؛ التعليق عند 64-66 يعترف بأن التكرار «لا مفر منه».',
      'اشتقّهما من مصدر تبديل واحد، أو أضف اختبارًا يفرض تطابق مجموعة الرموز.'),

    F('U44', 'low', 'interface',
      'حقول إدخال مسمّاة بـ placeholder فقط',
      'acp-composer.mjs:17 · settings-panes.mjs (7 مواضع) · workspace-library.mjs:978 · browser-pane.mjs:81',
      'placeholder ليس اسمًا متاحًا: يختفي عند الكتابة ولا يُنطق بثبات. md.mjs:162 يُخرج checkbox بلا أي اسم متاح لكل عنصر في قائمة مهام GFM.',
      'أضف label بصريًا مخفيًا أو aria-label لكل واحد؛ وأعطِ checkbox اسمًا من نص المهمة.'),

    F('U45', 'low', 'interface',
      'قائمة ＋ بلا aria-haspopup ولا aria-expanded',
      'src/renderer/acp-composer.mjs:16-19',
      'لا إعلان لقائمة أوامر انفتحت ولا أي خيار مُبرَز.',
      'أضف aria-haspopup="listbox" و aria-expanded مبدّلًا في openMenu/closeMenu.'),

    F('U46', 'low', 'interface',
      'ثلاثة قوالب بنمط tabindex="0" بلا role',
      'src/renderer/mcp-setup.mjs:47, 54, 60',
      'نفس فئة العيب كـ U18، أخف.',
      'أضف role="button" لسلاسل القوالب الثلاث.'),

    F('U47', 'low', 'interface',
      'z-index بلا مقياس — وخلل حقيقي',
      'paper.css:1920 و 276',
      '14 قيمة حرفية بلا رمز --z-*. و .ctx-menu عند 300 فوق .overlay عند 60 — كليك يمين على صف ملف داخل ورقة إعدادات يطفو القائمة فوق ظهرتها وزر إغلاقها.',
      'أضف مقياس --z-base/-tile/-rail/-pop/-menu/-sheet/-overlay/-toast واستبدل الحرفية الأربع عشرة.'),

    F('U48', 'low', 'interface',
      'لا دعم لـ forced-colors ولا prefers-contrast',
      'src/renderer (0-deployments)',
      'وضع التباين العالي على ويندوز سيحوّل الظلال الصلبة والتدرجاتPastel إلى رمادي مسطح مع أزواج رموز لم تُتحقَّق يومًا في ذلك الوضع.',
      'كتلة @media (forced-colors: active) تستعيد border لكل عنصر يعتمد كليًا على box-shadow للإشارة إلى الحالة.'),

    F('U49', 'low', 'interface',
      'لا طبقة رموز design للمسافات والأنصاف والطبقات',
      'src/renderer/paper.css',
      '1158 مرجع var() — انضباط ألوان جيد — لكن التباعد حرفية مثبّتة في كل مكان، وتبقى 117 hex و 85 rgb() في ورقة الأساس.',
      'أضف مقياس --sp-1..8 و --r-sm/md/lg وابدأ بأكثر الحرفية تكرارًا.'),

    F('U50', 'low', 'interface',
      'index.html:2 يسمح بـ unsafe-inline في style-src',
      'src/renderer/index.html:2',
      'كل style="…" في الكود يعتمد عليه، بما فيها الـ 23 التي تعطّل RTL.',
      'اطوِ الأنماط السطرية في أصناف ثم أسقط \'unsafe-inline\' من style-src.'),

    F('U51', 'low', 'interface',
      'مبدّل Agent Platform واللوح ملحقان بـ body خارج .sheet',
      'src/renderer/agent-platform.mjs:100, 105',
      'يهربان من أي نطاق سمة يعتمد على الوجود داخل المكتب، ويخفيان عن طبقات #overlay-root و #toast-root.',
      'أدرجهما داخل els.grid، أو اجعل اللوح نوع overlay مسجّلًا عبر renderOverlay.'),

    /* -------------------------------------------------------------- core */
    F('C1', 'critical', 'core',
      'طبقتا دفاع SSRF لا تملكان أي موضع استدعاء إنتاجي',
      'src/core/research/security/researchSecurity.js:193, 207, 215 · searchProvider.js:24-36',
      'screenResolvedAddress و screenRedirect و MAX_REDIRECTS — الدوال الثلاث التي تدافع عمّا لا يستطيع فحص نصي رؤيته — مُعرَّفة ومختبَرة وموثّقة كعقد مزوّد، ولا مزوّد واحد يلتزم: لا يوجد مزوّد مسجَّل أصلًا (io.searchProviders فارغ). DNS rebinding وإعادة التوجيه إلى بيانات البيانات الوصفية بلا دفاع. REBINDING_SUFFIXES قائمة حجب من 10 مدخلات يقول تعليقها الخاص إنها «لا تكتمل أبدًا».',
      'انقل الفحص إلى داخل مسار الجلب في SourceManager.fetchFull/_screen: حلّ العنوان بـ dns.lookup(host, {all:true}) وافحص كل عنوان قبل فتح أي مقبس؛ واضبط maxRedirects: MAX_REDIRECTS و redirect دالة تستدعي screenRedirect. وأضف تأكيد إقلاع أن كل مزوّد مسجَّل يعلن ssrfChecked: true.'),

    F('C2', 'critical', 'core',
      'ميزانية التوكن/التكلفة للوكلاء غير قابلة للإنفاذ',
      'src/core/agents/governor.js:30-36, 193-198, 245-253 · watchdog.js:40-44',
      'خمس ميزانيات من ست تُزاد حصريًا بـ noteUsage() — و noteUsage بلا أي موضع استدعاء في src/ (فقط في الاختبارات). فـ record.tokens و cost و tasks تبقى 0 دائمًا، و _breach() لا يمكنه أبدًا إعادة AGENT_TOKEN_BUDGET_EXCEEDED أو AGENT_COST_BUDGET_EXCEEDED، و _runBreach() لا يمكنه إعادة تجاوز ميزانية التشغيل. watchdog يصنّف الخمسة كـ \'budget\' — رموز لا يمكن بلوغها في الإنتاج.',
      'استدعِ governor.noteUsage من الموضع الوحيد الذي يرى كل استجابة نموذج: غلّف محوّل المزوّد في ai/provider.js، أو آلة reasoning/reasoning.js:21,47,72,93 و runtime/evaluator.js:18 — وهي مواضع الاستدعاء الوحيدة على مسار المهمة. وأضف اختبار تأكيد أن تشغيلًا اصطناعيًا بـ 600 ألف توكن يعطي sweep() غير فارغ.'),

    F('C3', 'high', 'core',
      'provider.generate بلا مهلة ولا إشارة إبطال في 6 من 8 مواضع',
      'reasoning.js:21, 47, 72, 93 · runtime/evaluator.js:18 · planning/planner.js:150',
      'reasoning.js:72 و evaluator.js:18 يُستدعيان من داخل حلقة التنفيذ (runtime.js:148). استدعاء معلّق يحجب الحلقة إلى ما لا نهاية. مهلة المنسّق لا تغطي: runtime.cancel ينادي controller.abort() لكن generate() المعلّقة لم تستقبل الإشارة أصلًا.',
      'اجعل العقد إلزاميًا: generate({messages, signal, timeoutMs = 60_000}). غلّفه مرة واحدة في ai/provider.js بـ Promise.race ضد مؤقت مع الإشارة، ومرّر task._signal إلى reasoner.analyze/decide/evaluate/diagnose (runtime.js:106Currently لا يمرّر أي شيء).'),

    F('C4', 'high', 'core',
      'runtime.cancel() يبلّغ عن مهمة ملغاة بينما العمل ما زال يعمل',
      'src/core/runtime/task-manager.js:87-102 · src/core/runtime/runtime.js:126-187',
      'TaskManager.cancel ينتقل إلى CANCELLING → CANCELLED بشكل متزامن، دون فحص أن حلقة التنفيذ توقفت. المنسّق يرى cancelled فيعيد "task ended in cancelled" للمستخدم، و _runLoop أخيرًا لن ينفَّذ فتبقى المهمة في _tasks، ثم تستأنف الحلقة حين تستقر نداء النموذج.',
      'اجعل الإلغاء تعاونيًا: اضبط task.cancellation، وألغِ، ودع _runLoop ينفّذ الانتقال في finally. أو على الأقل أعِد bool من runtime.cancel يعترف بأن الحلustre لم تعترف، واعرضه في نتيجة المنسّق.'),

    F('C5', 'high', 'core',
      'WorkflowEngine.cancel() قد يبلّغ cancelled: true على نسخة تنتهي failed',
      'src/core/workflows/engine.js:174-201 مقابل 263-268 و 149-162',
      'cancel() يرجع {cancelled:true} قبل أي انتقال — هو يطلب فقط. إن هبط الإلغاء بينما منفّذ عقدة في الطور ورفض بخطأ خاص به (محوّل shell بـ "process killed"، أو AbortError)، يأخذ catch في 263 الفرع غير الإلغائي. النتيجة: قيل للمستدعي cancelled والنسخة failed. هذا بالضبط العيب الذي كُتب engine.js:12-15 لتفاديه ("الإلغاء حقيقي").',
      'في catch الخاص بـ _visit افحص instance.cancellation.requested قبل التصنيف وحوّل أي خطأ إلى WorkflowCancelledError. صفّر instance.currentNodeId في مسار الفشل أيضًا، وأضف partial: true إلى instanceView عند status === failed مع outputs غير فارغة.'),

    F('C6', 'high', 'core',
      'تحقق DAG غير مكتمل و maxNodes لا يُنفَّذ',
      'src/core/workflows/definition.js:20-44, 59 · engine.js:219, 233',
      'لا فحص للدورات (دورة تنجح في التحقق وتفشل وقت التشغيل بعد أن تكون عقد قد نُفِّذت وحُفظت)، ولا فحص لعقد start متعددة (engine.js:219 يأخذ الأولى فقط والثانية تُتجاهل بصمت)، ولا فحص لإمكانية الوصول. و settings.maxNodes ميت: لا مستهلك له في src/core. ولا إعادة محاولة على الإطلاق: خطأ أداة عابر يُسقط النسخة كلها.',
      'أضف تمرير DFS بألوان يرفض أي دورة؛ اشترط start واحدة بالضبط؛ أبلغ عن العقد غير القابلة للوصول؛ نفّذ maxNodes في validateWorkflow؛ وأضف retries اختيارية لكل عقدة افتراضيًا 0 مع سقف صلب/backoff من recovery/recovery.js:27-32.'),

    F('C7', 'medium', 'core',
      'ثلاثة منسّقات متنافسة بلا أرقام موحّدة',
      'orchestrator/orchestrator.js:568L · harness-orchestrator/orchestrator.js:556L · agents/coordinator.js:427L · harness-orchestrator/coordinator.js:528L',
      'اختبار phase5-architecture.test.mjs:105-137Already يثبّت وجود منسّقين ويؤكّد أن المنسّقين يتقاسمان مجموعات methods متمايزة — لكن ذلك لا يغطي الانقسام الرقمي الفعلي: عمق التفويض 3/3/4/3، مهلة المهمة 15/10/5 دقيقة، Fan-out 6/لا شيء/لا شيء، فترة الاستطلاع 40/25/50 مللي ثانية، ومخزنان مختلفان للتتبّع. طلب واحد عبر platform.orchestrator يسمح بعمق 3 ومهلة 15 دقيقة؛ عبر platform.harnessOrchestrator يسمح بعمق 4 ومهلة 10. لا اختبار يؤكد اتفاقهما.',
      'ارفع العمق والتباعد والمهلة وفترة الاستطلاع إلى ثابت ORCHESTRATION_LIMITS مُجمّد واحد تستورده الملفات الأربعة، ووسّع اختبار phase5-architecture ليؤكد أن كل وحدة تقرأ أرقامها من هناك.'),

    F('C8', 'medium', 'core',
      'خمس خرائط ذاكرة لا تتقلّص',
      'orchestrator.js:62 · harness-orchestrator/orchestrator.js:77, 78 · task-manager.js:17-18 · agents/coordinator.js:60',
      'orchestrator._runs سجل لكل handle() بما فيه نص الطلب والحصيلة الكاملة، مدى العملية؛ list({limit}) يصفّي ولا يحذف. harness._runs كتابة فقط — لا شيء يقرأها، تسريب صريح. TaskManager._tasks لا يُحذف منه أبدًا، وكل مهمة تحمل تتبّعًا من 500 مدخل. تباين: research/engine.js:64 يفرض هذا بشكل صحيح بـ MAX_RETAINED_TASKS = 25.',
      'أضف prune({keep}) إلى Orchestrator محاكيًا Scheduler.prune، واستدعِه من _conclude. احذف _runs في منسّق harness. ضع سقف 200 على _tasks بإخراج FIFO.'),

    F('C9', 'medium', 'core',
      'لا wrapUntrusted على المسار الوحيد الذي يمرّر محتوى الويب إلى نموذج',
      'research/agents/synthesizer.js:214-238 · researchSecurity.js:284',
      'wrapUntrusted موثّق كـ «الطريقة الوحيدة المدعومة» لوضع محتوى مسترجَع أمام نموذج، ومصدَّر، ولا يُستدعى إلا من الاختبار. synthesizer.write يدمج نصًا متأثرًا بالمهاجم في موجّه النموذج مباشرة. screenContent يشلّ الأشكال الشبيهة بالتعليمات ويحفظها عمدًا. verifyProse يتحقق من الاستشهادات لا من التعليمات.',
      'الفFINDINGS بـ wrapUntrusted في synthesizer.write (و reviewer.js و evidenceExtractor.js و queryPlanner.js).'),

    F('C10', 'medium', 'core',
      'entry.resources المصفوفة الوحيدة بلا حد في بيان المهارة',
      'src/core/skills/schemas/SkillManifest.js:218-222 · LocalSkillSource.js:82-86',
      'البيان يحدّ القدرات (40) والوسوم (24) والاعتماديات (32) — والموارد بلا حدّ عددي. LocalSkillSource يقرأ كل مسار تسلسليًا، وكل قراءة محدودة بـ 512 كيلوبايت. بيان بـ 512 كيلوبايت × N يكلّف N × 512 كيلوبايت من إدخال القرص ويدخل كله في digestOfSkill.',
      'أضف MAX_RESOURCES = 32 وارفض ما فوقه، alongside الحدود الثلاثة القائمة. وارفض المسارات المكررة (المكرر يُقرأ مرتين اليوم).'),

    F('C11', 'medium', 'core',
      'withTimeout يبلّغ كل مهلة أداة كـ unknown-tool ولا يلغي الأداة',
      'src/core/tools/manager.js:197-216',
      'الدالة لا تستقبل معرّف الأداة، فالفرعان يثبّتان "unknown-tool" — كل مهلة أداة تُعلن هكذا بينما حدث الحافز في 184 يحمل المعرّف الصحيح. وثانيًا: عند المهلة ترفض الوعد لكن tool.execute لا يُلغى إطلاقًا — withTimeout يستمع للإشارة الواردة فقط، ووحدة التحكم التي ينشئها لا تُستخدم.',
      'مرّر id إلى withTimeout. أنشئ AbortController محليًا مرتبطًا بالإشارة الواردة ومرّر signal إلى tool.execute، واستدعِ local.abort في المؤقت.'),

    F('C12', 'medium', 'core',
      'fetch و read يختلفان في handling لمُدخل entry نصي',
      'src/core/skills/sources/LocalSkillSource.js:80 مقابل 100',
      'fetch يتعامل مع الشكلين؛ read لا يتعامل إلا بالشكل الكائن. SkillManifest.normalizeEntry يقبل النص ويطبّعه، لكن read يُستدعى على بيان محفوظ قبل التطبيع حيث قد يكون entry نصًّا. فالمهارة تُحمّل SKILL.md بدل ملف الدخول المُعلَن، بصمت وبلا خطأ.',
      'استخرج مساعدة entryPathOf(manifest) واحدة واستخدمها في الاثنين. ولأن read على مسار التحميل بعد الموافقة، خطأ صريح أجدى من تراجع صامت.'),

    F('C13', 'low', 'core',
      'ثلاثة أخطاء دلالية في defineWorkflow',
      'src/core/workflows/definition.js:32, 28-29',
      'الشرط !Array.isArray(NODE_TYPES) ? false : … دائمًا صحيح Anderson لأن NODE_TYPES مصفوفة مثبّتة، فيختزل إلى فحص includes — يعمل لكنه find/replace سيّئ سيضلّل القارئ التالي. وعند 28-29 عنصر null في nodes يرمي TypeError بدل {ok:false}، فيرمي engine.run خطأً خامًا بدل رسالة invalid workflow النظيفة التي كُتب ليقولها.',
      'اكتب if (!NODE_TYPES.includes(n.type)). وأضف حارس isPlainObject(n).'),
  ];

  /* --------------------------------------------------------------- charts */

  const charts = {
    /* Derived from `findings` at render time by charts.js — these are the
     * checked-in values so the numbers are inspectable without a browser. */
    severityByDomain: [
      { domain: 'الأمان (main)',    critical: 3,  high: 7,  medium: 10, low: 6,  total: 26 },
      { domain: 'الواجهة (renderer)', critical: 6,  high: 18, medium: 17, low: 10, total: 51 },
      { domain: 'المنطق (core)',     critical: 2,  high: 4,  medium: 6,  low: 1,  total: 13 },
    ],

    totals: { critical: 11, high: 29, medium: 33, low: 17, all: 90 },

    coverageTrend: [
      { label: 'الأسطر',   actual: 85.97, gate: 70 },
      { label: 'العبارات', actual: 85.97, gate: 70 },
      { label: 'الدوال',   actual: 83.77, gate: 80 },
      { label: 'الفروع',   actual: 76.37, gate: 70 },
    ],

    /* Every "defence exists but cannot fire" — the highest-value cluster in
     * the whole report, because the code reads as safe and is not. */
    ghostDefences: [
      { name: 'wrapUntrusted',        file: 'researchSecurity.js:284', tested: true,  called: false, protects: 'prompt injection from web content' },
      { name: 'screenResolvedAddress', file: 'researchSecurity.js:193', tested: true, called: false, protects: 'DNS rebinding → SSRF' },
      { name: 'screenRedirect',        file: 'researchSecurity.js:207', tested: true, called: false, protects: 'redirect to cloud metadata' },
      { name: 'MAX_REDIRECTS',         file: 'researchSecurity.js:215', tested: true, called: false, protects: 'redirect chain depth' },
      { name: 'governor.noteUsage',    file: 'governor.js:193',        tested: true, called: false, protects: 'token + cost budget' },
      { name: 'fs-actions inside()',   file: 'fs-actions.js',         tested: true, called: 'partial', protects: 'path traversal — applied on fs:* only' },
    ],

    rtlSplit: [
      { label: 'تصريحات CSS فيزيائية',   value: 99,  need: 'margin-left/right, padding-left/right, border-left/right, left/right, text-align' },
      { label: 'تصريحات JS فيزيائية',    value: 23,  need: 'style.left/right, paddingLeft, marginLeft, tree indent' },
      { label: 'خصائص CSS منطقية',      value: 0,   need: 'margin-inline-*, inset-inline-*, text-align:start' },
      { label: 'سمات dir="rtl"',        value: 0,   need: 'on <html> and any dynamic content' },
      { label: 'خطوط عربية',            value: 0,   need: 'Noto Naskh / Cairo / Tajawal with U+0600-06FF' },
    ],

    /* effort = touches, impact = how much of the report it closes */
    fixMatrix: [
      { id: 'P1', title: 'إغلاق باب التنفيذ: قوائم سماح لكل مسار تنفيذ', sev: 'critical',
        findings: ['S1', 'S2', 'S3', 'S4', 'S5', 'S7', 'S8'], files: 9, effort: 3, impact: 9 },
      { id: 'P2', title: 'العربية و RTL: خط نسخ + dir + 122 تصريحًا منطقيًا', sev: 'critical',
        findings: ['U1', 'U2', 'U25', 'U34'], files: 23, effort: 5, impact: 10 },
      { id: 'P3', title: 'تنشيط الدفاعات الميتة (SSRF + الميزانية + wrapUntrusted)', sev: 'critical',
        findings: ['C1', 'C2', 'C9'], files: 7, effort: 4, impact: 9 },
      { id: 'P4', title: 'غلق تسريبات الذاكرة في الـ renderer', sev: 'critical',
        findings: ['U3', 'U4', 'U24', 'U12', 'U13'], files: 4, effort: 2, impact: 7 },
      { id: 'P5', title: 'مسارات التخطيط القسري الأربعة', sev: 'critical',
        findings: ['U5', 'U6', 'U7', 'U19'], files: 4, effort: 2, impact: 8 },
      { id: 'P6', title: 'وصول لوحة المفاتيح: helper واحد يصلح 43 عنصرًا', sev: 'high',
        findings: ['U15', 'U16', 'U17', 'U18', 'U46'], files: 6, effort: 2, impact: 7 },
      { id: 'P7', title: 'حوارات نظامية وحصر تركيز لكل الأوراق', sev: 'high',
        findings: ['U9', 'U14', 'U22'], files: 4, effort: 2, impact: 7 },
      { id: 'P8', title: 'حارس الوعد: 22 معالجًا بلا catch + lint', sev: 'high',
        findings: ['U20', 'U8', 'U33', 'U38', 'U39', 'U40'], files: 12, effort: 2, impact: 6 },
      { id: 'P9', title: 'الإشارة والمهلة على المزوّد — يغلق C3 و C4 معًا', sev: 'high',
        findings: ['C3', 'C4', 'C5'], files: 8, effort: 3, impact: 8 },
      { id: 'P10', title: 'إزالة Keychain المتزامن + إصلاح مسارات الاعتماد', sev: 'high',
        findings: ['S6', 'S9', 'S10'], files: 5, effort: 1, impact: 6 },
      { id: 'P11', title: 'تباين السمات + aria-live + motion', sev: 'medium',
        findings: ['U26', 'U27', 'U29', 'U36'], files: 5, effort: 2, impact: 5 },
      { id: 'P12', title: 'سقوف الذاكرة في المنسّق + رموز design', sev: 'medium',
        findings: ['C7', 'C8', 'S12', 'S14', 'S15', 'U47'], files: 8, effort: 2, impact: 4 },
      { id: 'P13', title: 'حذف الكود الميت', sev: 'low',
        findings: ['U21', 'U23', 'U42', 'S24', 'S25', 'C13'], files: 6, effort: 1, impact: 2 },
    ],

    /* Suggestions for where the project should go next — beyond fixing. */
    roadmap: [
      { horizon: 'الأسبوع 1–2', title: 'اجعل العربية citizen من الدرجة الأولى',
        body: 'ليس ترجمة سلاسل فقط: خط نسخ، و dir، و 122 تصريحًا منطقيًا، ثم اختبار واحد يمنع الانحدار (يرفض الخصائص الفيزيائية في CSS و mjs). القيمة: بدونها الواجهة ليست لك.',
        effort: 'M', payoff: 'الاستخدام اليومي' },
      { horizon: 'الأسبوع 1–2', title: 'اعتبر الـ renderer حدّ ثقة زائفًا في الوثائق',
        body: 'الملف main.js:1324-1330 يشرح القاعدة بوضوح ثم يطبّقها على fs:* فقط. اجعل التطبيق هو القاعدة: trustedRoot في كل معالج يأخذ مسارًا، بدل استثناء يُذكَّر.',
        effort: 'S', payoff: 'أمان' },
      { horizon: 'الأسبوع 2–3', title: 'قاعدة lint تُقيس ما لا يُقاس',
        body: 'أربع قواعد جديدة تغطي أعلى 30 خطأ: خصائص فيزيائية في CSS، addEventListener بلا remove، await بلا catch، و spawn بوسيط من renderer. كل خطأ في هذا التقرير كان قابلًا للالتقاط آليًا.',
        effort: 'S', payoff: 'وقاية' },
      { horizon: 'الأسبوع 3–4', title: 'عمود اختبارات لـ main-process',
        body: '12 ملفًا بـ 0% تغطية يحتجز أهم النتائج في التقرير. ابدأ بـ main.js عبر استخراج أدواته (docs/architecture.md يصف نمط التفكيك الذي نجح في الـ renderer أصلًا).',
        effort: 'L', payoff: 'ثقة' },
      { horizon: 'الشهر 2', title: 'ميزانية تكلفة حقيقية من أول استجابة',
        body: 'الحوكمة مبنية ومختبَرة ولا تُستدعى. اربطها بمزوّد النموذج ثم اعرض snapshot الحقيقية في واجهة Settings — المستخدم يريد أن يرى إنفاقه لا أن يصدّق أن هناك حدًّا.',
        effort: 'M', payoff: 'منتج' },
      { horizon: 'الشهر 2–3', title: 'وحدة منفصلة بدل ثلاثة منسّقات',
        body: 'ليست حالة صدفة: اختبار العمارة يقرّ بوجود منسّقين ويؤكّد تقسيم المنسّقين. الفارق الحقيقي تكرار الأرقام. واحد ثابت مُجمّد + اختبار اتفاق يحلّها دون إعادة كتابة.',
        effort: 'M', payoff: 'صيانة' },
      { horizon: 'الشهر 3', title: 'أخطر نظام فرعي هو الأقل اختبارًا',
        body: 'أكبر نظام فرعي (9,078 سطر) هو الوحيد بلا اختبار مباشر لمصدرَيه البعيدين غير الموثوقَين (GitHubSkillSource و SkillsShSource، 429 سطرًا) — بينما المصدرين المحلي والمدمج مختبَران مباشرة.',
        effort: 'S', payoff: 'أمان' },
      { horizon: 'الشهر 3', title: 'شمول الوصول والطباعة',
        body: 'لا forced-colors ولا prefers-contrast رغم أن الطابع البصري قائم على ظل صلب. مستخدم التباين العالي على ويندوز يرى رماديًا مسطحًا. Also: 87 موضعًا تحت عتبة AA في خمس سمات.',
        effort: 'M', payoff: 'شمول' },
    ],

    severityMeta: SEV,
  };

  return { metrics, findings, charts, SEV };
})();
