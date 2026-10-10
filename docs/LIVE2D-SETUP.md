# Live2D、DeepSeek 与本地环境

记录日期 2026-10-09。已选择先用现成美少女验证，再制作自己的蓝发女仆；文字聊天和口型优先，语音后续。性格允许自定义，平时轻度活动，全屏游戏或演示时安静。

## 当前电脑是否够用

本机已检测到 Windows 11、Ryzen 9 8940HX（16 核 / 32 线程）、约 16GB 内存、RTX 5060 Laptop（nvidia-smi 报告 8151 MiB 显存），另有 AMD 核显。Node 24.21.0、npm 11.19.0、Python 3.14.7、VS Code、Git 与 .NET 已存在。

现有 Electron 环境足够运行 Live2D 桌宠和 DeepSeek 云端聊天，本轮已在本机实际渲染。桌宠继续沿用 TypeScript、Electron 和 WebGL，无需迁移整个项目或安装 CUDA。现在的精细动作限制主要是模型绑定与美术素材，升级硬件不能替代分层和建模。

约 16GB 内存可以完成当前开发。以后同时开大型游戏引擎、Blender、浏览器和本地语音推理时，32GB 更宽裕；先根据实际任务观察占用。8GB 显存不适合本地完整部署大型 DeepSeek 服务模型，当前使用云端 API 合适。

## 现在的 Live2D 管线

