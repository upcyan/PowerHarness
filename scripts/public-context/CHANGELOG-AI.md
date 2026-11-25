# 公开构建变更摘要

## [0.3.116] — 2026-11-25

- 修复工具调用超时后转后台孤儿的问题。`dsh-tool-bash` 的 `promoteOnTimeout` 默认开着，前台命令到达
  deadline 后不退出，而是被提升成后台任务继续跑，而发起它的调用早已返回，没有 job id 再指向它。
  11 月 24 日实测有两个六小时前由 `trash` 留下的孤儿各占 85% CPU，加起来超过整个 harness。
  `patch-dsh.mjs` 新增 `patchBashTimeoutPolicy`，在 `dsh-base` 层把它钉成 `false`；需要长跑的仍可显式
  `run_in_background`。锚点匹配数必须为 1，上游改了这一行构建就失败，不会静默带着旧默认值发出去。
- core 的 V8 老生代上限改成按工作集算。`supervisor.js` 新增 `coreOldSpaceMiB`，启动时传
  `--max-old-space-size`，取 Node 自身默认（RAM/4，上限 4096）、实测工作集 1900MB×1.6、RAM−2048MB
  三者最小值，下限夹在 512。本机 15.4GB 算出 3040MB，比原来的 4288MB 收紧 29%；2GB 机器是 512，
  16GB 以上是 3040。只收紧不放松，可用 `DSH_CORE_MAX_OLD_SPACE_MB` 覆盖，设 0 则不传。
  起因是 core 常驻 1.9GB 却有 927MB 被换出到 swap，4GB 的默认上限让垃圾在两次 major GC 之间堆太久。
- 备份不再只增不删。两处漏点：`ops.js` 的 `pruneBackups` 里有一行 `if (item.kind === 'uninstall') continue;`，
  卸载保全永不回收，实测积了 20 份 45.4GB，横跨 0.2.0-rc.2 到 0.2.2-rc.5；`upgrade-snapshot.js` 每次升级
  都新开一个 operation 目录却没有清理代码，积了 15 份 34GB。两处都改成保留最近 5 份。排序键取
  `receipt.json` 的 `id`（前缀是 ISO 时间戳），不能取目录名——目录名是随机 UUID，按它排会把 10 月的旧
  备份留下、最新的删掉。删除条件收得很紧：只删名字是 UUID 且带 receipt.json 的普通目录。
  存量清理后 `DSH-Recovery/dsh-fnos` 从 180GB 降到 142GB。
- 备份目录和数据目录在同一块物理盘时给出提示。`install-options.js` 加了 `sameDevice()` 比 `st_dev`，
  首启配置页和改配页都会提示。只提示不阻断，措辞里写明不改也能正常用；提示不进 `check()` 的
  `issues`，不会拦住安装。另外跨 dev 让升级冷备没法用硬链接，实测 62GB 全量复制跑了 32 分钟。
- 诊断页在桌面图标入口下没有返回通道。`gateway.js` 的 `guideLogsPage` 调 `diagnosticsUi.render` 时漏了
  第 5 个参数 `settingsHref`，两个通道一起失效：页面上没有「返回应用设置」链接，渲染出的脚本也变成
  `if (false && …)`，壳页收不到 `postMessage`，顶栏停在「强制刷新 DSH」。直连侧 `logsPage` 一直传了这个
  参数，所以只有桌面图标这一侧坏。现在补上 `gatewayManagePrefix + '/?view=logs'`。
- 插件 URL 放行显示来源插件。清单原先只有 `/bili/*` 这样的路径，看不出是谁在要。插件 `package.json`
  不声明路由（`dsh.bundle` 只有 `["patch"]`），路径名和包名也常对不上：`/bili` 是 billion-context、
  `/permgate` 是 @mrweicodes/dsh-permgate、`/redteam` 是 dsh-purge，按包名匹配 22 条只对得上 12 条。
  改成从运行时取：插件调 `fetch` 时 JS 调用栈里带着它自己的脚本 URL，`plugin-url-compat.js` 取栈里第一个
  `/plugins/<名>/` 随上报发出，服务端按字面量白名单校验后记录，放行时存进 `approvedPlugins`，界面显示
  「来源插件：<名>」。取不到就写「未知」，不编造。改动前放行过的记录没有归属数据，要重新触发一次插件
  请求才补得上。插件内 `setTimeout` 异步发起的调用栈仍保留定义位置，照样能归因；页面内联脚本发起的
  调用栈里没有这个片段，这时留空。

