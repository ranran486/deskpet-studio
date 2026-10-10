# 参与开发

项目使用 Node.js 22.12+、TypeScript 和 Electron，桌面功能主要面向 Windows 10/11 x64。

```sh
npm ci
npm test
npm start
```

`npm test` 包括构建与无 GUI 检查，不需要 Live2D Core 或官方模型。真实窗口检查需先执行 npm run setup:runtime，并在交互式 Windows 桌面运行：

```sh
npm run selfcheck -- --no-sandbox
npm run test:gameplay
node tools/selftest-dialogue-settings-ui.cjs
node tools/selftest-edge-postures.cjs
```

`--no-sandbox` 只用于确实需要它的受限测试环境，普通安装和运行不默认使用。可选 Live2D 需先安装对应运行库与完整模型，不能把导入测试的合成文件当作可渲染模型。全屏测试需真实前台窗口；存在焦点限制时明确记录未验证项。

- 保持主进程、preload、渲染器和 shared 的边界，不开放渲染器 Node 权限。
- 人物通过 `action-profile.json` 绑定通用动作语义，缺少素材时保留温和回退。
- 本机密钥、配置、对话和导入插件留在用户数据目录；不得加入源码或安装包。
- 复用第三方代码时保留来源、版本与许可；人物图片与代码授权分开记录。
- 修改功能后运行对应检查。提交说明写清行为变化、验证方法和未覆盖的环境。

开发用生成物位于 `dist/`、`.runtime/`、`release/`、`templates/actions-v1/`，由构建或导出命令重新生成。不要提交这些目录。`npm run source:export` 生成仅含可发布文件的源码目录和 ZIP，可用于开源发布前核对。