直接复用 [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) 0.4.0 的 MIT Cubism 4 分发文件和 [PixiJS](https://github.com/pixijs/pixijs) 6.5.10；模型和 Core 来自 [Live2D 官方样例](https://github.com/Live2D/CubismWebSamples)。这套版本已通过本机验证，未宣称支持所有新版 Cubism 特性。

标准参数驱动视线、头身角度、眼睑、眉毛、口型；只写实际存在的参数并限制在模型范围内。进入拖拽或休息时停止原生动作并禁用自动 Idle，退出恢复。头发、衣服等物理继续交给原生模型物理，窗口移动与模型变形分开处理。高 DPI 画布采用最高 2 倍分辨率。

日和没有完整蜷缩、腿部走路或提衣领悬垂绑定，目前是头身轻摆、闭眼休息、原生互动和边缘探头替代。蓝鲸原有帧动画继续保留其专属姿态。统一协议代表行为可继承；某个模型未绘制、未绑定的姿态无法凭空继承。

模型目录至少包含 `角色.model3.json`、`.moc3` 与所引用纹理；物理、动作、表情文件也要齐全。在设置 → 外形与模型 → 导入 Live2D 选择完整目录。导入器校验本地相对路径、缺失文件与大小，拒绝外链和路径逃逸。

官方素材已经准备。重新准备时先阅读 Core 和素材条款，再运行：

```powershell
cd E:\dev\deskpet
npm run setup:live2d -- --accept-live2d-license
npm run build
npm start
```

Core 与样例素材为本地可选安装。每个使用者应先阅读官方条款，再显式接受安装；公开源码不包含这两项资源。适配器及第三方许可见 THIRD_PARTY.md。

## DeepSeek 设置

打开宠物右键 → 设置 → 聊天与人格，选择「DeepSeek · 云端 API」。

| 字段 | 本轮默认与用途 |
| --- | --- |
| Base URL | `https://api.deepseek.com`，程序拼接 `/chat/completions` |
| 模型名 | `deepseek-flash`，另可选择 `deepseek-v4-pro` |
| API Key | 填自己的 Key，然后点击「保存 Key」；不需要在聊天里发送 Key |
| 自定义性格与说话方式 | 自行填写称呼、性格、说话习惯，点击「保存参数」；下一轮生效 |
| 回复时自动表情与小动作 | 可关闭；只允许四种情绪与挥手、点头、歪头 |

接口与模型名按 [DeepSeek 官方文档](https://api-docs.deepseek.com/) 核对。模型别名可能调整，之后以官方文档和「测试连接」为准。测试连接读取模型列表，不等于完成一次真实对话。

回复控制标记在主进程过滤，气泡只显示自然语言。会话按用户／助手顺序保存在内存，退出应用后不保留聊天历史。关闭气泡取消当前请求；已取消请求的结果不会覆盖新一轮回复。

口型目前由文字流触发合成节奏，不含音频、录音、TTS 或真实音素同步。之后接语音时保留同一 `talk` 与表情契约，替换为音量或音素驱动。

本轮使用隔离的本地 SSE 服务验证认证头、请求结构、流式分块、自动情绪、人格保存和会话顺序，没有消费云端费用。当前真实 Key 尚未设置，保存 Key 后需再做一轮实际 DeepSeek 对话。当前 Key 在本机配置文件保存并向渲染界面脱敏，后续可改为 Windows 系统加密存储。

## 自己的蓝发角色制作

1. 从现有图片补画分层美术。至少拆出头、脸、前后发、眼白、瞳孔、上下眼睑、眉毛、嘴、身体、左右手臂、腿与服装；补齐转头和动作时原本被遮挡的部分。
2. 安装 [Live2D Cubism Editor](https://www.live2d.com/en/cubism/download/editor/)，导入 PSD，建立网格和变形器，绑定头身角度、眼睛、嘴型及发丝物理。
3. 用标准参数实现可继承的基础表情；为蜷缩、衣领悬挂与四肢下垂制作专用参数或动作组。幅度大、遮挡关系变化明显的姿态可能需要额外图层或专用姿态素材。
4. 导出 model3.json、moc3、纹理、physics3.json、exp3.json、motion3.json，导入本项目测试拖拽／聊天／待机组合。

现成图片可以作为美术参考，但不能直接转换成与人工绑定同等的精细 Live2D。下一阶段可以在现有统一协议上增加参数别名和动作组映射，而无需重写桌面宿主或聊天接口。

## 后续游戏开发环境

游戏类型暂未确定，先维持当前桌宠环境。试做游戏时建议将工具与项目分开，例如 `E:\dev\tools`、`E:\dev\games`；每个项目固定引擎和依赖版本。

| 工具 | 建议配置 |
| --- | --- |
| Godot | 先下载 [Windows 标准版](https://godotengine.org/download/windows/) 并解压运行；当前官方稳定版为 4.7.2。做 2D 或小型 3D 原型，用 GDScript 即可；使用 C# 时才选择 .NET 版并检查所需 SDK |
| 示例项目 | 从 [godot-demo-projects](https://github.com/godotengine/godot-demo-projects) 选平台跳跃、3D 或 UI 示例，切到与引擎相匹配的稳定分支，保留许可与素材署名 |
| Cubism Editor | 制作自己的 Live2D 时安装；按官方 FREE／PRO 功能选择，先验证工作流再决定付费 |
| Blender | 确定做 3D 素材时再从官方安装；当前桌宠不依赖它 |
| Python / uv | 当前文字聊天不需要额外 Python 服务。语音阶段可用 [uv](https://github.com/astral-sh/uv) 为选定语音项目创建独立 Python 环境，按其版本锁文件选版本，不替换现有 3.14 |
| FFmpeg | 录制、转码或语音音频预处理时按需安装；当前 Live2D 渲染不依赖 |

语音与打断阶段参考 [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)，复用允许使用的模块；其前端、后端、角色模型许可分别核对。本轮未安装整套语音栈、Godot、Blender 或修改全局环境。

## 验证入口

```powershell
npm test
npm run test:ui
npm run test:live2d
npm run selfcheck -- --no-sandbox
```

全屏安静检测采用 PowerToys 的 Windows 通知状态方式，补充前台窗口与显示器边界判断，排除桌面、自身与普通最大化窗口。检测周期约两秒。当前测试覆盖独立全屏窗口进入／退出；不能代替每一款独占、无边框或多屏游戏的实测。

软件不会更改全屏游戏的窗口、输入或进程。桌宠的桌面层级仍保持任务栏前，进入安静模式暂停动画并暂时隐藏气泡，退出恢复。