## [0.3.115] — 2026-11-23

- 内置插件几乎全丢。0.3.111、0.3.112、0.3.113 三版 FPK 的 `plugins-bundled/bundled-plugins.json` 里只有
  `@tnnevol/dsh-codex-auth 7.0.1` 一个，而构建机上能打包的有 37 个。原因是 `build-linux.sh` 在没设
  `DSH_BUNDLE_PLUGINS_FROM` 时回退到 `${HOME}/.dsh/profiles/web`，那个目录在构建 shell 里要么不存在、
  要么是只剩 codex-auth 7.0.1 的空壳 profile，于是脚本以成功状态打出一个几乎没有插件的包，全新安装的
  用户拿不到任何恢复插件。这次构建显式传 `DSH_BUNDLE_PLUGINS_FROM` 指向实际 profile，bundle 37 个。
  `build-linux.sh` 的回退逻辑没改。
- 给 `dsh-patch-manager@0.3.3` 补许可证明。它声明 Apache-2.0 但发布的 tgz 里没有 LICENSE 文件，被 SPDX
  门禁一直挡在外面，全新安装拿不到补丁管理器。已在 `fnos/app/third-party-licenses/dsh-patch-manager/LICENSE`
  放入 Apache-2.0 全文，并把 `dsh-patch-manager: 0.3.3` 加进 `scripts/bundle-plugins.py` 的 approved 名单。
  按既定决定仍然不进包的：`dsh-agent-memory`、`dsh-cm-demo`、`dsh-workbuddy-panel`、
  `@vectorize-io/hindsight-coding-agents`，版权风险清单 5 项照旧拒绝。
- 升级前加了一道只读检查。停旧应用之前，以应用身份检查 pnpm 临时目录和回收站是否可读，不可读就退出
  并打印路径，不会自动改属主。启动自检也只报不可读路径和当前进程的有效 UID/GID，不给批量 chown 命令，
  不递归接管数据目录或历史备份。迁移降权用应用专组取 gid，不从 passwd 主组拿（这台机器上 passwd 主组
  写的是 901，实际进程跑在 956）。




这是当前版本的公开源码摘要，不是内部完整历史或现场部署证明。不复述私有设备坐标和凭据，不为满足条目数量补造旧历史。

## [0.3.113] — 2026-11-21

- 修复：浏览器端包写盘前增加真语法校验（`new vm.Script`）。此前补丁脚本只在 Node 侧装饰器做
  `new Function` 检查，浏览器包（`lib/client.js`）完全没有语法门 —— 一次 insert-before 把语句拼进
  对象字面量内部，导致 ui-chat 整包不执行、必需入口失败、全站 "Failed to load plugins"（2026-11-20 事故）。
  现在 patch-dsh 的三处浏览器包写盘点（连接信任、前台恢复、输入区背景）写入前逐个解析，失败即中止构建。

## [0.3.112] — 2026-11-20 · 上游核心 0.2.2-rc.5 + 补丁退役机制

