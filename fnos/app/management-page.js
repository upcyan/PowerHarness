const ops = require('./ops.js');
const cores = require('./core-manager.js');
const profiles = require('./profiles.js');
const plugins = require('./plugins.js');
const pluginPaths = require('./plugin-paths.js');
const grants = require('./grants.js');

const groups = [
  { id: 'overview', label: '概览', description: '查看运行状态、重启 DSH 和调整服务端口。', items: [['overview', '运行状态'], ['runtime', '运行控制']] },
  { id: 'core', label: '核心与扩展', description: '管理 DSH 核心版本、插件及其 npm 下载源。', items: [['versions', 'DSH 版本'], ['plugins', '插件管理'], ['registry', 'npm 源']] },
  { id: 'data', label: '数据与权限', description: '管理配置档与备份，以及目录、容器和插件 URL 的访问权限。', items: [['profiles', '配置档'], ['backups', '备份与恢复'], ['grants', '目录权限'], ['containers', '容器权限'], ['pluginPaths', '插件 URL 放行']] },
  { id: 'diagnostics', label: '诊断', description: '查看日志并开启限时网络调试。', items: [['logs', '诊断日志'], ['network', '网络调试']] }
];
const views = new Set(groups.flatMap((group) => group.items.map(([id]) => id)));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function selectedView(value) { return views.has(value) ? value : 'overview'; }

