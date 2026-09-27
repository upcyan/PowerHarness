# DeepSeek Harness for fnOS

将 DeepSeek 官方 **dsh Web UI** 打包为飞牛 fnOS 的 FPK 应用。当前目标为 fnOS x86_64。FPK 随包携带 `@deepseek-ai/dsh@0.1.5-rc.3` 作为首次安装及离线兜底核心；后续 dsh 核心可独立安装到应用私有数据目录，FPK 管理入口保持不变。

## 打开方式

安装并启动后，点击 fnOS 桌面的 DeepSeek Harness 图标。电脑通过 NAS IPv4 登录时使用应用的 `https://NAS_IP:3080` 入口；手机飞牛 App 和主机名入口将 DSH 页面、静态资源、HTTP API 与 WebSocket 通过 fnOS 已认证的应用路径 `/app/dsh-fnos/dsh/` 转发，因此不再要求手机直连 NAS 局域网地址或独立端口。窗口顶部有独立的 **应用设置** 按钮；窗口主体显示完整 dsh Web UI。在 DSH 页面，顶部按钮为 **强制刷新 DSH**；点击后需确认，确认后会以一次性 URL 重新加载 DSH 页面，未保存的输入可能丢失，但不会重启 DSH 核心。进入应用设置后按钮显示 **返回 DSH**，可直接返回。应用设置管理 FPK 的核心更新、备份和安全模式，dsh 自带的 Settings 仍用于模型等 dsh 配置。两种入口都使用一次性进入凭据。局域网独立 HTTPS 入口第一次打开时仍需接受应用生成的本机证书。随后在 **Settings → Models** 设置 DeepSeek API Key，并选择工作区。fnOS 点对点、公网和 FN Connect 的最终可用性需要在对应的真实连接方式下验证，尤其是 WebSocket 和文件上传。

Web UI 的命令和文件操作在 NAS 上以应用专用用户身份执行。初始工作区位于应用私有数据目录。要访问其他 NAS 文件夹，请到 fnOS 应用中心找到 DeepSeek Harness，在访问权限中授权目录并重新启动应用。应用设置的 **数据与安全 → 目录权限** 显示授权根目录的基础权限；可读取的目录会在工作区的 **fnOS 授权目录** 中出现快捷入口。快捷入口不会把外部目录内容复制进应用备份，访问仍受 fnOS 目录权限控制。子目录可能有单独的 ACL；如果选择 DSH 工作区时遇到 `EACCES`，在目录权限页输入完整工作区路径，点 **检测实际写入权限**。检测会创建并立即删除一个临时空目录，以确认该位置能否用于 DSH 工作区。若写入被拒绝，需要在 fnOS 中为应用授予目标目录读写权限并检查该子目录的 ACL。

**数据与安全 → 容器权限** 可检查应用用户的 Rootless Docker 安装条件及专属 Socket。NAS 管理员完成 Rootless 守护进程安装并使其运行后，设置页会验证 Socket 归属和守护进程的 Rootless 标志，再允许切换 DSH 使用的 `DOCKER_HOST`。FPK 不会安装 Docker 或自动修改用户组；若应用用户仍在系统 `docker` 组，DSH 仍可访问高权限 Docker Socket，需由管理员移出该组并重启应用。Rootless Docker 也不等同于文件目录白名单。

## 管理、备份与故障恢复

点击 fnOS 窗口顶部的 **应用设置** 可打开管理页。一级分类和二级菜单分别组织版本、npm 源、插件、配置档、备份、运行控制与诊断。操作提示固定在页面顶部，提交期间按钮沿边缘显示光点，完成后停止。页面提供 npm 官方源、npmmirror、腾讯云和华为云快捷切换，也可填写可信的 HTTPS 源；可检查、安装并切换已安装的 dsh 版本。dsh 配置档可从官方 Web 模板新建并切换，切换前自动备份。**插件管理**可安装、禁用、启用、卸载并清理当前配置档的额外插件，安全模式下仍可禁用或卸载冲突插件。安装接受 npm 包名或固定版本，要求声明 dsh bundle 和 SHA-512 摘要，以禁用安装脚本、严格检查 Node 和依赖兼容的方式安装，并用 npm 漏洞公告拒绝高危或严重漏洞。检查不可用、安装失败或启动失败时恢复旧配置；若插件与现有加载项冲突，页面会显示冲突 ID。上述检查无法证明插件运行时代码安全，只应安装可信发布者的插件。FPK 内置私有 `pnpm`，供 DSH 的插件市场使用，无需改动应用商店 Node 安装目录。所选 npm 源也会传给 dsh 进程，供其自身的插件管理使用；更改源后需重启 dsh 才会传给现有核心。

