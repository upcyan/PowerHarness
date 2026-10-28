# 构建 FPK

从源码构建 FPK 的完整说明：依赖、两条构建路径、内置插件打包、图标生成与验收范围。

在 Linux x86_64 构建机安装 Node.js 24、npm、Python 3、支持静态 libc 的 C 编译器和官方 `fnpack`，然后执行：

```sh
bash scripts/build-linux.sh                 # 用 fnos/manifest 里的版本原样打包
bash scripts/build-linux.sh --bump patch    # 打包前把版本自增（patch|minor|major）
bash scripts/build-linux.sh --set 1.0.0     # 指定版本
```

**先通过安全与兼容性检查，再生成 FPK。** Linux 构建在调用 `fnpack` 前强制执行运行时依赖审计（所有等级）与实际 MCP 客户端/DSH 桥接 ABI、OAuth issuer 拒绝/正常授权检查；漏洞、审计网络故障或兼容检查失败立即退出，不生成新 FPK、不推进 manifest。Windows 重打包也重新审计参考包的实际锁文件，并拒绝复用未修复的 MCP 客户端。不能用 `npm ci` 的审计警告或旧包曾通过代替这些门禁。

**版本必须自增，否则 fnOS 会认为不是更新。** 版本只在**打包成功后**才写回 `fnos/manifest`：暂存副本先盖上目标版本（`fnpack` 从那里读取），失败或中断的构建不会推进已记录的版本。两条构建路径（`build-linux.sh` 与 `repack-windows.py --bump`）共用 `scripts/version.py`，不再各写一份自增逻辑——两套实现不一致，正是打包出「应用商店已有版本」的原因。`version.py show|bump|set` 也可单独使用。

## 内置插件

FPK 可以携带可选插件离线资源（`app/plugins-bundled/`），首次安装由用户逐项选择，默认不安装，可全部跳过。构建时从指定的已安装 profile 只读制作副本；不会携带该 profile 的个人配置、凭据或会话。可用 `DSH_BUNDLE_PLUGINS_FROM=<profile 目录>` 指定资源来源。公开分发前还须单独核对各资源的许可证、版权声明和源代码提供义务；可安装或允许本地打包不等于自动允许公开再分发。

**打包的只有插件代码**：按 npm 自己的 `files` 语义（与 `npm pack` 一致）取文件，再按规则过滤。凭证与个人设置（`.credentials.yaml`、`codebuddy-auth.json`、`settings.yaml`、`.env*`、`*.pem`、`id_rsa` 等）、会话与工作区（`sessions/`、`workspace/`）、插件运行时状态（`state.json`、`*.log`、`*.sqlite`）一律不入包；`node_modules/` 也不入，共享依赖由 DSH 运行时与其回退层提供。**换一台机器安装这个 FPK，不会带上任何个人数据。**

安装行为是「**仅首次按明确选择写入**」：只安装首装向导所选资源，全部跳过时不会自动安装。已有安装没有首装选择记录时不补装；已完成的初始化也不会因用户后来删除或替换插件而重装。升级保持既有插件与启用状态。

脚本使用锁定依赖版本安装基础 dsh，应用经过核对的 fnOS 访问适配，并调用 `fnpack build`。输出在 `dist/`；NAS 首次安装不需要下载 npm 依赖。FPK 通过 fnOS 应用商店依赖 `nodejs_v24`，不内置 Node；日后独立更新核心时才从所选 npm 源下载。

Ubuntu WSL2 x86_64 也可作为构建机。将 Linux 版 Node.js 24 加入 `PATH`，再设置 `FNPACK_BIN` 指向 Linux 版 fnpack 后运行上述脚本。构建后可执行 `bash scripts/smoke-linux.sh [包路径]`，从 FPK 解包并检查 dsh、Linux 原生模块、内置 pnpm 版本及 HTTPS 网关启动。

⚠ **不要在有本应用实例运行的机器上直接跑这个脚本**：脚本会启动一份 supervisor，而 supervisor 会把 `/opt/dsh/home` 指向自己的数据目录——在实机上会**改指生产的 DSH 桥接**。临时目录被清理后，生产桥接会变成死链，导致应用进入安全模式。此外脚本固定使用 `3080`，该端口被占用时（例如本机已跑着本应用）会直接失败，请只在专用构建机或隔离环境（独立 mount/网络命名空间）中运行。脚本断言桌面入口页含「控制台」，与 `handleGuide` 现在渲染的内容一致。WSL 中导入 fnOS 根文件系统不能代替 fnOS 安装验收；应用中心依赖、桌面入口和 NAS 文件授权仍需在 fnOS 虚拟机或实机检查。

运行时依赖及原生 CLI 助手源码均未变化时可在 Windows 上直接重打包（助手只复用已校验源码/二进制哈希的 Linux 参考包；缺助手或源码变化必须完整 Linux 构建）：`python scripts/repack-windows.py [--bump patch|minor|major]` 复用参考 FPK（默认 `dist/dsh-fnos.fpk`）中已打好补丁的 Linux runtime，仅从 `fnos/` 重建应用层。脚本会核对 `package.json`、`package-lock.json` 与 `patch-dsh.mjs` 是否与参考 runtime 一致，不一致时报错并要求完整 Linux 构建。此路径不使用 fnpack：FPK 结构（外层 tar.gz 含 `app.tgz`，manifest 追加 `checksum = MD5(app.tgz)`，键对齐 27 列）已逐字节比对官方 fnpack 1.2.3 输出核对。首次构建或依赖更新仍需 Linux/WSL 构建机，因为 runtime 含 linux-x64 预编译原生模块。

应用图标（`fnos/ICON.PNG`、`fnos/ICON_256.PNG`，以及应用内引用的 `fnos/app/ui/images/icon_{64,256}.png`）由 `scripts/create-icons.py` 从 `fnos/app/ui/images/icon-source.png` 生成，需要 Python 3 和 numpy。图标是铺满画布的**白色不透明圆角方块**，圆角半径取边长的 `0.2518`——该常数实测自 fnOS 自带图标（`/usr/trim/www/static/app/icons/` 的 224/272/112 px 三族一致）与第三方 FPK 图标，飞牛不会自行裁剪应用图标，因此圆角必须烘焙进 alpha 通道。**改动图标素材或该脚本后必须重新生成，否则会退回旧的透明底字形样式。** Windows 下用 `scripts/create-icons.ps1`（转发到同一个 Python 脚本，不重复实现绘制逻辑）。

**验收范围**：本应用已在一台 fnOS 实机上通过应用中心安装并运行（应用中心清单、`state.json` 与网关监听均可观察）。但**开发环境的验证不等于生产实测**：插件启停、卸载、备份与恢复的自动化验证都在隔离的 mount/网络/PID 命名空间中、用本地替身核心完成，尚未由真人在实机上按业务流程走一遍。同样需要在各自真实条件下单独确认的还有：手机飞牛 App、点对点、公网与 FN Connect 的连接方式（尤其 WebSocket 与文件上传）、多用户/非管理员访问路径、NAS 目录授权与子目录 ACL 矩阵、以及跨版本升级与回滚的完整演练。架构、安全边界和验收步骤见 [docs/design.md](design.md)。

FPK 与 dsh 核心解耦的目标和后续兼容边界见 [docs/decoupled-runtime.md](decoupled-runtime.md)。
