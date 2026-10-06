const fs = require('node:fs');
// yaml 用于读取 patch 里的模型 provider 列表（AI 诊断面板的下拉框）；
// 与 gateway.js 同款降级写法：NODE_PATH 未含 runtime 时不阻塞页面渲染。
let yamlModule = null;
try { yamlModule = require('yaml'); } catch { /* 降级：AI 面板不列 provider */ }
const ops = require('./ops.js');
const cores = require('./core-manager.js');
const profiles = require('./profiles.js');
const plugins = require('./plugins.js');
const pluginPaths = require('./plugin-paths.js');
const grants = require('./grants.js');
const actions = require('./actions.js');   // 破坏性 action 的唯一定义处（见该文件头注释）

const groups = [
  { id: 'overview', label: '概览', description: '查看运行状态、重启 DSH 和调整服务端口。', items: [['overview', '运行状态'], ['runtime', '运行控制']] },
  { id: 'core', label: '核心与扩展', description: '管理 DSH 核心版本、插件、npm 下载源与 profile 配置文件。', items: [['versions', 'DSH 版本'], ['plugins', '插件管理'], ['registry', 'npm 源'], ['config', '配置文件']] },
  { id: 'data', label: '数据与权限', description: '管理配置档与备份，以及目录、容器和插件 URL 的访问权限。', items: [['profiles', '配置档'], ['backups', '备份与恢复'], ['grants', '目录权限'], ['containers', '容器权限'], ['pluginPaths', '插件 URL 放行']] },
  { id: 'diagnostics', label: '诊断', description: '查看日志、执行 dsh/npm/pnpm 命令、开启限时网络调试。', items: [['logs', '诊断日志'], ['terminal', '命令行'], ['network', '网络调试']] }
];
const views = new Set(groups.flatMap((group) => group.items.map(([id]) => id)));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function selectedView(value) { return views.has(value) ? value : 'overview'; }

// ⚠ 0.3.58：safe mode 下的"一键修复"卡片。safe mode 的 reason 已经是
// diagnoseStartupFailure 从 core 启动错误里提取的可读根因；这里对【确定性
// 可自愈】的两种根因给出直达修复按钮，而不是让管理员去猜要改哪个文件：
//   · patch 层损坏（解析非数组 / 双文档）→ action 'heal-patch-layer'：
//     备份现文件后重置为合法空层（裸 []），随即重启 core。用户的 patch 条目
//     会丢，所以卡片上必须写明这一点；
//   · 插件加载项重复（duplicate loader entry id: X）→ action
//     'dedupe-patch-layer'：只删用户层里的重复声明（保留第一份），不动插件
//     本体——包自带的 bundle patch 仍会装载，功能无损。
// 其他根因（端口占用、缺导出等）不适合盲修，不显示卡片，走常规排查路径。
// 启动异常诊断卡（0.3.61）：state.error 只有一行，看不出「卡在哪一步」。
// supervisor 在超时/启动失败时把结构化诊断写入 startup-reports/last-failure.json
// （失败类型、等待时长、根因线索、core 最后输出），这里渲染成卡片 + 一键动作。
function startupDiagnosisCard(diag, form, action, state) {
  if (!diag || !diag.at) return '';
  const age = Date.now() - Date.parse(diag.at);
  const fresh = Number.isFinite(age) && age >= 0 && age < 24 * 3600 * 1000;
  if (!fresh && state.mode !== 'safe') return '';
  const labels = {
    'startup-timeout': '启动超时：核心未在限时内打印就绪标记（已自动加时重试一次）',
    'startup-failed': '启动失败：核心进程提前退出',
  };
  const kindLabel = labels[diag.reason] || String(diag.reason || '启动异常');
  const hints = (diag.hints || []).map((hint) => '<li><strong>' + escapeHtml(hint.text) + '</strong>' + (hint.advice ? '<br><span class="hint">' + escapeHtml(hint.advice) + '</span>' : '') + '</li>').join('');
  const tail = (diag.tail || []).slice(-25).join('\n');
  const waited = typeof diag.waitedMs === 'number' ? Math.round(diag.waitedMs / 1000) + ' 秒' : '—';
  return '<div class="card remediation"><h3>启动异常诊断' + (fresh ? '（最近一次）' : '（历史记录）') + '</h3>'
    + '<p><strong>' + escapeHtml(kindLabel) + '</strong></p>'
    + '<p class="hint">时间：' + escapeHtml(new Date(diag.at).toLocaleString('zh-CN')) + ' · 等待 ' + waited
    + (diag.runtimeVersion ? ' · 核心 ' + escapeHtml(String(diag.runtimeVersion)) : '')
    + (diag.profile ? ' · 配置档 ' + escapeHtml(String(diag.profile)) : '') + '</p>'
    + (diag.message ? '<p class="error">' + escapeHtml(diag.message) + '</p>' : '')
    + (hints ? '<h4>根因线索</h4><ul>' + hints + '</ul>' : '<p class="hint">没有提取到已知特征线索，可打开核心日志人工排查。</p>')
    + (tail ? '<details><summary>核心最后输出（已遮盖令牌）</summary><pre>' + escapeHtml(tail) + '</pre></details>' : '')
    + '<div class="actions">' + action('sync-module-resolution', '同步模块解析层') + action('restore-exemptions', '重建版本豁免') + '<a class="primary-link" href="/__fnos/logs?source=dsh">查看核心日志</a></div>'
    + '<p class="hint">「同步模块解析层」按当前核心目录重建回退层软链、归档遮蔽回退层的旧版核心包；「重建版本豁免」按期望清单重放被数据回滚清空的 exact-version 豁免。两者在核心重启后生效。</p>'
    + '</div>';
}
// AI 诊断模式卡（0.3.61）：核心起不来时，用只含模型 provider 的纯净 patch 启动
// （supervisor 的 enter-diagnosis），再用网关侧直连模型的对话面板分析日志——
// 该通道不经过 core，核心挂了也能用；退出时从进入前的备份恢复原配置。
function diagnosisCard(state, form, action, diag, csrf, aiProviders) {
  const active = !!diag?.active;
  if (!active && state.mode !== 'safe') return '';
  const legacy = active && diag.mode !== 'read-only';
  const items = aiProviders || [];
  const options = items.map(p => '<option value="' + escapeHtml(p.id) + '" data-models="' + escapeHtml(JSON.stringify(p.models || [])) + '" data-preferred="' + escapeHtml(p.model || '') + '"' + (p.preferred ? ' selected' : '') + '>' + escapeHtml(p.id) + (p.reason ? '（暂不支持）' : '') + '</option>').join('');
  const core = ['ready', 'rollback'].includes(state.mode) ? '核心已就绪' : '核心未就绪（' + escapeHtml(state.mode || 'unknown') + '）';
  return '<div class="card remediation ai-diagnosis"><h3>只读 AI 辅助诊断</h3>'
    + '<p><strong id="ai-core-state">' + core + '</strong>。此面板不依赖核心启动；发送诊断请求不会停用插件、修改 patch 或重启核心。</p>'
    + (legacy ? '<p class="error">这是旧诊断流程留下的配置变更，不能据此认定第三方插件全部已停用。请确认并恢复原配置。</p><p class="hint">原配置备份：<code>' + escapeHtml(String(diag.backup || '未记录')) + '</code></p>' : '')
    + '<p class="hint">仅发送运行状态（模式与版本）和你输入的内容；不会自动上传原始配置或日志。请先遮盖敏感内容。仅支持文本 Chat/API-key；OAuth/Codex 等协议暂不支持。</p>'
    + (items.some(p => p.temporaryOnly) ? '<p class="error">当前配置不可解析：仅展示官方内置 Chat 目录，不读取原密钥。请输入本次临时诊断密钥；原配置保持不变。</p>' : '')
    + (!items.length ? '<p class="error">未能读取可用模型配置。请先校验配置或备份，不要为打开此面板而重置 patch。</p>' : '')
    + '<div id="ai-log" aria-live="polite"></div><div class="ai-fields">'
    + '<label>模型 provider<select id="ai-provider">' + options + '</select></label>'
    + '<label>模型<select id="ai-model"></select></label>'
    + '<label>端点（服务器配置/官方内置目录）<input id="ai-base" type="url" readonly></label>'
    + '<p id="ai-provider-hint" class="hint"></p>'
    + '<label>临时诊断密钥（可选，不保存）<input id="ai-key" type="password" autocomplete="off" placeholder="留空则使用明确引用的托管 API key"></label>'
    + '</div><label>错误信息或问题<textarea id="ai-input" rows="3" placeholder="粘贴已脱敏的错误，并说明发生的操作"></textarea></label>'
    + '<input id="ai-csrf" type="hidden" value="' + escapeHtml(String(csrf || '')) + '"><p><button type="button" id="ai-send">发送给所选模型</button></p>'
    + (active ? '<div class="actions">' + action('exit-diagnosis', legacy ? '恢复旧诊断前配置并退出' : '关闭只读诊断') + '</div>' : '')
    + '</div>';
}
// 会话存档卡片（0.3.61）：让管理员在设置页看到「是否有会话尚未存档」，并可一键
// 建快照。回滚只回退到最近一次快照，未存档的会话在回滚时会丢——把它变成可见、
// 可操作的指标，而不是隐含风险。
// 装载脱节卡片（0.3.61）：插件已安装、patch 也声明了，却没登记进 bundles ⇒ 客户端
// 模块不会被装载，浏览器 boot 报「did not activate / import failed」，而核心照常运行
// ——正是「核心正常但 Web 进不去」的典型成因。启动时会自动登记，这里给手动入口。
function pluginWiringCard(wiring, action) {
  const issues = (wiring && wiring.issues) || [];
  if (!issues.length) return '';
  const fixable = issues.filter((item) => item.fixable);
  const rows = issues.map((item) => '<li><strong>' + escapeHtml(item.id) + '</strong>' +
    '<br><span class="hint">' + escapeHtml(item.detail) + '</span></li>').join('');
  return '<div class="card remediation"><h3>检测到插件装载脱节</h3>'
    + '<p>下面这些插件已被安装、也在配置文件里声明，但没有登记进配置档的装载清单（bundles），因此它们的<strong>客户端模块不会被装载</strong>：浏览器会出现「N entry did not activate」，而<strong>核心本身仍正常运行</strong>。</p>'
    + '<ul>' + rows + '</ul>'
    + '<div class="actions">' + (fixable.length ? action('repair-plugin-wiring', '登记到装载清单并重启') : '') + '</div>'
    + '<p class="hint">核心启动时会自动登记可修复项；这里提供手动入口（需重启核心生效）。</p></div>';
}
function sessionArchiveCard(archive, action, settings) {
  if (!archive) return '';
  // 策略说明（0.3.61）：默认「自动」，可选定时（周期自定义）或手动。
  const mode = settings?.sessionMode || 'auto';
  const intervalMin = settings?.sessionInterval || 60;
  const humanInterval = intervalMin >= 1440 ? Math.round(intervalMin / 1440) + ' 天'
    : intervalMin >= 60 ? (intervalMin % 60 === 0 ? intervalMin / 60 + ' 小时' : intervalMin + ' 分钟')
    : intervalMin + ' 分钟';
  const modeText = {
    auto: '自动：核心启动后检测到未存档的会话即建立快照',
    timer: '定时：每 ' + humanInterval + ' 检查一次，有更新则快照',
    manual: '手动：仅在点击下方按钮时检查',
  }[mode];
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';
  const pending = archive.added || archive.grown;
  const lastText = archive.lastAt ? new Date(archive.lastAt).toLocaleString('zh-CN') : '从未记录（升级后首次检查会建立基线）';
  const tone = !archive.known ? '' : pending ? 'bad' : 'ok';
  const headline = !archive.known
    ? '尚未建立会话存档基线'
    : pending
      ? '有未存档的会话更新'
      : '会话存档已是最新';
  const detail = !archive.known
    ? '已有 ' + archive.count + ' 个会话（' + mb(archive.totalBytes) + '）。点击下方按钮建立基线并立即快照。'
    : pending
      ? '自上次快照后：新增 ' + archive.added + ' 个会话、' + archive.grown + ' 个有更新，待存档约 ' + mb(archive.pendingBytes) + '。若不快照，一旦发生失败回滚，这些会话会随 dsh-home 一起回退。'
      : '共 ' + archive.count + ' 个会话（' + mb(archive.totalBytes) + '），全部已在快照覆盖范围内。';
  return '<div class="card' + (pending || !archive.known ? ' remediation' : '') + '"><h3>会话存档 <span class="hint">' + escapeHtml(headline) + '</span></h3>'
    + '<p>' + escapeHtml(detail) + '</p>'
    + '<p class="hint">当前策略：' + escapeHtml(modeText) + '。上次存档点：' + escapeHtml(lastText) + '。失败回滚会把数据恢复到最近一次快照，未存档的会话将无法恢复。</p>'
    + '<div class="actions">' + action('snapshot-sessions', pending || !archive.known ? '检查并立即快照' : '重新检查') + '<a class="primary-link" href="/__fnos/?view=backups">管理备份</a></div>'
    + '</div>';
}
// ── 分级排障引导（0.3.62）──────────────────────────────────────────────
// 背景：safe mode 里原本平铺了 10 多个修复按钮（重置 patch、清理重复声明、
// 禁用第三方插件、修复插件文件、同步模块解析、重建豁免、AI 诊断……），
// 破坏性从"无损重启"到"清空全部配置"混在一起，管理员只能靠猜。
// 2026-10-02 就因此踩坑：点了「重置 patch 配置并重启」（dsh-fix），
// 把 16 条插件配置降成 1 条 —— 而它本该先从备份恢复。
//
// 改成按**破坏性从小到大**分四级，每级只暴露该级该做的事，并写明影响：
//   ① 无损：重启（不动任何数据）
//   ② 可逆：从备份恢复 / 清理重复声明（备份留底，随时可退）
//   ③ 隔离：安全模式 / 禁用第三方插件（不删文件，可一键恢复）
//   ④ 重置：重置 patch / 修复插件文件 / 切换核心（会丢配置，需二次确认）
//
// 另外提供"远程/离线排障"出口：导出诊断包，把日志交给外部排查。
function remediationGuide(options) {
  // action 按钮助手由 render() 作用域传入（本函数在模块层，拿不到 render 的局部定义）
  const { action, canRestore, hasBackups, canDedupe, canDisablePatch, canDisableThirdParty, canRepairFiles, dryRunAvailable } = options;
  const row = (title, desc, buttons, tone) =>
    `<div class="guide-row ${tone || ''}"><div class="guide-text"><strong>${title}</strong><span>${desc}</span></div><div class="guide-actions">${buttons}</div></div>`;

  const checkPanel = '<div class="guide-actions"><button type="button" id="recovery-check">运行只读基础检查</button></div><pre id="recovery-check-result" hidden aria-live="polite"></pre>';
  const failure = require('./recovery-guide').classifyFailure(options.error);
  if (failure.infrastructure) {
    return '<div class="card remediation guide"><h3>' + escapeHtml(failure.title) + '</h3><p>' + escapeHtml(failure.advice) + '</p>' + checkPanel
      + '<div class="guide-actions"><a class="primary-link" href="/__fnos/logs?source=supervisor">查看诊断日志</a><a class="primary-link" href="/__fnos/diagnostics-pack" download>导出诊断包</a>'
      + (failure.kind === 'port' ? '<a class="primary-link" href="#port-settings">检查端口设置</a>' : '')
      + action('retry', '完成路径/权限/端口检查后重试') + '</div>'
      + '<p class="hint">已隐藏禁用插件与重置配置：这些操作不能修复当前基础设施故障。AI 面板仅供只读分析。</p></div>';
  }
  const steps = [];
  steps.push(row('① 先核对日志，再重试',
    '先查看启动日志与错误阶段。重启不修改配置，但会中断当前任务；不是所有故障都能靠重启恢复。',
    action('retry', '重新启动 DSH')));

  const level2 = [];
  if (canRestore) level2.push(action('restore-patch-config', '从备份恢复 patch 配置'));
  if (canDedupe) level2.push(action('dedupe-patch-layer', '清理重复声明并重启'));
  if (canDisablePatch) level2.push(action('disable-patch-config', '禁用全部自定义条目（自动备份）'));
  if (level2.length) {
    steps.push(row('② 配置可逆修复',
      '只动 cordis.patch.yml，且会把原文件先备份到 patch-backups —— 出问题能退回来。',
      level2.join(''), 'tone-safe'));
  }

  const level3 = [];
  if (canDisableThirdParty) level3.push(action('disable-third-party-plugins', '禁用第三方插件并重启'));
  steps.push(row('③ 隔离第三方插件',
    '把第三方插件的 loader 条目置为 disabled 后重启：<strong>插件文件不删</strong>，排除兼容性问题后可在插件管理里重新启用。',
    level3.join(''), 'tone-warn'));

  const level4 = [];
  if (canRepairFiles) level4.push(action('repair-plugin-files', '修复插件文件并重启'));
  steps.push('<details><summary>④ 高风险操作：确认备份后展开</summary>' + row('重置（会丢配置）',
    '<strong>重置 patch 配置会把文件里的插件启用/禁用与插入声明清空</strong>（插件本体不受影响）。只有在②③都无效、且已确认备份可用时才用。',
    action('heal-patch-layer', '重置 patch 配置并重启'), 'tone-danger') + '</details>');

  return `<div class="card remediation guide"><h3>按影响从小到大排障</h3>`
    + `<p class="hint">下面是四级修复，<strong>建议从上往下依次尝试</strong>；每级都写明了会动什么、能不能退回。</p>`
    + checkPanel + steps.join('')
    + `<div class="guide-foot"><span>都没解决？</span><a class="guide-link" href="/__fnos/diagnostics-pack" download>导出诊断包（交给外部排查）</a>${dryRunAvailable ? action('enter-diagnosis', '进入 AI 诊断模式') : ''}</div>`
    + `</div>`;
}

