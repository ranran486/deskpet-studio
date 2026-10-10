# 基于现有动作的人物模板

0.2.0 的模板直接提取蓝鲸现有 37 帧动作和现有行为协议，保留动作版本 v1。模板不包含新人物美术，也不会把蓝鲸的帧复制成另一个角色。

## 模板内容

`templates/actions-v1/template.json` 记录现有 idle、walk、sleep-curl、peek-left、peek-right、lounge-bottom、hang-top、drag-lift 八个身体动作，以及害羞、开心、惊讶、生气、瞌睡、晕鱼、喜欢、无语八种表情。骨架坐标、动作优先级、160ms 表情过渡、90 秒瞌睡、边缘停留与离开冷却均沿用当前程序。`template.json` 是素材制作参考；运行时通过角色自己的 `action-profile.json` 绑定动作，状态帧与速度仍由该角色的 `states.json` 控制。

拖拽优先于边缘姿势，边缘姿势优先于普通互动；同一人物的口型、视线和情绪通过相应渲染器协调。Live2D 缺少的参数不写入，存在的参数按模型范围限幅和平滑。旧皮肤未提供 profile 仍可使用原有语义回退。

## 更换人物

1. 设置 → 外形与模型 → 导入新人物。PNG/帧序列、PSD、Live2D 导入器自动生成 `action-profile.json`。
2. 右键 → 设置 → 外形与模型 →「导出当前人物动作模板」，选择文件夹，得到当前绑定及三类模板。命令行 `npm run template:actions` 也可重新导出蓝鲸现有动作。
3. 修改新人物目录的 `action-profile.json`，将右侧名称换成该人物已有名称，并在 `plugin.json` 的 `data.actionProfile` 指向此文件。已有插件可运行 `npm run template:bind -- --skin "E:\路径\人物目录"`；已存在文件需显式 `--force` 才会覆盖。
4. 重新加载插件或重启。设置页显示已绑定与替代项，可逐项预览。

精灵示例：

```json
{
  "version": "deskpet-character-actions/1",
  "kind": "sprite",
  "states": { "idle": "Resting", "walk": "Locomotion", "shy": "Flustered", "drag-lift": "Grabbed", "talk": "Chattering" },
  "anchors": { "collar": { "x": 0.5, "y": 0.08 }, "peek": { "left": 0.4, "right": 0.6 } }
}
```

精灵 `states` 左侧是框架语义，右侧是人物自己 `states.json` 的状态名；各状态引用本人物图集。PSD 的 `joints` 可覆盖自动识别的关节，坐标为角色局部 0..1；仍需分层素材。Live2D 的 `parameters` 将标准参数映射为模型参数 ID，`expressions` 绑定原生表情名，`motions.wave` 指定原生动作组与索引。衣领抓点和窥探线同样使用局部 0..1，与窗口像素无关。0.2.1 增加精灵 `anchors.hangY`（脚部挂点）和 `anchors.loungeY`（趴伏手部接触线）；蓝鲸分别为 0.06、0.78，可按新人物的画面调整。倒挂接触屏幕顶边，趴伏接触任务栏上沿并遮住身体。

## 适配与验证

新人物没有蜷缩、趴桌沿、倒挂或挣扎素材时，框架使用已有动作回退；这能继承交互流程，不能自动补画四肢。日和当前使用闭眼、头身轻摆等替代。只有一张图片的角色，需要补画动作帧、拆 PSD 层或制作 Cubism 变形后才能得到完整肢体效果。

检查顺序：预览表情 → 走动 → 边缘停留 → 拖起与释放 → 睡眠唤醒 → 聊天叠加 → 切换人物。尤其确认衣领抓点、底部落地、顶部倒挂、左右裁切是否符合该人物比例。程序测试使用了状态全部改名的橘猫，验证自身素材绑定、抓点、导出与来回切换。

参考 [Petra](https://github.com/Wumiu/Petra) 的桌宠素材管线、[VPet](https://github.com/LorisYounger/VPet) 的行为组织、[pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) 的参数与原生动作接口。保留现有 Electron 技术栈，未整体复制其他项目。
