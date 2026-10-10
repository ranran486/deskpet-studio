import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
for (const file of ['selftest', 'selftest-sandbox', 'selftest-actions', 'selftest-live2d', 'selftest-pet-life', 'selftest-action-profiles', 'selftest-edge-logic', 'selftest-dialogue-settings', 'selftest-source']) {
  const result = spawnSync(process.execPath, [path.join(root, 'tools', `${file}.mjs`)], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log('[deskpet] all node selftests passed')