function safeModeRemediation(state, form, action) {
  if (state.mode !== 'safe' || !state.error) return '';
  const reason = String(state.error);
  if (require('./recovery-guide').classifyFailure(reason).infrastructure) return remediationGuide({ action, error: reason });
  if (/must be a top-level YAML array|failed to parse overlay/.test(reason)) {
    return `<div class="card remediation"><h3>检测到 patch 配置损坏</h3><p>cordis.patch.yml 的内容无法被 DSH 解析为合法配置。可以一键重置为合法的空配置：原文件会先备份到 patch-backups，随后自动重启 DSH 核心。</p><p class="error">注意：文件里的插件启用/禁用、插入声明会被清空（插件本体不受影响，需要时可在插件管理里重新配置）。</p><div class="actions">${action('heal-patch-layer', '重置 patch 配置并重启')}</div></div>`;
  }
  const dupMatch = reason.match(/插件加载项重复：\s*([A-Za-z0-9._@/-]{1,120})/);
  if (dupMatch) {
    const id = escapeHtml(dupMatch[1]);
    return `<div class="card remediation"><h3>检测到重复的插件声明</h3><p>插件 <strong>${id}</strong> 被声明了多次（常见原因：插件包自带装载声明，用户配置里又有一份誊写副本）。可以一键删除配置里的重复副本：插件本身及其装载声明会保留，随后自动重启 DSH 核心。</p><div class="actions">${action('dedupe-patch-layer', '清理重复声明并重启')}</div></div>`;
  }
  // 通用第三恢复按钮（对照上游桌面版 fatal-recovery 的 disablePlugins）：
  // 无论崩因是插件代码还是配置，禁掉全部第三方插件重启都是有效的排查/脱困动作。
  // 端口占用与"根因已由上面专属卡片接管"时不重复给（端口问题禁插件也无意义）。
  if (!/EADDRINUSE|端口被占用/.test(reason)) {
    return `<div class="card remediation"><h3>通用恢复：禁用全部第三方插件</h3><p>若启动失败疑似第三方插件与核心不兼容，可一键禁用它们后重启：插件文件保留，恢复请到「配置文件」页用备份恢复（或 dsh-fix 重置该层）。</p><div class="actions">${action('disable-third-party-plugins', '禁用第三方插件并重启')}</div></div>`;
  }
    return '';
}

