/** Reuses electron-builder's NSIS target. Only explicitly selected public assets are packaged. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { build, Platform, Arch } from 'electron-builder'
import { listPackage } from '@electron/asar'
import './make-beta-icon.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version + '-beta.1'
process.chdir(root)
process.env.ELECTRON_BUILDER_CACHE ??= path.join(root, '.runtime/cache/electron-builder')
if (process.argv.includes('--mirror')) process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= 'https://npmmirror.com/mirrors/electron-builder-binaries/'
const dirOnly = process.argv.includes('--dir')
const stage = path.join(root, '.runtime', `beta-stage-${Date.now()}`)
const output = path.join(root, 'release', 'framework-beta')
fs.mkdirSync(stage, { recursive: true })
const blocked = new Set(['live2dcubismcore.min.js', 'cubism4.min.js', 'pixi.min.js', 'unsafe-eval.min.js'])
fs.cpSync('dist', path.join(stage, 'dist'), { recursive: true, filter: source => !source.endsWith('.map') && !blocked.has(path.basename(source)) })
const packs = ['cat-default', 'cat-actions', 'bubble-default', 'chat-openai', 'chat-ollama', 'pomodoro-js']
for (const pack of packs) fs.cpSync(path.join(root, 'packs', pack), path.join(stage, 'packs', pack), { recursive: true })
const blueDir = path.join(stage, 'packs/blue-maid')
fs.mkdirSync(blueDir, { recursive: true })
for (const file of ['plugin.json', 'action-profile.json', 'atlas.json', 'states.json', 'spritesheet.png', 'preview-front.png', 'preview-side.png', 'preview-back.png', 'ASSET-NOTES.md']) fs.copyFileSync(path.join(root, 'packs/blue-maid', file), path.join(blueDir, file))
packs.push('blue-maid')
fs.mkdirSync(path.join(stage, 'assets'), { recursive: true })
const iconFile = path.join(root, '.runtime/beta-build-resources/deskpet-beta.ico')
fs.copyFileSync(iconFile, path.join(stage, 'assets/deskpet.ico'))
fs.copyFileSync('assets/dialogue.zh-CN.json', path.join(stage, 'assets/dialogue.zh-CN.json'))
for (const license of ['Petra-MIT.txt', 'Anime2.5DRig-MIT.txt', 'ag-psd-MIT.txt', 'PowerToys-MIT.txt', 'GenhuiC-11-MIT.txt']) {
  fs.mkdirSync(path.join(stage, 'LICENSES'), { recursive: true }); fs.copyFileSync(path.join(root, 'LICENSES', license), path.join(stage, 'LICENSES', license))
}
fs.writeFileSync(path.join(stage, 'BETA_README.txt'), `DeskPet 框架内测版 ${version}\r\n\r\n默认角色蓝鲸，橘猫可切换。八种表情、摸头、戳肚子、五种投喂、心情、90 秒睡眠、四侧姿势与粒子。无 Key 可用本地文案聊天。\r\n双击安装；右键进入设置，双击喂食，头顶轻抚，身体下部单击。\r\n设置里可导出现有动作模板，新人物绑定自己的动作素材；动作与互动语言页可修改全部本地台词，保存立即生效。DeepSeek Key 由测试者自行填写。\r\n不需要 Node、Python 或管理员权限。包内未携带本机密钥、日志、日和、Live2D Core 或生成源图。\r\n角色美术权利按原素材来源处理，代码 MIT 不包含角色美术。此内测构建未签名，请确认发送者与 SHA256。\r\n版本与更新见 CHANGELOG.md，玩法见 GAMEPLAY.md，模板见 ACTION-TEMPLATES.md。\r\n` )

const assertArchive = appOutDir => {
  const archive = path.join(appOutDir, 'resources/app.asar'), entries = listPackage(archive)
  for (const raw of entries) {
    const entry = raw.replaceAll('\\', '/')
    if (/(\.runtime|hiyori-live2d|live2dcubismcore|cubism4\.min|latest-node-tests|^\/?plugins\/|source-actions|reference-sheet\.png)/i.test(entry)) throw new Error(`内测包混入不应分发的文件：${entry}`)
  }
  fs.writeFileSync(path.join(output, 'package-audit.json'), JSON.stringify({ generatedAt: new Date().toISOString(), profile: 'framework-beta', defaultSkin: 'builtin.blue-maid', entryCount: entries.length, includedPacks: packs, excludes: ['user credentials', 'runtime data', 'user plugins', 'Live2D Core', 'Hiyori', 'source/reference sheets'], passed: true }, null, 2))
}
await build({
  targets: Platform.WINDOWS.createTarget(dirOnly ? ['dir'] : ['nsis'], Arch.x64),
  publish: 'never',
  config: {
    appId: 'dev.deskpet.framework.beta', productName: 'DeskPet Beta',
    directories: { output }, electronDist: path.join(root, 'node_modules/electron/dist'),
    extraMetadata: { version, author: 'deskpet', description: 'DeskPet expressions, interaction and reusable action profiles' },
    files: [{ from: stage, to: '.', filter: ['**/*'] }, 'package.json', '!node_modules/.cache/**/*', '!node_modules/@pixi/**/*', '!node_modules/pixi.js/**/*'],
    extraResources: [{ from: path.join(root, 'tools/windows-fullscreen.ps1'), to: 'tools/windows-fullscreen.ps1' }, { from: path.join(root, 'templates/actions-v1'), to: 'templates/actions-v1' }],
    asar: true, npmRebuild: false,
    toolsets: { nsis: '0.0.0' },
    win: { icon: iconFile, target: 'nsis', requestedExecutionLevel: 'asInvoker', signExecutable: false },
    nsis: { oneClick: true, perMachine: false, allowElevation: false, createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: 'DeskPet 内测', uninstallDisplayName: 'DeskPet 框架内测版', deleteAppDataOnUninstall: false, runAfterFinish: true, artifactName: 'DeskPet-Framework-Beta-${version}-Setup-${arch}.exe' },
    afterPack: context => assertArchive(context.appOutDir),
  },
})
if (!dirOnly) {
  const files = fs.readdirSync(output).filter(file => file.endsWith('.exe'))
  const hashes = files.map(file => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex')}  ${file}`).join('\n')
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), hashes + '\n')
  fs.copyFileSync(path.join(stage, 'BETA_README.txt'), path.join(output, '内测说明.txt'))
  for (const [source, name] of [['CHANGELOG.md', 'CHANGELOG.md'], ['docs/ACTION-TEMPLATES.md', 'ACTION-TEMPLATES.md'], ['docs/GAMEPLAY.md', 'GAMEPLAY.md'], ['docs/DIALOGUE-SETTINGS.md', 'DIALOGUE-SETTINGS.md']]) fs.copyFileSync(path.join(root, source), path.join(output, name))
}
console.log(`Framework beta ready: ${output}`)