- 改动文件：`PowerHarness/package.json`（dsh 0.2.2-rc.5）、`fnos/app/*`（无）、`dsh-patch-manager/engine.js`+`client.js`（打包内版本）、补丁定义。
- 改动类型：上游核心升级 + 补丁管理器退役（retired）机制 + 选中引用复制补丁重锚。
- 为什么：上游 0.2.2-rc.5（依赖 +dsh-cua-bundle/dsh-deepseek-chat-import、-experimental-agent-team-profile、auto-review 回归）；对话草稿停靠类补丁 4 条功能已被 rc.5 上游内置，继续重放会冲突；引用选中浮层复制按钮补丁在 rc.5 文件重构后锚点失效需重锚。
- 做了什么：核心 pin 升 rc.5（MCP client 保持 2.3.1 overrides）；补丁管理器引擎支持 retired 标记（已退役条目退出可选集不再参与应用/重放）；对话草稿停靠 4 条补丁退役（上游已内置等价）；选中引用复制补丁按 rc.5 新代码结构重锚（复制+长按复制双语提示、剪贴板失败落 execCommand 兜底）；其余 46 条补丁定义原样保留。
- 验证方式：patch-manager 78/78 隔离验收；候选补丁 dry-run 三态验证（retired 退出/新锚对 rc.5 valid/对 rc.1 broken 拒写）；MCP runtime 预打包门 rc.5 布局通过（含嵌套 fallback）。

## [0.3.111] 2026-11-19 · 维护保活防 Bad Gateway + 状态横幅防抖

- **改动文件**：`fnos/app/supervisor.js`、`fnos/app/gateway.js`、`fnos/app/recovery-status.js`、`fnos/app/setup-page.js`。
- **改动类型**：核心重启期间网关维护保活 + 外壳状态横幅瞬时抖动防误报 + 安装向导插件选择沿用。
- **为什么**：核心换镜像/冷启动的窗口期网关端口无人监听，fnOS 桌面直连显示裸 Bad Gateway 造成误解；外壳状态轮询单次 5 秒超时即亮"暂时无法确认核心状态"横幅，反代或网络瞬时抖动会误亮几秒。
- **做了什么**：网关新增维护保持态（503 维护页自动刷新，恢复即放行），核心重启不再停网关，由新镜像启动时按实例归属回收端口（卸载/迁移路径仍保留真实停止）；外壳状态横幅改为连续 2 次失败才显示，一次成功即清零；安装向导提交沿用上次插件选择不再清空；设置页文案"数据目录"改"工作目录"，窄屏勾选行换行布局修正。
- **验证方式**：`node --check` 全通过；维护页 503/恢复 401 行为测试；横幅正控（瞬断不亮、持续失败亮）与负控 Playwright 真浏览器验证。
- **影响面**：桌面直连在核心重启期间看到维护页而非 Bad Gateway；瞬时网络抖动不再误亮状态横幅；安装向导插件选择不再丢失。

## [0.3.110] 2026-11-17 · 启动判死防误杀 + 应用设置页目录改配

- **改动文件**：`fnos/app/supervisor.js`、`fnos/app/directory-reconfigure.js`、`fnos/app/install-migration.js`、`fnos/wizard/config`、`fnos/cmd/config_callback`。
- **改动类型**：启动看门狗 CPU 活性防护 + fnOS「应用设置」页自定义目录改配。
- **为什么**：核心启动被其他任务抢占 CPU 时长时间无输出，空转判据把"推进中"误判为"卡死"杀进程进安全模式；应用设置页此前没有自定义项，目录改配只能进管理控制台。
- **做了什么**：判死前采样 /proc/<pid>/stat 的 utime+stime，CPU 仍在增长即续期不杀（纯睡眠死锁照旧判死，硬上限兜底不变）；新增 wizard/config 数据/备份目录表单，保存回调写请求文件，supervisor 轮询消费，复用与控制台完全一致的迁移事务链（plan/确认/复制/校验/回滚）。
- **验证方式**：`node --check` 全通过；判死判据单测（CPU 增长续期 / 纯睡眠判死 / 硬上限兜底）；目录改配走隔离迁移事务链复核。
- **影响面**：核心启动被 CPU 抢占时不再误杀；数据/备份目录可在应用设置页改配，无需进控制台。

## [0.3.108] 2026-11-16 · 状态条去重 + 启动页宿主接管 + 迁移确认机制