远程入口为 DSH 插件提供同一个 `/app/dsh-fnos/dsh/` 路由前缀。FPK 会直接改写内置 DSH 路径；遇到第三方插件使用未知根路径时，先记录路径并阻止该次请求，在 **应用设置 → 核心与扩展 → 插件 URL 放行** 显示候选项。管理员确认路径属于可信插件后点击“放行”，再强制刷新 DSH；放行仅使该路径及其子路径的浏览器 URL 自动改写到 DSH 网关，不授予文件、系统或插件执行权限。检测覆盖 HTML 根路径资源、DSH 动态插入的脚本及样式表、同源根路径 `fetch`、XHR、WebSocket、EventSource、Worker、Beacon 和普通链接点击；动态模块导入、CSS 内的绝对路径及直接修改 `location` 等行为不能保证被检测或兼容。插件仍应优先使用相对 URL 或 `globalThis.__FNOS_GATEWAY_PREFIX__`。FPK 不会接管 fnOS 根路径，因为这会与飞牛自身接口冲突。安装检查也不能证明第三方插件与当前 DSH 核心版本兼容；若插件持续显示加载中，请先检查 DSH 核心日志中的缺失服务或依赖错误。该入口只允许 fnOS 管理员访问，因此供 GitHub 等外部服务主动调用的 webhook 不能直接借用这条路径；此类路由需要单独配置、严格限定路径并验证请求签名。插件代码与应用设置在同一个 fnOS 来源下运行，因此只安装可信插件。

插件前端可用 `fetch(new URL('dsh-example/ping', document.baseURI), { method: 'POST', ... })` 构造同源请求：局域网独立入口会指向 `/dsh-example/ping`，fnOS 远程入口会指向 `/app/dsh-fnos/dsh/dsh-example/ping`。不要在会修改状态的接口上以 GET 查询参数代替 POST。排查 4xx 时，**应用网关**日志会记录 `route`（`public` 或 `gateway`）、实际 `upstreamPort`、插件路由名和路径 SHA-256 前 16 位；日志不记录完整 URL、查询参数或 Cookie。可计算请求 pathname（不含查询参数）的 SHA-256 与 `pathHash` 对照，确认浏览器请求与上游错误是否为同一路径。

管理页的 **诊断日志** 以 **应用网关 / 应用运行 / DSH 核心** 横向标签切换，每类可直接查看、复制或下载最近日志。页面最新记录在上，DSH 核心保留同次运行中的堆栈顺序；下载保持原始顺序。日志里的 `Z` 时间是 UTC，北京时间需加 8 小时。日志自动轮转；页面和下载的 DSH 核心日志会遮盖常见令牌、Cookie 与 API Key，但不能保证识别所有敏感内容，分享前仍需检查。原始 `dsh.log` 留在应用私有目录，不经管理页提供。手机飞牛 App 打开窗口时会自动记录一次浏览器来源与设备类别；若之后出现嵌入错误，可在窗口顶栏点 **记录诊断** 再点 **诊断日志**。日志也会自动记录网关拒绝事件；无需先加载 dsh HTTPS 页面或下载文件。诊断提交与日志查看都使用 fnOS 已认证的同源入口，随机诊断密钥单次有效；不记录浏览器完整地址、Cookie 或一次性票据。若手机页面来源不可读取，日志中可能显示 `null`。WebView 阻止 iframe 时，页面脚本未必能读取具体错误码。手机 WebView 表单来源为 `null` 时，FPK 管理操作仍要求 HTTPS 会话和表单防伪令牌。

**诊断 → 网络调试** 可手动开启一个临时 HTTPS 端口，默认只读 15 分钟，有效期可选 1–60 分钟。页面生成随机端口和 256 位 Token，并提供复制连接信息按钮。调试者向 `/snapshot` 发带 `Authorization: Bearer <Token>` 的 GET 请求，可读取应用状态与遮盖后的三类日志。只读模式不接受指令。

