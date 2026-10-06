// 管理页 action 的**唯一定义处**（0.3.62）。
//
// ── 为什么需要它 ──
// 一条 action 要穿过三道门才生效：
//   ① management-page.js 渲染按钮（发出去）
//   ② gateway.js  白名单（转发给 supervisor；不认则 400 Unknown action）
//   ③ supervisor.js 白名单 + 分支（真正执行；不认则静默 return）
// 这三份名单原本是**手工维护的三份拷贝**，实测漏改两次：
//   · restart-all       —— supervisor 与页面都加了，漏了 gateway
//                          → 用户点「完全重启整个程序」直接"重启失败"
//   · snapshot-sessions —— 页面有按钮、supervisor 有实现，gateway 却拒收
//                          → 「检查并立即快照」一点就 400
// 现在把名单集中在这里，两侧都从这里取，漏改在结构上不可能发生。
//
// ── 信任模型（重要）──
// 这份名单**不是安全边界**，只是"拒绝拼错的 action 名"的防呆开关：
// 它在鉴权（x-trim-isadmin / CSRF 会话）**之后**才生效，能通过鉴权的人
// 本来就拥有管理页的全部能力。真正的破坏性护栏是 DESTRUCTIVE 里的二次确认。

// supervisor 能执行的 action（也是 gateway 应转发的集合）。
const SUPERVISOR_ACTIONS = [
  'backup', 'restore', 'retry', 'safe-mode', 'check-update',
  'install-core', 'switch-core', 'use-bundled',
  'set-registry', 'set-backup-settings', 'set-docker-mode', 'set-core-port', 'set-public-port',
  'create-profile', 'switch-profile',
  'install-plugin', 'disable-plugin', 'enable-plugin', 'uninstall-plugin',
  'confirm-restore', 'dismiss-restore',
  'save-patch-config', 'disable-patch-config', 'restore-patch-config',
  'heal-patch-layer', 'dedupe-patch-layer', 'disable-third-party-plugins',
  'repair-plugin-files', 'repair-plugin-wiring', 'sync-module-resolution', 'restore-exemptions',
  'snapshot-sessions', 'restart-all',
  'run-terminal-command', 'enter-diagnosis', 'exit-diagnosis'
];

// gateway 自己处理、不需要 supervisor 参与的 action。
const GATEWAY_ACTIONS = [
  'probe-workspace',
  'start-network-debug', 'stop-network-debug',
  'allow-plugin-path', 'dismiss-plugin-path', 'revoke-plugin-path'
];

// 高破坏性操作：会在弹窗里显式列出"将执行什么"，并要求用户确认。
// 键是 action，值是要在确认框里写的具体后果。
const DESTRUCTIVE = {
  'restart-all': '完全重启整个程序：核心、网关与管理页会一起重启，页面短暂断连（约 20–90 秒）。',
  'heal-patch-layer': '重置 patch 配置：cordis.patch.yml 里的插件启用/禁用与插入声明会被清空（插件本体不受影响）。原文件会先备份到 patch-backups。',
  'dedupe-patch-layer': '清理重复声明：cordis.patch.yml 里同一 id 的重复条目会被删除，只保留第一份。',
  'disable-third-party-plugins': '禁用全部第三方插件：它们的 loader 条目会被置为 disabled，插件文件保留。',
  'disable-patch-config': '禁用 patch 配置：整个用户 patch 层将不再生效，DSH 回到 bundle 默认配置。',
  'restore': '恢复备份：DSH 的设置、会话与私有工作区会被快照内容**替换**，此后的改动将丢失。',
  'confirm-restore': '恢复备份：DSH 的设置、会话与私有工作区会被快照内容**替换**，此后的改动将丢失。',
  'restart': '重启 DSH 核心：当前会话会暂时断开，正在进行的对话与任务会被中断。',
  'run-terminal-command': '在服务器上执行命令：以应用身份运行，可读写应用数据目录。'
};

const supervisorSet = new Set(SUPERVISOR_ACTIONS);
const gatewaySet = new Set(GATEWAY_ACTIONS);
const allSet = new Set([...SUPERVISOR_ACTIONS, ...GATEWAY_ACTIONS]);

/** supervisor 是否应处理该 action。 */
function isSupervisorAction(action) { return supervisorSet.has(action); }
/** gateway 是否应转发/处理该 action。 */
function isGatewayAction(action) { return allSet.has(action); }
/** 该 action 是否属于高破坏性操作（需要二次确认）。 */
function isDestructive(action) { return Object.hasOwn(DESTRUCTIVE, action); }
/** 高破坏性操作的后果说明（用于确认框）。 */
function destructiveNotice(action) { return DESTRUCTIVE[action] || ''; }

module.exports = {
  SUPERVISOR_ACTIONS, GATEWAY_ACTIONS, DESTRUCTIVE,
  isSupervisorAction, isGatewayAction, isDestructive, destructiveNotice
};
