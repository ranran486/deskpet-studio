# 发给其他人内测

当前准备 Windows 10/11 x64 的框架内测版，使用 electron-builder + NSIS。按用户要求，默认是蓝发女仆「蓝鲸」，可切换本项目从代码生成的橘猫；未包含日和或 Live2D Core。蓝鲸的美术权利仍按原素材来源处理，不随第三方代码获得 MIT 许可。

## 发什么

在 `release/framework-beta` 中取这三个文件：

- `DeskPet-Framework-Beta-0.2.3-beta.1-Setup-x64.exe`
- `内测说明.txt`
- `SHA256SUMS.txt`

可以用微信、QQ、邮件附件或私有网盘发给测试者；本轮没有上传或代发。对方下载到本机后双击安装 EXE，安装器会建立桌面和开始菜单快捷方式，首次安装后启动。无需安装 Node、npm、Python 或 Git，也不需要管理员权限。

此安装包为未签名内测构建，Windows 可能显示发布者未知或信誉提示。测试者应确认发送者与文件哈希；正式分发时再配置代码签名。本机打包程序检查不代替不同电脑的实测。

## 测试者配置

未填写 API Key 也能测试全部本地互动、离线聊天、拖动、气泡、边缘待机、动作模板、设置与模型导入。文字 AI 对话需要在右键 → 设置 → 聊天与人格 → DeepSeek 填自己的 Key，点击「保存 Key」，再测试实际对话。

每个人的配置、密钥、日志和导入素材保存在自己的 Windows 用户数据目录中，与安装文件分开。安装包不携带开发者的配置、密钥、日志或聊天记录。

如果希望所有人不用填 Key、由你统一承担费用，下一阶段搭建带用户凭据、限额和限流的服务端代理，再让客户端连接它。不要把你的真实 DeepSeek Key 放进 EXE、共享配置或发给所有测试者。

## 一键打包

以后可以双击 `scripts/package-beta.cmd`。命令行等价入口：

```powershell
cd E:\dev\deskpet
npm run dist:beta
```

如果首次下载 NSIS 编译工具无法连接 GitHub，可运行：

```powershell
npm run dist:beta -- --mirror
```

镜像只提供编译工具下载，electron-builder 仍使用上游固定哈希验证。缓存位于项目 `.runtime/cache/electron-builder`。该设置不会改变桌宠的网络接口。

`npm run dist:beta:dir` 仅生成未压缩的程序目录，用于开发检查。发给别人时通常选 Setup EXE，不要只发 `win-unpacked` 里的主 EXE，因为主程序需要同目录的运行文件。

打包使用白名单，只有编译后的代码、指定内置插件、蓝鲸运行图集与预览、自制橘猫、图标、必要依赖和许可进入产物。开发用 `.runtime`、用户 plugins、测试工具、生成源图、源映射、Core 和日和均不进入。`package-audit.json` 记录文件目录审核结果。

## Live2D 内测版

本地安装和测试不自动包含向第三方提供模型与 Core 的使用。Live2D Core 协议将向第三方提供使用计入分发；对于可自由添加角色模型的 Expandable Application，协议列明额外申请与审批条件。小规模或非商业内测也不能直接推定为豁免。

依据 [Live2D Core 协议第 1.5、2.1、2.2 节](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) 和 [样例素材协议](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)，需要分别核对 Core、应用类型和日和素材。可向 Live2D 说明这是 Windows 桌宠，允许用户导入模型、预计测试人数、收费方式和测试用途，取得适用的确认或协议后再准备相应发行配置。本项目当前仍保留完整本机 Live2D 开发版本。

## 反馈与后续迭代

让测试者记录版本、Windows 版本、显示器缩放、问题步骤、期望行为与实际行为，附截图。分享日志前先检查是否含私人聊天内容；不要发 API Key。

下一版发布时增加安装包版本号，并保持同一内测 appId。NSIS 支持重新安装更新；目前未接自动更新服务器，测试者需要重新下载安装包。若要网盘链接自动更新、集中收集反馈或统一 AI 后端，分别增加对应服务即可。
