# DeskPet Studio · 蓝鲸桌面伙伴

让桌面多一位会回应你的伙伴。 / A little companion that brings your desktop to life.

Windows 桌宠，基于 Electron、TypeScript 和原生 ESM。当前版本 **0.2.3**。默认角色是蓝发女仆「蓝鲸」，可切换自制橘猫，或导入自己的图片、帧序列和分层 PSD；Live2D 为可选本地扩展。

蓝鲸会回应摸头、戳肚子、喂食和夸夸，根据心情切换表情。拖动、屏幕边缘待机和瞌睡等行为配有动作、气泡台词与粒子特效。没有接入 API 时，角色仍可使用本地文案互动；接入 DeepSeek 后，对话可自动联动表情和小动作。通用动作模板将角色素材、动作映射和互动语言分开配置，方便新人物继承行为，再适配对应素材与参数。

## English

**DeskPet Studio** is an extensible Windows desktop pet built with Electron, TypeScript, and native ESM. Its default companion, **Lan Jing**, reacts to head pats, belly pokes, feeding, praise, and teasing with mood-driven expressions, screen-edge poses, speech bubbles, and floating particles.

Built-in dialogue keeps interactions available without an API. Optional DeepSeek chat can trigger expressions and small gestures; its endpoint, model, API key, and character personality are configurable in Settings. Shared action templates separate behavior, character assets, and dialogue, making it easier to adapt new characters.

### Getting started

Use Node.js **22.12+**; Node.js **24** is the tested recommendation. From the project directory:

~~~sh
npm ci
npm start
~~~

The first launch downloads the Electron runtime through its official installer. No paid API is required for offline interactions. Head pats, belly pokes, double-click feeding, dragging, and the right-click menu provide the main controls; **Alt+P** toggles visibility.

### Rendering and project status

The default character uses sprite assets and existing animations. Layered PSD/2.5D and optional Live2D rendering are also supported. Live2D needs a compatible model and runtime configured separately; new characters need asset or parameter adaptation. A single illustration is not automatically converted into a fully rigged model. Text-driven mouth animation is simulated, with voice support planned for later development.

This is an early beta, primarily tested on Windows. Run `npm test` for build and logic checks; GUI checks require an interactive Windows desktop. See the Chinese sections below and the linked documentation for configuration, development, and packaging.

### Licensing

Original project code is [MIT-licensed](LICENSE); third-party code retains its respective licenses. Lan Jing artwork and derived assets are documented separately in [ASSET-LICENSE.md](ASSET-LICENSE.md) and are not automatically covered by MIT. Original attribution and authorization records remain to be completed by the maintainer. Live2D Core and official sample assets are excluded from this repository and the current beta installer.

## 快速开始

需要 Node.js 22.12+，建议使用经过本项目验证的 Node.js 24。首次安装需要网络，运行普通桌宠不需要 Python、Rust 或付费 API。

~~~sh
npm ci
npm start
~~~

npm start 首次运行会按需调用 Electron 官方安装器下载运行时；也可提前执行 npm run setup:runtime。Windows 也可以运行 scripts/setup.cmd，或双击 scripts/launch.vbs。配置、导入模型、文案和日志保存在本机 .runtime/userdata，不进入源码包。

## 功能

| 模块 | 能力 |
| --- | --- |
| 桌面宿主 | 透明置顶、像素命中与点击穿透、拖拽、位置记忆、Windows 全屏安静 |
| 动作与姿势 | 移动、蜷缩、左右窥探、趴任务栏上沿、顶部倒挂、衣领挣扎；缺少素材时回退 |
| 互动 | 摸头、戳肚子、五种投喂、连续同款嫌弃、夸夸/逗逗、心情、90 秒睡眠与唤醒 |
| 视觉 | 八种事件表情、爱心/星星/zzz 等粒子、简洁气泡 |
| 语言 | 240 条默认文案、51 分组，设置中即时编辑，所有人物共用 |
| 聊天 | 离线关键词回应、DeepSeek/OpenAI 兼容接口、Ollama；云端地址、模型、Key 和性格可配置 |
| 人物适配 | 精灵、PSD 装配、可选 Live2D；action-profile.json 绑定通用动作、参数和抓点 |
| 插件 | 数据、声明式事件与受限 JS；清单、权限、私有存储和重载。JS 运行环境不是强安全隔离，只运行可信插件 |

双击喂食；按住头顶轻抚；点身体下部戳肚子；左键拖动；右键打开动作、互动和设置；Alt+P 显示/隐藏。

底部趴姿把身体藏在任务栏后，手部贴任务栏上沿；倒挂用脚部挂点贴屏幕顶边，气泡放在下方。离开姿势后恢复普通地面边界。

## 开发与验证

~~~sh
npm test
npm run typecheck
npm run test:gameplay
node tools/selftest-dialogue-settings-ui.cjs
node tools/selftest-edge-postures.cjs
~~~

npm test 包含构建和逻辑检查，使用本地模拟服务，不依赖 Live2D 官方素材，不请求付费 API。GUI 检查需要交互式 Windows 桌面；全屏检查还需要测试窗口获得真实前台焦点。测试数据和结果位于 .runtime。

构建由 tools/build.mjs 统一执行，动作模板随构建生成。项目没有额外打包器：主进程、preload、渲染器与 shared 各自使用原生 ESM。

## 源码与发布

~~~sh
npm run source:export
npm run dist:beta
~~~

前者输出只含可发布文件的目录、源码 ZIP 和哈希审核清单；后者生成 Windows NSIS 内测安装器。初次使用请先阅读素材范围和发布说明。

## 文档

- [运行与环境](docs/RUN.md)
- [架构](docs/ARCHITECTURE.md) · [插件协议](docs/PLUGIN.md)
- [动作模板与换人物](docs/ACTION-TEMPLATES.md)
- [互动玩法](docs/GAMEPLAY.md) · [语言设置](docs/DIALOGUE-SETTINGS.md)
- [可选 Live2D 与 API](docs/LIVE2D-SETUP.md)
- [发布源码](docs/OPEN-SOURCE.md) · [内测安装包](docs/BETA-DISTRIBUTION.md)
- [贡献方式](CONTRIBUTING.md) · [更新日志](CHANGELOG.md)

## 许可与来源

代码采用 [MIT](LICENSE)。蓝鲸参考图、派生动作图和图标单独按 [素材范围](ASSET-LICENSE.md) 处理，原画作者与授权记录需维护者补充；自制橘猫为自由示例。Live2D Core 和日和不包含在公开源码中。

第三方来源、版本与许可见 [THIRD_PARTY.md](THIRD_PARTY.md)。参考 Petra、Anime2.5DRig、pixi-live2d-display、PowerToys 等现有实现，保留署名和许可证。