- **改动文件**：`fnos/app/shell-recovery.js`、`fnos/app/management-page.js`、`fnos/app/unavailable-page.js`、`fnos/app/install-migration.js`。
- **改动类型**：控制台状态条双层去重 + unavailable 页宿主接管握手 + management 页宿主握手 + 安装迁移确认。
- **为什么**：外壳 #boot-status 与 iframe 内 unavailable/控制台各自的状态卡同屏两份重复；切换控制台时两层 banner 竞争显示。
- **做了什么**：外壳 shell-recovery.js 的 notify 在 view=settings 时主动发 fnos:host-recovery 给 iframe；management-page.js 加宿主握手块（8s 超时内收到 fnos:host-recovery 即隐藏 status-banner）；unavailable-page.js 已有同款握手（0.3.107 引入）；install-migration.js 保留（目标已有时 preserveExisting no-op）。
- **验证方式**：Playwright 探针 status-dedup-20261116/ before+probe 报告 duplicated:false / consoleBanner:null；node --check 全通过；prebuild 12/12。
- **影响面**：starting/safe/maintenance 各模式下单屏只出现一层状态提示；控制台独立打开时状态卡正常显示。
- **遗留**：迁移"非空二次确认后清空复制删除旧数据"的用户交互层未在本包实现（install-migration.js 已有事务框架但 UI 确认按钮待设计）。

## [0.3.107] 2026-11-15 · 控制台非阻断恢复 UI + AI 独立诊断强化 + 补丁管理器 retired 分类 + 启动判据放宽

- **改动文件**：`fnos/app/recovery-status.js`、`fnos/app/unavailable-page.js`、`fnos/app/management-page.js`、`fnos/app/diagnostic-context.js`、`fnos/app/diagnosis-prompt.js`、`fnos/app/supervisor.js`、`plugins-bundled/patch-manager/`。
- **改动类型**：故障恢复 UI 重做（非阻断）+ AI 诊断独立化 + 补丁管理器安全改造 + 启动看门狗判据放宽。
- **为什么**：旧控制台全屏遮罩挡住排障入口、被动轮询反复刷新页面丢工作区；AI 诊断混用会话凭据；补丁面板大量过时定义误报 broken；整机重启后冷缓存首行 115 秒 > 90 秒判死阈值必误判 stall。
- **做了什么**：新增 `recovery-status.js` 常规文档流状态组件（按实例折叠持久化、单飞轮询、pagehide/pageshow 生命周期），unavailable 页改为轮询不再 5 秒重载；management 页被动状态更新不刷新工作区；AI 诊断改走管理网关独立通道（preview-context 只读上下文白名单、默认不附加、发送前确认端点）；diagnostic-context 白名单化（safeState 只出 kind/noOutputSeconds/activeVersion）；diagnosis-prompt 重写为证据优先；patch-manager engine/client 支持 `retired:true`（引擎不选、面板显示已退役、digest 变化使旧审批失效）；supervisor 首试 idle 90s→150s；测试 fixture 28 包对齐 manifest 1.5.0。
- **验证方式**：控制台行为/浏览器验收 77+16 项全过；补丁管理器 78+36+9 项与三份负控全过；`node --check` 9 模块通过；prebuild `node --test` 12/12。
- **影响面**：故障时控制台保持可操作；AI 诊断不再触碰会话凭据；面板过时补丁显示"已退役"；整机重启后启动恢复缩短约 4-6 分钟。
- **遗留**：core 冷缓存启动慢的后端根因不在本包范围；第二实例待单独验证。

## [0.3.97] 2026-10-29 · DSH核心升级至0.2.1-rc.4与补丁脚本适配