function render(dataDir, state, session, requestUrl, openDshPath, nonce = '', networkDebug = null, dockerStatus = null, ports = null, diagnosticProviders = null) {
  const url = new URL(requestUrl, 'https://fnos.invalid');
  const view = selectedView(url.searchParams.get('view'));
  const group = groups.find((item) => item.items.some(([id]) => id === view));
  const notice = url.searchParams.get('notice');
  const update = ops.readJson(ops.dataPath(dataDir, 'update.json'), {});
  const settings = ops.readJson(ops.dataPath(dataDir, 'update-settings.json'), {});
  const registry = cores.registryUrl(settings.registry);
  const installedCores = cores.listCores(dataDir);
  const backups = ops.listBackups(dataDir);
  const backupSettings = ops.backupSettings(dataDir);
  const profileNames = profiles.list(dataDir);
  const activeProfile = profiles.selected(dataDir);
  const installedPlugins = plugins.list(dataDir, activeProfile);
  const pluginsNeedRepair = installedPlugins.some((item) => item.filesOk === false);
  // 装载一致性（0.3.61）：核心能起来、Web 却报 did not activate —— 根因是 patch 声明了
  // 某插件却没登记进 bundles（它的客户端模块不会被装载）。启动时会自动登记，这里也
  // 显式提示，让管理员在插件页直接看到问题与修复入口。
  let wiring = { ok: true, issues: [] };
  try { wiring = ops.diagnosePluginWiring(dataDir, activeProfile, yamlModule); } catch { wiring = { ok: true, issues: [] }; }
  const patchView = ops.readPatchConfig(dataDir, activeProfile);
  const patchBackups = ops.listPatchBackups(dataDir);
  // profile 为 null 的是没有来源 metadata 的历史备份：它们只能靠管理员明确确认
  // 才能恢复到当前配置档，绝不按"看起来像"自动判定来源。
  const legacyPatchBackups = patchBackups.filter((item) => !item.profile).map((item) => item.name);
  const patchBackupOptions = patchBackups.map((item) => {
    let entryCount = 0;
    try { entryCount = (fs.readFileSync(ops.dataPath(dataDir, 'patch-backups', item.name), 'utf8').match(/^- (id|insert):/gm) || []).length; } catch { /* 文件缺失按 0 */ }
    const origin = item.profile ? `配置档 ${item.profile}` : '来源未知的历史备份';
    return [item.name, `${item.name}（${new Date(item.time).toLocaleString('zh-CN')} · ${entryCount} 条 · ${origin}）`];
  });
  const startupDiag = ops.readJson(ops.dataPath(dataDir, 'startup-reports', 'last-failure.json'), null);
  // 会话存档状态（0.3.61）：回滚会把 dsh-home 打回快照时刻，会话随之回退。这里用
  // stat 级账本（不读文件内容）算出有多少会话尚未存档，供设置页提示并一键快照。
  let sessionArchive = null;
  try { sessionArchive = ops.sessionArchiveStatus(dataDir); } catch { sessionArchive = null; }
  const diagnosisState = ops.readJson(ops.dataPath(dataDir, 'diagnosis-state.json'), null);
  // AI 诊断面板的 provider 选项：诊断模式下 patch 只剩 llm-pi-ai，而
  // agent-default-model 指向的 provider 可能不在其中，所以必须让管理员手选。
  const aiProviders = diagnosticProviders || (() => {
    try {
      const doc = yamlModule ? yamlModule.parse(ops.readPatchConfig(dataDir, activeProfile).patch) : null;
      const rows = Array.isArray(doc) ? doc : [];
      const llm = rows.find((row) => row && row.id === 'llm-pi-ai') || {};
      const providers = (llm.config && llm.config.providers) || {};
      const fallback = (rows.find((row) => row && row.id === 'agent-default-model') || {}).config || {};
      return Object.entries(providers).map(([id, spec]) => ({
        id,
        baseURL: String((spec && spec.baseURL) || ''),
        model: String((spec && spec.models && spec.models[0] && spec.models[0].id) || ''),
        models: (spec.models || []).map(m => ({ id: m.id, api: spec.api || '', baseURL: spec.baseURL || '', supported: spec.api === 'openai-completions' })),
        preferred: fallback.provider === id,
      }));
    } catch { return []; }
  })();
  const terminalHistory = ops.readJson(ops.dataPath(dataDir, 'terminal-history.json'), []);
  const pluginUrlPaths = pluginPaths.snapshot(dataDir);
  const authorizedDirectories = grants.inspect();
  const statusBase = { starting: '启动中', ready: '运行中', rollback: '已回滚', safe: '安全模式', maintenance: '自动维护模式，请等待' }[state.mode] || '未知';
  // 维护态带上"正在做什么"（0.3.62，用户反馈）：只显示「维护中」等于没说。
  const op = state.operation && typeof state.operation === 'object' ? state.operation : null;
  const status = state.mode === 'maintenance' && op && op.text ? `${statusBase}：${op.text}` : statusBase;
  // 状态徽标语气（0.3.61）：原先只有一种蓝色，运行中与安全模式看起来一样。
  const statusTone = state.mode === 'ready' ? 'ok' : state.mode === 'safe' ? 'bad' : ['starting', 'maintenance', 'rollback'].includes(state.mode) ? 'warn' : '';
  const appVer = ops.appVersion();
  const csrf = escapeHtml(session.csrf);
  const form = (name, fields, label, buttonClass = '') => `<form method="post" action="/__fnos/action"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="view" value="${view}"><input type="hidden" name="action" value="${name}">${fields}<button type="submit"${buttonClass ? ` class="${buttonClass}"` : ''}>${label}</button></form>`;
  const action = (name, label, fields = '') => form(name, fields, label);
  const select = (name, values, selected) => `<select name="${name}">${values.map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>`;
  const coreOptions = installedCores.map((version) => [version, `DSH ${version}${version === state.activeVersion ? '（运行中）' : ''}`]);
  const profileOptions = profileNames.map((name) => [name, `${name}${name === activeProfile ? '（运行中）' : ''}`]);
  const backupRows = backups.map((item) => `<tr><td>${escapeHtml(item.createdAt)}</td><td>${escapeHtml(item.kind)}</td><td>${escapeHtml(item.version)}</td><td>${action('restore', '恢复此备份', `<input type="hidden" name="backupId" value="${escapeHtml(item.id)}">`)}</td></tr>`).join('');
  const pluginCards = installedPlugins.map((item) => {
    const field = `<input type="hidden" name="packageName" value="${escapeHtml(item.name)}">`;
    if (item.enablementError) return `<article class="plugin-card"><div><strong>${escapeHtml(item.name)}</strong><span>启用状态记录损坏，操作已锁定</span></div><p class="error">${escapeHtml(item.enablementError)}。请从备份页恢复配置；安装文件未被删除。</p></article>`;
    const status = item.enabled ? (item.filesOk === false ? '已启用（文件缺失）' : '已启用') : item.compatible ? '已禁用' : '文件缺失或非插件';
    const toggle = item.enabled ? form('disable-plugin', field, '禁用') : item.compatible ? form('enable-plugin', field, '启用') : '';
    return `<article class="plugin-card"><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.version)} · ${status}</span></div><div class="actions">${toggle}${form('uninstall-plugin', field, '卸载并清理', 'danger')}</div></article>`;
  }).join('');
  const pendingPluginPaths = pluginUrlPaths.candidates.map((item) => `<article class="plugin-card"><div><strong><code>${escapeHtml(item.path)}/*</code></strong><span>最近检测：${escapeHtml(item.lastSeen)} · 次数：${item.count}</span></div><div class="actions">${form('allow-plugin-path', `<input type="hidden" name="path" value="${escapeHtml(item.path)}">`, '放行')}${form('dismiss-plugin-path', `<input type="hidden" name="path" value="${escapeHtml(item.path)}">`, '忽略')}</div></article>`).join('');
  const approvedPluginPaths = pluginUrlPaths.approved.map((item) => `<article class="plugin-card"><div><strong><code>${escapeHtml(item)}/*</code></strong><span>已允许自动改写到 DSH 网关</span></div><div class="actions">${form('revoke-plugin-path', `<input type="hidden" name="path" value="${escapeHtml(item)}">`, '撤销放行', 'danger')}</div></article>`).join('');
  const registryPresets = [
    ['npm 官方源', 'https://registry.npmjs.org/'],
    ['npmmirror 镜像', 'https://registry.npmmirror.com/'],
    ['腾讯云镜像', 'https://mirrors.cloud.tencent.com/npm/'],
    ['华为云镜像', 'https://repo.huaweicloud.com/repository/npm/']
  ].map(([label, value]) => action('set-registry', label, `<input type="hidden" name="registry" value="${value}">`)).join('');
  const grantRows = authorizedDirectories.map((item) => `<tr><td><code>${escapeHtml(item.path)}</code></td><td>${!item.directory ? '目录不存在或无法进入' : !item.readable ? '无读取权限' : item.writable ? '可读写' : '只读'}</td></tr>`).join('');
  const debugMode = networkDebug?.mode || 'read-only';
  const debugForm = form('start-network-debug', `<label>访问模式 ${select('mode', [['read-only', '只读模式'], ['command', '指令模式']], debugMode)}</label><label>有效期（分钟） <input type="number" name="minutes" min="1" max="60" value="${networkDebug?.minutes || 15}" required></label>`, networkDebug ? '切换模式并重新计时' : '开启临时调试');
  // 给 AI 调试者的提示词随连接信息一起复制出去。两种模式的可用能力不同，
  // 提示词分别描述，避免只读模式的 AI 去尝试并不存在的指令接口。
  const debugExpires = networkDebug ? escapeHtml(new Date(networkDebug.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })) : '';
  const debugPromptCommon = networkDebug ? `连接方式：\n- 接口基址：https://${networkDebug.address}:${networkDebug.port}（自签名证书：curl 请加 -k 或忽略证书校验）\n- 鉴权：每个请求带请求头 Authorization: Bearer ${networkDebug.token}\n- 本次调试有效期至北京时间 ${debugExpires}，过期自动失效\n\n协作约定：\n- 把接口返回原文完整贴出，不要凭记忆转述。\n- 连接地址与 Token 是敏感凭据，不要转存或写进日志、代码；调试完成后提醒管理员在「应用设置 → 远程调试」里关闭临时调试。` : '';
  const debugPrompt = debugMode === 'command'
    ? `你是受邀参与 DeepSeek Harness（DSH，飞牛 fnOS 应用）远程调试的 AI 助手。管理员把连接信息发给你，请按说明协助排查。\n\n${debugPromptCommon}\n\n可用接口（指令模式）：\n1) GET /snapshot —— 只读快照：应用状态与网关/应用/DSH 三方最近日志（已脱敏）。请先取快照再判断。\n2) POST /command —— 执行管理指令。请求头 Content-Type: application/json，请求体为 JSON：{"action":"..."}。白名单指令：\n- check-update：检查核心更新\n- retry：重启 DSH 核心（服务会短暂中断）\n- backup：创建一份备份\n- safe-mode：进入安全模式\n- enable-plugin / disable-plugin：需附带 "packageName":"<已安装插件包名>"\n- probe-plugin-route：需附带 "path":"< /dsh-插件名/ping 或 /dsh-插件名/summary >"，探测插件路由是否可达\n成功返回 {"ok":true,"result":…}；同一时刻仅允许一条指令（并发得 409）。\n\n约定：retry、safe-mode、disable-plugin 这类有破坏性的动作，执行前先说明影响并征得管理员同意。`
    : `你是受邀参与 DeepSeek Harness（DSH，飞牛 fnOS 应用）远程调试的 AI 助手。管理员把连接信息发给你，请按说明协助排查。\n\n${debugPromptCommon}\n\n可用接口（只读模式）：\n- GET /snapshot —— 唯一接口：返回应用状态与网关/应用/DSH 三方最近日志（已脱敏）。\n- 本模式没有任何管理指令：POST /command 会返回 403 read-only mode，请勿尝试任何写操作。\n\n约定：你的任务是读取快照、分析日志、定位问题并给出结论与建议；需要的变更操作请整理成具体步骤，由管理员在本机执行。`;
  const debugPanel = networkDebug
    ? `<p>当前为<strong>${debugMode === 'command' ? '指令模式' : '只读模式'}</strong>，至北京时间 <strong>${escapeHtml(new Date(networkDebug.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</strong> 自动关闭。</p><div id="debug-info" class="debug-info"><div>只读快照：<code>https://${escapeHtml(networkDebug.address)}:${networkDebug.port}/snapshot</code></div>${debugMode === 'command' ? `<div>指令接口：<code>https://${escapeHtml(networkDebug.address)}:${networkDebug.port}/command</code></div>` : ''}<div>临时 Token：<code>${escapeHtml(networkDebug.token)}</code></div></div><div id="debug-prompt" hidden>${escapeHtml(debugPrompt)}</div><div class="actions"><button id="copy-debug" type="button">复制连接信息</button><label><input type="checkbox" id="copy-debug-prompt" checked> 附带给 AI 的调试说明</label>${action('stop-network-debug', '立即关闭')}</div><div class="divider"></div><h3>切换模式或有效期</h3>${debugForm}<p class="hint">切换会立即关闭旧端口、废弃旧 Token，并生成新的连接信息；已发起的 FPK 操作可能继续完成。</p>`
    : `<p>在 NAS IPv4 地址上临时开启随机 HTTPS 端口。默认只读 15 分钟，可设置 1–60 分钟；到期、手动关闭或应用重启后失效。</p>${debugForm}`;
  const debugHelp = `<p class="hint">只读模式仅提供状态和遮盖后的日志。指令模式额外允许固定插件路由探测、检查更新、重启 DSH、备份、安全模式、已安装插件启停；不允许任意 Shell、安装、卸载或恢复。持有 Token 的人可执行上述操作，请只向可信调试者提供。指令入口仅接受带 Bearer Token 的 JSON POST。</p>`;
  const dockerUser = dockerStatus && /^[a-z_][a-z0-9_-]*$/.test(dockerStatus.username) ? dockerStatus.username : 'dsh_fnos';
  const dockerRows = dockerStatus ? [
    ['应用用户', `${dockerStatus.username}（UID ${dockerStatus.uid}）`],
    ['可写用户主目录', dockerStatus.homeReady ? '已就绪' : '未就绪'],
    ['newuidmap / newgidmap', dockerStatus.uidmap ? '已安装' : '缺失'],
    ['Rootless 安装工具', dockerStatus.setupTool ? '已安装' : '缺失'],
    ['subuid / subgid', `${dockerStatus.subuid ? '已配置' : '未配置'} / ${dockerStatus.subgid ? '已配置' : '未配置'}`],
    ['Rootless 守护进程', dockerStatus.connection.ready ? '已验证' : dockerStatus.connection.reason],
    ['系统 docker 组', dockerStatus.dockerGroup ? '应用用户仍在组内，具有主机 root 级访问风险' : '应用进程不在组内']
  ].map(([name, value]) => `<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(value)}</td></tr>`).join('') : '';
  const dockerPanel = `<h2>容器权限</h2><p>当前连接：<strong>${dockerStatus?.mode === 'rootless' ? 'Rootless Docker' : '系统默认'}</strong>。Rootless 守护进程应以应用用户运行，Socket 固定在 <code>${escapeHtml(dockerStatus?.socket || '/run/user/UID/docker.sock')}</code>。</p><div class="table-scroll"><table><tbody>${dockerRows || '<tr><td>无法读取 Docker 检查状态</td></tr>'}</tbody></table></div>${dockerStatus?.dockerGroup ? '<p class="error">应用用户仍属于系统 docker 组。即使切到 Rootless，DSH 仍可显式访问系统 Docker Socket；确认 Rootless 可用后，应从该组移除应用用户并重启 FPK。</p>' : ''}<div class="divider"></div><h3>连接 DSH</h3><p>启用时会验证本用户 Socket 与 Docker 的 Rootless 标志，然后重启 DSH。关闭连接仅清除专用 Socket 设置，不会修改 NAS 的用户组。</p><div class="actions">${dockerStatus?.connection.ready && dockerStatus.mode !== 'rootless' ? action('set-docker-mode', '使用 Rootless Docker', '<input type="hidden" name="dockerMode" value="rootless">') : ''}${dockerStatus?.mode === 'rootless' ? action('set-docker-mode', '恢复系统默认连接', '<input type="hidden" name="dockerMode" value="system">') : ''}<a class="primary-link" href="/__fnos/?view=containers">刷新检查</a></div><div class="divider"></div><h3>NAS 管理员准备步骤</h3><ol><li>检查应用用户 <code>${escapeHtml(dockerUser)}</code> 的主目录是否存在且可写；安装 <code>newuidmap</code>、<code>newgidmap</code> 与 Docker Rootless 安装工具，并为该用户配置互不重叠的 subuid/subgid 范围，每项至少 65536 个。</li><li>以该应用用户运行 <code>dockerd-rootless-setuptool.sh install</code>。若 fnOS 支持用户级 systemd，再启用用户的 Docker 服务和 linger。</li><li>刷新本页，确认“Rootless 守护进程”显示“已验证”，然后点击“使用 Rootless Docker”。</li><li>确认 DSH 能使用 Rootless Docker 后，由 NAS 管理员执行 <code>sudo gpasswd -d ${escapeHtml(dockerUser)} docker</code>，再从应用中心完整停止并启动 FPK，刷新本页确认不再属于系统 docker 组。</li></ol><p class="hint">FPK 不会安装 Docker、修改 NAS 系统用户或自动开放 Docker Socket。Rootless Docker 仍可操作应用用户有权访问的文件，请继续限制工作区和插件权限。</p>`;

  const panels = {
    overview: `<h2>运行状态</h2><div class="summary"><div><span>应用状态</span><strong>${status}</strong></div><div><span>DSH 核心</span><strong>${escapeHtml(state.activeVersion || state.bundledVersion || '未知')}</strong></div><div><span>配置档</span><strong>${escapeHtml(activeProfile)}</strong></div><div><span>应用版本</span><strong>${escapeHtml(appVer || '未知')}</strong></div></div>${state.error ? `${safeModeRemediation(state, form, action)}${startupDiagnosisCard(startupDiag, form, action, state)}${state.reportPath && state.mode === 'safe' ? `<p class="hint">完整诊断报告：<code>${escapeHtml(state.reportPath)}</code>（含错误全文与启动日志尾部）</p>` : ''}` : ''}${/*
      诊断模式卡片独立渲染（0.3.62 修复）：它原先挂在 `state.error` 分支里，
      而**诊断模式下核心是正常运行的**（正是它要达成的效果）—— error 为 null，
      于是整张卡片（含模型 provider 下拉）根本不出现。用户进诊断模式后只看到
      「已启用」的残影或什么都没有，无法选模型，功能不完整。
      该卡片自身用 diag.active 判断，不需要 error 作为前置条件。
    */''}${diagnosisCard(state, form, action, diagnosisState, csrf, aiProviders)}${['ready', 'rollback'].includes(state.mode) && openDshPath ? `<p><a class="primary-link" data-dsh-open href="${escapeHtml(openDshPath)}">打开 DSH Web UI</a></p>` : ''}<p class="hint">通过上方菜单管理核心、扩展、备份与诊断。</p>`,
    versions: `<h2>DSH 版本</h2><p>应用版本（FPK）：<strong>${escapeHtml(appVer || '未知')}</strong><br>随包版本：${escapeHtml(state.bundledVersion || '未知')} · 当前版本：${escapeHtml(state.activeVersion || '未知')}</p><p>npm latest（默认渠道）：<strong>${escapeHtml(update.latest || '未检查')}</strong><br>npm next（预览渠道）：<strong>${escapeHtml(update.next || '未检查')}</strong><br>上次检查：${escapeHtml(update.checkedAt || '尚未检查')}</p>${action('check-update', '立即检查更新')}<div class="divider"></div><h3>安装新版本</h3>${form('install-core', `<label>版本号 <input name="version" required pattern="[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?" value="${escapeHtml(update.latest || '')}"></label>`, '安装并切换核心')}<h3>切换已有版本</h3>${coreOptions.length ? form('switch-core', `<label>已安装版本 ${select('version', coreOptions, state.activeVersion)}</label>`, '切换版本') : '<p class="hint">暂无独立安装的版本。</p>'}${action('use-bundled', '切换到随包核心')}`,
    registry: `<h2>npm 源</h2><p>当前源：<code>${escapeHtml(registry)}</code></p><div class="actions">${registryPresets}</div>${form('set-registry', `<label>自定义 HTTPS 源 <input name="registry" type="url" required value="${escapeHtml(registry)}"></label>`, '保存源')}<p class="hint">仅填写可信的 HTTPS 镜像地址。插件使用新源需要重新启动 DSH 核心。</p>`,    config: `<h2>配置文件</h2><p>当前配置档：<strong>${escapeHtml(activeProfile)}</strong>。DSH 的自定义配置写在 <code>cordis.patch.yml</code>（每个配置档一份），保存后 DSH 会自动热加载（patchReload: live），无需重启；若 core 因此异常，请到「运行控制」重试进入安全模式，<strong>按影响从小到大的分级引导</strong>修复（含备份恢复与禁用自定义条目）。</p><h3>cordis.patch.yml（可编辑）</h3>${form('save-patch-config', `<textarea name="content" class="patch-editor" spellcheck="false" wrap="off">${escapeHtml(patchView.patch)}</textarea>`, '保存并应用')}<h3>备份（自动保留最近 10 份）</h3>${patchBackupOptions.length ? form('restore-patch-config', `<label>选择备份 ${select('backupName', patchBackupOptions, patchBackupOptions[0] && patchBackupOptions[0][0])}</label>${legacyPatchBackups.length ? `<label class="hint"><input type="checkbox" name="confirmLegacyProfile" value="true"> 我确认把「来源未知的历史备份」恢复到当前配置档 ${escapeHtml(activeProfile)}（${legacyPatchBackups.length} 份历史备份需要此确认）</label>` : ''}`, '恢复此备份') : '<p class="hint">暂无备份（保存或禁用时会自动创建）。</p>'}<div class="divider"></div><h3>cordis.yml（根配置，只读）</h3><pre class="patch-readonly">${escapeHtml(patchView.rootConfig) || '（空）'}</pre><p class="hint">这是 profile 根配置，DSH 官方要求不要直接修改它；所有自定义都应写在上方 cordis.patch.yml。</p>`,

    plugins: `<h2>插件管理</h2>${pluginWiringCard(wiring, action)}<p>当前配置档：<strong>${escapeHtml(activeProfile)}</strong>。禁用会保留安装文件；卸载会从配置、依赖清单和安装目录清理插件。操作完成后会验证 DSH 能否启动。</p>${state.mode === 'safe' ? '<p class="error">当前处于安全模式。可先禁用冲突插件，成功后 DSH 会自动恢复运行。</p>' : ''}<h3>安装新插件</h3>${form('install-plugin', '<label>插件来源 <input name="packageName" required placeholder="name@1.2.3、user/repo 或 github:user/repo#tag"></label>', '检查并安装插件')}<p class="hint">安装前会检查 DSH 插件声明、依赖兼容性并（对 npm 来源）查询高危漏洞公告；支持 npm 来源（name@1.2.3）与 GitHub 来源（user/repo 或 github:user/repo#tag，经 pnpm 安装）。安装失败会恢复原配置。GitHub 来源不经过 npm 安全审计；插件运行时代码拥有 DSH 权限，请只安装可信发布者的插件。</p><h3>从本地文件导入</h3><form id="plugin-import-form"><p><input type="file" id="plugin-import-file" accept=".tgz,.tar.gz" required></p><p><button type="submit" id="plugin-import-btn">上传并安装</button><span id="plugin-import-status" class="hint"></span></p></form><p class="hint">支持 npm pack 产物（.tgz，≤64MB）。上传后走与在线安装相同的校验与回滚链；插件运行时代码拥有 DSH 权限，请只导入可信来源的包。</p>${pluginsNeedRepair ? `<div class="card remediation"><h3>检测到插件文件缺失</h3><p>部分插件的 node_modules 文件不完整（通常是 pnpm 操作半途失败所致，表现为插件路由 404、功能消失）。可按 pnpm-lock.yaml 一键重建插件目录，完成后自动重启 DSH。</p><div class="actions">${action('repair-plugin-files', '一键修复插件文件并重启')}</div></div>` : ''}<h3>已安装插件</h3><p><input type="search" id="plugin-search" placeholder="搜索插件名…" autocomplete="off" style="width:100%;max-width:360px"></p><div class="plugin-list">${pluginCards || '<p class="hint">当前配置档没有额外安装的插件。</p>'}</div><div class="divider"></div>`,
    pluginPaths: `<h2>插件 URL 放行</h2><p>手机和 fnOS 远程入口使用子路径。应用会自动发现插件请求的根路径 API，但不会自动放行。确认路径属于可信插件后点击“放行”，再返回并强制刷新 DSH。</p><p class="hint">这里只控制浏览器 URL 自动改写，不限制插件在 DSH 内部的权限，也不代替插件与 DSH 核心版本的兼容检查。每条规则覆盖对应路径及其子路径，不含其他前缀。</p><h3>待放行</h3><div class="plugin-list">${pendingPluginPaths || '<p class="hint">尚未检测到第三方根路径请求。先打开插件页面，再刷新这里。</p>'}</div><div class="divider"></div><h3>已放行</h3><div class="plugin-list">${approvedPluginPaths || '<p class="hint">尚未放行第三方路径。</p>'}</div>`,
    profiles: `<h2>DSH 配置档</h2><p>当前配置档：<strong>${escapeHtml(activeProfile)}</strong>。新配置档从 DSH 官方 Web 模板创建，切换前自动备份。</p>${form('switch-profile', `<label>已有配置档 ${select('profile', profileOptions, activeProfile)}</label>`, '切换配置档')}${form('create-profile', '<label>新配置档名称 <input name="profile" required pattern="[a-z][a-z0-9_-]{0,31}" maxlength="32" placeholder="例如 work"></label>', '新建并切换')}`,
    grants: `<h2>目录权限</h2><p>在 fnOS 应用中心找到 DeepSeek Harness，打开访问权限并授予需要使用的 NAS 文件夹。授权后重新启动应用，再刷新此页。</p><p>已授权且可读取的目录会在 DSH 工作区的 <code>${escapeHtml(grants.shortcutFolder)}</code> 中显示为快捷入口。文件操作仍受 fnOS 对应用账号授予的权限限制。</p><div class="table-scroll"><table><thead><tr><th>fnOS 授权目录</th><th>当前访问</th></tr></thead><tbody>${grantRows || '<tr><td colspan="2">当前未收到 fnOS 授权目录。请在 fnOS 应用中心授予访问权限。</td></tr>'}</tbody></table></div><div class="divider"></div><h3>检测工作区写入权限</h3><p>输入在 DSH 中选择的完整目录，例如 <code>/vol1/共享文件夹/项目目录</code>。检测会在该目录短暂创建并删除一个空文件夹，与 DSH 的工作区检查一致。</p>${form('probe-workspace', '<label>工作区绝对路径 <input name="workspacePath" required placeholder="/vol1/共享文件夹/项目目录"></label>', '检测实际写入权限')}<p class="hint">上表只显示授权根目录的基础权限；子目录可能有不同 ACL。若刚授权仍未显示，请在 fnOS 应用中心停止并重新启动本应用。</p>`,
    containers: dockerPanel,
    backups: `<h2>备份与恢复</h2>${sessionArchiveCard(sessionArchive, action, backupSettings)}<p>备份包含 DSH 设置、会话和私有工作区；恢复会覆盖当前数据。</p><p>自动备份条件：${{ always: '每天 03:00', changed: '每天 03:00，仅内容有改动', updates: '仅在更新或切换前' }[backupSettings.dailyMode]}。更新前的回滚备份始终执行。</p>${action('backup', '立即备份')}<div class="divider"></div><h3>备份策略</h3>${form('set-backup-settings', `<label>每日保留 <input type="number" name="dailyLimit" min="1" max="30" value="${backupSettings.daily}" required></label><label>手动保留 <input type="number" name="manualLimit" min="1" max="30" value="${backupSettings.manual}" required></label><label>更新前保留 <input type="number" name="upgradeLimit" min="1" max="10" value="${backupSettings['pre-upgrade']}" required></label><label>自动备份 ${select('dailyMode', [['always', '每天'], ['changed', '仅内容有改动'], ['updates', '仅更新或切换前']], backupSettings.dailyMode)}</label><label>会话存档 ${select('sessionMode', [['auto', '自动（推荐）'], ['timer', '定时检查'], ['manual', '仅手动']], backupSettings.sessionMode)}</label><label>检查周期（分钟）<input type="number" name="sessionInterval" min="5" max="10080" value="${backupSettings.sessionInterval}" required></label>`, '保存备份策略')}<p class="hint">会话存档策略只影响「是否/何时为会话新建快照」：自动模式在核心启动后检测到未存档的会话即快照；定时模式按检查周期执行（5 分钟 ~ 7 天，默认 60 分钟）；手动模式只在上面按钮点击时检查。</p>}<h3>已有备份</h3><div class="table-scroll"><table><thead><tr><th>时间</th><th>类型</th><th>DSH 版本</th><th>操作</th></tr></thead><tbody>${backupRows || '<tr><td colspan="4">暂无备份</td></tr>'}</tbody></table></div>`,
    runtime: `${state.mode === 'safe' ? remediationGuide({
      action,
      error: state.error,
      canRestore: patchBackups.length > 0,
      hasBackups: true,
      canDedupe: true,   // dedupe 幂等：无重复时服务端会明确回报「未发现重复」
      canDisablePatch: true,
      canDisableThirdParty: true,
      canRepairFiles: true,
      dryRunAvailable: true
    }) : ''}${diagnosisCard(state, form, action, diagnosisState, csrf, aiProviders)}<h2>运行控制</h2><p>启动异常时可重新启动 DSH 核心，或进入安全模式检查配置。</p><div class="actions">${action('retry', '重新启动 DSH')}${action('safe-mode', '进入安全模式')}</div><div class="divider"></div><h3 id="port-settings">端口设置</h3><p>公网入口端口是浏览器与手机飞牛 App 访问应用的 HTTPS 端口（fnOS 应用中心未提供修改入口，可在此调整）。内部核心端口仅在本机回环地址上使用。</p><p>当前公网入口端口：<strong>${ports?.publicPort ?? Number(process.env.FNOS_PORT || 3080)}</strong>${ports?.customized ? `（应用中心默认 ${ports.manifestPort}，原端口仍保持兼容监听）` : `（默认，由应用中心分配）`} · 内部核心端口：<strong>${ops.portSettings(dataDir).corePort}</strong></p>${form('set-public-port', `<label>公网入口端口 <input type="number" name="publicPort" min="1024" max="65535" value="${ports?.publicPort ?? Number(process.env.FNOS_PORT || 3080)}" required></label>`, '保存并切换端口')}<p class="hint">保存后网关立即以新端口对外服务，原端口尽量保持兼容监听；填回默认端口 ${ports?.manifestPort ?? Number(process.env.FNOS_PORT || 3080)} 可恢复默认。</p><div class="divider"></div><h3>内部核心端口</h3><p>仅当启动失败提示 <code>EADDRINUSE</code>（端口被 NAS 上其他进程占用）时才需要修改。保存后 DSH 会以新端口重启；启动失败会自动恢复原端口。</p>${form('set-core-port', `<label>内部核心端口 <input type="number" name="corePort" min="1024" max="65535" value="${ops.portSettings(dataDir).corePort}" required></label>`, '保存并重启 DSH')}<p class="hint">修改公网端口后：浏览器需改用新地址访问；NAS 防火墙需放行新端口；证书不变，无需重新接受。残留的 dsh 进程会在下次启动时自动清理；若内部端口提示被其他进程占用，请先停止占用该端口的应用。</p>`,
    logs: `<h2>诊断日志</h2><p>查看应用网关、应用运行与 DSH 核心的最近日志。页面支持复制和下载。</p><p><a class="primary-link" href="/__fnos/logs?source=gateway">打开诊断日志</a></p><p class="hint">DSH 核心日志会遮盖常见令牌；分享前请再次检查内容。</p>`,
    network: `<h2>网络调试</h2>${debugPanel}${debugHelp}`,
    terminal: `<h2>命令行</h2><p>在当前配置档目录直接执行 <code>dsh</code>、<code>npm</code>、<code>pnpm</code> 命令（例如 <code>dsh plugin --profile web list</code>、<code>pnpm ls --depth 0</code>）。仅管理员可用；不经过 shell，60 秒超时，输出保留最近 20 条。</p>${form('run-terminal-command', '<label>命令 <input name="command" required autocomplete="off" spellcheck="false" placeholder="dsh plugin --profile web list" style="width:100%;min-width:0"></label>', '执行')}${terminalHistory.length ? `<h3>最近执行</h3><div class="table-scroll"><table><thead><tr><th>时间</th><th>命令</th><th>退出码</th></tr></thead><tbody>${terminalHistory.map((item) => `<tr><td>${escapeHtml(item.time)}</td><td><code>${escapeHtml(item.command)}</code></td><td>${item.code}</td></tr>`).join('')}</tbody></table></div><h3>最近一次输出</h3><pre class="patch-readonly">${escapeHtml(terminalHistory[0]?.output || '（无输出）')}</pre>` : '<p class="hint">还没有执行记录。</p>'}`
  };

  const primaryNav = groups.map((item) => `<a href="/__fnos/?view=${item.items[0][0]}"${item.id === group.id ? ' aria-current="page"' : ''}>${item.label}</a>`).join('');
  const secondaryNav = group.items.map(([id, label]) => `<a href="/__fnos/?view=${id}"${id === view ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  // 标题栏重启：点击先弹窗二选一（0.3.62）。
  // 起因：原来只有一个按钮直接走 `retry`——它**只重启 core**。改了 supervisor /
  // gateway / management-page 之后点它，改动不会生效（supervisor 仍是旧进程），
  // 反复造成「重启了却没变化」的困惑；而且管理页自己就是 gateway 提供的，只重启
  // core 也修不了管理页自身的故障。这里把两种语义摆明，让用户按需要选。
  const restartDialog = `<div class="restart-dialog" id="restart-dialog" hidden>
    <div class="restart-dialog-backdrop" data-restart-cancel></div>
    <div class="restart-dialog-card" role="dialog" aria-modal="true" aria-labelledby="restart-dialog-title">
      <h3 id="restart-dialog-title">重启 DSH</h3>
      <p class="restart-dialog-hint">两种重启的影响范围不同，按当前需要选择。</p>
      <div class="restart-options">
        <form method="post" action="/__fnos/action" data-restart-option="core">
          <input type="hidden" name="csrf" value="${csrf}">
          <input type="hidden" name="view" value="${view}">
          <input type="hidden" name="action" value="retry">
          <button class="restart-option" type="submit">
            <strong>仅重启 DSH 核心</strong>
            <span>约 10–60 秒。会话与配置不动，管理页保持可用。<em>改了插件/配置后选这个。</em></span>
          </button>
        </form>
        <form method="post" action="/__fnos/action" data-restart-option="all">
          <input type="hidden" name="csrf" value="${csrf}">
          <input type="hidden" name="view" value="${view}">
          <input type="hidden" name="action" value="restart-all">
          <button class="restart-option" type="submit">
            <strong>完全重启整个程序</strong>
            <span>约 20–90 秒。核心、网关、管理页一起重启，页面会短暂断连。<em>改了应用自身或管理页异常时选这个。</em></span>
            <span class="restart-caveat">重启期间 3080 会有十几秒无响应，<strong>fnOS 应用中心可能把状态显示成「已停用」——这是正常的</strong>。程序会自己重新监听，无需操作；若稍后仍显示已停用，点「启用」即可。</span>
          </button>
        </form>
      </div>
      <div class="restart-dialog-foot">
        <button type="button" class="restart-cancel" data-restart-cancel>取消</button>
      </div>
    </div>
  </div>`;
  const headerRestart = `<button class="restart-icon" type="button" id="restart-open" title="重启 DSH" aria-label="重启 DSH" aria-haspopup="dialog"><svg class="restart-glyph" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg></button>`;
  const duplicateNotice = state.error && notice && notice.includes(String(state.error));
  const noticeBar = notice && !duplicateNotice ? `<div class="notice ${notice.startsWith('操作失败') ? 'notice-error' : ''}" role="status">${escapeHtml(notice)}</div>` : '';
  // 状态横幅（0.3.62）：启动异常/维护中时，**任何视图**都该看得到原因。
  // 起因：state.error 只在 overview 面板渲染，其余 5 个视图只有徽标上的
  // 「维护中」三个字 —— 用户停在别处就完全不知道发生了什么（10-02 实测踩到：
  // 停用再启动后停在维护中，界面无任何原因，只能干等）。
  // 非就绪状态横幅（0.3.62 强化）：维护态原先只说「维护中」，管理员不知道
  // 程序在做什么、要等多久，只能反复刷新。现在写明：在做什么 + 已用时 + 预计。
  const opStarted = op && op.startedAt ? Date.parse(op.startedAt) : NaN;
  const opElapsed = Number.isFinite(opStarted) ? Math.max(0, Math.round((Date.now() - opStarted) / 1000)) : null;
  const opLine = op && op.text
    ? `<span class="op-line">当前操作：<strong>${escapeHtml(op.text)}</strong>`
      + (opElapsed !== null ? `<span class="op-elapsed"> · 已用 ${opElapsed} 秒</span>` : '')
      + (state.mode !== 'maintenance' && op.etaSeconds ? ` · 预计约 ${op.etaSeconds} 秒` : '')
      + `</span>`
    : '';
  const statusBanner = (state.error || state.mode === 'maintenance')
    ? `<div id="status-banner" class="notice ${state.mode === 'maintenance' && !state.error ? 'notice-busy' : 'notice-error'}" role="alert">`
      + `<strong>${escapeHtml(statusBase)}</strong>`
      + (state.error ? `<span> · ${escapeHtml(require('./recovery-guide').classifyFailure(state.error).title)}</span><details class="failure-detail"><summary>查看完整错误</summary><pre>${escapeHtml(String(state.error))}</pre></details>` : '')
      + opLine
      + (state.mode === 'maintenance' ? `<span class="op-hint">维护耗时受数据量和磁盘速度影响，暂无法准确预计完成时间。DSH 服务可能暂时不可用；完成后会自动尝试恢复，请等待，无需重复操作。</span>` : '')
      + `</div>`
    : '';
  // A failed change that left the core unable to start is not rolled back on
  // its own any more: the snapshot is offered here instead, because applying
  // it discards everything written since it was taken.
  const pending = state.pendingRestore;
  const pendingBar = pending ? `<div class="pending" role="alert"><div><strong>检测到失败，需要你决定是否回滚数据</strong><p>${escapeHtml(pending.reason)}</p><p class="hint">恢复会把 DSH 设置、会话和私有工作区替换为 ${escapeHtml(pending.createdAt)} 的快照；此后的改动将丢失。放弃则保留当前数据，快照仍留在“备份与恢复”里。</p></div><div class="actions">${form('confirm-restore', '', '恢复到操作前', 'danger')}${form('dismiss-restore', '', '保留当前数据')}</div></div>` : '';
  // 危险操作清单交给前端：确认文案与服务端定义同源，避免两处各写一份。
  // 内嵌进 <script type="application/json"> 的 JSON 必须做 HTML 安全转义：
  // 文案里若出现 `</script>` / `<!--` / `<script` 会**提前结束脚本块**，后续
  // 内容被当成 HTML 解析（数据丢失甚至注入）。转义 `<` 即可覆盖全部这些序列
  // ——块内的结束标记 `</script` 必须以 `<` 开头，单独的 `>` 无害（OWASP 同款做法）。
  // 顺带把 U+2028/U+2029 也转义：它们在 JSON 里合法，但作为 JS 字面量会断行，
  // 是同一类"嵌进别的语言"陷阱，一并处理以绝后患。
  const destructiveJson = JSON.stringify(actions.DESTRUCTIVE)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const busyScript = nonce ? `<script nonce="${nonce}">
  (() => {
    const button = document.getElementById('recovery-check');
    const output = document.getElementById('recovery-check-result');
    if (!button || !output) return;
    button.onclick = async () => {
      button.disabled = true; output.hidden = false; output.textContent = '只读检查中…';
      const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 12000);
      try {
        const res = await fetch('/__fnos/preflight', { cache: 'no-store', credentials: 'same-origin', signal: abort.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const info = await res.json();
        output.textContent = info.checks.map(c => (c.status === 'ok' ? '✓ ' : '⚠ ') + c.text).join('\\n') + '\\n\\n' + info.note;
      } catch { output.textContent = '检查未完成，请确认登录与网关连接；未执行任何修复。'; }
      finally { clearTimeout(timer); button.disabled = false; }
    };
  })();
  // 状态徽标读写的唯一入口（0.3.61）：重启期间即时反映「重启中」，就绪后回到「运行中」。
  const APP_STATE_TONE = { '运行中': 'ok', '重启中': 'warn', '安全模式': 'bad', '维护中': 'warn', '自动维护模式，请等待': 'warn', '启动中': 'warn', '已回滚': 'warn' };
  // 统一的刷新闸门（0.3.66）：临时轮询（重启后 1 秒）与常驻轮询（每 3 秒）
  // 都可能判定"状态变化了，刷新页面" —— 两者各刷一次会让用户看到两次闪跳，
  // 且都可能在 fetch 在途时打断它。这里只允许第一个申请者生效。
  let reloadGate = false, reloadTimer = null, operationGeneration = 0;
  let pageActive = true, stateFlight = null, postController = null, authProblem = false;
  let observedBootId = ${JSON.stringify(state.bootId || null)};
  const restartRequest = () => {
    if (!/^[a-f0-9]{32}$/.test(observedBootId || '') || !window.crypto?.getRandomValues) return null;
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    return { id: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''), fromBootId: observedBootId };
  };
  const currentOperation = (generation) => pageActive && generation === operationGeneration;
  const cancelReload = () => { clearTimeout(reloadTimer); reloadTimer = null; reloadGate = false; };
  const beginOperation = () => { cancelReload(); operationGeneration++; stateFlight?.controller.abort(); return operationGeneration; };
  const scheduleReload = (delay, generation = operationGeneration) => {
    if (reloadGate || !currentOperation(generation)) return false;
    reloadGate = true;
    reloadTimer = setTimeout(() => {
      reloadTimer = null; reloadGate = false;
      if (!currentOperation(generation) || document.hidden || document.body.dataset.busy === '1' || document.querySelector('#ai-log > div')) return;
      location.reload();
    }, delay);
    return true;
  };
  // 所有状态读取共享一次在途请求，deadline 包括响应体读取。
  const requestState = (deadline = Date.now() + 12000) => {
    if (!pageActive || document.hidden) return Promise.reject(new Error('页面已暂停'));
    if (authProblem) { const error = new Error('凭据过期，请刷新页面'); error.authExpired = true; return Promise.reject(error); }
    if (stateFlight) return stateFlight.promise;
    const controller = new AbortController();
    const generation = operationGeneration;
    const flight = { controller, promise: null };
    const timer = setTimeout(() => controller.abort(), Math.max(0, Math.min(12000, deadline - Date.now())));
    flight.promise = (async () => {
      const res = await fetch('/__fnos/state?t=' + Date.now(), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!currentOperation(generation) || document.hidden) throw new Error('状态请求已失效');
      if (res.status === 401 || res.status === 403) {
        authProblem = true;
        const error = new Error('凭据过期，请刷新页面'); error.authExpired = true; throw error;
      }
      if (!res.ok && res.status !== 503) throw new Error('HTTP ' + res.status);
      const info = await res.json();
      if (!currentOperation(generation)) throw new Error('状态请求已失效');
      if (/^[a-f0-9]{32}$/.test(info?.bootId || '')) observedBootId = info.bootId;
      return { status: res.status, info };
    })().finally(() => { clearTimeout(timer); if (stateFlight === flight) stateFlight = null; });
    stateFlight = flight;
    return flight.promise;
  };
  const setAppState = (text, tone) => {
    const el = document.getElementById('app-state');
    if (!el) return;
    el.textContent = text;
    el.className = 'state' + (tone === undefined ? (APP_STATE_TONE[text] ? ' ' + APP_STATE_TONE[text] : '') : (tone ? ' ' + tone : ''));
  };
  // 轮询核心是否就绪（重启完成后页面自动恢复，不需要手动刷新）。
  const waitForCoreReady = async (timeoutMs = 180000, generation = operationGeneration, requireDisruption = false, restart = null) => {
    const deadline = Date.now() + timeoutMs;
    let sawDisruption = false;
    while (Date.now() < deadline && currentOperation(generation)) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(1500, Math.max(0, deadline - Date.now()))));
      if (!currentOperation(generation) || Date.now() >= deadline) break;
      if (document.hidden) continue;
      try {
        const { status, info } = await requestState(deadline);
        if (!currentOperation(generation) || Date.now() >= deadline) break;
        if (document.hidden) continue;
        if (restart) {
          const receipt = info?.restartReceipt;
          const matches = receipt?.id === restart.id && receipt.fromBootId === restart.fromBootId;
          if (matches && receipt.status === 'failed') {
            const error = new Error('完全重启失败，请检查运行控制'); error.restartFailed = true; throw error;
          }
          if (matches && receipt.status === 'completed' && status === 200 && info.mode === 'ready' &&
              receipt.toBootId === info.bootId && info.bootId !== restart.fromBootId) return true;
        } else if (status === 200 && info?.mode === 'ready' && (!requireDisruption || sawDisruption)) return true;
        if (status === 503 || (info?.mode && info.mode !== 'ready')) sawDisruption = true;
        if (status === 503) {
          const label = { starting: '启动中', maintenance: '重启中', safe: '安全模式', rollback: '已回滚' }[info && info.mode] || '重启中';
          setAppState(label, label === '安全模式' || label === '已回滚' ? 'bad' : 'warn');
        }
      } catch (error) {
        if (!currentOperation(generation)) return false;
        if (error.authExpired || error.restartFailed) throw error;
        // 网络错误不构成重启发生的证据。
      }
    }
    return false;
  };
  // ── 标题栏重启弹窗（0.3.62）──────────────────────────────────────────
  // 两个选项语义不同，必须在提交前让用户看清：
  //   · retry        → 只重启 core（管理页 / gateway 不动）
  //   · restart-all  → supervisor 用 execve 原地替换镜像，core + gateway 全重启
  // 完全重启期间网关会断开，fetch 必然失败——这不是"操作失败"，所以要单独
  // 提示"正在重启，稍后刷新"，而不是复用失败分支的红色警告。
  (() => {
    const dialog = document.getElementById('restart-dialog');
    const openBtn = document.getElementById('restart-open');
    if (!dialog || !openBtn) return;
    const close = () => {
      dialog.hidden = true;
      document.body.classList.remove('restart-dialog-open');
      openBtn.focus();
    };
    const open = () => {
      dialog.hidden = false;
      document.body.classList.add('restart-dialog-open');
      const first = dialog.querySelector('button.restart-option');
      if (first) first.focus();
    };
    openBtn.addEventListener('click', open);
    dialog.addEventListener('click', (event) => {
      if (event.target.closest('[data-restart-cancel]')) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !dialog.hidden) close();
    });
  })();
  if (window.parent !== window) window.parent.postMessage({ type: 'dsh-fnos-view', view: 'settings' }, '*');
  document.addEventListener('click', (event) => {
    if (event.target.closest('a[data-dsh-open]') && window.parent !== window) window.parent.postMessage({ type: 'dsh-fnos-view', view: 'dsh' }, '*');
  });
  // —— AI 诊断对话（网关直连模型，不经过 core；核心挂了也能用）——
  (() => {
    const log = document.getElementById('ai-log');
    const input = document.getElementById('ai-input');
    const btn = document.getElementById('ai-send');
    if (!log || !input || !btn) return;
    const history = [];
    const csrf = document.getElementById('ai-csrf')?.value || '';
    const providerSel = document.getElementById('ai-provider');
    const baseInput = document.getElementById('ai-base');
    const modelSel = document.getElementById('ai-model');
    const keyInput = document.getElementById('ai-key');
    const hint = document.getElementById('ai-provider-hint');
    let models = [], selection = 0, controller = null;
    const updateModel = () => {
      const selected = models.find(m => m.id === modelSel.value);
      baseInput.value = selected ? selected.baseURL || '' : '';
      btn.disabled = !(selected && selected.supported && selected.baseURL);
      hint.textContent = btn.disabled ? '未解析到受支持的 Chat 模型与端点。Codex/OAuth 不使用此调用链。' : '端点来自服务器配置或官方目录；不能在浏览器覆盖，以免把密钥发送到其他地址。';
    };
    const applyProviderBase = () => {
      selection++; controller?.abort(); history.length = 0; log.textContent = ''; keyInput.value = '';
      const option = providerSel.selectedOptions[0];
      try { models = JSON.parse(option?.dataset.models || '[]'); } catch { models = []; }
      modelSel.replaceChildren();
      for (const model of models) {
        const item = document.createElement('option'); item.value = model.id; item.textContent = model.id + (model.supported ? '' : '（暂不支持）'); modelSel.appendChild(item);
      }
      if (models.some(m => m.id === option?.dataset.preferred)) modelSel.value = option.dataset.preferred;
      updateModel();
    };
    applyProviderBase();
    providerSel.addEventListener('change', applyProviderBase);
    modelSel.addEventListener('change', () => { selection++; controller?.abort(); history.length = 0; log.textContent = ''; updateModel(); });
    const append = (role, text) => {
      const div = document.createElement('div');
      div.style.margin = '6px 0';
      div.style.whiteSpace = 'pre-wrap';
      div.textContent = (role === 'user' ? '我：' : 'AI：') + text;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
      return div;
    };
    const send = async () => {
      const message = input.value.trim();
      if (!message || btn.disabled) return;
      input.value = '';
      append('user', message);
      const pending = append('assistant', '分析中…');
      btn.disabled = true;
      const token = selection;
      try {
        const provider = providerSel ? providerSel.value : '';
        const baseURL = baseInput ? baseInput.value.trim() : '';
        controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), 125000);
        let res;
        try { res = await fetch('/__fnos/ai-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ csrf, message, history, provider, model: modelSel.value, baseURL, apiKey: keyInput.value }) }); } finally { clearTimeout(deadline); }
        if (token !== selection) return;
        const data = await res.json().catch(() => ({ ok: false, error: 'HTTP ' + res.status }));
        if (token !== selection) return;
        if (data.ok) {
          pending.textContent = 'AI：' + data.reply;
          history.push({ role: 'user', content: message }, { role: 'assistant', content: data.reply });
        } else { pending.textContent = '⚠ ' + (data.error || '调用失败'); }
      } catch (error) { pending.textContent = '⚠ 网络错误：' + error.message; }
      updateModel();
      log.scrollTop = log.scrollHeight;
      input.focus();
    };
    btn.addEventListener('click', send);
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); } });
  })();
  // 常驻状态轮询（0.3.66，用户反馈）：原先只有**点了操作按钮**才临时轮询，
  // 若用户从应用中心冷启动应用后停在管理页，页面会一直显示旧状态（"维护中"），
  // 必须手动切视图才发现已就绪。现在页面加载即每 3 秒拉一次 /__fnos/state，
  // 状态变化时更新徽标与横幅；就绪即停（不再打扰）。
  (() => {
    const LABEL = { starting: '启动中', ready: '运行中', rollback: '已回滚', safe: '安全模式', maintenance: '自动维护模式，请等待' };
    let lastMode = null;
    let lastOpSignature = null;
    let idleTicks = 0;
    const tick = async () => {
      // ⚠ 有操作在途时必须让位（0.3.66 修正）。
      // 常驻轮询原本会在状态变化时 location.reload()，但用户点「重启」的
      // fetch 提交可能**还没走完** —— reload 会打断它，前端 .catch() 于是把
      // 按钮显示成「操作失败，请刷新页面重试」，而服务端可能已成功。
      // 这与 0.3.62 修过的「轮询打断在途 POST」是同一类错误（我又犯了一次）。
      // 判据：body.dataset.busy 是提交处理设置的标志，操作期间只观看不动作。
      if (!pageActive || document.hidden || document.body.dataset.busy === '1') return;
      const generation = operationGeneration;
      try {
        const { info } = await requestState();
        if (!currentOperation(generation) || document.hidden || document.body.dataset.busy === '1') return;
        if (!info || typeof info.mode !== 'string') { idleTicks = 0; return; }
        const aiCore = document.getElementById('ai-core-state');
        if (aiCore) aiCore.textContent = ['ready', 'rollback'].includes(info.mode) ? '核心已就绪' : '核心未就绪（' + info.mode + '）';
        const recoveryGuide = document.querySelector('.guide');
        if (recoveryGuide) recoveryGuide.hidden = info.mode !== 'safe';
        idleTicks = 0;
        // ⚠ 0.3.73：相同 mode 也要更新「操作文案/进度」——维护中的操作会变化，
        // 而 mode 一直是 maintenance。原实现在 mode 未变时直接 return，
        // 于是「正在创建配置备份…」这类文案永远停在第一个操作上。
        const op0 = info.operation && typeof info.operation === 'object' ? info.operation : null;
        const opSignature = op0 ? String(op0.text || '') + '|' + String(op0.progress || '') : '';
        // 即使服务端状态没变，也需覆盖 BFCache/操作超时留下的临时文案。
        const changed = lastMode !== null && info.mode !== lastMode;
        lastMode = info.mode;
        lastOpSignature = opSignature;
        const base = LABEL[info.mode] || info.mode;
        const op = op0;
        setAppState(info.mode === 'maintenance' && op && op.text ? base + '：' + op.text : base,
          info.mode === 'ready' ? undefined : (info.mode === 'safe' || info.mode === 'rollback' ? 'bad' : 'warn'));
        // 横幅也要跟着状态走（0.3.68，用户反馈）：横幅是服务端渲染的静态 DOM，
        // 原先只有徽标（#app-state）会被轮询更新，横幅会**一直停在"维护中"**
        // 直到手动刷新。就绪时移除它；维护中且文案变了就就地更新。
        const banner = document.getElementById('status-banner');
        if (banner) {
          if (info.mode === 'ready') banner.remove();
          else if (info.mode === 'maintenance' && op && op.text) {
            // 用 textContent 而非 innerHTML 拼接：op.text 来自服务端，虽已转义过一次，
            // 但前端字符串拼接是二次加工，直接写 DOM 文本可彻底避免注入。
            const line = banner.querySelector('.op-line');
            const strong = line && line.querySelector('strong');
            if (strong) strong.textContent = String(op.text);
            if (line) {
              const began = op.startedAt ? Date.parse(op.startedAt) : NaN;
              let elapsed = line.querySelector('.op-elapsed');
              if (Number.isFinite(began)) {
                if (!elapsed) { elapsed = document.createElement('span'); elapsed.className = 'op-elapsed'; line.appendChild(elapsed); }
                elapsed.textContent = ' · 已用 ' + Math.max(0, Math.round((Date.now() - began) / 1000)) + ' 秒';
              } else if (elapsed) elapsed.remove();
            }
          }
        }
        // 只在**没有操作在途**时刷新（上面的 busy 检查已保证），且再次确认
        if (document.body.dataset.busy === '1') return;
        if (changed && info.mode === 'ready') { scheduleReload(700); return; }
        if (changed && info.mode !== 'ready') scheduleReload(0);
      } catch (error) { idleTicks = 0; if (currentOperation(generation) && error.authExpired) setAppState(error.message, 'bad'); }
    };
    tick();
    setInterval(tick, 3000);
    window.addEventListener('pageshow', () => setTimeout(tick, 0));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  })();

  // —— 插件管理：搜索过滤 ——
  document.getElementById('plugin-search')?.addEventListener('input', (event) => {
    const q = event.target.value.trim().toLowerCase();
    document.querySelectorAll('.plugin-card').forEach((card) => {
      card.style.display = !q || (card.textContent || '').toLowerCase().includes(q) ? '' : 'none';
    });
  });
  // —— 插件管理：本地 .tgz 导入（base64 上传 → 服务端落盘安装）——
  document.getElementById('plugin-import-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('plugin-import-status');
    const button = document.getElementById('plugin-import-btn');
    const file = document.getElementById('plugin-import-file')?.files?.[0];
    if (!file || !status || !button) return;
    const csrf = document.querySelector('input[name="csrf"]')?.value || '';
    const fail = (text) => { status.textContent = text; button.disabled = false; };
    try {
      button.disabled = true;
      status.textContent = '读取文件…';
      if (file.size > 64 * 1024 * 1024) return fail('文件超过 64MB 上限');
      const contentBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',').pop() || '');
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsDataURL(file);
      });
      status.textContent = '上传与安装中（可能需要一分钟左右）…';
      const response = await fetch(window.location.pathname + '?action=import-plugin-local&csrf=' + encodeURIComponent(csrf) + '&view=plugins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ filename: file.name, contentBase64 }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) return fail(body.error || ('HTTP ' + response.status));
      status.textContent = body.notice || '导入完成';
      setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      fail('导入失败：' + (error.message || error));
    }
  });
  document.getElementById('copy-debug')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    // 默认把给 AI 的调试说明附在连接信息后面（可取消勾选）；提示词按当前
    // 模式由服务端渲染进隐藏节点，textContent 读取时已还原转义。
    let value = document.getElementById('debug-info').innerText.trim();
    const promptNode = document.getElementById('debug-prompt');
    const promptToggle = document.getElementById('copy-debug-prompt');
    if (promptNode && (!promptToggle || promptToggle.checked)) value += '\\n\\n' + promptNode.textContent.trim();
    button.classList.add('is-working');
    button.setAttribute('aria-busy', 'true');
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
      else {
        const field = document.createElement('textarea');
        field.value = value;
        field.style.position = 'fixed';
        field.style.left = '-9999px';
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        if (!copied) throw new Error('copy unavailable');
      }
      button.textContent = '已复制';
    }
    catch { button.textContent = '复制失败，请长按连接信息'; }
    finally { button.classList.remove('is-working'); button.removeAttribute('aria-busy'); }
  });
  function resetBusy() {
    document.querySelectorAll('button.is-working').forEach((button) => {
      button.classList.remove('is-working');
      button.removeAttribute('aria-busy');
      button.disabled = false;
      if (button.classList.contains('restart-icon')) button.setAttribute('aria-label', '重启 DSH');
      else button.textContent = button.dataset.originalText || button.textContent;
    });
    delete document.body.dataset.busy;
    document.body.classList.remove('page-busy');
  }
  window.addEventListener('pagehide', () => { pageActive = false; beginOperation(); postController?.abort(); resetBusy(); });
  window.addEventListener('pageshow', () => { pageActive = true; resetBusy(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelReload(); stateFlight?.controller.abort(); } });
  document.addEventListener('submit', async (event) => {
    if (!event.target.matches('form[action="/__fnos/action"]')) return;
    const action = event.target.querySelector('input[name="action"]')?.value;
    // retry / restart-all 的确认已由标题栏弹窗承担（0.3.62）：弹窗里两个选项各自
    // 写明了影响范围与预计耗时，再来一个 window.confirm 是重复打断。其余仍是
    // 直接提交的表单（如「重新启动 DSH」卡片按钮），故这里不再拦 retry。
    // 高破坏性操作统一二次确认（0.3.62）：清单与服务端同源（actions.js 的
    // DESTRUCTIVE），文案写明**具体会动什么**，而不是笼统的"确定吗"。
    // 之前只有 restore 有确认，heal-patch-layer（重置 patch 配置）没有 ——
    // 用户因此把 16 条插件配置点成了 1 条。现在凡在清单里的都要确认。
    let destructive = {};
    try { destructive = JSON.parse(document.getElementById('destructive-actions')?.textContent || '{}'); } catch { /* 降级：无确认 */ }
    const destructiveNotice = destructive[action];
    if (destructiveNotice && !window.confirm(destructiveNotice + '\\n\\n确定继续吗？')) {
      event.preventDefault();
      return;
    }
    const button = event.submitter || event.target.querySelector('button[type="submit"]');
    if (!button) return;
    // 不让浏览器直接导航：同步提交会立刻开始跳转，真实浏览器会把页面冻结在
    // 点击前的画面（paint holding），busy 反馈 —— 包括重启图标的旋转 ——
    // 根本没机会绘制，用户看到的正是"点了没反应，过很久页面才刷新"。
    // 改为 fetch 提交：页面留在原地，动画真实转满整个操作时长（重启可达
    // 半分钟），完成后再刷新拿新状态。
    event.preventDefault();
    if (document.body.dataset.busy === '1') return;
    const generation = beginOperation();
    if (event.target.dataset.restartOption) {
      const dialog = document.getElementById('restart-dialog');
      if (dialog) dialog.hidden = true;
      document.body.classList.remove('restart-dialog-open');
    }
    document.body.dataset.busy = '1';
    document.body.classList.add('page-busy');
    // 状态徽标立即进入「重启中」（0.3.61）：此前只转按钮图标，徽标仍写「运行中」，
    // 管理员会以为没反应。改成即时反馈 + 就绪后自动刷回，中间不再需要手动刷新。
    // 现在标题栏按钮是 type=button（点击开弹窗），不再直接提交表单；
    // 真正的提交来自弹窗里的两个 form，各自带 data-restart-option。
    const optionScope = button.closest('form');
    const isRestart = Boolean(button.classList.contains('restart-icon') || (optionScope && optionScope.dataset.restartOption));
    if (isRestart) setAppState('重启中', 'warn');
    button.dataset.originalText = button.textContent;
    if (button.classList.contains('restart-icon')) button.setAttribute('aria-label', '正在重启 DSH');
    else if (event.target.dataset.restartOption) { button.disabled = true; button.textContent = '已提交，正在重启…'; }
    else {
      button.dataset.originalText = button.textContent;
      button.textContent = '处理中…';
    }
    button.classList.add('is-working');
    button.setAttribute('aria-busy', 'true');
    const form = event.target;
    const restart = action === 'restart-all' ? restartRequest() : null;
    const operationDeadline = Date.now() + 180000;
    const formBody = new URLSearchParams(new FormData(form));
    if (restart) formBody.set('restartRequestId', restart.id);
    // ⚠ 不能用 form.action：表单里有 <input name="action">，控件的命名访问会
    // 遮蔽 HTMLFormElement 的 action 属性，fetch 会拿到一个元素而不是 URL
    // （序列化成 "[object HTMLInputElement]"，请求必 404）。用字面属性值。
    // ⚠ 必须转成 URLSearchParams：服务端按 urlencoded 解析请求体，
    // FormData 默认是 multipart，凭据字段会全部解析失败（403）。
    postController = new AbortController();
    const postAbort = postController;
    const postDeadline = setTimeout(() => postAbort.abort(), 180000);
    fetch(form.getAttribute('action'), { signal: postAbort.signal, method: 'POST', body: formBody, credentials: 'same-origin' })
      .then(async (reply) => {
        if (!currentOperation(generation)) return;
        if (!reply.ok) throw new Error('HTTP ' + reply.status);
        // 重启类操作：服务端返回时核心可能仍在启动，直接刷新只会看到旧状态或 503
        // 页面。这里轮询到真正就绪再跳转，之后徽标自然回到「运行中」。
        if (isRestart) {
          const ready = await waitForCoreReady(Math.max(0, operationDeadline - Date.now()), generation, action === 'restart-all', restart);
          if (!currentOperation(generation)) return;
          if (!ready) {
            setAppState('启动较慢，可稍后刷新', 'warn');
            resetBusy();
            return;
          }
        }
        // 服务端把操作结果放在重定向的 notice 参数里；reload 当前地址会把它丢掉，
        // 失败也会被当成成功。跳到 fetch 跟随后的最终地址（同源，服务端自己签发）。
        const target = new URL(reply.url, location.href);
        if (target.origin === location.origin && target.href !== location.href) location.href = target.href;
        else location.reload();
      })
      .catch(async (error) => {
        if (!currentOperation(generation)) return;
        // ⚠ 0.3.73（A11）：区分「鉴权/网络失败」与「重启导致的正常断连」。
        // 原实现一律把 isRestart 的情况标成「重启失败」—— 完全重启会主动断连，
        // 会主动断掉当前连接，fetch 因此必然 reject，于是一次**成功**的重启
        // 在界面上被标成"重启失败"。现在按错误类型给出不同结论，并且都恢复按钮。
        const message = String((error && error.message) || '');
        const status = message.startsWith('HTTP ') ? Number(message.slice(5)) : 0;
        let authExpired = error.authExpired || status === 401 || status === 403;
        let restartFailed = Boolean(error.restartFailed);
        // 丢失POST响应只查询同一请求的回执，不重发。旧ready/其他请求一律不算成功。
        if (restart && !authExpired && !status && !restartFailed) {
          try {
            const confirmed = await waitForCoreReady(Math.max(0, operationDeadline - Date.now()), generation, true, restart);
            if (!currentOperation(generation)) return;
            if (confirmed) { resetBusy(); location.reload(); return; }
          } catch (confirmationError) {
            if (!currentOperation(generation)) return;
            authExpired = Boolean(confirmationError.authExpired);
            restartFailed = Boolean(confirmationError.restartFailed);
          }
        }
        if (authExpired) {
          authProblem = true;
          // 未被接受的请求不能拿旧核心ready证明重启成功，也不能自动重发。
          setAppState('凭据过期，请刷新页面', 'bad');
        } else if (restartFailed) {
          setAppState('完全重启失败，请检查运行控制', 'bad');
        } else if (isRestart) {
          setAppState('重启状态未确认，请刷新检查', 'warn');
        }
        button.disabled = false;
        delete document.body.dataset.busy;
        document.body.classList.remove('page-busy');
        button.classList.remove('is-working');
        button.removeAttribute('aria-busy');
        if (button.classList.contains('restart-icon')) button.setAttribute('aria-label', authExpired ? '重启 DSH（凭据已过期，请刷新页面）' : '重启 DSH');
        else button.textContent = authExpired ? '凭据过期，请刷新页面' : '操作失败，请重试';
      }).finally(() => { clearTimeout(postDeadline); if (postController === postAbort) postController = null; });
  });
  </script>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DeepSeek Harness 应用设置</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f7fb;color:#1c2333;font:15px/1.55 system-ui,sans-serif}.shell{max-width:980px;margin:auto;padding:24px 18px 64px}.notice{position:sticky;top:0;z-index:10;padding:12px max(18px,calc((100vw - 944px)/2));background:#e6f5eb;color:#14522e;border-bottom:1px solid #b8ddc4;box-shadow:0 3px 12px #17224715}.notice-error{background:#fff0ee;color:#9b2424;border-color:#edc0ba}.pending{display:flex;gap:14px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;margin:0 0 18px;padding:14px 16px;background:#fff8e6;border:1px solid #e8cf95;border-left:4px solid #c8901a;border-radius:10px}.pending strong{display:block;margin-bottom:6px;color:#7a5200}.pending p{margin:0 0 6px}.pending .hint{margin:0}.pending .actions{display:flex;gap:8px;flex:none;flex-wrap:wrap}/* 宽屏下 form 是 inline-flex（按钮排一行用的），会让它按内容收缩 —— 实测
   944px 的卡片里 form 只有 318px，patch 编辑器因此极窄。含编辑器的 form
   单独改成块级撑满，编辑器才拿得到全宽。 */
