# 架构与设计取舍

这份文档记录**为什么这么做**，以及**踩过的坑**。每个坑都是自测抓出来的真实 bug，不是假想风险。

## 1. 技术选型

| 决策 | 理由 | 代价 |
|---|---|---|
| **Electron**（而非 Tauri / PySide6 / WPF） | 「自定义外形 + 聊天气泡」本质是 HTML/CSS 的强项；插件用 `plugins/<id>/` 动态加载天然热重载；本机实测可装可跑 | 包体 80–150MB；透明 overlay 的重绘性能上限低于纯原生 |
| **原生 ESM，不用打包器** | 少一层工具链就少一类"构建能过、运行报错"的问题；渲染层直接用 `<script type="module">` | 必须给渲染层一个正常的源 → 于是有了 `deskpet://` 协议 |
| **小依赖面** | 框架能力用 Electron 与 Node 内置 API；PSD 解析使用 ag-psd，素材构建使用开发依赖 pngjs | 依赖由 package-lock.json 锁定，PSD 与普通皮肤路径分离 |
| **对外契约集中在一个文件** | `src/shared/types.ts` 是插件协议的唯一来源，宿主与渲染层都从它取类型 | 改协议要动一个文件（这正是想要的） |
| **纯逻辑与 Electron 解耦** | 插件扫描、校验、权限表、触发器、协议解析都不 import `electron`，因此能用纯 Node 测（`tools/selftest*.mjs`） | 需要刻意保持模块边界（例如把权限表抽成 `permissions.ts`） |

## 2. 进程与数据流

```
主进程 (src/main)
  index.ts      启动、单实例、--doctor/--selfcheck 分支、数据目录重定向
  window.ts     透明置顶窗口、点击穿透、拖动轮询、位置记忆、多屏夹取
  protocol.ts   deskpet:// 协议（渲染层源 + 插件资源白名单）
  host.ts       动作执行 + 权限网关 + 会话历史 + 命令表 + 存储
  permissions.ts 动作 → 权限 的唯一映射表
  plugins/      manifest 校验 · registry 扫描/合并 · declarative 触发器 · sandbox 代码插件
  chat/         双协议流式（Ollama NDJSON / OpenAI SSE）
  ipc.ts        全部 IPC 入口（渲染层唯一的门）
  selfcheck.ts  截图、渲染/互动/导入校验与报告
  logger.ts     同步落盘日志（app.exit 也不丢）

渲染进程 (src/renderer)  ← 无 Node，只有 contextBridge 暴露的具名方法
  main.ts       装配、命中判定循环、拖动、双击对话、右键命令
  sprite.ts     精灵图 + 动画状态机 + alpha 掩膜命中
  bubble.ts     气泡（打字机 / 流式追加 / 命令 chips）

preload (src/preload)   contextBridge 白名单 API（渲染层拿不到 ipcRenderer 本身）
```

## 3. 窗口：透明、置顶、穿透、拖动

**默认穿透**是桌宠的体验底线（宠物周围的透明区域不该挡住桌面点击）。做法：

1. 窗口 `transparent + frame:false + skipTaskbar + alwaysOnTop('screen-saver')`。
2. 默认 `setIgnoreMouseEvents(true, { forward: true })` —— 鼠标事件仍会转发给渲染层。
3. 渲染层用**像素级命中判定**决定要不要临时关掉穿透：
   - 加载精灵图时一次性 `getImageData` 整张图，缓存成 alpha 掩膜；
   - 指针位置映射到当前帧的图集矩形，查 alpha 通道（阈值 16）；
   - 命中宠物本体或气泡矩形 → `setInteractive(true)` → 主进程 `setIgnoreMouseEvents(false)`。
4. 拖动**不用** `-webkit-app-region: drag`（它与穿透互斥，而且拖拽热区在 Windows 高缩放下有历史 bug）：改成主进程在拖动期间用 `screen.getCursorScreenPoint()` 每 15ms 跟随光标，无 IPC 往返、帧率稳定。
5. 松手后把窗口夹回**离它最近那块屏**的工作区，并防抖保存位置。

已知坑（本机未复现但要知道）：Electron 的 `forward` 转发在 Windows 上 hover 判定有历史 issue（30808）、Linux 完全不支持（16777）。我们的命中判定只依赖 `mousemove` 的坐标，不依赖 hover 语义，因此对这两个 issue 相对免疫；但**多显示器 DPI 需要真机多屏验证**（本机单屏，未验证）。

## 4. `deskpet://` 协议：为什么必须有

两个独立原因，任何一个都足以逼出这个协议：

1. **原生 ESM 需要正常的源**：`file://` 下浏览器按 CORS 规则拒绝加载 ES module。给渲染层 `deskpet://renderer/` 这个 standard+secure 的源，才能不用打包器直接用 `import`。
2. **插件资源需要白名单**：`deskpet://pack/<pluginId>/<相对路径>` 把插件目录纳入受控访问，路径一律过 `safeJoin`（拒绝绝对路径、`..` 逃逸、盘符），比让插件资源走 `file://` 安全得多。