管理员可以显式切换到**指令模式**；每次开启或切换都会更换端口和 Token。指令接口为带 Bearer Token 的 JSON `POST /command`，只接受 `probe-plugin-route`（限定 `/dsh-插件名/ping` 或 `/summary`，固定向本机 DSH 发送无凭据 POST）、`check-update`、`retry`、`backup`、`safe-mode`、`disable-plugin`、`enable-plugin`。例如 `{"action":"probe-plugin-route","path":"/dsh-example/ping"}`。插件路由探测仅返回状态码、内容类型和响应字节数，不返回正文。插件启停另需 `packageName` 字段，且只能指定当前配置档中已安装的包。任意 Shell、软件安装、卸载和备份恢复都不经临时端口开放。

到期、手动关闭或应用重启后，端口及 Token 失效；已经发起的 FPK 操作可能继续完成。首次连接临时端口可能需要信任应用的本机 HTTPS 证书；NAS 防火墙也必须允许所显示的端口。Token 持有者在指令模式下可重启或停止 DSH、操作备份及插件，请只向可信调试者提供，使用完立即关闭。

备份与回滚只替换应用私有目录内的 DSH 配置和数据。fnOS 管理的 `/vol1/@appconf` 不属于 DSH 数据；旧备份即使包含该目录，也不会在恢复时写入它。

核心更新先安装到独立版本目录，再停止旧核心、备份数据并试运行新核心。启动、浏览器登录或 Web 页面检查失败时恢复数据并重启旧核心；成功后记住新版本，重启 NAS 仍使用它。上游大改导致当前适配补丁无法应用时会拒绝升级。当前更新直接从管理员选定的 npm 源安装，尚未实现设计稿中的签名发布包与完整插件兼容测试。

应用默认每天 03:00 暂停 dsh，备份其设置、会话、私有工作区及 fnOS 配置后重新启动。可设置为仅内容有改动时做每日备份，或只在更新、切换前做自动备份。每日、手动和更新前备份的保留数量分别可设为 **1–30、1–30、1–10**，默认 **7、3、2**。更新前的回滚备份始终执行。备份在应用私有数据目录中，卸载并清除应用数据或 NAS 磁盘故障会同时丢失备份，重要数据仍需使用 NAS 的独立备份方案。

新版 dsh 首次启动失败时，应用恢复升级前数据并尝试启动上一版可用核心。若回滚也失败，或运行中的 dsh 意外停止，应用进入安全模式：保留管理入口，停止 dsh 文件与命令操作，等待管理员查看状态、恢复备份或重试。恢复备份会覆盖当前设置和私有工作区。

## 构建 FPK

在 Linux x86_64 构建机安装 Node.js 24、npm 和官方 `fnpack` 1.2.3，然后执行：

```sh
bash scripts/build-linux.sh
```

脚本使用锁定依赖版本安装基础 dsh，应用经过核对的 fnOS 访问适配，并调用 `fnpack build`。输出在 `dist/`；NAS 首次安装不需要下载 npm 依赖。FPK 通过 fnOS 应用商店依赖 `nodejs_v24`，不内置 Node；日后独立更新核心时才从所选 npm 源下载。

Ubuntu WSL2 x86_64 也可作为构建机。将 Linux 版 Node.js 24 加入 `PATH`，再设置 `FNPACK_BIN` 指向 Linux 版 fnpack 后运行上述脚本。构建后可执行 `bash scripts/smoke-linux.sh`，从 FPK 解包并检查 dsh、Linux 原生模块及 HTTPS 网关启动。WSL 中导入 fnOS 根文件系统不能代替 fnOS 安装验收；应用中心依赖、桌面入口和 NAS 文件授权仍需在 fnOS 虚拟机或实机检查。

依赖未变化时可在 Windows 上直接重打包：`python scripts/repack-windows.py` 复用参考 FPK（默认 `dist/dsh-fnos.fpk`）中已打好补丁的 Linux runtime，仅从 `fnos/` 重建应用层。脚本会核对 `package.json`、`package-lock.json` 与 `patch-dsh.mjs` 是否与参考 runtime 一致，不一致时报错并要求完整 Linux 构建。此路径不使用 fnpack：FPK 结构（外层 tar.gz 含 `app.tgz`，manifest 追加 `checksum = MD5(app.tgz)`，键对齐 27 列）已逐字节比对官方 fnpack 1.2.3 输出核对。首次构建或依赖更新仍需 Linux/WSL 构建机，因为 runtime 含 linux-x64 预编译原生模块。

**当前仓库尚未在 fnOS 实机完成安装验证。** 架构、安全边界和验收步骤见 [docs/design.md](docs/design.md)。

FPK 与 dsh 核心解耦的目标和后续兼容边界见 [docs/decoupled-runtime.md](docs/decoupled-runtime.md)。
