# 默认角色素材记录

参考为用户提供的蓝发女仆正侧背三视图。用内置 imagegen 工具去掉背景与文字、保留角色设计，生成真透明 PNG。未经第三方项目提取角色素材。

生成提示词：

> Use case: background-extraction. Asset type: transparent desktop pet character reference sheet. Edit target: attached three-view blue-haired chibi maid. Remove the white background and the three blue Chinese caption labels only. Preserve the exact character design, navy to cyan long hair, blue eyes, lace maid headband, dark blue dress, white whale apron, proportions, linework, colors, poses and FRONT / LEFT PROFILE / BACK order. Arrange three full-body views in one horizontal row on true transparent alpha, each centered in its own equal-width third, with feet on the same baseline, similar height, generous 6% transparent padding around every figure. No text, no ground shadow, no extra characters. This will be used as a game character atlas; clear separated views, no overlapping or cropped hair.

`reference-sheet.png` 为生成的参考图。`tools/pack-blue-maid.mjs` 按视图分组读取 alpha 边界，居中、脚底对齐装入 640×800 格子，不重新绘制角色。运行 `npm run assets:maid` 重建图集、atlas 和三张预览。

`states.json` 中的 motion 是可替换的轻量整体变换。素材没有独立眼睛／嘴／发丝图层，不能据此声称已有精细绑定。准备好分层 PSD 后，在设置中心导入即可使用相同互动接口。

原图的角色权利归其原权利人，用户提供参考不意味着其美术受项目第三方代码的 MIT 许可覆盖。

## 2026-10-09 正式动作包

动作姿态由内置 imagegen 基于此角色生成，源图存于 `source-actions/`，完整提示词见 `../../docs/action-preview-v1/generation-prompts.json`。旧动作有 23 个 640×640 帧。`tools/pack-blue-maid-expressions.mjs` 继续加入八种表情、趴桌沿、倒挂和四帧挣扎，当前共 37 帧，统一脚底和后衣领支点，保留睡眠裁切线。新源图与提示词分别在 `source-expressions/` 与 `source-poses/`。`action-profile.json` 将现有动作绑定到统一行为语义，供换人物适配。

`npm run assets:maid` 先生成三视图预览与快捷方式图标，再生成正式动作图集。动作调度使用 `src/shared/action-model.ts`；精灵图按人物自己的语义 clip 播放，PSD 按图层绑定重定向，旧角色没有对应细节时回退。