顺带解决了 canvas 污染：渲染层源是 `deskpet://renderer`、图片在 `deskpet://pack`，跨源读像素会被 taint，所以协议响应带 `access-control-allow-origin: *`，图片用 `crossOrigin="anonymous"` 加载。**如果这里漏了，命中判定会静默退化成"整块矩形"** —— 代码里对此有显式降级与日志。

## 5. 动画状态机

- **状态栈**：待机底座 + 压在栈上的临时状态（拖动、说话、插件反应），谁先结束谁出栈。桌宠场景不需要行为树：状态数 5~15、行为以"随机待机 + 事件反应"为主时，栈 + 加权随机比 BT 更好调。
- **待机调度**：底座状态下每个 clip 播完 → 停 0.4~2.6 秒 → 按 `weight` 抽下一个 clip。这就是"待机动作"。
- **单调时钟**：全部用 `performance.now()`，不用墙上时间，休眠/锁屏唤醒不会跳帧。
- **帧驱动**：`requestAnimationFrame` + 累积器（`frameAcc -= frameMs`）而不是"每次加一帧"，掉帧时不会越播越快。

## 6. 插件系统

**一个契约**：`plugin.json`。`runtime` 决定怎么执行，`kind` 决定贡献什么。数据包（外形/主题/聊天后端）连代码都不用写。

**校验即防线**：加载前检查 JSON 合法性、字段类型、`data.*` / `entry` 是否存在、**路径是否越界**、触发器结构、`match` 正则合法性、权限名合法性、`engine.deskpet` 版本区间。校验不过不加载，原因会进 `--doctor` 与自检报告。

**合并语义**：皮肤提供基础状态，每个启用的动作包再往上叠 —— 同名状态**覆盖**、新状态名**追加**。禁用动作包后新增状态立刻消失（自测里有对应用例）。

**权限是硬约束**：动作 → 权限只有一张表（`permissions.ts`），声明式触发器、代码插件沙箱、IPC 入口共用。没申请的权限，调用**直接抛错**而不是静默失败；声明式插件同样受限，不存在后门。

**沙箱与看门狗**：代码插件在新 V8 realm 里跑（拿不到 `process`/`require`），顶层加载 5 秒、`activate/deactivate` 10 秒（可配）——**关键是调用本身必须发生在 `vm.runInContext` 的那次脚本执行里**，否则死循环会完全脱离看门狗（见第 9 节）。

**诚实的能力边界**：`node:vm` 不是安全边界。自测 `tools/selftest-sandbox.mjs` 会**实测一次原型链逃逸并把结果打印出来**，而不是声称"安全沙箱"。要跑不可信插件就换 `utilityProcess`——`CodePluginRuntime` 只依赖 `ctx` 一个契约，替换点集中在一个文件。

## 7. 聊天链路

```
渲染层 send(text)
  → ipc chatSend（携带 requestId）
  → PetHost.chatFromRenderer（拼接会话历史，上限 40 条）
  → registry.chatProvider（选后端插件）→ resolveProvider（解析 {config:"x"} 引用）
  → streamChat：POST 后端，边读边切行
       ollama           → NDJSON，逐行 JSON
       openai-compatible → SSE，data: {...} / data: [DONE]
  → onDelta → IPC chatDelta → 气泡打字机
  → chatDone / chat-reply 事件（插件也能订阅）
```

一次注入 `systemPrompt`（在 `streamChat` 里做，因此渲染层气泡与插件 `chat.ask` 行为一致）。错误分类明确：连不上后端 → 提示"Ollama 没在跑？"；缺 key → 明确报错而不是发空请求；HTTP 非 200 → 带上响应体片段。

## 8. 可观测性：两套自测 + 一个报告

GUI 应用最难的是"改了以后不知道坏没坏"。这里的做法：

| 层 | 命令 | 覆盖 |
|---|---|---|
| 纯逻辑 | `scripts\selftest.cmd` | 版本协商、清单校验（含攻击面）、插件扫描与状态合并、图集交叉校验、权限表、触发器、**对本地 mock 服务器跑真 HTTP 的流式解析**、代码插件沙箱 |
| GUI 自检 | `scripts\selfcheck.cmd` | 渲染层 bootstrap、动画使画面变化（**像素差分**）、气泡开关、皮肤/状态/帧引用、插件全通过、无渲染层 JS 报错、命中判定心跳、**宠物中心合成探针返回 `pet`** |

`selfcheck` 会写 `.runtime/selfcheck/report.json`（含插件清单、触发器、命令、聊天后端可达性、像素差分、最近日志）与三张截图。像素差分 + 合成探针的意义：把"看着好像能跑"换成可判定的数字。

## 9. 踩坑记录（每条都是真实修过的 bug）