- **改动文件**：`package.json`、`scripts/patch-dsh.mjs`。
- **改动类型**：上游核心版本升级与配套补丁脚本适配。
- **为什么**：上游发布 0.2.1-rc.4；client-connection 自该版起改用独立版本线并合并 browser/node 入口为单一 `lib/client.js`，多处相对路由写法重构为等价新形态，旧补丁脚本的严格版本门与锚点断言会误拦新核心。
- **做了什么**：依赖升级并经隔离安装验证；补丁脚本版本门改为同 rc 线校验；九处路由锚点逐个对照 rc.4 产物源码确认语义等价后更新；Iterator 守卫断言改为仅拦裸解引用旧形态、放行带条件检查的安全 polyfill。
- **验证方式**：补丁脚本全流程通过（核心网关补丁、前台载体补丁、九处锚点校验、旧引擎 polyfill 注入）；插件快照哈希留作失败回滚比对。
- **影响面**：仅构建树与候选包；不触生产安装与插件源码；混合版本运行待隔离启动实测。
- **遗留**：候选包隔离启动回归待跑；现场安装需另行授权。

## [0.3.96] 2026-10-21 · 修正已有数据升级的迁移回调

- **改动文件**：`fnos/app/install-migration.js`、`fnos/cmd/install_callback`。
- **改动类型**：升级回调的只读无操作判定及错误诊断保留。
- **为什么**：平台确认在安装后迁移回调失败；正式目录已有真实数据，旧目录留有会话锁，先检查迁移写权限和旧锁会错误拦截无需迁移的升级。
- **做了什么**：可信路径、目录独立及未完成迁移事务检查仍在；仅对明确 preserve-existing 且目标已有真实数据的情况，在迁移授权和冷态检查之前只读返回；实际迁移仍拒绝活动进程、写锁和缺失权限。回调追加阶段摘要，不再覆盖底层错误。
- **验证方式**：规范隔离环境运行9例，包括真实 install_callback、旧会话锁、活动目标、无父目录授权、未知事务拒绝、空目标仍校验、移除修复的变异复现及恢复、原始错误保留；已通过，最终包仍需具名回归和产物验收。
- **影响面**：只改源码及新候选；未停启或修改生产数据，未删除锁，未扩大 ACL，不自动再次安装。
- **遗留**：新候选的真实平台重试仍需用户安排；不提交、不同步、不发布。

## [0.3.96] 2026-10-21 · DSH 0.2.1-rc.2 与新图标安装候选

- **改动文件**：`fnos/ICON.PNG`、`fnos/ICON_256.PNG`、`fnos/app/ui/images/`、`package.json`、`package-lock.json`、`scripts/patch-dsh.mjs`、`scripts/verify-mcp-runtime.mjs`、`fnos/app/upgrade-snapshot.js`。
- **改动类型**：升级准备与安装保护。
- **为什么**：旧候选外层仍为 0.3.95；客户端拆分入口及生命周期签名改变，必须校正版本并绑定最终源码后安装。
- **做了什么**：集成新图标，锁定 DSH 0.2.1-rc.2，保持旧/新入口兼容；将 MCP 固定为已修复跨域重定向泄漏的 2.3.1，验证真实 ABI、同源成功与跨域拒绝及故障注入；升级冷备隔离到单操作目录并显式收紧回执权限，不改用户备份设置。
- **验证方式**：此前构建与隔离测试记录保留；本次重新构建、包内版本/文件校验、隔离启动与安装回调验收后才进入生产安装。
- **影响面**：本条是候选源码记录，不代表生产已升级。
- **遗留**：安装现场验收待执行；不提交、不推送、不发布。

## [0.3.95] 2026-10-16 12:23:56 +0800 · 公开构建上下文输入

- **改动文件**：`scripts/build-context.py`、`scripts/public-context/`、两平台构建入口。
- **改动类型**：公开构建输入与打包边界。
- **为什么**：公开检出不包含被忽略的本地工作笔记，不能依赖个人文档才能打包。
- **做了什么**：为缺失的工作笔记提供公共指南与当前摘要；已有坏输入继续拒绝，私有源不改，打包副本继续清洗。
- **验证方式**：用隔离源码、stage及参考包核对回退、私有优先、坏输入和版本边界；具体结果见构建报告，本摘要不预先宣称通过。
- **影响面**：仅离线构建，不代表设备已升级，不改变用户数据、插件选择或共享服务。
