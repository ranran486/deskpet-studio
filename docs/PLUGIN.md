# 插件开发手册

一个插件 = **一个文件夹 + 一个 `plugin.json`**。文件夹丢进项目的 `plugins/`（检出开发时最方便，能进版本管理）、或 `<数据目录>/plugins/`（运行期热装，数据目录见 `scripts\start.cmd --doctor` 输出），或放进仓库的 `packs/` 作为内置插件。

- `runtime` 决定**怎么执行**：`data`（纯资源）/ `declarative`（只写触发器）/ `javascript`（写代码）
- `kind` 决定**贡献什么**：`skin` / `action` / `theme` / `chat` / `behavior`

骨架：

```
my-plugin/
  plugin.json        清单（必需）
  index.js           runtime=javascript 时的入口
  spritesheet.png    skin 用
  atlas.json         skin 用
  states.json        skin / action 用
  tokens.json        theme 用
```

---

## 1. 清单字段

```jsonc
{
  "manifestVersion": 1,              // 固定 1
  "id": "com.example.my-pet",        // 全局唯一，只允许字母数字与 . _ -
  "name": "我的桌宠",
  "version": "1.0.0",                // 必须 x.y.z
  "description": "一句话说明",        // 建议填（缺了会给 warning）
  "author": "you",                   // 建议填
  "homepage": "https://…",
  "icon": "preview.png",             // 内置图标名或包内相对路径

  "kind": "skin",                    // skin | action | theme | chat | behavior
  "runtime": "data",                 // data | declarative | javascript
  "engine": { "deskpet": ">=0.1.0 <1.0.0" },   // 版本协商，语义同 npm range

  "permissions": ["pet:speak"],      // 代码/声明式插件必须显式申请
  "configSchema": {                  // 宿主据此生成设置界面，并喂给插件
    "model": { "type": "text", "label": "模型", "default": "qwen2.5:7b" }
  },
  "network": { "hosts": ["api.example.com"] },  // 申请 network 权限时必填白名单

  "data": {                          // 资源引用（相对包内路径，禁止绝对路径与 ..）
    "spritesheet": "spritesheet.png",
    "atlas": "atlas.json",
    "states": "states.json",
    "tokens": "tokens.json",
    "chat": { }
  },

  "entry": "index.js",               // runtime=javascript 必填
  "sdkVersion": "0.1.0",
  "triggers": [ ],                   // runtime=declarative|javascript 时可用
  "provides": { "states": ["idle"] } // 纯展示信息
}
```

**版本协商**：`engine.deskpet` 不匹配当前宿主版本时，插件会被标记为不兼容并拒绝加载（错误信息里写明双方版本）。支持 `*` `1.2.x` `>=` `<=` `>` `<` `=` `^` `~`、空格表示 AND、`||` 表示 OR。

**校验与安全**：加载时会检查 JSON 合法性、字段类型、`data.*` 与 `entry` 是否存在、路径是否越界（绝对路径 / `..` 逃逸一律拒绝）、`triggers` 结构、正则合法性、权限名合法性、`configSchema.select` 是否有 `options`。校验不过的插件不会加载，原因会出现在 `--doctor` 与自检报告里。

---

## 2. 外形包（`kind: skin`, `runtime: data`）

`atlas.json`（Aseprite 的 json-hash 导出是超集）：

```json
{
  "frames": {
    "idle_0": { "x": 0,   "y": 0, "w": 128, "h": 128 },
    "idle_1": { "x": 128, "y": 0, "w": 128, "h": 128 }
  },
  "meta": { "size": { "w": 3200, "h": 128 }, "frameSize": { "w": 128, "h": 128 } }
}
```

`states.json`：

```json
{
  "default": "idle",
  "drag": "drag",
  "talk": "talk",
  "states": {
    "idle": {
      "fps": 6, "loop": true,
      "clips": [
        { "frames": ["idle_0", "idle_1", "idle_2", "idle_3"], "weight": 3 },
        { "frames": ["idle_look_0", "idle_look_1"], "weight": 2 },
        { "frames": ["idle_tail_0", "idle_tail_1"], "weight": 1 }
      ]
    },
    "wave":  { "fps": 8, "loop": false, "next": "idle",
               "clips": [{ "frames": ["wave_0", "wave_1", "wave_2", "wave_3"] }] },
    "talk":  { "fps": 10, "loop": true,  "clips": [{ "frames": ["talk_0", "talk_1"] }] }
  }
}
```

