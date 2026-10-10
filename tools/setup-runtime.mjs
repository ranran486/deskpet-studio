import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export function ensureElectronRuntime() {
  const pkg = path.join(root, 'node_modules/electron'), marker = path.join(pkg, 'path.txt')
  const installed = () => fs.existsSync(marker) && fs.existsSync(path.join(pkg, 'dist', fs.readFileSync(marker, 'utf8').trim()))
  if (installed()) return
  const installer = path.join(pkg, 'install.js')
  if (!fs.existsSync(installer)) throw new Error('Run npm ci before installing the Electron runtime')
  const result = spawnSync(process.execPath, [installer], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0 || !installed()) throw new Error('Electron runtime installation failed; check network and download settings')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ensureElectronRuntime()
