import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to) }
for (const file of ['index.html', 'styles.css', 'settings.html', 'settings.css']) copy(`src/renderer/${file}`, `dist/renderer/${file}`)
for (const [from, to] of [
  ['node_modules/pixi.js/dist/browser/pixi.min.js', 'dist/renderer/vendor/pixi.min.js'],
  ['node_modules/@pixi/unsafe-eval/dist/browser/unsafe-eval.min.js', 'dist/renderer/vendor/unsafe-eval.min.js'],
  ['src/renderer/vendor/cubism4.min.js', 'dist/renderer/vendor/cubism4.min.js'],
]) copy(from, to)
const core = 'src/renderer/vendor/live2dcubismcore.min.js', builtCore = 'dist/renderer/vendor/live2dcubismcore.min.js'
if (fs.existsSync(core)) copy(core, builtCore)
else if (fs.existsSync(builtCore)) fs.unlinkSync(builtCore)
for (const file of ['rigger.cjs', 'genericparts.cjs', 'LICENSE.txt']) copy(`src/main/skin/vendor/${file}`, `dist/main/skin/vendor/${file}`)
const preload = fs.readFileSync('dist/preload/index.js', 'utf8').replace('sourceMappingURL=index.js.map', 'sourceMappingURL=index.mjs.map')
fs.writeFileSync('dist/preload/index.mjs', preload)
copy('dist/preload/index.js.map', 'dist/preload/index.mjs.map')
fs.unlinkSync('dist/preload/index.js'); fs.unlinkSync('dist/preload/index.js.map')
// Delete stale compiled modules only; retain unrelated files and the optional vendor runtime.
const cleanStaleModules = (dir) => {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== 'vendor') cleanStaleModules(full)
    else if (entry.isFile() && /\.js(?:\.map)?$/.test(entry.name)) {
      const relative = path.relative(path.join(root, 'dist'), full).replace(/\.js(?:\.map)?$/, '.ts')
      if (!fs.existsSync(path.join(root, 'src', relative))) fs.unlinkSync(full)
    }
  }
}
for (const folder of ['main', 'preload', 'renderer', 'shared']) cleanStaleModules(path.join(root, 'dist', folder))
await import('./export-action-template.mjs')
console.log('[deskpet] build ok')