**动画语义**（照这个写就不会踩坑）：

- 底座状态（`default`，通常 `idle`）：一个 clip 播完 → 停 0.4~2.6 秒 → **按 `weight` 加权随机抽下一个 clip**。这就是"待机动作"的来源，所以待机状态一般配多个 clip。
- `loop: false` 且不在底座：播完进 `next`（没写则回到底座）。
- 拖动时自动用 `drag` 指定的状态，说话时自动用 `talk` 指定的状态（两者都是临时压栈，结束自动弹回）。状态名可以随便起（`happy` / `sleep` / `purr` 都行），插件用 `pet.react` / `pet.setState` 触发。
- 所有帧名必须能在图集里找到；引用不存在的帧会在自检里报错。

**自定义外形的最小路径**：把 Aseprite 导出的横排精灵图 + json-hash 图集丢进文件夹，按上面的结构补一份 `states.json`，写 `plugin.json`，就完成了。参考生成器 `tools/make-default-skin.py`（Pillow 参数化作图，可重复运行）。

可选字段：`anchor`（默认 `{x:0.5,y:1}` 底部居中）、`scale`、`frameSize`。

---

## 3. 动作包 / 主题包（`data`）

- **动作包**：`kind: "action"`，可以只提供 `data.states`（与皮肤状态**合并**：同名覆盖、新名追加），也可以只提供 `triggers`，或两者都给。启用/禁用即时生效。
- **主题包**：`kind: "theme"`，`data.tokens` 指向：

```json
{
  "bubbleBackground": "rgba(28,30,38,.94)",
  "bubbleColor": "#f2f4f8",
  "bubbleBorder": "1px solid rgba(255,255,255,.12)",
  "bubbleRadius": "14px",
  "bubbleFontFamily": "\"Microsoft YaHei\", sans-serif",
  "bubbleFontSize": "14px",
  "bubbleMaxWidth": "280px",
  "bubbleShadow": "0 8px 26px rgba(0,0,0,.34)",
  "accent": "#6ea8ff",
  "extra": { "--my-var": "1px solid red" }
}
```

---

## 4. 聊天后端（`kind: chat`, `data`）

```jsonc
"data": {
  "chat": {
    "type": "ollama",                       // 或 openai-compatible
    "baseUrl": { "config": "baseUrl" },     // 也可以用字面量字符串
    "model": { "config": "model" },
    "systemPrompt": { "config": "persona" },
    "temperature": 0.8,
    "apiKeyRef": "builtin.chat-openai",     // 密钥存在用户配置里，不写进包
    "requiresApiKey": true
  }
}
```

- `type: "ollama"` → `POST {baseUrl}/api/chat`，NDJSON 流式（`{message:{content},done}`）。
- `type: "openai-compatible"` → `POST {baseUrl}/chat/completions`，SSE 流式（`data: {...}` / `data: [DONE]`）。DeepSeek、通义、vLLM、LM Studio、OpenRouter 都吃这套。
- **`{ "config": "字段名" }` 是配置引用**：运行期按该插件 `configSchema` 的默认值 + 用户覆盖解析。所以换个模型、换个地址都不用改代码。
- 密钥：`config.secrets[apiKeyRef]`，只在用户目录里；缺失时给出明确报错而不是发空请求。
- 多个 `kind: chat` 插件同时存在时，用配置里的 `chatProvider` 选择默认，也可以在调用时指定 `providerId`。

---

## 5. 声明式触发器（`runtime: declarative`）

```jsonc
"triggers": [
  {
    "id": "idle-ask-pet",
    "when": { "on": "idle", "idleSeconds": 45, "cooldownSeconds": 600 },
    "actions": [
      { "type": "pet.react", "reaction": "wave" },
      { "type": "pet.speak", "message": "要不要摸摸我？", "durationMs": 4000 }
    ]
  }
]
```

### `when` 字段

