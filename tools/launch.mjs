import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { ensureElectronRuntime } from './setup-runtime.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url), env = { ...process.env }
ensureElectronRuntime()
delete env.ELECTRON_RUN_AS_NODE
const args = process.argv.slice(2)
if (!args.some(arg => arg.startsWith('--data-dir='))) args.unshift('--data-dir=.runtime/userdata')
const child = spawn(require('electron'), [root, ...args], { cwd: root, env, stdio: 'inherit' })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
