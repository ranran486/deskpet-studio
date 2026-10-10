# 发布源码

`npm run source:export` 创建 `release/source/deskpet-<版本>/` 和 Windows ZIP，另写出文件哈希审核清单。输出目录已存在时拒绝覆盖，可以使用 `npm run source:export -- --out 新目录`。

导出采用白名单，包含代码、锁文件、必要文档、第三方许可证、蓝鲸和自制橘猫、素材提示词、CI 与问题模板。排除本机数据、密钥、对话、导入插件、依赖、构建、Core、日和样例、代理工作上下文和历史测试报告。已知密钥格式扫描和逐文件 SHA-256 可辅助人工核对；它们不能代替对素材权利的确认。

上传前核对：

- 代码采用 MIT，第三方代码保留原许可；人物素材范围见 `ASSET-LICENSE.md`。蓝鲸原画作者和授权记录需要维护者补充，不把角色图片自动认作 MIT 素材。
- 从导出目录执行 `npm ci`、`npm test`、`npm start`，确认它不依赖开发机器的旧文件。GUI 检查在交互式 Windows 桌面运行。
- Electron 44 的运行时需显式安装；首次 `npm start` 会按需调用官方安装器。提前运行 `npm run setup:runtime` 后也可执行 GUI 验证脚本。
- 把源码目录中的文件上传到 GitHub 仓库，不把 ZIP 当作整个仓库的唯一文件。自动构建产物和安装器适合另放 GitHub Releases。
- 在 GitHub 创建仓库后，使用页面给出的仓库地址设置 remote 并推送；项目不会自动代建仓库、上传或暴露账号凭据。

根目录 `.gitignore` 也保护本机数据。不要使用 `git add -f` 绕过这些规则；若已有 Git 历史，忽略规则不自动清除历史，需要先核对被跟踪文件。