| 字段 | 适用 `on` | 说明 |
|---|---|---|
| `on` | 全部 | 见下表事件名 |
| `everyMinutes` | `timer` | 每 N 分钟；可写 `{ "config": "interval" }` |
| `at` | `timer` | 每天 `HH:mm`；可写配置引用。每 20 秒检查一次，同一天只触发一次 |
| `idleSeconds` | `idle` | 空闲达到 N 秒（宿主每秒检查；触发后重新计时） |
| `match` | `chat:message` | 只响应匹配该正则的消息 |
| `cooldownSeconds` | 全部 | 两次触发的最小间隔；`idle` 建议配大一点 |
| `once` | 全部 | 只触发一次，之后自动停用 |
| `state` | `state:enter`/`state:exit` | 限定状态名 |

事件名：`startup` `ready` `tick`（每秒）`timer` `idle` `click` `double-click` `right-click` `drag:start` `drag:end` `chat:message` `chat:reply` `state:enter` `state:exit` `skin:changed` `plugin:enabled` `plugin:disabled`。

### `actions` 全表（第二列是该动作需要的权限）

| 动作 | 权限 | 说明 |
|---|---|---|
| `{ "type": "pet.speak", "message": "…", "durationMs": 4000 }` | `pet:speak` | 气泡说话（打字机效果），并切到 `talk` 状态 |
| `{ "type": "pet.react", "reaction": "wave" }` | `pet:react` | 播一次动作后自动回到原位 |
| `{ "type": "pet.setState", "state": "sleep" }` | `pet:state` | 切状态（不自动回退） |
| `{ "type": "pet.skin", "skin": "com.example.other" }` | `pet:skin` | 换外形 |
| `{ "type": "pet.move", "dx": 20, "dy": 0 }` / `{ "type": "pet.move", "to": "right" }` | `pet:move` | 移动；`to` 取 `left/right/top/bottom/center`，会夹在当前屏工作区内 |
| `{ "type": "bubble.hide" }` | `bubble` | 收起气泡 |
| `{ "type": "notify", "title": "…", "body": "…" }` | `notify` | 系统通知 |
| `{ "type": "storage.set", "key": "k", "value": 1 }` | `storage` | 写插件私有存储 |
| `{ "type": "storage.inc", "key": "k", "by": 1 }` | `storage` | 计数自增 |
| `{ "type": "log", "message": "…" }` | — | 写宿主日志 |
| `{ "type": "run", "handler": "startFocus", "args": { "minutes": 25 } }` | — | 调代码插件注册的 handler（`runtime: javascript`） |
| `{ "type": "chat.ask", "prompt": "说一句鼓励的话" }` | `chat` | 向当前聊天后端提问，并把回答说出来 |

**权限是硬约束**：动作需要的权限没在 `permissions` 里声明，宿主会拒绝执行并写一条 warning。声明式插件和代码插件走**同一张权限表**（`src/main/permissions.ts`），不存在"声明式就能绕过"的后门。

---

## 6. 代码插件（`runtime: javascript`）

`entry` 指向的 JS 跑在 `node:vm` 起的**新 realm** 里：拿不到 `process`、`require`、Node 内置模块，只有下面这个 `ctx`。`module` / `exports` / `ctx` 都是注入的全局，所以可以直接用 CommonJS 写法，顶层声明 `let ctx = null` 也不会冲突。

```js
let ctx = null
let timer = null

module.exports = {
  activate(context) {
    ctx = context
    ctx.log('已授权：' + context.permissions.join(', '))

    ctx.handle('startFocus', (args) => { /* 供 { "type": "run" } 调用 */ return { ok: true } })
    ctx.registerCommand({ id: 'focus25', title: '番茄钟 25 分钟', run: () => {} })
    ctx.on('click', (payload) => ctx.say('别戳我啦'))
    timer = ctx.timer.every(60_000, () => ctx.say('起来动动'))
    ctx.storage.set('count', Number(ctx.storage.get('count', 0)) + 1)
  },
  deactivate() {
    if (timer) timer()      // 卸载时宿主也会兜底清理
  },
}
```

### `ctx` API