1. **ESM 里 `electron` 的具名导出全部失效** —— 报 `does not provide an export named 'Notification'`。真因不是 ESM，而是环境里 `ELECTRON_RUN_AS_NODE=1`：electron.exe 退化成纯 Node，`electron` 解析到 npm 包（它只导出一个可执行文件路径字符串）。清掉这个变量即可，`scripts\*.cmd` 里已显式清除。
2. **受限环境可能阻止安装器子进程** —— 普通环境使用官方显式安装器；若受限环境确实发生 `spawn EPERM`，可用 `scripts/setup.cmd --sandbox`，由 Python 校验压缩包 SHA-256 后解包。该替代路径不作为普通安装的默认流程。
3. **`vm` 的 timeout 不覆盖后续调用** —— 我在 `runInContext` 里只返回函数、再回宿主 realm 调 `activate()`，插件里一个 `while(true){}` 就能冻结整个应用。修了两次：先在 vm 内调用，再让**调用本身**成为 `runInContext` 那次脚本执行的一部分（`__deskpet_exports.activate(__deskpet_hook_ctx)`）。
4. **函数包装参数与插件代码重名** —— `(function (module, exports, ctx) {…})` 撞上插件顶层的 `let ctx = null`，直接 `SyntaxError`。改成把 `module`/`exports`/`ctx` 作为 vm 全局注入、源码按脚本直接求值。
5. **跨 realm 的 Error 变成 `{}`** —— 插件抛错时日志里只有 `{}`，等于没有诊断信息（`instanceof Error` 跨 realm 为 false）。改为鸭子类型格式化 `name/message/stack`。
6. **命中判定只在变化时上报** —— 自检因此完全观测不到这条链路（指针不动就 0 条上报），一度误报为失败。改为周期性心跳 + **宠物中心合成探针**，顺带把"像素命中真的能分辨本体与透明区"变成可判定事实。
7. **异步日志流在 `app.exit()` 时丢内容** —— 报告写完了、日志却是空的。改成同步 `appendFileSync`。
8. **自检取景被 startup 触发器抢镜** —— "待机"截图里其实是启动问候的动作与气泡。改为确定性取景：先关气泡、重置到待机底座，再截图。
9. **`.cmd` 文件里写中文会被 cmd.exe 按 GBK 拆行** —— 注释也会被当成命令执行。所有 `.cmd` 保持纯 ASCII，中文注释放到 `.ts`/`.mjs`/`.md`。
10. **PowerShell 里动态 `import()` 绝对 Windows 路径需要 `file://`** —— 否则 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。测试脚本里统一用 `pathToFileURL`。
11. **缺聊天后端插件包** —— 接口写好了、界面也接好了，但 `packs/` 里没有 `kind: chat` 的包，等于默认不可用。是自测的"两个内置聊天后端都在"用例把它抓出来的。

## 10. 环境适配（这台机器特有的三件事）

| 现象 | 处理 |
|---|---|
| `ELECTRON_RUN_AS_NODE=1` 被继承 | 所有启动脚本显式 `set "ELECTRON_RUN_AS_NODE="`，否则 GUI 与 Electron API 全都没有 |
| 系统 `%APPDATA%` 不可写（受限沙箱） | 检出/开发运行时**默认**把数据目录指向项目内 `.runtime/userdata`（打包版才用系统 userData），也可用 `--data-dir=<路径>` / `DESKPET_DATA_DIR` 覆盖 —— 于是「一个文件夹拿走全部内容」，项目外不留文件 |
| Chromium 多进程 IPC 需要命名管道 | 受限沙箱下会 `FATAL: mojo platform_channel.cc: 拒绝访问 (0x5)`；正常终端直接跑，沙箱内需要 `--no-sandbox` |

## 11. 下一步的扩展点

- `utilityProcess` 隔离代码插件（替换点已收敛在一个文件）。
- 打包（electron-builder）+ 开机自启 + 托盘菜单（`launchAtLogin` 配置项已留）。
- 面板类插件（`kind: "panel"`，用 `deskpet://pack/<id>/panel.html` 开独立窗口）。
- Live2D 已通过独立 SkinView 适配器复用 PixiJS / pixi-live2d-display / 官方 Core，Hiyori 为可选本机测试模型。标准参数继承视线、表情和口型，原生动作按拖拽／休息优先级暂停与恢复；详见 LIVE2D-SETUP.md，公开分发许可另行核对。
- 多显示器 DPI 的真机验证与位置恢复策略。

## 构建和缓存

构建由 tools/build.mjs 统一执行，Windows CMD 为兼容入口。动作模板自动生成；删除过期的编译模块，preload 只保留 .mjs 与对应源映射。官方 Electron 运行时通过 tools/setup-runtime.mjs 按需安装，普通编译和逻辑测试不需要它。

插件数据 JSON 在一次扫描周期内缓存，返回结构化副本避免调用方污染；scan/reload 重新读取磁盘。互动循环停止时释放包括通配事件在内的所有订阅，重新启动时重置生命周期状态。
