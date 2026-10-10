import fs from 'node:fs'
import path from 'node:path'
import { createActionProfile, validateActionProfile } from '../dist/shared/action-profile.js'
const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1]
if (!args.includes('--skin')) throw new Error('用法：npm run template:bind -- --skin 新人物插件目录（可选 --force）')
if (!value('--skin') || value('--skin').startsWith('--')) throw new Error('--skin 后需要人物插件目录')
const dir = path.resolve(value('--skin')), manifestFile = path.join(dir, 'plugin.json'), manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
if (manifest.kind !== 'skin' || !manifest.data) throw new Error('请指定人物皮肤插件，不是聊天或行为插件')
const kind = manifest.data?.live2d ? 'live2d' : manifest.data?.rig ? 'rig' : 'sprite'
const stateFile = manifest.data?.states ? path.resolve(dir, manifest.data.states) : null
if (stateFile && !stateFile.startsWith(dir + path.sep)) throw new Error('状态文件不在人物目录内')
const states = stateFile ? JSON.parse(fs.readFileSync(stateFile, 'utf8')).states : undefined
const file = path.join(dir, 'action-profile.json')
if (fs.existsSync(file) && !args.includes('--force')) throw new Error('已有动作绑定文件；需要覆盖时显式使用 --force')
const profile = validateActionProfile(createActionProfile(kind, states))
fs.writeFileSync(file, JSON.stringify(profile, null, 2)); manifest.data.actionProfile = 'action-profile.json'; fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
console.log(`Existing actions bound to ${manifest.name}: ${file}`)
