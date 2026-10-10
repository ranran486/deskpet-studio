# 运行与环境

## 普通安装

Windows 10/11 x64，Node.js 22.12+（本项目验证使用 Node.js 24）。在项目根目录运行：

~~~sh
npm ci
npm start
~~~

npm ci 按锁文件安装依赖。Electron 44 使用显式安装器；npm start 会在首次启动时调用它，也可先执行 npm run setup:runtime。默认使用 npm 官方仓库，未强制设置全局镜像。没有 API Key 也能使用全部本地互动和文案。

Windows 快捷入口：scripts/setup.cmd 安装；scripts/start.cmd 构建并运行；scripts/launch.vbs 无控制台启动；scripts/create-shortcut.cmd 创建快捷方式。启动器只在源文件较新时重建。

## 受限环境的可选处理

如果普通 npm 安装因为环境禁止生命周期子进程而失败，可用 scripts/setup.cmd --sandbox。它先安装依赖而不运行安装钩子，再用 Python 3.9+ 下载运行时；压缩包与官方 Electron SHA-256 对照后才解包。此路径只用于 Windows，不是普通用户的默认流程。

如果 Chromium 沙箱受环境限制，显式使用 npm start -- --no-sandbox，或在本机 .runtime/launch-flags.txt 中配置该参数。不要把这种环境配置写入公开源码。

## 角色与互动

首次默认蓝鲸，橘猫可在「外形与模型」切换。已有配置保留。双击喂食，按住头顶轻抚，身体下部单击，左键拖拽，右键选择动作或打开设置。趴姿身体藏在任务栏后；其他姿势保持地面边界。Alt+P 显示/隐藏。

文案在「动作与互动语言」按组编辑，保存即时生效，所有人物共用；参见 DIALOGUE-SETTINGS.md。图片、帧序列、Aseprite 图集和分层 PSD 可从模型页导入，动作继承见 ACTION-TEMPLATES.md。

## 聊天与 Live2D

DeepSeek 地址、模型、Key、性格与自动表情在「聊天与人格」设置。Key 和用户数据留在本机 .runtime/userdata。真实云端可用性要用自己的接口验证，测试脚本只使用本地模拟服务。

Live2D Core 与官方日和是可选安装，不包含在公开源码中。阅读官方条款后执行 npm run setup:live2d -- --accept-live2d-license，再重启或重新加载模型库。完整绑定取决于模型自身，只有图片不能自动得到真实 Live2D 全身变形。详见 LIVE2D-SETUP.md。

## 检查与报告

npm test 验证配置、插件、导入、语义动作、文案和源码工作流，不依赖官方模型。npm run selfcheck 检查真实窗口；test:gameplay、语言和边缘姿势脚本验证实际互动。GUI 测试在交互式桌面运行；原生全屏检查需要真实前台焦点，缺少条件时明确记录未覆盖项。

报告、截图、测试临时目录位于 .runtime。反馈应包含版本、显示缩放、模型、复现步骤和实际行为；分享日志前检查私人对话，不要分享 Key。