| 成员 | 需要的权限 | 说明 |
|---|---|---|
| `ctx.id` / `ctx.version` / `ctx.config` / `ctx.permissions` | — | 只读信息；`config` 已合并默认值与用户覆盖 |
| `ctx.has(permission)` | — | 查询是否授权 |
| `ctx.log(...args)` | — | 写宿主日志（带插件 id 前缀） |
| `ctx.on(event, handler)` | — | 订阅事件，返回取消订阅函数；卸载时自动清理 |
| `ctx.handle(name, fn)` | — | 注册 handler，`fn` 可返回 Promise；`run` 动作与命令都指向它 |
| `ctx.say(text, { durationMs })` | `pet:speak` | 说话 |
| `ctx.react(state)` | `pet:react` | 播一次动作 |
| `ctx.setState(state)` | `pet:state` | 切状态 |
| `ctx.setSkin(pluginId)` | `pet:skin` | 换外形 |
| `ctx.move({ dx, dy, to })` | `pet:move` | 移动窗口 |
| `ctx.registerCommand({ id, title, run })` | `command` | 右键菜单里出现 |
| `ctx.notify(title, body)` | `notify` | 系统通知 |
| `ctx.storage.get/set/delete/all` | `storage` | 私有持久化 → `<数据目录>/plugin-data/<id>.json`（即 `.runtime/userdata/plugin-data/`） |
| `ctx.timer.every(ms, fn)` / `ctx.timer.after(ms, fn)` | `timer` | 返回取消函数；卸载时全部清理 |
| `ctx.fetch(url, init)` | `network` | 受 `network.hosts` 白名单限制，越界抛错 |
| `ctx.chat(messages, { provider, onDelta })` | `chat` | 调聊天后端，返回完整文本；`onDelta` 拿流式增量 |

未授权的调用会**直接抛错**（不会静默失败），错误信息形如 `插件 x 未申请权限「pet:skin」，调用被拒绝`。

### 加载与生命周期

1. 扫描 → 校验 `plugin.json` → 版本协商 → 解析 `configSchema` 默认值。
2. 顶层脚本在新 realm 内求值（上限 5 秒，防死循环）。
3. 调用 `activate(ctx)`（上限 10 秒；同步死循环会被 vm 掐断）。
4. 禁用/重载时调用 `deactivate()`，然后清理它注册的 timer / handler / 命令 / 事件订阅。
5. 插件本身抛错不会影响宿主：加载失败会被记录，插件不会被标记为已加载。

---

## 7. 调试

```bat
scripts\start.cmd --doctor    :: 不开窗口，只打印插件扫描/校验结果与错误原因
scripts\selfcheck.cmd         :: 开窗口跑一遍并截图，报告在 .runtime\selfcheck\report.json
scripts\selftest.cmd          :: 纯逻辑自测（协议、权限、触发器、沙箱、流式解析）
```

- 日志：`<数据目录>\logs\deskpet.log`（检出运行时就是 `.runtime\userdata\logs\deskpet.log`；打包版才是 `%APPDATA%\deskpet\logs\`），同步落盘，崩溃也不丢。
- 改完插件后不必重启：宿主提供 reload（设置界面/`pluginReload` IPC），用户插件目录里的改动会重新扫描。
- `config.json` 与 `plugin-config` 就在数据目录下，手改也生效。

---

## 8. 限制与升级路径

| 限制 | 说明与对策 |
|---|---|
| `node:vm` 不是安全边界 | 能防误伤，防不住敌意。`tools/selftest-sandbox.mjs` 会实测并打印逃逸结果。要跑不可信插件，把 `CodePluginRuntime` 换成 `utilityProcess`/`worker_threads` + `MessagePort`：该运行时只依赖 `ctx` 一个契约，替换点集中在一个文件 |
| 插件回调里的死循环 | 看门狗覆盖顶层加载与 `activate/deactivate`；回调（timer / handler / 事件）里的死循环仍会卡住主进程。同上，用进程隔离 |
| 插件之间不能直接通信 | 目前各自独立；需要协作就通过宿主能力（存储、事件、聊天）中转 |
| 没有沙箱化的 UI 扩展点 | 代码插件不能画自己的界面，只能通过气泡说话。需要的话再加 `kind: "panel"`（宿主开一个独立窗口，用 `deskpet://pack/<id>/panel.html` 加载） |
| Live2D | 已实现。data.live2d 指向完整 model3.json，导入时拷贝 moc3、纹理、物理、表情和动作。复用 PixiJS 与 Cubism Core；本机测试已获同意，公开分发许可单独核对 |
