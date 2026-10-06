/**
 * DSH legacy-engine compatibility shim.
 *
 * DeepSeek Harness targets a modern Chromium (126+). The fnOS desktop entry is
 * commonly opened inside QAX Trusted Browser / older enterprise browsers that
 * are frozen on Chromium 107 (Nov 2022), which lacks several runtime APIs the
 * DSH client bundles call directly:
 *
 *   AbortSignal.any                     Chromium 116
 *   Promise.withResolvers               Chromium 119
 *   Promise.try                         Chromium 128
 *   Array.fromAsync                     Chromium 121
 *   URL.parse                           Chromium 126
 *   Iterator (+ iterator helpers)       Chromium 122
 *   Array.prototype.toSorted/...        Chromium 110
 *   Object.groupBy / Map.groupBy        Chromium 117
 *   Symbol.dispose / asyncDispose / metadata
 *   ReadableStream async iteration      Chromium 124
 *
 * The shim is injected into the served index.html <head> as a classic script so
 * it always executes before the deferred module bundle. Modern browsers are
 * untouched: every block is guarded by a feature check.
 */
(function () {
  "use strict";
  var g = typeof globalThis !== "undefined" ? globalThis : self;
  function define(target, key, value) {
    Object.defineProperty(target, key, { value: value, writable: true, configurable: true });
  }

  /* --- Composer fix: the "floating input box" bug ---
   *
   * The conversation shell paints the composer seat with a single declaration:
   *   background: linear-gradient(180deg,
   *     color-mix(in srgb, var(--dsw-alias-bg-base) 0%, transparent) 0px,
   *     var(--dsw-alias-bg-base) 36px)
   * Chromium < 111 cannot parse color-mix(), so the WHOLE declaration is DROPPED
   * (not degraded to transparent) and the seat ends up with no background at
   * all. Because that seat is position:absolute/sticky and overlays the
   * scrolling view, every row that passes behind it - and behind the toolbar and
   * the token/status footer - stays fully visible, so text interleaves with the
   * input box. That is the bug.
   *
   * Two layers, both unconditional (no feature sniffing, no ordering luck), the
   * whole file is regenerated from fix_dock.css by build_shim.py:
   *   A) the seat is never transparent again — every engine, every view;
   *   B) in views where the shell itself opts into "overlay" mode (the
   *      trajectory view marks itself with [data-conversation-composer-overlay]),
   *      the composer is turned back into a real docked bar: the outer scroller
   *      stops scrolling, the view area scrolls instead, and the seat takes its
   *      own row at the bottom. Structurally impossible to overlap.
   *      Views WITHOUT that marker (chat, usage, landing) are left alone on
   *      purpose: their scroll logic hangs off [data-conversation-scroll]
   *      (chat literally calls closest("[data-conversation-scroll]")), so
   *      restructuring the shell there would break auto-scroll.
   */
  if (typeof document !== "undefined" && document.createElement) {
    var composerFixStyle = document.createElement("style");
    composerFixStyle.setAttribute("data-dsh-legacy-css", "composer-dock");
    composerFixStyle.textContent = [
      /* BEGIN composer-dock-rules */
      "[data-composer-seat]{ background: var(--dsw-alias-bg-base, #ffffff) !important; box-shadow: 0 -18px 16px -10px var(--dsw-alias-bg-base, #ffffff) !important;}",
      "[data-conversation-scroll]:has([data-conversation-composer-overlay]){ overflow:hidden !important; --dsh-composer-height:0px !important;}",
      "[data-conversation-scroll]:has([data-conversation-composer-overlay]) > [data-slot=\"conversation.session\"]{ display:flex !important; flex-direction:column !important; flex:1 1 0% !important; min-height:0 !important;}",
      "[data-conversation-scroll]:has([data-conversation-composer-overlay]) > [data-slot=\"conversation.session\"] > *{ flex:1 1 0% !important; min-height:0 !important; overflow-y:auto !important; overflow-x:hidden !important;}",
      "[data-conversation-scroll]:has([data-conversation-composer-overlay]) > [data-composer-seat]{ position:relative !important; top:auto !important; bottom:auto !important; left:auto !important; right:auto !important; flex:none !important; z-index:7 !important;}",
      "[data-conversation-scroll]:has([data-conversation-composer-overlay]) [class$=\"_ledger\"]{ --dsh-trajectory-bottom-clearance:0px !important;}",
      "[data-conversation-scroll]:has([data-conversation-composer-overlay]) [class*=\"_tablePane\"], [data-conversation-scroll]:has([data-conversation-composer-overlay]) [class*=\"_detailBody\"]{ padding-bottom:0 !important;}"
      /* END composer-dock-rules */
    ].join("\n");
    (document.head || document.documentElement).appendChild(composerFixStyle);
  }

  /* --- Mobile / touch supplement (mobile.css) ---
   *
   * The dsh-web-mobile-cyanmod plugin already owns: composer toolbar wrapping and
   * touch sizing, header title room, turn rail + capsule, safe areas, full-screen
   * settings panel, sidebar drawer, tap-outside-to-collapse, auto-hiding tips.
   * It deliberately does NOT touch: the view tabs, the token/status footer, the
   * sidebar utility buttons, the trajectory filter row, the small controls inside
   * the settings panel, the table container, or the desktop-only resize handles.
   * This block fills exactly those gaps.
   *
   * Same 700px breakpoint as cyanmod so nothing falls into a gap between the two;
   * desktop (>=701px) is a no-op. Generated from mobile.css by build_mobile.py —
   * edit the CSS, not this block.
   */
  if (typeof document !== "undefined" && document.createElement) {
    var mobileStyle = document.createElement("style");
    mobileStyle.setAttribute("data-dsh-legacy-css", "mobile");
    mobileStyle.textContent = [
      /* BEGIN mobile-rules */
      "/* ============================================================================\n * DSH 窄屏 / 触摸补充补丁（v2）\n *\n * 定位：这是 dsh-web-mobile-cyanmod 的**补充层**，不是替代品。\n *   cyanmod 已经处理：输入区工具行换行 + 触控放大、顶栏标题让位、时间轴/轮次\n *   导航、安全区、设置面板全屏、侧栏抽屉、点击外部收起、tips 自动隐藏。\n *   它没碰：视图切换 tab、底部状态栏、侧栏工具按钮、轨迹筛选行、设置页各处\n *   小控件、表格容器、桌面专用件。← 本文件只补这些。\n *\n * 两条硬约束：\n *   1) 不与 cyanmod 抢同一批元素。它刻意压小顶栏按钮是为了给标题让宽度\n *      （README：标题 128px → 180px），所以顶栏**只扩热区、不改视觉尺寸**。\n *   2) 一律用 [class*=\"…\"] 匹配（宿主 CSS Module 的哈希段会随版本变）。\n *\n * 断点与 cyanmod 保持一致（700px），避免落在两者之间的夹缝里。\n * ========================================================================= */\n\n@media (max-width: 700px) {\n\n  /* ---------------------------------------------------------------------- *\n   * 0) 桌面专用件\n   *    wSkVaW_widthHandle：侧栏拖宽手柄，桌面用。窄屏没有意义，\n   *    而且它左右各向视口外伸出一大截（实测 -559px / +169px）。\n   * ---------------------------------------------------------------------- */\n  [class*=\"wSkVaW_widthHandle\"] { display: none !important; }\n\n\n  /* ---------------------------------------------------------------------- *\n   * 1) 视图切换 tab（对话 / 轨迹 / CodeBuddy 用量）\n   *    产品原生 26×25px —— 用手指点非常勉强。tab 行本来就有富余高度。\n   *    ⚠ 光给 min-height 只会长高不长宽（\"对话\"两个字就 26px），横向也要加\n   *    padding 才够 44：26 + 10*2 = 46。\n   * ---------------------------------------------------------------------- */\n  [class*=\"wSkVaW_tab\"] {\n    min-height: 44px !important;\n    padding: 0 10px !important;\n  }\n\n\n  /* ---------------------------------------------------------------------- *\n   * 2) 顶栏图标按钮 —— 刻意不动，这是唯一有意\"欠适配\"的地方\n   *\n   * cyanmod 把标题行 height 钉死在 32px，三个子块（headerActions /\n   * headerUtilities / headerCorner）钉死在 28px + `overflow:hidden`。\n   * 伪元素扩热区会被 overflow:hidden 整条裁掉（实测：伪元素几何算出来\n   * 38×46 完全正确，但 elementsFromPoint 在按钮外 6px 处命中父级），\n   * 想放开 overflow 就得用 (0,2,2) 以上的特异性去推翻它钉死的高度。\n   *\n   * 而它的注释里写明了这是用户的要求：\n   *   「用户 09-27 第三轮反馈：标题栏因为文字换行都拉高了，不是说了除了\n   *     标题文字，其他精简成符号和数字吗？怎么还有文字」\n   * 所以顶栏紧凑优先于触摸目标，这里保持原样。真要动，得先问用户。\n   * ---------------------------------------------------------------------- */\n\n\n  /* ---------------------------------------------------------------------- *\n   * 3) 侧栏抽屉里的工具按钮（搜索 / 视图选项 / 添加工作区）\n   *\n   * ⚠⚠ 这一处踩过大坑，改之前务必读完：\n   *   产品把这一行做成了「点搜索 → 变搜索框」的折叠动画，靠 **max-width 过渡**\n   *   实现，折叠态的预算是 searchSlot 28px + headerActions 60px —— 三个按钮\n   *   实际只分到 ~29px 宽。直接给按钮加 min-width:40px 会撑破这两个容器：\n   *   headerActions 是 `max-width:60px` **且 overflow:hidden**，第二个按钮被裁到\n   *   只剩 16px（实测按钮 rect 252…292，容器却在 268 就裁掉；侧栏可视宽度只有\n   *   280px，所以视觉上\"第三个图标缺一半\"）。这是线上真实出现过的回归。\n   *\n   *   两态是用**类名**区分的（不是内联样式、也不是祖先状态类）：\n   *     折叠：.bhn1Oq_searchSlot            / .bhn1Oq_headerActions\n   *     展开：.bhn1Oq_searchSlotExpanded    / .bhn1Oq_headerActionsHidden\n   *   所以要放大**只能在折叠态**，用 :not() 主动让位，展开态交还给产品。\n   *   （试过 `:focus-within`：展开确实由 focus 触发，但用类名更稳。）\n   *\n   *   折叠态预算重算：44 + 4 + (44+4+44) = 140px，行内容宽 252px（260 - 8 padding），\n   *   标签\"工作区\"42px ⇒ 42 + 140 = 182 ≤ 252，靠 searchSlot 的 margin-left:auto\n   *   吸收富余，右对齐不变；最后一个按钮右边界 268 < 侧栏可视 280，不裁切。\n   *   实测展开态几何与产品原样**完全一致**（搜索框 53…237 / 184px 宽），动画无损。\n   * ---------------------------------------------------------------------- */\n  [class*=\"bhn1Oq_sectionHeader\"] {\n    min-height: 44px !important;\n  }\n  [class*=\"bhn1Oq_searchSlot\"]:not([class*=\"bhn1Oq_searchSlotExpanded\"]) {\n    max-width: 44px !important;\n  }\n  [class*=\"bhn1Oq_headerActions\"]:not([class*=\"bhn1Oq_headerActionsHidden\"]) {\n    max-width: 92px !important;\n  }\n  [class*=\"bhn1Oq_searchSlot\"]:not([class*=\"bhn1Oq_searchSlotExpanded\"]) [class*=\"bhn1Oq_searchButton\"],\n  [class*=\"bhn1Oq_headerActions\"]:not([class*=\"bhn1Oq_headerActionsHidden\"]) [class*=\"bhn1Oq_iconButton\"] {\n    min-width: 44px !important;\n    min-height: 44px !important;\n  }\n  /* ⚠⚠ 折叠态的搜索按钮虽然已经是 44×44，但**实际点不到 44 高**：\n   *   它的父容器 .bhn1Oq_search 被产品钉死 height:28px 且 overflow:hidden，\n   *   实测按钮 rect 128,128 44x44 而父容器 128,136 44x28 ⇒ 上下各被裁 8px，\n   *   有效命中区只剩 44×28。这是\"规则写了但没生效\"的隐蔽失败 ——\n   *   只看 rect 会以为已经到位，必须算「被最近可剪裁祖先裁掉多少」。\n   *   把父容器一起抬到 44 即可：它的祖父 .bhn1Oq_sectionHeader 正好 44 高，\n   *   44 能完整容下，不会再被裁一层。\n   *   （同行的 .bhn1Oq_headerActions 高度是 auto，两个 44×44 图标按钮实测\n   *     clip=0/0，所以不需要类似处理。） */\n  [class*=\"bhn1Oq_searchSlot\"]:not([class*=\"bhn1Oq_searchSlotExpanded\"]) div[class*=\"bhn1Oq_search\"] {\n    min-height: 44px !important;\n  }\n  /* 侧栏「新会话」大按钮：252×38 —> 44\n   * ⚠ 必须排除 newSessionLabel：它含子串 `hHd-Xa_newSession`，会被一起命中，\n   *   而它是按钮的**子节点**（span）。按钮是 box-sizing:border-box + padding:8px 16px，\n   *   内含盒只有 28px 高；把 label 也抬到 44 后它顶出内含盒 —— 实测按钮\n   *   scrollHeight 由 37 涨到 51（over 9）。这是「[class*=] 子串误伤子节点」\n   *   的典型，和 cyanmod 的 `_titleRow` 是同一类坑。 */\n  [class*=\"hHd-Xa_newSession\"]:not([class*=\"newSessionLabel\"]) {\n    min-height: 44px !important;\n  }\n  /* 侧栏头部品牌 / 新建会话行：216×24 —> 36 */\n  [class*=\"hHd-Xa_brand\"] {\n    min-height: 36px !important;\n  }\n  /* 侧栏底部的「设置」入口：260×42 —> 44 */\n  [class*=\"VOzbGW_trigger\"] {\n    min-height: 44px !important;\n  }\n  /* 设置面板里的 semi-design 小按钮：产品 size-small 是 24 高（含\n   * .semi-button-with-icon-only 的 24×24），实测渲染 36 高。\n   * 这是**所有插件**在设置页里的通用按钮尺寸（CodeBuddy 的「管理面板 /\n   * 添加账号 / 换客户端登录」、插件市场的操作按钮、Token Saver 等），\n   * 所以在这里统一抬到 44 触摸高。\n   * min-height 会压过 height 的定值；纯图标按钮的宽是 width:24px 定的，\n   * 得单独补 min-width，否则只会长高不长宽。 */\n  .semi-button-size-small {\n    min-height: 44px !important;\n  }\n  .semi-button.semi-button-with-icon-only.semi-button-size-small {\n    min-width: 44px !important;\n  }\n\n\n  /* ---------------------------------------------------------------------- *\n   * 4) 底部状态栏的两个胶囊\n   *\n   * 问题：窄屏下一行放不下，产品把文字 ellipsis 掉 ——\n   *   \"6 轮 23 步 · 78 tok/s\" → \"6 轮 23 步 · 7…\"\n   *   \"370K tok · 缓存命中 90%\" → \"370K tok · 缓存…\"\n   * 实测截断发生在 bOPqQW_label（text-overflow:ellipsis + white-space:nowrap），\n   * 而它的宽度被 bOPqQW_pill / bOPqQW_anchor 压着（128px）。\n   * 放开宽度 + 让行容器换行 ⇒ 两枚各占一行、文字完整（实测 155px / 182px）。\n   * ⚠ height 必须一起放开，否则换行出来的第二枚会被容器高度裁掉。\n   * ---------------------------------------------------------------------- */\n  [class*=\"bOPqQW_root\"],\n  [class*=\"bOPqQW_anchor\"] {\n    flex-wrap: wrap !important;\n    row-gap: 4px !important;\n    height: auto !important;\n  }\n  [class*=\"bOPqQW_anchor\"],\n  [class*=\"bOPqQW_pill\"] {\n    flex: 0 0 auto !important;\n    max-width: 100% !important;\n  }\n  [class*=\"bOPqQW_label\"] {\n    text-overflow: clip !important;\n    overflow: visible !important;\n  }\n\n  /* 「回到底部」悬浮按钮 34×34 */\n  [class*=\"EvIC1a_toBottom\"] {\n    min-width: 44px !important;\n    min-height: 44px !important;\n  }\n\n\n  /* ---------------------------------------------------------------------- *\n   * 5) 轨迹页筛选行（时长 / 轮次 / 调用 / 搜索框）\n   *    产品控件 20 高 / 搜索框 18 高。\n   *\n   * ⚠⚠ 光把控件抬到 36 是**不够**的，会换来一类更隐蔽的问题：\n   *   行容器 .fV0t5q_root 被产品钉死 height:32px/.fV0t5q_inner 31px，\n   *   控件抬到 36 后上下各顶出 ~2px，并被最外层 .qBU-ya_root{overflow:hidden}\n   *   裁掉；搜索框那层更窄 —— .fV0t5q_search 只有 22px，里面的 input 抬到 36\n   *   后顶出 7px（实测 over 7），虽然它自己 overflow:visible 不会裁，\n   *   但会压到相邻行。\n   *   实测（只抬控件、不抬容器）：root 32/over 3、inner 31/over 3、search 22/over 7。\n   *   所以容器必须跟着一起抬。 */\n  [class*=\"fV0t5q_root\"],\n  [class*=\"fV0t5q_inner\"] {\n    min-height: 40px !important;\n  }\n  [class*=\"fV0t5q_search\"] {\n    min-height: 36px !important;\n  }\n  /* ⚠ 排除 actionIcon / toggleIcon：它们是按钮的**子元素**（span），含子串\n   *   `fV0t5q_action` / `fV0t5q_toggle`，会被一起抬成 36px 高（实测 span\n   *   14×36）。图标居中所以暂时看不出视觉问题，但这是「子串选择器误伤\n   *   子节点」的同一类坑，与 §3 的 newSessionLabel 同源，这里先收紧。 */\n  [class*=\"fV0t5q_toggle\"]:not([class*=\"toggleIcon\"]),\n  [class*=\"fV0t5q_action\"]:not([class*=\"actionIcon\"]),\n  [class*=\"fV0t5q_searchInput\"] {\n    min-height: 36px !important;\n  }\n\n  /* 输入区上方的「工作目录」「权限模式」选择器：产品 28 高。\n   * 这两处不在 cyanmod 的输入区触控规则里，撑到 36。 */\n  [class*=\"pXSMma_workspace\"],\n  [class*=\"cubgiG_seat\"] {\n    min-height: 36px !important;\n  }\n\n  /* 轮次边界标记 \"请求 #14\"（16×16）。\n   * ⚠ 这里**不能**用伪元素扩热区：实测在列表里被祖先裁掉，探点直接返回 null\n   * （元素位置超出了可命中区域）。只能放大本体。 */\n  [class*=\"Y0dWHa_requestBoundaryControl\"] {\n    min-width: 30px !important;\n    min-height: 30px !important;\n  }\n\n  /* \"更早的历史 …\"（28×15） */\n  [class*=\"_1p9O6q_earlierHistory\"] {\n    min-width: 40px !important;\n    min-height: 28px !important;\n  }\n\n\n  /* ---------------------------------------------------------------------- *\n   * 6) 设置页\n   * ---------------------------------------------------------------------- */\n  /* 字号大小的上/下箭头：本体 17×12px，是全站最难点的控件。\n   * ⚠ 两枚箭头间距只有 14px，纵向加大必然互相重叠（重叠区会被后绘制的那枚\n   * 吃掉，变成\"点上一个掉到下一个\"），所以只加宽、不加高。\n   * 真正的兜底是这行的输入框可以直接点进去输数字。 */\n  [class*=\"bVCLcG_arrow\"] {\n    min-width: 34px !important;\n  }\n  /* 关闭（×）/ 打开配置文件 这类小按钮：抽屉式面板里它们周围有空间，直接撑到 44。\n   * 实测「关闭」是 28×40，「打开配置文件」94×40 —— 高度差 4px，宽度差得多。 */\n  [class*=\"VOzbGW_close\"],\n  [class*=\"_button_cfgyt_\"] {\n    min-height: 44px !important;\n  }\n  [class*=\"VOzbGW_close\"] {\n    min-width: 44px !important;\n  }\n  /* 设置面板第二行那串横向标签（通用设置/模型/插件/Agent 预设/Codex Auth/\n   * CodeBuddy/插件市场/Token Saver，实测总宽 ~908px，远超 390px）：\n   * cyanmod 让它可以横滑 —— **保留横滑**（这些标签是设置页唯一的导航，\n   * 绝不能为了不溢出而隐藏或换行堆高），只把每个标签的纵向热区撑到 44，\n   * 并让滚动条细一点、别抢走手势。 */\n  [class*=\"VOzbGW_navCell\"] {\n    min-height: 44px !important;\n    -webkit-overflow-scrolling: touch;\n  }\n  [class*=\"VOzbGW_navList\"] {\n    scrollbar-width: thin;\n  }\n\n\n  /* ---------------------------------------------------------------------- *\n   * 7) 对话正文里的小控件\n   * ---------------------------------------------------------------------- */\n  /* 代码块右上角的「复制」按钮 22×18（同样不能用伪元素：会被代码块的\n   * overflow 裁掉，verify_hits.js 实测 miss） */\n  [class*=\"_copyButton_\"] {\n    min-width: 36px !important;\n    min-height: 28px !important;\n  }\n  /* 消息操作行（复制 / 好评 / 差评 / 分支 / 用时）：产品 28×28。\n   * ⚠ 只加高**不加宽**：这行是 `flex-wrap:nowrap`，按钮组实测 26…198、时间戳\n   * 219…353，加起来 327px 已经比父容器 321px 宽。横向再撑会把\"9月28日 22:01\"\n   * 挤到几十像素。纵向 28 → 36 无风险（实测 行 32 → 40，scrollWidth 仍 = 321，\n   * 时间戳仍是 219…353，零挤压）。 */\n  [class*=\"xzv4MW_action\"],\n  [class*=\"_8_XoUG_action\"],\n  [class*=\"Q51KRG_trigger\"] {\n    min-height: 36px !important;\n  }\n  /* 轮次跳转标记：产品 20×22。\n   * ⚠ 这一列**节距只有 30px**（实测 y=181/211/241…）。先前给到 32×32 是错的：\n   * 32 > 30 会让相邻两枚互相压住 2px，\"点上一枚的下缘\"会落到下一枚上。\n   * 纵向必须 < 30 ⇒ 取 28；横向补到 36（该列宽本来就是 36，不撑破）。 */\n  [class*=\"eGxaPq_mark\"] {\n    min-width: 36px !important;\n    min-height: 28px !important;\n  }\n\n\n  /* ---------------------------------------------------------------------- *\n   * 8) 表格 / 长文本\n   *    对话正文里的 markdown 表格实测 380px 宽，容器只有 321px，\n   *    在 390px 视口下右边界已经越出屏幕。\n   * ---------------------------------------------------------------------- */\n  [class*=\"_tableScroll_\"] {\n    max-width: 100% !important;\n    overflow-x: auto !important;\n    -webkit-overflow-scrolling: touch;\n  }\n  [class*=\"_tableScroll_\"] table {\n    font-size: 12.5px;\n  }\n  [class*=\"_tableScroll_\"] th,\n  [class*=\"_tableScroll_\"] td {\n    padding-left: 6px !important;\n    padding-right: 6px !important;\n  }\n  /* 工具参数 / 长 URL：允许在任意位置断行，别再撑出几千像素宽 */\n  [class*=\"Y0dWHa_toolCallPayload\"],\n  [class*=\"Y0dWHa_contentText\"] {\n    overflow-wrap: anywhere;\n  }\n\n\n  /* ---------------------------------------------------------------------- *\n   * 9) 插件 @tnnevol/dsh-codebuddy —— 输入框右侧的额度小圆点\n   *    （注意：这两条属于**第三方** CodeBuddy 插件，不是自研插件；\n   *     自研插件是 dsh-codebuddy-usage，它的「CodeBuddy 用量」tab 见第 10 节。）\n   * ---------------------------------------------------------------------- */\n  /* 输入框上那个额度余量小圆点（26×26）—— 撑到 32 并换成 flex 居中，\n   * 保证放大后图标仍居中（cyanmod 的经验：把内层撑成盒子会让内容贴顶）。 */\n  [class*=\"dsh-codebuddy-usage-popover-trigger\"] {\n    min-width: 32px !important;\n    min-height: 32px !important;\n    display: inline-flex !important;\n    align-items: center !important;\n    justify-content: center !important;\n  }\n  /* \"刷新\" 按钮 */\n  .dsh-codebuddy-usage-refresh {\n    min-height: 36px !important;\n  }\n\n\n  /* ---------------------------------------------------------------------- *\n   * 10) 插件 @tnnevol/dsh-codebuddy —— 管理面板（shell.overlay 全屏层）\n   *\n   * 根节点 .dsh-codebuddy-panel（role=dialog），内部是 semi-design 的\n   * Layout + Sider，页面靠 hash 路由隔离：\n   *     #/codebuddy/accounts（账号管理）   #/codebuddy/tokens（Token 统计）\n   *\n   * 先看清楚「为什么截图里全是压叠的字」——根因不在文字，在列宽：\n   *\n   *   style.css 顶层（无任何断点覆盖）：\n   *     .dsh-codebuddy-panel .semi-layout-sider{width:168px;min-width:168px}\n   *     .dsh-codebuddy-panel-stat-grid{grid-template-columns:repeat(4,minmax(0,1fr))}\n   *     .dsh-codebuddy-panel-stat{padding:24px 18px}\n   *   ⇒ 390px 视口下左栏固定吃掉 168px，正文只剩 222px；\n   *     views 左右各 16px、stat-card 边框各 1px 之后，四列每列只有 36px，\n   *     而每列的 padding 就要 18+18=36px ⇒ **内容宽度 = 0**，\n   *     于是 75px 的标签（white-space:nowrap，且没有 min-width:0）和\n   *     64px 的数值直接溢出到相邻列上。实测：\n   *       .dsh-codebuddy-panel-stat       [203,180 36x109]\n   *       .dsh-codebuddy-panel-stat-label [184,204 75x20]   ← 比所在列还宽\n   *       .dsh-codebuddy-panel-stat-value [189,234 64x31]\n   *\n   * 作者其实写了窄屏处理（@media (width<=720px) / (width<=760px)），但：\n   *   ① 720 断点里把 sider 又原样重申成 168px —— 等于没有塌陷；\n   *   ② 760 断点里只给 Token 页的 .dsh-codebuddy-token-overview-stats\n   *      降成两列，**账号页这张 .dsh-codebuddy-panel-stat-grid 被漏掉了**\n   *      （全文件只有那一处定义，无断点覆盖）。\n   * 所以这是插件自身的空档，本层的职责是补上，而不是重做它的设计。\n   *\n   * ⚠ 面板本身就是滚动容器（.dsh-codebuddy-panel-views{overflow-y:auto}），\n   *   所以触摸目标一律**放大本体**，不用伪元素扩热区（会被祖先 overflow 裁掉）。\n   * ⚠ 选择器统一带 .dsh-codebuddy-panel 前缀把优先级抬到 (0,2,0) 以上，\n   *   压住插件自身的单类名规则；关键项仍带 !important。\n   * ⚠ 改这里之后要确认 Token 页没被牵连（它有作者自己的两列规则）。\n   * ---------------------------------------------------------------------- */\n\n  /* ---- 10.1 左栏 → 顶栏 -------------------------------------------------\n   * 这是整个面板在手机上可用的前提：不做这一步，正文永远只有 222px，\n   * 后面无论怎么调内部细节都只是在窄缝里挤。\n   * semi 自己就有 .semi-navigation-horizontal 横排变体，但变体类名由 React\n   * 决定、CSS 加不上，所以这里按它已知的 DOM 结构复刻横排布局。 */\n  .dsh-codebuddy-panel .semi-layout-has-sider {\n    flex-direction: column !important;\n  }\n  .dsh-codebuddy-panel .semi-layout-sider {\n    width: 100% !important;\n    min-width: 0 !important;\n    max-width: none !important;\n    height: auto !important;\n    flex: 0 0 auto !important;\n  }\n  /* 插件给 .semi-layout-sider-children 挂了 height:100% + 1px 的补偿\n   * （.semi-layout-sider-children{height:100%;margin-top:-.1px;padding-top:.1px}），\n   * 纵向改横排后父级没有定高，这 100% 会退化成 0 —— 必须显式还原。 */\n  .dsh-codebuddy-panel .semi-layout-sider-children {\n    height: auto !important;\n    margin-top: 0 !important;\n    padding-top: 0 !important;\n  }\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-nav {\n    width: 100% !important;\n    height: auto !important;\n    padding: 8px !important;\n    border-right: 0 !important;\n    border-bottom: 1px solid var(--dsw-alias-border-l2) !important;\n  }\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-nav .semi-navigation-inner {\n    flex-direction: row !important;\n    align-items: center !important;\n    justify-content: flex-start !important;\n    gap: 8px !important;\n    height: auto !important;\n  }\n  /* .semi-navigation-vertical .semi-navigation-header-list-outer{height:100%}\n   * 横排后也跟着塌，改成按内容高 */\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-nav .semi-navigation-header-list-outer {\n    height: auto !important;\n    display: inline-flex !important;\n    align-items: center !important;\n    gap: 8px !important;\n    flex: 1 1 auto !important;\n    min-width: 0 !important;\n  }\n  /* 站名（logo 右侧 18px 的 \"CodeBuddy\"）让位给导航项；logo 保留，\n   * 它是这个面板唯一的品牌锚点，也占不了多少宽度。 */\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-nav .semi-navigation-header {\n    width: auto !important;\n    padding: 0 !important;\n    flex: 0 0 auto !important;\n  }\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-nav .semi-navigation-header-text {\n    display: none !important;\n  }\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-nav .semi-navigation-header-logo {\n    margin-right: 0 !important;\n  }\n  /* .semi-navigation-vertical .semi-navigation-list-wrapper{padding-top:12px;overflow:hidden auto} */\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-nav .semi-navigation-list-wrapper {\n    padding-top: 0 !important;\n    overflow: visible !important;\n    height: auto !important;\n    flex: 1 1 auto !important;\n    min-width: 0 !important;\n  }\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-nav .semi-navigation-list {\n    display: flex !important;\n    flex-direction: row !important;\n    gap: 6px !important;\n  }\n  /* semi 的 item 原本是 width:100% + height:36px + margin-bottom:8px（纵向列表用），\n   * 横排要改成按内容定宽，并撑到 44 的触摸高。 */\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-nav .semi-navigation-list > .semi-navigation-item-normal {\n    width: auto !important;\n    height: auto !important;\n    min-height: 44px !important;\n    margin-bottom: 0 !important;\n    align-items: center !important;\n    flex: 0 0 auto !important;\n  }\n  /* item 末尾那个折叠箭头（semi 的 icon:last-child）横排下没有意义 */\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-nav .semi-navigation-item-icon:last-child {\n    display: none !important;\n  }\n  /* 折叠按钮所在的页脚：面板没开 collapsible，实测是空节点白占 32px 高 */\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-nav .semi-navigation-footer {\n    display: none !important;\n  }\n\n  /* ---- 10.2 账号页统计卡：补两列（插件漏掉的那张表） --------------------\n   * 口径与作者写给 Token 页的 ≤760px 规则完全一致\n   * （.dsh-codebuddy-token-overview-stats 那四条），只是换个前缀。 */\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-stat-grid {\n    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;\n  }\n  /* 24px 18px 的 padding 是为定宽四列设计的，两列下必须收窄 */\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-stat-grid > .dsh-codebuddy-panel-stat {\n    padding: 14px 12px !important;\n    gap: 6px !important;\n    align-items: flex-start !important;\n    text-align: left !important;\n  }\n  /* 分隔线跟着换列重排：第 1、3 项落在左列，不该有左边框；第 3 项起加顶边。\n   * （插件原规则是 .dsh-codebuddy-panel-stat+.dsh-codebuddy-panel-stat{border-left}，\n   *  只写了\"相邻就有左框\"，两列下必须按奇偶收敛。） */\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-stat-grid > .dsh-codebuddy-panel-stat:nth-child(odd) {\n    border-left: 0 !important;\n  }\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-stat-grid > .dsh-codebuddy-panel-stat:nth-child(n + 3) {\n    border-top: 1px solid var(--dsw-alias-border-l2) !important;\n  }\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-stat-grid .dsh-codebuddy-panel-stat-value {\n    font-size: 22px !important;\n  }\n  /* 兜底：将来若列仍被压窄，标签宁可省略号，也不要溢出压到隔壁列上\n   * （原规则 white-space:nowrap 且没有 min-width:0 —— 这正是压叠的直接成因）。 */\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-stat-grid .dsh-codebuddy-panel-stat-label {\n    max-width: 100% !important;\n    min-width: 0 !important;\n  }\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-stat-grid .dsh-codebuddy-panel-stat-label > span:last-child {\n    min-width: 0 !important;\n    overflow: hidden !important;\n    text-overflow: ellipsis !important;\n  }\n\n  /* ---- 10.3 面板内的触摸目标 -------------------------------------------- */\n  /* 工具栏里的返回按钮（产品 32×32） */\n  .dsh-codebuddy-panel .dsh-codebuddy-panel-toolbar .semi-button {\n    min-width: 44px !important;\n    min-height: 44px !important;\n  }\n  /* semi 按钮：产品尺寸是 36 高（含 size-small / with-icon-only 的 24×24），\n   * min-* 会压过 height/width 的定值，所以这一条同时覆盖 36 高和大图标按钮。 */\n  .dsh-codebuddy-panel .semi-button-size-small {\n    min-height: 44px !important;\n  }\n  /* 账号卡右上角「更多操作」（24×36） */\n  .dsh-codebuddy-panel .dsh-codebuddy-account-card-more .semi-button {\n    min-width: 44px !important;\n    min-height: 44px !important;\n  }\n  /* 纯图标按钮（如 Token 页的「刷新本面板」）产品是 24×24，\n   * min-height 那一条只管到高度，宽度会留在 24 —— 这里补上。\n   * 这些按钮所在的行都还有富余（实测 今天54+近7天67+近30天75+24 ≈ 250 < 362）。 */\n  .dsh-codebuddy-panel .semi-button.semi-button-with-icon-only.semi-button-size-small {\n    min-width: 44px !important;\n  }\n  /* 「自动切换 / 自动签到 / 自动旅行」三行：产品只有 19px 高、行距 27px，\n   * 是全面板最难点的三处。把**行**撑到 44 高，行距随之变成 44+8=52，\n   * 这样下面把开关的原生 input 放大到 44×44 才不会跟相邻行抢点击。 */\n  .dsh-codebuddy-panel .dsh-codebuddy-auto-checkin-toggle {\n    min-height: 44px !important;\n  }\n  /* 开关本体只有 26×16，但 .semi-switch-small 的尺寸和滑块位移是配套的\n   * （26×16 配 translate(11px)），直接改宽高会把滑块顶偏 —— 所以**不动本体**，\n   * 只把它内部那个 opacity:0 的原生 checkbox 放大到 44×44 并居中。\n   * 它本来就是 position:absolute;opacity:0，放大后视觉零变化，命中区实打实变大，\n   * 而且因为行距已是 52 > 44，不会越到隔壁行去。 */\n  .dsh-codebuddy-panel .semi-switch-small .semi-switch-native-control {\n    top: 50% !important;\n    left: 50% !important;\n    right: auto !important;\n    bottom: auto !important;\n    width: 44px !important;\n    height: 44px !important;\n    transform: translate(-50%, -50%) !important;\n  }\n\n  /* ---- 10.4 图表横向滚动在触摸下更顺 ----------------------------------\n   * Token 页「最近一年的每日活跃度」是个 53 周的方格图（宽 685px），\n   * 作者把它放在 .dsh-codebuddy-token-activity-scroll{overflow-x:auto} 里，\n   * **本来就是设计成横向滚动的**，所以窄屏下它被裁在卡片右边界属于正常。\n   * 这里只是给触摸加惯性滚动，并给滚动条留出可点的高度。\n   * ⚠ 不要试图把它改成不滚动 —— 那会真的丢掉后几个月的数据。 */\n  .dsh-codebuddy-panel .dsh-codebuddy-token-activity-scroll {\n    -webkit-overflow-scrolling: touch;\n    overscroll-behavior-x: contain;\n  }\n\n\n  /* ---------------------------------------------------------------------- *\n   * 11) 插件 @tnnevol/dsh-codebuddy —— 设置页里的 CodeBuddy 分区\n   *     （settings.section：账号管理 / 管理面板 / 自动切换 / 切换阈值 / 显示额度余量）\n   *\n   * 这里只有一个真问题，但很显眼：「切换阈值」的**标签文字压在滑块轨道上**。\n   *\n   * 根因是插件自己把 semi 的默认值覆盖掉了：\n   *     .semi-form-field-label{flex-shrink:0}                  ← semi 默认，不会被压\n   *     .semi-form-field-main{width:100%}                      ← 主区要 100%\n   *     .dsh-codebuddy-pref-form .semi-form-field[x-label-pos=left]\n   *       .semi-form-field-label{flex:0 auto;min-width:0}      ← 插件覆盖：可压缩 + 可缩到 0\n   * 于是标签被压成 **14px 宽**，而它里面的\n   *     .dsh-codebuddy-form-label-title{white-space:nowrap}    ← 又不许换行\n   * strong 实际要 56px ⇒ 文字溢出 42px，撞进右侧滑块。\n   * 实测几何：label [16,403 14x22] / strong [16,403 56x22] /\n   *           .semi-slider-rail 起点 x=67 —— 文字到 72，轨道自 67 起，重叠 5px。\n   *\n   * 修法只做一件事：把标签的「可压缩」收回成 semi 原本的不可压缩。\n   * 收回后：标签 56 → gap 24 → 主区 278 → 轨道起点 96，不再相交。\n   * ⚠ 作用域限死在 .dsh-codebuddy-pref-form，别动其它插件的 semi 表单。 */\n  .dsh-codebuddy-pref-form .semi-form-field[x-label-pos=\"left\"] .semi-form-field-label {\n    flex: 0 0 auto !important;\n    min-width: max-content !important;\n  }\n\n\n  /* ---------------------------------------------------------------------- *\n   * 12) 插件 dshmarket（设置页 →「插件市场」）的标题行\n   *\n   * 该行（.nUhMVa_titleRow）是 flex / nowrap / **height:32px** / gap:2px，\n   * 宽 350px；六个子项按内容排要 ~378px，差 28px：\n   *   svg 22 + h2「插件市场」64 + a「dsh-market」61 + span「v1.66.3」37\n   *   + 「换用线上版本」92 + 「本次全部忽略」92 + 5×2 gap = 378\n   * 因为是 nowrap，缺的 28px 只能从「可压缩」的子项上刮，而 h2 是这一行里\n   * 唯一没设 flex-shrink:0 的**文字**节点 ⇒ 被压成 **56px**，\n   * 中文撑不下 56px ⇒ 「插件市场」断成「插件市 / 场」两行。\n   * 实测（修复前）：h2 [44,118 56x32]。\n   *\n   * 修法三件事，缺一不可：允许换行 / 解除 32px 死高 / 禁止 h2 被压缩。\n   *\n   * ⚠ 只加 `flex-wrap:wrap` 会**变得更糟**，这一步我踩过并实测到了：\n   *   内容撑成两行，但盒子仍被 height:32px 钉住 ⇒ clientHeight=32 而\n   *   scrollHeight=94，第二行整行溢出到盒子外，压住下面的\n   *   a.nUhMVa_submitLink「申请收录插件 ↗」（它在 y=185，正落在第二行\n   *   168~212 的区间里）。所以 `height:auto` 是**必需项**，不是优化项。\n   *   ——这也是一个可复用的判据：容器 clientHeight < scrollHeight\n   *   且 overflow 不是 auto/scroll 时，必然在压别人，拿 rect 两两求交集并不够。\n   *\n   * ⚠⚠ 特异性必须压过 cyanmod 的 `[class*=\"_titleRow\"]{height:32px!important}`\n   *   （cyanmod/client.js:1090，那条的本意是钉**对话顶栏**标题行的高度）。\n   *   它用的是子串匹配，而市场这一行的类名恰好以 `_titleRow` 结尾，于是被误套。\n   *   两条规则特异性同为 (0,1,0) 且都带 !important ⇒ **源序靠后的赢**；\n   *   cyanmod 作为插件在运行时注入样式，永远排在本 shim（内联在 <head>）之后，\n   *   所以只写 `[class*=\"nUhMVa_titleRow\"]` 是**必输**的：\n   *     height:auto 被顶掉 → 只剩 min-height:44px 兜着 ⇒ 盒子停在 44px，\n   *     而内容要 90px ⇒ 第二行整行溢出，又压回 submitLink 上，等于白改。\n   *\n   *   ⚠ 这个坑差点漏掉：本地用 PROBE_PRE_CSS 注入时，注入的 <style> 排在最后，\n   *   我方规则反超 cyanmod，测出来一直是 94px 全绿；只有部署后才暴露。\n   *   复现办法：把 cyanmod 那条规则**重述到注入样式末尾**（见 _sim_cyanmod.css），\n   *   立刻还原成 44px + 6 处压叠。**凡与 cyanmod 有交集的选择器，都必须按\n   *   「源序靠后」的假设来定特异性，不能靠注入态自测。**\n   *\n   * 修法：选择器叠两个属性选择器，特异性升到 (0,2,0)。\n   *   第二个 [class*=\"titleRow\"] 被第一个完全蕴含（`nUhMVa_titleRow` 本身\n   *   就含 `titleRow`），所以**匹配集合一字不变**，纯粹是抬权。\n   *\n   * ⚠ h2 必须用**标签名**限定。`[class*=\"nUhMVa_title\"]` 是个子串匹配，\n   *   会连 .nUhMVa_titleRow 自己一起命中。\n   *\n   * 为什么不改成 nowrap + 截断：350px 里减法不够用 —— 固定项\n   *   22+64+92+92+10 = 280，只剩 70px 要装 61px 的仓库名和 37px 的版本号，\n   *   两个都得截断成「dsh-ma…」「v1.6…」。换行是这里唯一**不丢信息**的解；\n   *   代价是该行由 32 变 94（44 + gap 6 + 44），下面内容整体下移 62px。 */\n  [class*=\"nUhMVa_titleRow\"][class*=\"titleRow\"] {\n    flex-wrap: wrap !important;\n    row-gap: 6px !important;\n    height: auto !important;\n    min-height: 44px !important;\n  }\n  h2[class*=\"nUhMVa_title\"] {\n    flex: 0 0 auto !important;\n    min-width: max-content !important;\n    white-space: nowrap !important;\n  }\n\n  /* ---- 12.2 市场自己的控件行（tab / 分类 chip / 筛选搜索框） ---------------\n   * 这三处属于**安全的那一类**：容器 `overflow` 都是 visible，父级垂直余量很大\n   * （实测 room 上/下 = 280/530、68/416、16/468），且都只差高度、不差宽度。\n   *   .nUhMVa_tab         33 高 ×5 个（发现 / 已安装 / …）—— 宽 50~93 已 ≥44\n   *   ._pill_e3ygd_1      24 高的分类 chip —— 关键：**行距 40 = 24 + gap 16**，\n   *                       抬到 44 后行距自动变 60 > 44，相邻两行不会互相压住。\n   *                       （这正是 §7 `eGxaPq_mark` 那个反例的镜像：那里节距是\n   *                       写死的 30，所以只能加宽；这里节距来自 gap，会跟着长。）\n   *   .nUhMVa_searchInput 外层 32 / 内层 input 24 —— 两层一起抬，否则 input\n   *                       会顶出外层（同 §5 轨迹搜索框的教训） */\n  [class*=\"nUhMVa_tab\"] {\n    min-height: 44px !important;\n  }\n  [class*=\"nUhMVa_root\"] button[class*=\"_pill_e3ygd_1\"] {\n    min-height: 44px !important;\n  }\n  [class*=\"nUhMVa_searchInput\"] {\n    min-height: 44px !important;\n  }\n  [class*=\"nUhMVa_searchInput\"] input {\n    min-height: 40px !important;\n  }\n\n  /* ---- 12.3 设置页导航：保持单行横滑（用户拍板，2026-09-29 回退）------------\n   * 历史：本节曾按「适配彻底」原则把 8 个 Tab 改成折行（wrap）全可见，\n   *   理由是横滑中间态像坏了（Auth 截半 + 横滚条，02:37 用户截图）。\n   * 回退原因：部署后用户明确反馈不认可折行样式（03:27 截图：Tab 堆 3 行占半屏），\n   *   并指认 02:37 的单行横滑才是认可的原样式 —— **样式取舍以用户为准**。\n   * 现状：删除本节 wrap 规则后，cyanmod 的\n   *   `[role=\"dialog\"][aria-modal=\"true\"][aria-labelledby] > nav > div:last-child\n   *   { flex-wrap: nowrap !important }`（特异性 (0,4,2)，运行时注入）重新生效，\n   *   导航恢复「单行 + overflow-x 横滑」；右侧渐隐遮罩 + 细滚动条提示可滑。\n   * 触达末尾 Tab（如 Token Saver）的方式 = 横向滑动手势，属原生交互。\n   * ⚠ 若未来要再动这块，特异性教训仍然有效：cyanmod 是 (0,4,2)，(0,2,0) 必输。\n   * ⚠ 特异性历史保留在 git/本注释，勿再轻易对用户已认可的布局做「更彻底」的改造。 */\n\n  /* ---- 12.4 Token Saver 插件面板（设置抽屉内）：数据表横向出血 ------------\n   * 实测（400px）：.st-wrap scrollWidth 448 > 360，「近期活动」的 td\n   *   （st-dim \"prompt~16,96\" 等）冲出视口右缘 52~64px。\n   * 修法：让卡片自己成为横向滚动容器（数据表在卡内滑动，而不是刺穿布局）。\n   * 过度匹配审计：st-* 是 Token Saver 的字面类名，范围用 VOzbGW_options\n   *   （设置抽屉内容区）收窄，避免撞别的插件的 st- 前缀。 */\n  [class*=\"VOzbGW_options\"] div[class*=\"st-card\"] {\n    overflow-x: auto !important;\n  }\n\n  /* ---- 12.5 市场卡片触摸目标（dshmarket 1.66.3 部署态探针实测 2026-09-29）------\n   * 390px 实测小目标：favoriteBtn 14×14、commentsLink 22×16、opEntry(任务) 46×26、\n   * catsTogg 宽 28、descToggle 20×16，以及若干内联文字链（repoLink 12 / submitLink 18 /\n   * nmLink 22 高）。全部远低于 44px 触摸标准。\n   * 修法分两类：\n   *   a) 块级/inline-flex 控件 → min-width/height 44 + flex-shrink:0\n   *      （foot 所在卡片底部有纵向余量，列表本就滚动，行高增长无害；\n   *       .foot 是 nowrap + footTags flex:1 min-width:0，右侧变宽只会让标签区内部换行）。\n   *   b) 内联文字链 → 只加 padding 扩 hit-area：inline 元素的垂直 padding 会扩大\n   *      可点面积但**不参与行高布局**（视觉零位移），这是对列表行内链唯一安全的扩法。\n   * 过度匹配审计：全部以 nUhMVa_（dshmarket 文件级哈希，探针实证归属）开头，\n   * 不会命中宿主或其它插件的同名语义类。 */\n  [class*=\"nUhMVa_favoriteBtn\"] {\n    min-width: 44px !important;\n    min-height: 44px !important;\n    justify-content: center !important;\n    flex-shrink: 0 !important;\n  }\n  [class*=\"nUhMVa_commentsLink\"] {\n    display: inline-flex !important;\n    align-items: center !important;\n    min-height: 44px !important;\n    padding: 0 10px !important;\n    flex-shrink: 0 !important;\n  }\n  [class*=\"nUhMVa_opEntry\"] {\n    min-height: 44px !important;\n  }\n  [class*=\"nUhMVa_catsTogg\"] {\n    min-width: 44px !important;\n    min-height: 44px !important;\n  }\n  [class*=\"nUhMVa_descToggle\"] {\n    min-width: 44px !important;\n    min-height: 40px !important;\n    padding: 0 14px !important;\n  }\n  [class*=\"nUhMVa_repoLink\"],\n  [class*=\"nUhMVa_submitLink\"] {\n    padding: 14px 0 !important;\n  }\n  [class*=\"nUhMVa_nmLink\"] {\n    padding: 11px 0 !important;\n  }\n\n  /* ---------------------------------------------------------------------- *\n   * 13) 附：子串选择器「过度匹配」审计结论（不是规则，是备忘）\n   *\n   * 本文件全部用 `[class*=\"哈希_名\"]` 匹配。子串匹配的固有风险是\n   * **同一个元素的兄弟/子节点类名也含这个子串**（如 `_newSession` 命中\n   * `_newSessionLabel`），从而把规则施加到不该动的节点上。\n   * cyanmod 的 `[class*=\"_titleRow\"]` 命中 dshmarket 的 `nUhMVa_titleRow`\n   * 就是这么造成的（见 §12）。\n   *\n   * 用脚本把本文件 41 个子串拿去和全站 bundle（118MB / 77679 个类名 token）\n   * 对撞，19 个子串存在过度匹配。逐条核对后：\n   *\n   *   ✅ 已修（有实测证据）：\n   *      hHd-Xa_newSession → newSessionLabel   （§3，label 顶出内含盒 over 9）\n   *      fV0t5q_action     → actionIcon        （§5，图标被抬成 14×36）\n   *      fV0t5q_toggle     → toggleIcon        （§5，同上）\n   *\n   *   ➖ 属于「同一元素的状态类」，**不能排除**，排除了反而会失效：\n   *      wSkVaW_tab      → tabActive / tabs（tabs 是容器，多一条 min-height 无害）\n   *      eGxaPq_mark     → markActive / markBusy / markUnloaded（状态类）\n   *      VOzbGW_navCell  → navCell+active（元素自身两个类）\n   *\n   *   ✔ 已核验无害（父子一起被抬高，盒子自洽，不产生溢出；用「定高盒子\n   *     clientHeight < scrollHeight」的检测器在 对话 / 轨迹 / 设置 / 两个插件\n   *     面板 全部扫过，零命中）：\n   *      hHd-Xa_brand      → brandIdentity / brandMark / brandName\n   *      pXSMma_workspace  → workspaceLabel / workspaceRow\n   *      cubgiG_seat       → seatLabel / seatIcon / seat-char-in / seat-icon-in\n   *      fV0t5q_action     → actions（容器）\n   *      xzv4MW_action     → actions（容器）\n   *      bVCLcG_arrow      → arrows（容器）\n   *      EvIC1a_toBottom   → toBottomSlot\n   *      VOzbGW_trigger    → triggerLabel / triggerRow（行内被抬高，自洽）\n   *\n   *   ✔ 已被 :not() 配对保护：bhn1Oq_searchSlot/searchSlotExpanded、\n   *      bhn1Oq_headerActions/headerActionsHidden\n   *   ✔ §12 的 `[class*=\"titleRow\"]` 是抬权用的第二属性选择器，被第一个完全\n   *      蕴含，匹配集合不变，不会命中 wSkVaW_titleRow。\n   *\n   * ⚠ 这些结论绑定当前版本。改插件 / 升级宿主后，重新跑一次对撞脚本再下结论。\n   * ---------------------------------------------------------------------- */\n}\n  /* ────────────────────────────────────────────────────────────\n   * 14) token-saver 状态条（.st-strip）在 composer dock 里被挤成竖条\n   * ----------------------------------------------------------------------\n   * 症状（390×844@3x 实测，0.1.7-rc.2 + dsh-plugin-save-token 2.4.1）：\n   * dock 是 nowrap 单行 flex，原生会话统计与 .st-strip 同行；窄屏下 strip\n   * 被压到内容宽 109px（rect 139×81），4 个 span 纵向折行成怪条，视觉上\n   * 压过统计行；原生统计同时被挤截断（“缓存命中 8…”）。\n   * 修复：dock 允许换行；strip flex-basis:100% 独占一行、内容居中。\n   * .st-strip 是插件自有稳定类可直选；dock/composerStack 是宿主 CSS\n   * Module 哈希类，按 [class*=\"语义段\"] 约定匹配，跨版本免疫。\n   * ⚠ 单一来源教训：12.3 回退与 12.5 触摸目标曾被直接写进 legacy 块、\n   *   未同步回本文件，导致一次重建把两者弄丢（2026-09-29 已并回）。此后\n   *   改移动端样式一律改本文件再 build_mobile.py，严禁直改 legacy 块。\n   * ---------------------------------------------------------------------- */\n  [class*=\"composerStack\"] [class*=\"dock\"] { flex-wrap: wrap; row-gap: 4px; }\n  [class*=\"composerStack\"] [class*=\"dock\"] .st-strip {\n    flex: 0 0 100%;\n    justify-content: center;\n    row-gap: 2px;\n  }"
      /* END mobile-rules */
    ].join("\n");
    (document.head || document.documentElement).appendChild(mobileStyle);
  }

  /* --- Well-known symbols (dispose 134, asyncDispose is a typo guard, metadata 125) --- */
  if (typeof Symbol === "function") {
    if (!Symbol.dispose) define(Symbol, "dispose", Symbol("Symbol.dispose"));
    if (!Symbol.asyncDispose) define(Symbol, "asyncDispose", Symbol("Symbol.asyncDispose"));
    if (!Symbol.metadata) define(Symbol, "metadata", Symbol("Symbol.metadata"));
  }

  /* --- Iterator global + iterator helpers (Chromium 122) --- */
  var IteratorCtor = g.Iterator;
  if (typeof IteratorCtor === "undefined") {
    IteratorCtor = function Iterator() {};
    IteratorCtor.prototype = Object.create(Object.prototype);
    IteratorCtor.prototype[Symbol.iterator] = function () { return this; };
    g.Iterator = IteratorCtor;
  }
  /* Wrapper that keeps helper chains working after an eager materialisation. */
  function wrap(array) {
    var obj = {
      __array: array,
      [Symbol.iterator]: function () { return array[Symbol.iterator](); },
      toArray: function () { return array.slice(); },
      forEach: function (fn) { array.forEach(function (v, i) { fn(v, i); }); return obj; },
      map: function (fn) { return wrap(array.map(function (v, i) { return fn(v, i); })); },
      filter: function (fn) { return wrap(array.filter(function (v, i) { return fn(v, i); })); },
      take: function (n) { return wrap(array.slice(0, n)); },
      drop: function (n) { return wrap(array.slice(n)); },
      reduce: function (fn, init) { return arguments.length > 1 ? array.reduce(function (a, v, i) { return fn(a, v, i); }, init) : array.reduce(function (a, v, i) { return fn(a, v, i); }); },
      some: function (fn) { return array.some(function (v, i) { return fn(v, i); }); },
      every: function (fn) { return array.every(function (v, i) { return fn(v, i); }); },
      find: function (fn) { return array.find(function (v, i) { return fn(v, i); }); },
      join: function (separator) { return array.join(separator); }
    };
    Object.setPrototypeOf(obj, IteratorCtor.prototype);
    return obj;
  }
  function iterableToArray(source) {
    if (source == null) return [];
    if (typeof source.toArray === "function") return source.toArray();
    if (source.__array) return source.__array.slice();
    if (typeof Symbol !== "undefined" && typeof source[Symbol.iterator] === "function") return Array.from(source);
    if (typeof source.next === "function") {
      var out = [];
      var step = source.next();
      while (step && !step.done) { out.push(step.value); step = source.next(); }
      return out;
    }
    return [];
  }
  if (typeof IteratorCtor.from !== "function") {
    define(IteratorCtor, "from", function (source) { return wrap(iterableToArray(source)); });
  }
  var iteratorHelpers = {
    toArray: function () { return iterableToArray(this); },
    forEach: function (fn) { iterableToArray(this).forEach(function (v, i) { fn(v, i); }); },
    some: function (fn) { return iterableToArray(this).some(function (v, i) { return fn(v, i); }); },
    every: function (fn) { return iterableToArray(this).every(function (v, i) { return fn(v, i); }); },
    find: function (fn) { return iterableToArray(this).find(function (v, i) { return fn(v, i); }); },
    reduce: function (fn, init) {
      var arr = iterableToArray(this);
      return arguments.length > 1 ? arr.reduce(function (a, v, i) { return fn(a, v, i); }, init) : arr.reduce(function (a, v, i) { return fn(a, v, i); });
    },
    map: function (fn) { return wrap(iterableToArray(this).map(function (v, i) { return fn(v, i); })); },
    filter: function (fn) { return wrap(iterableToArray(this).filter(function (v, i) { return fn(v, i); })); },
    take: function (n) { return wrap(iterableToArray(this).slice(0, n)); },
    drop: function (n) { return wrap(iterableToArray(this).slice(n)); },
    /* The bundle ships its own join polyfill; this one runs first when needed. */
    join: function (separator) { return iterableToArray(this).join(separator); }
  };
  for (var helper in iteratorHelpers) {
    if (typeof IteratorCtor.prototype[helper] !== "function") {
      define(IteratorCtor.prototype, helper, iteratorHelpers[helper]);
    }
  }

  /* --- AbortSignal.any (Chromium 116) --- */
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any !== "function") {
    define(AbortSignal, "any", function (signals) {
      var list = Array.prototype.slice.call(signals);
      var controller = new AbortController();
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].aborted) {
          controller.abort(list[i].reason);
          return controller.signal;
        }
      }
      for (var j = 0; j < list.length; j++) {
        (function (signal) {
          signal.addEventListener("abort", function () { controller.abort(signal.reason); }, { once: true });
        })(list[j]);
      }
      return controller.signal;
    });
  }

  /* --- Promise.withResolvers (119) / Promise.try (128) --- */
  if (typeof Promise.withResolvers !== "function") {
    define(Promise, "withResolvers", function () {
      var resolve, reject;
      var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
      return { promise: promise, resolve: resolve, reject: reject };
    });
  }
  if (typeof Promise.try !== "function") {
    define(Promise, "try", function (fn) {
      var args = Array.prototype.slice.call(arguments, 1);
      return new Promise(function (resolve) { resolve(fn.apply(undefined, args)); });
    });
  }

  /* --- Array.fromAsync (121) --- */
  if (typeof Array.fromAsync !== "function") {
    define(Array, "fromAsync", function (source, mapFn, thisArg) {
      var input = source;
      return Promise.resolve(input).then(function (iterable) {
        var items = [];
        var iterator = iterable == null ? null : (typeof Symbol !== "undefined" && iterable[Symbol.asyncIterator]) ? iterable[Symbol.asyncIterator]() : (typeof Symbol !== "undefined" && iterable[Symbol.iterator]) ? iterable[Symbol.iterator]() : null;
        if (!iterator) {
          var keys = iterable == null ? [] : Object.keys(iterable);
          return Promise.all(keys.map(function (key) { return Promise.resolve(iterable[key]).then(function (value) { return mapFn ? mapFn.call(thisArg, value, Number(key)) : value; }); }));
        }
        function step(nextFn, method) {
          return Promise.resolve(nextFn.call(iterator)).then(function (result) {
            if (result.done) return items;
            return Promise.resolve(mapFn ? mapFn.call(thisArg, result.value, items.length) : result.value).then(function (value) {
              items.push(value);
              return step(nextFn, method);
            });
          });
        }
        return typeof iterator.next === "function" ? step(iterator.next, "next") : items;
      });
    });
  }

  /* --- URL.parse (126) --- */
  if (typeof URL !== "undefined" && typeof URL.parse !== "function") {
    define(URL, "parse", function (input, base) {
      try { return base === undefined ? new URL(input) : new URL(input, base); } catch (error) { return null; }
    });
  }

  /* --- Non-mutating array copies (110) --- */
  if (typeof Array.prototype.toSorted !== "function") {
    define(Array.prototype, "toSorted", function (compare) { return Array.prototype.slice.call(this).sort(compare); });
  }
  if (typeof Array.prototype.toReversed !== "function") {
    define(Array.prototype, "toReversed", function () { return Array.prototype.slice.call(this).reverse(); });
  }
  if (typeof Array.prototype.toSpliced !== "function") {
    define(Array.prototype, "toSpliced", function (start, deleteCount) {
      var copy = Array.prototype.slice.call(this);
      var rest = Array.prototype.slice.call(arguments, 2);
      copy.splice.apply(copy, [start, deleteCount].concat(rest));
      return copy;
    });
  }
  if (typeof Array.prototype.with !== "function") {
    define(Array.prototype, "with", function (index, value) {
      var copy = Array.prototype.slice.call(this);
      var i = index < 0 ? copy.length + index : index;
      copy[i] = value;
      return copy;
    });
  }

  /* --- Object.groupBy / Map.groupBy (117) --- */
  if (typeof Object.groupBy !== "function") {
    define(Object, "groupBy", function (items, callback) {
      /* Null-prototype object with enumerable own keys, matching the spec shape. */
      var out = Object.create(null);
      Array.prototype.forEach.call(items, function (item, index) {
        var key = callback(item, index);
        if (out[key] === undefined) out[key] = [];
        out[key].push(item);
      });
      return out;
    });
  }
  if (typeof Map.groupBy !== "function") {
    define(Map, "groupBy", function (items, callback) {
      var out = new Map();
      Array.prototype.forEach.call(items, function (item, index) {
        var key = callback(item, index);
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(item);
      });
      return out;
    });
  }

  /* --- String well-formedness (111) --- */
  if (typeof String.prototype.isWellFormed !== "function") {
    define(String.prototype, "isWellFormed", function () {
      return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(String(this));
    });
  }
  if (typeof String.prototype.toWellFormed !== "function") {
    define(String.prototype, "toWellFormed", function () {
      return String(this).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
    });
  }

  /* --- ReadableStream async iteration (124) --- */
  if (typeof ReadableStream !== "undefined" && typeof Symbol.asyncIterator === "symbol" && typeof ReadableStream.prototype[Symbol.asyncIterator] !== "function") {
    define(ReadableStream.prototype, Symbol.asyncIterator, function () {
      var reader = this.getReader();
      return {
        next: function () {
          return reader.read().then(function (result) {
            return result.done ? { done: true, value: undefined } : { done: false, value: result.value };
          });
        },
        return: function () {
          return reader.cancel().then(function () { return { done: true, value: undefined }; });
        },
        throw: function (error) {
          return reader.cancel().then(function () { throw error; });
        }
      };
    });
  }

  /* --- localStorage quota guard for conversation snapshots ---
   *
   * The DSH client persists a full-store snapshot under
   *   dsh.conversation.session-<id>
   * and re-writes the ENTIRE value on every state change (typing, streaming,
   * scrolling). There is no size cap and no graceful degradation: once a long
   * session exceeds the ~5MB localStorage quota, every keystroke logs
   * "QuotaExceededError ... exceeded the quota" and the console floods.
   *
   * Strategy (upstream-proof, no bundle changes):
   *  1) On setItem failure, evict other session snapshots (oldest first, never
   *     the key being written) and retry once. Reclaims space from stale
   *     sessions so ordinary-sized snapshots keep persisting.
   *  2) If it still fails and the payload is huge (>= 2MB), silently drop THIS
   *     write instead of logging every time. The snapshot is a client-only
   *     convenience (session restore); the server event stream is unaffected.
   *     A one-line notice is logged once per key so the situation stays visible
   *     without flooding the console.
   */
  if (typeof Storage !== "undefined" && typeof window !== "undefined" && window.localStorage) {
    try {
      var ls = window.localStorage; // capture explicitly: bare `localStorage` only exists in real browsers
      var SNAP_PREFIX = "dsh.conversation.session-";
      var HUGE_SNAPSHOT_BYTES = 2 * 1024 * 1024;
      var silencedKeys = Object.create(null);

      function snapshotKeys() {
        var out = [];
        for (var i = 0; i < ls.length; i++) {
          var k = ls.key(i);
          if (k && k.indexOf(SNAP_PREFIX) === 0) out.push(k);
        }
        return out;
      }

      function evictOtherSnapshots(keepKey) {
        var keys = snapshotKeys();
        var saved = [];
        for (var i = 0; i < keys.length; i++) {
          if (keys[i] === keepKey) continue;
          saved.push([keys[i], ls.getItem(keys[i])]);
          ls.removeItem(keys[i]);
        }
        return saved;
      }

      function restoreSnapshots(saved) {
        for (var i = saved.length - 1; i >= 0; i--) {
          try { ls.setItem(saved[i][0], saved[i][1]); } catch (e) { break; }
        }
      }

      var origSetItem = ls.setItem.bind(ls);
      ls.setItem = function (key, value) {
        try {
          origSetItem(key, value);
        } catch (err) {
          if (key && key.indexOf(SNAP_PREFIX) === 0) {
            var saved = evictOtherSnapshots(key);
            try {
              origSetItem(key, value);
              silencedKeys[key] = false;
              return;
            } catch (retryErr) {
              restoreSnapshots(saved);
              if (String(value).length >= HUGE_SNAPSHOT_BYTES) {
                if (!silencedKeys[key]) {
                  silencedKeys[key] = true;
                  console.warn("[dsh-legacy-compat] conversation snapshot for this session is too large for localStorage; local snapshot persistence is disabled for it (server session is unaffected)");
                }
                return; // drop silently; do not flood the console per keystroke
              }
            }
          }
          throw err;
        }
      };
    } catch (guardErr) { /* storage unusable; nothing to guard */ }
  }
})();