function render(dataDir, state, session, requestUrl, openDshPath, nonce = '', networkDebug = null, dockerStatus = null, ports = null) {
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
  const pluginUrlPaths = pluginPaths.snapshot(dataDir);
  const authorizedDirectories = grants.inspect();
  const status = { starting: '启动中', ready: '运行中', rollback: '已回滚', safe: '安全模式', maintenance: '维护中' }[state.mode] || '未知';
  const csrf = escapeHtml(session.csrf);
  const form = (name, fields, label, buttonClass = '') => `<form method="post" action="/__fnos/action"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="view" value="${view}"><input type="hidden" name="action" value="${name}">${fields}<button type="submit"${buttonClass ? ` class="${buttonClass}"` : ''}>${label}</button></form>`;
  const action = (name, label, fields = '') => form(name, fields, label);
  const select = (name, values, selected) => `<select name="${name}">${values.map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>`;
  const coreOptions = installedCores.map((version) => [version, `DSH ${version}${version === state.activeVersion ? '（运行中）' : ''}`]);
  const profileOptions = profileNames.map((name) => [name, `${name}${name === activeProfile ? '（运行中）' : ''}`]);
  const backupRows = backups.map((item) => `<tr><td>${escapeHtml(item.createdAt)}</td><td>${escapeHtml(item.kind)}</td><td>${escapeHtml(item.version)}</td><td>${action('restore', '恢复此备份', `<input type="hidden" name="backupId" value="${escapeHtml(item.id)}">`)}</td></tr>`).join('');
  const pluginCards = installedPlugins.map((item) => {
    const field = `<input type="hidden" name="packageName" value="${escapeHtml(item.name)}">`;
    const status = item.enabled ? '已启用' : item.compatible ? '已禁用' : '文件缺失或非插件';
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
  const debugPanel = networkDebug
    ? `<p>当前为<strong>${debugMode === 'command' ? '指令模式' : '只读模式'}</strong>，至北京时间 <strong>${escapeHtml(new Date(networkDebug.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</strong> 自动关闭。</p><div id="debug-info" class="debug-info"><div>只读快照：<code>https://${escapeHtml(networkDebug.address)}:${networkDebug.port}/snapshot</code></div>${debugMode === 'command' ? `<div>指令接口：<code>https://${escapeHtml(networkDebug.address)}:${networkDebug.port}/command</code></div>` : ''}<div>临时 Token：<code>${escapeHtml(networkDebug.token)}</code></div></div><div class="actions"><button id="copy-debug" type="button">复制连接信息</button>${action('stop-network-debug', '立即关闭')}</div><div class="divider"></div><h3>切换模式或有效期</h3>${debugForm}<p class="hint">切换会立即关闭旧端口、废弃旧 Token，并生成新的连接信息；已发起的 FPK 操作可能继续完成。</p>`
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
    overview: `<h2>运行状态</h2><div class="summary"><div><span>应用状态</span><strong>${status}</strong></div><div><span>DSH 核心</span><strong>${escapeHtml(state.activeVersion || state.bundledVersion || '未知')}</strong></div><div><span>配置档</span><strong>${escapeHtml(activeProfile)}</strong></div></div>${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ''}${['ready', 'rollback'].includes(state.mode) && openDshPath ? `<p><a class="primary-link" data-dsh-open href="${escapeHtml(openDshPath)}">打开 DSH Web UI</a></p>` : ''}<p class="hint">通过上方菜单管理核心、扩展、备份与诊断。</p>`,
    versions: `<h2>DSH 版本</h2><p>随包版本：${escapeHtml(state.bundledVersion || '未知')} · 当前版本：${escapeHtml(state.activeVersion || '未知')}</p><p>npm latest（默认渠道）：${escapeHtml(update.latest || '未检查')} · npm next（预览渠道）：${escapeHtml(update.next || '未检查')} · 上次检查：${escapeHtml(update.checkedAt || '尚未检查')}</p>${action('check-update', '立即检查更新')}<div class="divider"></div><h3>安装新版本</h3>${form('install-core', `<label>版本号 <input name="version" required pattern="[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?" value="${escapeHtml(update.latest || '')}"></label>`, '安装并切换核心')}<h3>切换已有版本</h3>${coreOptions.length ? form('switch-core', `<label>已安装版本 ${select('version', coreOptions, state.activeVersion)}</label>`, '切换版本') : '<p class="hint">暂无独立安装的版本。</p>'}${action('use-bundled', '切换到随包核心')}`,
    registry: `<h2>npm 源</h2><p>当前源：<code>${escapeHtml(registry)}</code></p><div class="actions">${registryPresets}</div>${form('set-registry', `<label>自定义 HTTPS 源 <input name="registry" type="url" required value="${escapeHtml(registry)}"></label>`, '保存源')}<p class="hint">仅填写可信的 HTTPS 镜像地址。插件使用新源需要重新启动 DSH 核心。</p>`,
    plugins: `<h2>插件管理</h2><p>当前配置档：<strong>${escapeHtml(activeProfile)}</strong>。禁用会保留安装文件；卸载会从配置、依赖清单和安装目录清理插件。操作完成后会验证 DSH 能否启动。</p>${state.mode === 'safe' ? '<p class="error">当前处于安全模式。可先禁用冲突插件，成功后 DSH 会自动恢复运行。</p>' : ''}<h3>已安装插件</h3><div class="plugin-list">${pluginCards || '<p class="hint">当前配置档没有额外安装的插件。</p>'}</div><div class="divider"></div><h3>安装插件</h3><p>输入 npm 包名或固定版本，安装前检查 DSH 插件声明、完整性摘要、Node 和依赖兼容性及高危漏洞公告。</p>${form('install-plugin', '<label>插件包名 <input name="packageName" required placeholder="@scope/plugin 或 @scope/plugin@1.2.3"></label>', '检查并安装插件')}<p class="hint">检查无法完成或启动失败会恢复原配置。插件运行时代码仍可能拥有 DSH 权限，请只安装可信发布者的插件。</p>`,
    pluginPaths: `<h2>插件 URL 放行</h2><p>手机和 fnOS 远程入口使用子路径。应用会自动发现插件请求的根路径 API，但不会自动放行。确认路径属于可信插件后点击“放行”，再返回并强制刷新 DSH。</p><p class="hint">这里只控制浏览器 URL 自动改写，不限制插件在 DSH 内部的权限，也不代替插件与 DSH 核心版本的兼容检查。每条规则覆盖对应路径及其子路径，不含其他前缀。</p><h3>待放行</h3><div class="plugin-list">${pendingPluginPaths || '<p class="hint">尚未检测到第三方根路径请求。先打开插件页面，再刷新这里。</p>'}</div><div class="divider"></div><h3>已放行</h3><div class="plugin-list">${approvedPluginPaths || '<p class="hint">尚未放行第三方路径。</p>'}</div>`,
    profiles: `<h2>DSH 配置档</h2><p>当前配置档：<strong>${escapeHtml(activeProfile)}</strong>。新配置档从 DSH 官方 Web 模板创建，切换前自动备份。</p>${form('switch-profile', `<label>已有配置档 ${select('profile', profileOptions, activeProfile)}</label>`, '切换配置档')}${form('create-profile', '<label>新配置档名称 <input name="profile" required pattern="[a-z][a-z0-9_-]{0,31}" maxlength="32" placeholder="例如 work"></label>', '新建并切换')}`,
    grants: `<h2>目录权限</h2><p>在 fnOS 应用中心找到 DeepSeek Harness，打开访问权限并授予需要使用的 NAS 文件夹。授权后重新启动应用，再刷新此页。</p><p>已授权且可读取的目录会在 DSH 工作区的 <code>${escapeHtml(grants.shortcutFolder)}</code> 中显示为快捷入口。文件操作仍受 fnOS 对应用账号授予的权限限制。</p><div class="table-scroll"><table><thead><tr><th>fnOS 授权目录</th><th>当前访问</th></tr></thead><tbody>${grantRows || '<tr><td colspan="2">当前未收到 fnOS 授权目录。请在 fnOS 应用中心授予访问权限。</td></tr>'}</tbody></table></div><div class="divider"></div><h3>检测工作区写入权限</h3><p>输入在 DSH 中选择的完整目录，例如 <code>/vol1/1000/deepseek_harness/softrouter</code>。检测会在该目录短暂创建并删除一个空文件夹，与 DSH 的工作区检查一致。</p>${form('probe-workspace', '<label>工作区绝对路径 <input name="workspacePath" required placeholder="/vol1/1000/deepseek_harness/softrouter"></label>', '检测实际写入权限')}<p class="hint">上表只显示授权根目录的基础权限；子目录可能有不同 ACL。若刚授权仍未显示，请在 fnOS 应用中心停止并重新启动本应用。</p>`,
    containers: dockerPanel,
    backups: `<h2>备份与恢复</h2><p>备份包含 DSH 设置、会话和私有工作区；恢复会覆盖当前数据。</p><p>自动备份条件：${{ always: '每天 03:00', changed: '每天 03:00，仅内容有改动', updates: '仅在更新或切换前' }[backupSettings.dailyMode]}。更新前的回滚备份始终执行。</p>${action('backup', '立即备份')}<div class="divider"></div><h3>备份策略</h3>${form('set-backup-settings', `<label>每日保留 <input type="number" name="dailyLimit" min="1" max="30" value="${backupSettings.daily}" required></label><label>手动保留 <input type="number" name="manualLimit" min="1" max="30" value="${backupSettings.manual}" required></label><label>更新前保留 <input type="number" name="upgradeLimit" min="1" max="10" value="${backupSettings['pre-upgrade']}" required></label><label>自动备份 ${select('dailyMode', [['always', '每天'], ['changed', '仅内容有改动'], ['updates', '仅更新或切换前']], backupSettings.dailyMode)}</label>`, '保存备份策略')}<h3>已有备份</h3><div class="table-scroll"><table><thead><tr><th>时间</th><th>类型</th><th>DSH 版本</th><th>操作</th></tr></thead><tbody>${backupRows || '<tr><td colspan="4">暂无备份</td></tr>'}</tbody></table></div>`,
    runtime: `<h2>运行控制</h2><p>启动异常时可重新启动 DSH 核心，或进入安全模式检查配置。</p><div class="actions">${action('retry', '重新启动 DSH')}${action('safe-mode', '进入安全模式')}</div><div class="divider"></div><h3>端口设置</h3><p>公网入口端口是浏览器与手机飞牛 App 访问应用的 HTTPS 端口（fnOS 应用中心未提供修改入口，可在此调整）。内部核心端口仅在本机回环地址上使用。</p><p>当前公网入口端口：<strong>${ports?.publicPort ?? Number(process.env.FNOS_PORT || 3080)}</strong>${ports?.customized ? `（应用中心默认 ${ports.manifestPort}，原端口仍保持兼容监听）` : `（默认，由应用中心分配）`} · 内部核心端口：<strong>${ops.portSettings(dataDir).corePort}</strong></p>${form('set-public-port', `<label>公网入口端口 <input type="number" name="publicPort" min="1024" max="65535" value="${ports?.publicPort ?? Number(process.env.FNOS_PORT || 3080)}" required></label>`, '保存并切换端口')}<p class="hint">保存后网关立即以新端口对外服务，原端口尽量保持兼容监听；填回默认端口 ${ports?.manifestPort ?? Number(process.env.FNOS_PORT || 3080)} 可恢复默认。</p><div class="divider"></div><h3>内部核心端口</h3><p>仅当启动失败提示 <code>EADDRINUSE</code>（端口被 NAS 上其他进程占用）时才需要修改。保存后 DSH 会以新端口重启；启动失败会自动恢复原端口。</p>${form('set-core-port', `<label>内部核心端口 <input type="number" name="corePort" min="1024" max="65535" value="${ops.portSettings(dataDir).corePort}" required></label>`, '保存并重启 DSH')}<p class="hint">修改公网端口后：浏览器需改用新地址访问；NAS 防火墙需放行新端口；证书不变，无需重新接受。残留的 dsh 进程会在下次启动时自动清理；若内部端口提示被其他进程占用，请先停止占用该端口的应用。</p>`,
    logs: `<h2>诊断日志</h2><p>查看应用网关、应用运行与 DSH 核心的最近日志。页面支持复制和下载。</p><p><a class="primary-link" href="/__fnos/logs?source=gateway">打开诊断日志</a></p><p class="hint">DSH 核心日志会遮盖常见令牌；分享前请再次检查内容。</p>`,
    network: `<h2>网络调试</h2>${debugPanel}${debugHelp}`
  };

  const primaryNav = groups.map((item) => `<a href="/__fnos/?view=${item.items[0][0]}"${item.id === group.id ? ' aria-current="page"' : ''}>${item.label}</a>`).join('');
  const secondaryNav = group.items.map(([id, label]) => `<a href="/__fnos/?view=${id}"${id === view ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  const headerRestart = `<form id="header-restart-form" method="post" action="/__fnos/action"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="view" value="${view}"><input type="hidden" name="action" value="retry"><button class="restart-icon" type="submit" title="重启 DSH" aria-label="重启 DSH"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/></svg></button></form>`;
  const noticeBar = notice ? `<div class="notice ${notice.startsWith('操作失败') ? 'notice-error' : ''}" role="status">${escapeHtml(notice)}</div>` : '';
  const busyScript = nonce ? `<script nonce="${nonce}">
  if (window.parent !== window) window.parent.postMessage({ type: 'dsh-fnos-view', view: 'settings' }, '*');
  document.addEventListener('click', (event) => {
    if (event.target.closest('a[data-dsh-open]') && window.parent !== window) window.parent.postMessage({ type: 'dsh-fnos-view', view: 'dsh' }, '*');
  });
  document.getElementById('copy-debug')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const value = document.getElementById('debug-info').innerText.trim();
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
      if (button.classList.contains('restart-icon')) button.setAttribute('aria-label', '重启 DSH');
      else button.textContent = button.dataset.originalText || button.textContent;
    });
  }
  window.addEventListener('pageshow', resetBusy);
  document.addEventListener('submit', (event) => {
    if (!event.target.matches('form[action="/__fnos/action"]')) return;
    if (event.target.querySelector('input[name="action"]')?.value === 'retry' &&
        !window.confirm('确定重启 DSH 核心吗？当前会话会暂时断开，未保存的输入可能丢失。')) {
      event.preventDefault();
      return;
    }
    const button = event.submitter || event.target.querySelector('button[type="submit"]');
    if (!button) return;
    if (button.classList.contains('restart-icon')) button.setAttribute('aria-label', '正在重启 DSH');
    else {
      button.dataset.originalText = button.textContent;
      button.textContent = '处理中…';
    }
    button.classList.add('is-working');
    button.setAttribute('aria-busy', 'true');
  });
  </script>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DeepSeek Harness 应用设置</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f7fb;color:#1c2333;font:15px/1.55 system-ui,sans-serif}.shell{max-width:980px;margin:auto;padding:24px 18px 64px}.notice{position:sticky;top:0;z-index:10;padding:12px max(18px,calc((100vw - 944px)/2));background:#e6f5eb;color:#14522e;border-bottom:1px solid #b8ddc4;box-shadow:0 3px 12px #17224715}.notice-error{background:#fff0ee;color:#9b2424;border-color:#edc0ba}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}h1{font-size:23px;margin:0}header .state{font-size:13px;padding:6px 10px;border-radius:999px;background:#e6ecfa;color:#244b95;white-space:nowrap}.primary,.secondary{display:flex;gap:7px;overflow-x:auto;white-space:nowrap}.primary{padding:5px 0 12px}.secondary{padding:12px 0 18px;border-top:1px solid #e3e7ef}.primary a,.secondary a{display:inline-flex;align-items:center;min-height:36px;padding:7px 13px;border-radius:9px;color:#344054;text-decoration:none}.primary a{font-weight:600}.primary a[aria-current],.secondary a[aria-current]{background:#175cd3;color:#fff}.secondary a:not([aria-current]):hover,.primary a:not([aria-current]):hover{background:#e8edf7}.card{background:#fff;border:1px solid #e5e9f1;border-radius:15px;padding:24px;box-shadow:0 4px 20px #1722470b;min-height:300px}h2{font-size:21px;margin:0 0 14px}h3{font-size:16px;margin:24px 0 10px}p{margin:12px 0}.hint{color:#667085;font-size:14px}.error{color:#a52222}.divider{border-top:1px solid #e5e9f1;margin:22px 0}.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.summary div{background:#f5f8ff;padding:16px;border-radius:10px}.summary span{display:block;color:#667085;font-size:13px}.summary strong{display:block;margin-top:5px;overflow-wrap:anywhere;font-size:17px}form{display:inline-flex;align-items:end;flex-wrap:wrap;gap:8px;margin:5px 10px 5px 0;max-width:100%}form label{display:flex;flex-direction:column;gap:4px;font-size:14px;min-width:0}input,select{font:inherit;min-height:38px;max-width:100%;padding:7px 9px;border:1px solid #cbd2df;border-radius:8px;background:#fff;color:#1c2333}input[type=number]{width:86px}input[type=url],input[name=packageName],input[name=workspacePath]{width:min(420px,75vw)}button,.primary-link{display:inline-flex;align-items:center;justify-content:center;min-height:38px;border:0;border-radius:8px;background:#175cd3;color:#fff;padding:8px 13px;font:inherit;text-decoration:none;cursor:pointer}button:hover,.primary-link:hover{background:#1248a4}.actions{display:flex;flex-wrap:wrap;gap:8px}code{overflow-wrap:anywhere}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;min-width:520px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #e7eaf0}th{font-size:13px;color:#667085}td form{margin:0}@property --edge-angle{syntax:"<angle>";inherits:false;initial-value:0deg}button.is-working{position:relative;isolation:isolate;box-shadow:0 0 0 1px #77cfff,0 0 9px #4ebdff55}button.is-working::after{content:"";position:absolute;inset:-2px;border-radius:inherit;padding:2px;background:conic-gradient(from var(--edge-angle),transparent 0deg 250deg,#50baff 295deg,#f3fcff 324deg,#75d2ff 340deg,transparent 360deg);-webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:edge-sweep 1.35s linear infinite;pointer-events:none}@keyframes edge-sweep{to{--edge-angle:360deg}}@media(prefers-reduced-motion:reduce){button.is-working::after{animation:none;background:#84d6ff}}.plugin-list{display:grid;gap:10px}.plugin-card{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px 15px;border:1px solid #e2e7f0;border-radius:10px;background:#fbfcff}.plugin-card strong{display:block;overflow-wrap:anywhere}.plugin-card span{display:block;color:#667085;font-size:13px}.plugin-card form{width:auto;margin:0}button.danger{background:#fff3f2;color:#a52828;border:1px solid #e8b5b1}button.danger:hover{background:#ffe6e3}@media(max-width:620px){.plugin-card{display:block}.plugin-card .actions{margin-top:10px}.plugin-card form{width:auto}}@media(max-width:620px){.shell{padding:15px 10px 40px}h1{font-size:19px}.card{padding:18px;min-height:0}.summary{grid-template-columns:1fr}.primary a,.secondary a{padding:7px 10px}form{display:flex;flex-direction:column;align-items:flex-start;width:100%;margin:8px 0}form label{width:100%;flex:none}form input,form select{width:100%}input[type=url],input[name=packageName],input[name=workspacePath]{width:100%}}
  button.is-working{box-shadow:inset 0 0 0 1px #a3dfff}
  button.is-working::after{inset:0;padding:2px;background:conic-gradient(from var(--edge-angle),transparent 0deg 190deg,#58bfff33 220deg,#6bceffb3 260deg,#f5fdff 300deg,#8cdeff 325deg,transparent 360deg);animation-duration:1.8s}
  @media(prefers-reduced-motion:reduce){button.is-working::after{background:#84d6ff}}
  .debug-info{display:grid;gap:10px;padding:15px;margin:14px 0;background:#f5f8ff;border:1px solid #dfe8fb;border-radius:10px;overflow-wrap:anywhere}.debug-info code{user-select:all}
  header .header-actions{display:flex;align-items:center;gap:8px;flex:none}header .header-actions form{display:block;width:auto;margin:0}button.restart-icon{width:34px;height:34px;min-height:34px;padding:0;border:1px solid #cbd7ef;border-radius:9px;background:#fff;color:#175cd3}button.restart-icon:hover,button.restart-icon:focus-visible{background:#e8f0ff;border-color:#82a9ed}button.restart-icon svg{display:block}.group-description{margin:0;padding:0 2px 10px;color:#667085;font-size:13px}@media(max-width:620px){header{align-items:flex-start}header .header-actions{gap:6px}button.restart-icon{width:34px}header .state{font-size:12px}}
  </style></head><body>${noticeBar}<div class="shell"><header><h1>DeepSeek Harness · 应用设置</h1><div class="header-actions"><span class="state">${status}</span>${headerRestart}</div></header><nav class="primary" aria-label="设置分类">${primaryNav}</nav><p class="group-description">${group.description}</p><nav class="secondary" aria-label="二级菜单">${secondaryNav}</nav><main class="card">${panels[view]}</main></div>${busyScript}</body></html>`;
}

module.exports = { render, selectedView };
