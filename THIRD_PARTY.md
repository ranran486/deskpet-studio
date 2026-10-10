# 第三方来源与素材记录

## Petra

参考项目 [Wumiu/Petra](https://github.com/Wumiu/Petra)，版权 Copyright (c) 2026 Wumiu(FengLing)，MIT 全文在 `LICENSES/Petra-MIT.txt`。

参考其视线跟随、摸头与拖动阈值、漫游和躲避、待机、整点播报，以及 PSD 转 2.5D 管线。桌面宿主沿用本项目的 Electron 实现。未使用其角色 PSD、PNG、声音、麻将模块或 logo。

## Anime2.5DRig

[852wa/Anime2.5DRig](https://github.com/852wa/Anime2.5DRig)，版权 Copyright (c) 2026 hakoniwa，MIT 全文在 `LICENSES/Anime2.5DRig-MIT.txt`。

PSD 装配使用现有 vendored `src/main/skin/vendor/rigger.cjs` 与 `genericparts.cjs`，许可证同步到构建目录。项目自己的 `rig.ts` 将内核结果转为可序列化皮肤契约，渲染端采用 Canvas2D 整层变换。

## ag-psd

[Agamnentzar/ag-psd](https://github.com/Agamnentzar/ag-psd)，MIT 全文在 `LICENSES/ag-psd-MIT.txt`。

已作为运行期依赖接入，版本由 package-lock.json 锁定。主进程采用原始像素数据和 typed-array ImageData 工厂，不需要 node-canvas。仅在 PSD 导入时加载。

## pngjs

[yahoo/pngjs](https://github.com/pngjs/pngjs)，MIT，包内保留许可文本。仅为开发依赖，用于把 imagegen 输出打包成图集、预览和快捷方式图标；桌宠运行时不加载它。

## 蓝鲸角色

用户提供的蓝发女仆三视图作为参考，使用内置 imagegen 工具制作透明素材；图集包装脚本与提示词见 `packs/blue-maid/ASSET-NOTES.md`。该角色美术不随第三方代码自动获得 MIT 许可，其权利归原权利人；公开范围与待补充的署名记录见 ASSET-LICENSE.md。

## Live2D

适配器支持官方 Cubism Core 与 [Live2D/CubismWebSamples](https://github.com/Live2D/CubismWebSamples) 的 Hiyori。它们不包含在公开源码包中；可选安装器从官方来源下载，并在本机 packs/hiyori-live2d/SOURCES.json 记录来源与 SHA-256。Core 与素材分别适用 [Core 条款](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) 和 [免费素材条款](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)，下载、使用与对外分发的条件分别核对。

## PixiJS 与 pixi-live2d-display

[pixijs/pixijs](https://github.com/pixijs/pixijs) 6.5.10 与同版本 `@pixi/unsafe-eval` 为运行依赖，锁定在 package-lock.json，均为 MIT。后者使用官方兼容补丁在禁止 JS eval 的 CSP 下运行，未开放 script-src unsafe-eval。

[guansss/pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) 0.4.0 的 Cubism 4 UMD 分发文件直接复用于 `src/renderer/vendor/cubism4.min.js`，MIT Copyright (c) 2020 Guan。未重写模型解析或物理内核。使用 vendored 运行文件避免其包中仅用于发布文档的 gh-pages 进入桌宠运行依赖。MIT 全文分别为 `LICENSES/PixiJS-MIT.txt` 与 `LICENSES/pixi-live2d-display-MIT.txt`；版本、源地址与文件 hash 在 vendor/SOURCES.json。

## Windows 全屏检测

检测独占 D3D 的方法改写自 [microsoft/PowerToys 的 game_mode.h](https://github.com/microsoft/PowerToys/blob/main/src/common/utils/game_mode.h)，MIT Copyright (c) Microsoft Corporation。许可保存在 `LICENSES/PowerToys-MIT.txt`。补充 DWM 前台窗口与显示器大小判定，排除桌面、自己的窗口和普通最大化窗口，使用 DPI 感知坐标。以隐藏的只读 PowerShell helper 运行，不安装 Node 原生模块或修改全局执行策略。

## 对照项目

[GenhuiC-sudo/11](https://github.com/GenhuiC-sudo/11)，MIT Copyright (c) 2026，许可全文保存在 `LICENSES/GenhuiC-11-MIT.txt`。借鉴五种投喂、连续投喂嫌弃、心情、睡眠、姿势和粒子玩法，在当前 Electron 中实现；未整体移植 PySide 程序。该仓库为原型，角色图片权利与代码许可分开处理。蓝鲸新增表情与姿势由用户参考图通过 imagegen 生成，提示词分别保存在 source-expressions、source-poses；不使用对照项目的角色图。

[LorisYounger/VPet](https://github.com/LorisYounger/VPet) 用于对照状态驱动、动作与交互分离；本轮没有复制其角色资产或整体程序。

[Yanchen-J/DesktopPetLive2D](https://github.com/Yanchen-J/DesktopPetLive2D) 与 [One1turn/Live2D-DesktopPet](https://github.com/One1turn/Live2D-DesktopPet) 用于对照 Electron/Pixi 模型加载、参数口型和原生动作调用；未整体复制其应用。

[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) 用于后续语音、打断与表情协议设计参考。它的后端、前端和模型应分别核对各自许可，本轮没有整体复制其前端或角色素材。
