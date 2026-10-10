# 你自己的插件放这里

往这个目录丢一个文件夹就是一个插件（一个文件夹 + 一个 `plugin.json`）：

```
plugins/
  my-first-pet/
    plugin.json
    spritesheet.png
    atlas.json
    states.json
```

写好之后不用重启：宿主提供 reload（设置界面 / `pluginReload` IPC），下次启动也会自动扫描。

- 完整协议、四类插件的示例、动作与权限对照表、代码插件 `ctx` API：见 [../docs/PLUGIN.md](../docs/PLUGIN.md)
- 想直接抄现成的：`../packs/` 里有 6 个内置插件（外形 / 动作 / 主题 / 两个聊天后端 / 代码插件）
- 校验自己的包：`scripts\start.cmd --doctor` 会打印每个插件的校验结果与错误原因

这个目录是**项目内**的插件目录，好处是能跟着代码一起做版本管理。
运行期热装的插件也可以放在数据目录：`.runtime\userdata\plugins\`（两个目录都会被扫描，同 id 时这里的优先）。