form:has(.patch-editor){display:block;width:100%;margin:8px 0}
form:has(.patch-editor) textarea{width:100%}
.patch-editor{width:100%;min-height:56vh;padding:12px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border:1px solid #cdd6e4;border-radius:10px;background:#fbfcfe;color:#1c2333;resize:vertical;white-space:pre;overflow:auto}
/* 只读展示块同理，避免长行被容器压窄 */
.patch-readonly{width:100%}.patch-readonly{margin:8px 0 0;padding:12px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f4f6fb;border:1px solid #e3e8f2;border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere;color:#44506b}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}h1{font-size:23px;margin:0}header .state{font-size:13px;padding:6px 10px;border-radius:999px;background:#e6ecfa;color:#244b95;white-space:nowrap}.primary,.secondary{display:flex;gap:7px;overflow-x:auto;white-space:nowrap}.primary{padding:5px 0 12px}.secondary{padding:12px 0 18px;border-top:1px solid #e3e7ef}.primary a,.secondary a{display:inline-flex;align-items:center;min-height:36px;padding:7px 13px;border-radius:9px;color:#344054;text-decoration:none}.primary a{font-weight:600}.primary a[aria-current],.secondary a[aria-current]{background:#175cd3;color:#fff}.secondary a:not([aria-current]):hover,.primary a:not([aria-current]):hover{background:#e8edf7}.card{background:#fff;border:1px solid #e5e9f1;border-radius:15px;padding:24px;box-shadow:0 4px 20px #1722470b;min-height:300px}h2{font-size:21px;margin:0 0 14px}h3{font-size:16px;margin:24px 0 10px}p{margin:12px 0}.hint{color:#667085;font-size:14px}.error{color:#a52222}.divider{border-top:1px solid #e5e9f1;margin:22px 0}.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.summary div{background:#f5f8ff;padding:16px;border-radius:10px}.summary span{display:block;color:#667085;font-size:13px}.summary strong{display:block;margin-top:5px;overflow-wrap:anywhere;font-size:17px}form{display:inline-flex;align-items:end;flex-wrap:wrap;gap:8px;margin:5px 10px 5px 0;max-width:100%}form label{display:flex;flex-direction:column;gap:4px;font-size:14px;min-width:0}input,select{font:inherit;min-height:38px;max-width:100%;padding:7px 9px;border:1px solid #cbd2df;border-radius:8px;background:#fff;color:#1c2333}input[type=number]{width:86px}input[type=url],inpu... (line truncated to 2000 chars)
  button.is-working{box-shadow:inset 0 0 0 1px #a3dfff}
  button.is-working::after{inset:0;padding:2px;background:conic-gradient(from var(--edge-angle),transparent 0deg 190deg,#58bfff33 220deg,#6bceffb3 260deg,#f5fdff 300deg,#8cdeff 325deg,transparent 360deg);animation-duration:1.8s}
  @media(prefers-reduced-motion:reduce){button.is-working::after{background:#84d6ff}}
  .debug-info{display:grid;gap:10px;padding:15px;margin:14px 0;background:#f5f8ff;border:1px solid #dfe8fb;border-radius:10px;overflow-wrap:anywhere}.debug-info code{user-select:all}
  /* 全局按钮基础样式（曾被误删 → 所有按钮回退浏览器默认外观；HEAD 版本恢复） */
  button,.primary-link{display:inline-flex;align-items:center;justify-content:center;min-height:38px;border:0;border-radius:8px;background:#175cd3;color:#fff;padding:8px 13px;font:inherit;text-decoration:none;cursor:pointer}
  button:hover,.primary-link:hover{background:#1248a4}
  button.danger{background:#fff3f2;color:#a52828;border:1px solid #e8b5b1}
  button.danger:hover{background:#ffe6e3}
  header .header-actions{display:flex;align-items:center;gap:8px;flex:none}header .header-actions form{display:block;width:auto;margin:0}button.restart-icon{width:34px;height:34px;min-height:34px;padding:0;border:1px solid #cbd7ef;border-radius:9px;background:#fff;color:#175cd3;display:flex;align-items:center;justify-content:center}button.restart-icon:hover,button.restart-icon:focus-visible{background:#e8f0ff;border-color:#82a9ed}button.restart-icon svg{display:block}
/* 图标绕自身中心旋转。用 transform-box:view-box + transform-origin:center，
   轴心是 24x24 视口中心；该图标的墨迹在视口内四边等距，所以轴心即图形中心。
   改用 fill-box 会以包围盒为轴，图形一变就抖。 */
@keyframes restart-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
button.restart-icon .restart-glyph{transform-box:view-box;transform-origin:center}
/* 重启二选一弹窗（0.3.62）：把"只重启核心"与"完全重启程序"的差异摆明，
   避免用户改了 supervisor/gateway 后点核心重启、却看不到任何变化。 */
.restart-dialog[hidden]{display:none}
.restart-dialog{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:18px}
.restart-dialog-backdrop{position:absolute;inset:0;background:#0f172a99}
.restart-dialog-card{position:relative;width:100%;max-width:560px;background:#fff;border-radius:14px;padding:22px;box-shadow:0 18px 48px #0f172a33;max-height:90vh;overflow:auto}.notice-busy{background:#fffaeb;border-color:#fedf89;color:#7a2e0e}.op-line{display:block;margin-top:6px;font-weight:600}.op-hint{display:block;margin-top:4px;font-size:12px;opacity:.85;font-weight:400}.restart-caveat{display:block;margin-top:8px;padding:7px 9px;background:#fffaeb;border:1px solid #fedf89;border-radius:7px;font-size:12px;line-height:1.5;color:#7a2e0e;font-style:normal}
.restart-dialog-card h3{margin:0 0 6px;font-size:18px}
.restart-dialog-hint{margin:0 0 16px;color:#667085;font-size:13px}
.restart-options{display:grid;gap:10px}
.restart-options form{margin:0}
button.restart-option{display:block;width:100%;text-align:left;padding:14px;border:1px solid #cbd7ef;border-radius:11px;background:#fff;color:#1c2333;cursor:pointer;font:inherit}
button.restart-option:hover,button.restart-option:focus-visible{background:#f2f6ff;border-color:#82a9ed}
button.restart-option strong{display:block;margin-bottom:4px;font-size:15px;color:#175cd3}
button.restart-option span{display:block;font-size:13px;color:#475467;line-height:1.5}
button.restart-option em{font-style:normal;color:#175cd3}
.restart-dialog-foot{margin-top:14px;text-align:right}
button.restart-cancel{padding:9px 16px;border:1px solid #cbd7ef;border-radius:9px;background:#fff;color:#475467;cursor:pointer;font:inherit}
button.restart-cancel:hover{background:#f5f7fb}
body.restart-dialog-open{overflow:hidden}
/* 分级排障引导（0.3.62）：把平铺的修复按钮按破坏性分成四级，
   每级写明"会动什么、能不能退回"，避免误点高破坏性操作。 */
.guide .guide-row{display:flex;gap:14px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;padding:12px;margin:10px 0;border-left:3px solid #cbd7ef;background:#f8fafc;border-radius:8px}
.guide .guide-row.tone-safe{border-left-color:#4ea672;background:#f3faf5}
.guide .guide-row.tone-warn{border-left-color:#d6a12a;background:#fdf9ef}
.guide .guide-row.tone-danger{border-left-color:#d0553f;background:#fdf4f2}
.guide .guide-text{flex:1 1 320px;min-width:0}
.guide .guide-text strong{display:block;margin-bottom:4px}
.guide .guide-text span{display:block;font-size:13px;color:#475467;line-height:1.55}
.guide .guide-actions{display:flex;gap:8px;flex-wrap:wrap;flex:1 1 100%;min-width:0;max-width:100%;align-items:center}
.guide .guide-actions form{margin:0;min-width:0;max-width:100%}
.guide button{max-width:100%;white-space:normal;overflow-wrap:anywhere}
.failure-detail{position:static;font-size:13px}.failure-detail pre{max-height:160px}
.card code{overflow-wrap:anywhere}
.ai-fields{display:grid;gap:10px;min-width:0}.ai-diagnosis label{display:block;min-width:0}.ai-diagnosis input,.ai-diagnosis select,.ai-diagnosis textarea{width:100%;max-width:100%;min-width:0}.ai-diagnosis textarea{padding:10px;resize:vertical}.ai-diagnosis #ai-log{max-height:320px;overflow:auto;overflow-wrap:anywhere}
@media(max-width:560px){.guide .guide-actions{display:grid;grid-template-columns:minmax(0,1fr);width:100%}.guide .guide-actions form,.guide .guide-actions button,.guide .guide-actions a{width:100%;min-width:0}.notice{overflow-wrap:anywhere}}
.guide .guide-foot{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:1px solid #e4e9f2;font-size:13px;color:#667085}
button.restart-icon.is-working .restart-glyph{animation:restart-spin .9s linear infinite}
  /* 重启按钮不叠加按钮级边缘流光：图标旋转 + 整页边框流光已经足够表达忙态，
     按钮太小，两层流光叠在一起只会互相糊。 */
  button.restart-icon.is-working::after{display:none}
@media(prefers-reduced-motion:reduce){button.restart-icon.is-working .restart-glyph{animation:none;opacity:.6}}
  /* 整页忙态：视口四周边框的半透明彩虹流光。fixed + pointer-events:none
     盖在整页之上但不拦截任何交互；mask-composite 把填充镂空、只留 3px 边框
     环（与按钮 edge-sweep 同一手法）。 */
  @property --rainbow-angle{syntax:"<angle>";inherits:false;initial-value:0deg}
  @keyframes rainbow-sweep{to{--rainbow-angle:360deg}}
  body.page-busy::after{content:"";position:fixed;inset:0;z-index:9999;pointer-events:none;padding:3px;background:conic-gradient(from var(--rainbow-angle),#ff4d4f88,#ff9f0a88,#ffd60a88,#34c75988,#32ade688,#5e5ce688,#bf5af288,#ff4d4f88);-webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);mask-composite:exclude;animation:rainbow-sweep 1.6s linear infinite}
  /* 向内的半透明过渡带：四条向心淡出渐变叠在边框环内侧，边界更自然。 */
  body.page-busy::before{content:"";position:fixed;inset:0;z-index:9998;pointer-events:none;
    background:
      linear-gradient(to bottom, #6db8f233, transparent 46px),
      linear-gradient(to top, #6db8f233, transparent 46px),
      linear-gradient(to right, #6db8f233, transparent 46px),
      linear-gradient(to left, #6db8f233, transparent 46px)}
  @media(prefers-reduced-motion:reduce){body.page-busy::after{animation:none;background:#84d6ff33}body.page-busy::before{background:none}}.group-description{margin:0;padding:0 2px 10px;color:#667085;font-size:13px}@media(max-width:620px){header{align-items:flex-start}header .header-actions{gap:6px}button.restart-icon{width:34px}header .state{font-size:12px}}
    /* ===== 0.3.61 界面完善：补齐缺失元素样式 + 响应式 + 无障碍 ===== */
  /* 指标卡：原先固定 3 列，而概览实际有 4 个指标（状态/核心/配置档/应用版本），
     第 4 个会单独换行、宽度与上面三个不齐 —— 改成按可用宽度自适应。 */
  .summary{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
  /* 修复类卡片：此前 .remediation 没有任何规则，和普通卡片外观完全一样，
     管理员看不出「这张卡需要我做点什么」。左侧强调边 + 浅底把它区分出来。 */
  .card.remediation{border-left:4px solid #c8901a;background:#fffdf7}
  .card.remediation h3{margin-top:0;color:#7a5200}
  .card.remediation h4{margin:14px 0 6px;font-size:14px;color:#44506b}
  .card.remediation ul{margin:6px 0;padding-left:22px}
  .card.remediation li{margin:6px 0}
  /* 卡片内动作区：原先只靠 form 自身的 margin 撑开，多个按钮间距不一致。 */
  .actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:14px 0 0}
  .actions>form{display:inline-flex;margin:0}
  /* 数据表：备份/版本/权限列表此前是浏览器默认外观，无明显分隔与表头层次。 */
  /* 插件列表与卡片：.plugin-list 此前没有规则，卡片也没有内部布局 —— 窄屏下
     名称/版本/按钮挤在一行会溢出。 */
  .plugin-list{display:grid;gap:10px}
  .plugin-card{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:13px 15px;background:#fbfcfe;border:1px solid #e5e9f1;border-radius:11px}
  .plugin-card>div:first-child{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 200px}
  .plugin-card strong{font-size:15px;overflow-wrap:anywhere}
  .plugin-card span{color:#667085;font-size:13px}
  .plugin-card .actions{margin:0;flex:none}
  .plugin-card .actions form{margin:0}
  @media(max-width:560px){.plugin-card{flex-direction:column;align-items:stretch}.plugin-card .actions{width:100%}.plugin-card .actions>form{flex:1 1 auto}.plugin-card .actions button{width:100%}}
  /* 表格横向滚动容器：terminal 等视图已用 .table-scroll 包表格，但此前没有
     对应规则 —— 窄屏下表格会把整页撑宽（典型溢出源）。 */
  .table-scroll{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
  .table-scroll table{margin:0}
  table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}
  th,td{padding:9px 10px;text-align:left;border-bottom:1px solid #e9edf5;vertical-align:middle}
  th{color:#667085;font-weight:600;background:#f7f9fd}
  tbody tr:hover{background:#fafcff}
  /* 折叠块：诊断卡的「核心最后输出」等 details 此前是默认外观。 */
  details{margin:10px 0;border:1px solid #e3e8f2;border-radius:10px;background:#fbfcfe}
  summary{padding:9px 12px;cursor:pointer;font-size:14px;color:#344054}
  details[open] summary{border-bottom:1px solid #e9edf5}
  details>pre{margin:0;border:0;border-radius:0 0 10px 10px}
  /* 代码块：日志、patch 片段、输出尾部的统一呈现。 */
  pre{margin:10px 0;padding:12px;background:#f4f6fb;border:1px solid #e3e8f2;border-radius:10px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:#44506b;max-height:420px;overflow:auto}
  /* 状态徽标语义色：原先只有蓝色一种，运行中/安全模式/维护中长得一样。 */
  header .state.ok{background:#e6f5eb;color:#14522e}
  header .state.warn{background:#fff4e0;color:#7a5200}
  header .state.bad{background:#fff0ee;color:#9b2424}
  /* 键盘可达性：此前只有重启按钮有焦点样式，其余控件见不到焦点。 */
  a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid #175cd3;outline-offset:2px}
  /* 平板/窄屏：原本 620px 以外没有任何适配，24px 卡片内边距在平板上偏挤。 */
  @media(max-width:1024px){.shell{padding:20px 14px 48px}.card{padding:20px}}
  @media(max-width:760px){
    .card{padding:16px;border-radius:12px;min-height:0}
    .summary{grid-template-columns:repeat(auto-fit,minmax(128px,1fr))}
    /* 只让「没有包滚动容器」的裸表格自己滚动；.table-scroll 已经负责滚动，
       再套一层 display:block 会让表格宽度塌陷、表头与数据列错位。 */
    table:not(.table-scroll table){display:block;overflow-x:auto;white-space:nowrap}
    header{flex-wrap:wrap}
  }
  /* ===== 0.3.61 移动端适配 ===== */
  /* 触摸友好的点击区域：手机上 36px 的导航项偏小，易误触。 */
  @media(max-width:760px){
    .primary a,.secondary a{min-height:42px;padding:9px 14px}
    button,.primary-link{min-height:42px}
    input,select,textarea{font-size:16px}
  }
  /* 顶栏：标题 + 状态 + 重启按钮在窄屏会挤成一行溢出，改为可换行。 */
  @media(max-width:560px){
    header{flex-direction:column;align-items:stretch;gap:10px}
    header .header-actions{justify-content:flex-end}
    h1{font-size:20px}
    h2{font-size:18px}
    .shell{padding:14px 12px 40px}
    .card{padding:14px;border-radius:10px}
    form{display:block}
    form label{width:100%;margin-bottom:8px}
    form button{margin-top:8px}
    .actions{gap:6px}
    .actions>form{flex:1 1 100%}
    .actions button,.actions .primary-link{width:100%}
    .summary{grid-template-columns:1fr 1fr;gap:9px}
    .summary div{padding:12px}
    .notice{padding:10px 12px;font-size:14px}
  }
  /* 极窄屏（老设备/分屏 320px）：单列排布。 */
  @media(max-width:380px){
    .summary{grid-template-columns:1fr}
    .shell{padding:12px 10px 36px}
  }
  /* 触摸滑动提示：横向导航与表格可滚动时给出可见滚动条。 */
  .primary,.secondary,.table-scroll{scrollbar-width:thin}
  .primary::-webkit-scrollbar,.secondary::-webkit-scrollbar,.table-scroll::-webkit-scrollbar{height:6px}
  .primary::-webkit-scrollbar-thumb,.secondary::-webkit-scrollbar-thumb,.table-scroll::-webkit-scrollbar-thumb{background:#c9d3e3;border-radius:3px}
  /* 长内容强制断行：插件名、路径、命令、URL 在窄屏极易撑破卡片。 */
  .card{overflow-wrap:anywhere}
  .plugin-card strong,.debug-info code,.card code{overflow-wrap:anywhere}
  /* 防止横向滚动条：页面级兜底。 */
  html,body{max-width:100%;overflow-x:hidden}
</style></head><body><script type="application/json" id="destructive-actions">${destructiveJson}</script>${noticeBar}${statusBanner}${pendingBar}${restartDialog}<div class="shell"><header><h1>DeepSeek Harness · 应用设置</h1><div class="header-actions"><span class="state ${statusTone}" id="app-state">${status}</span>${headerRestart}</div></header><nav class="primary" aria-label="设置分类">${primaryNav}</nav><p class="group-description">${group.description}</p><nav class="secondary" aria-label="二级菜单">${secondaryNav}</nav><main class="card">${panels[view]}</main></div>${busyScript}</body></html>`;
}

module.exports = { render, selectedView };