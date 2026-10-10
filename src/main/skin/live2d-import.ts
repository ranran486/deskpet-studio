import fs from 'node:fs'
import path from 'node:path'
import { safeJoin } from '../plugins/manifest.js'
import { slugifyId } from './naming.js'
import type { ImportResult } from './import.js'
import { createActionProfile } from '../../shared/action-profile.js'

export interface Live2DDefinition {
  Version: number
  FileReferences: { Moc: string; Textures: string[]; Motions?: Record<string, Array<{ File: string }>>; Expressions?: Array<{ Name: string; File: string }>; [key: string]: unknown }
}
export function live2dAssets(definition: Live2DDefinition): string[] {
  if (definition.Version !== 3 || !definition.FileReferences?.Moc?.endsWith('.moc3') || !definition.FileReferences.Textures?.length) throw new Error('需要 Cubism model3.json、moc3 与至少一张纹理')
  const files = new Set<string>()
  const add = (value: unknown): void => {
    if (typeof value !== 'string' || !/\.(moc3|png|jpe?g|webp|json|wav|mp3|ogg)$/i.test(value) || /[:?#%]/.test(value) || !safeJoin(path.resolve('model-validation-root'), value)) {
      throw new Error(`模型资源路径不允许逃逸、外链或不支持的文件类型：${String(value)}`)
    }
    files.add(value.replace(/\\/g, '/'))
  }
  const refs = definition.FileReferences
  add(refs.Moc)
  if (!Array.isArray(refs.Textures)) throw new Error('Textures 必须是图片路径数组')
  for (const texture of refs.Textures) { if (!/\.(png|jpe?g|webp)$/i.test(texture)) throw new Error('纹理必须是图片'); add(texture) }
  for (const key of ['Physics', 'Pose', 'UserData', 'DisplayInfo']) if (refs[key] !== undefined) add(refs[key])
  for (const list of Object.values(refs.Motions ?? {})) for (const motion of list) {
    add(motion.File)
    const sound = (motion as { Sound?: unknown }).Sound
    if (sound !== undefined) add(sound)
  }
  for (const expression of refs.Expressions ?? []) add(expression.File)
  if (files.size > 256) throw new Error('模型资源数量超限')
  return [...files]
}
export function importLive2D(source: string, destRoot: string, name?: string): ImportResult {
  try {
    const modelFile = fs.readdirSync(source).find(file => file.toLowerCase().endsWith('.model3.json'))
    if (!modelFile) throw new Error('目录里没有 model3.json')
    const definition = JSON.parse(fs.readFileSync(path.join(source, modelFile), 'utf8')) as Live2DDefinition
    const files = [modelFile, ...live2dAssets(definition)]
    let total = 0
    for (const file of files) {
      const full = safeJoin(source, file)
      if (!full || !fs.existsSync(full)) throw new Error(`缺少模型资源：${file}`)
      const real = fs.realpathSync(full), base = fs.realpathSync(source)
      if (!real.startsWith(base + path.sep) || !fs.statSync(real).isFile()) throw new Error(`资源不在模型目录内：${file}`)
      total += fs.statSync(real).size
    }
    if (total > 128 * 1024 * 1024) throw new Error('模型资源超过 128MB')
    const displayName = name ?? path.basename(source), id = `user.${slugifyId(displayName)}-live2d`, dir = path.join(destRoot, id)
    if (fs.existsSync(dir)) throw new Error('同名模型包已经存在，请更换名称')
    fs.mkdirSync(dir, { recursive: true })
    for (const file of files) { const target = safeJoin(dir, file)!; fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(safeJoin(source, file)!, target) }
    fs.writeFileSync(path.join(dir, 'action-profile.json'), JSON.stringify(createActionProfile('live2d'), null, 2))
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ manifestVersion: 1, id, name: displayName, version: '1.0.0', description: '导入的 Cubism Live2D 模型', author: 'imported', kind: 'skin', runtime: 'data', engine: { deskpet: '>=0.1.0 <1.0.0' }, data: { live2d: modelFile, actionProfile: 'action-profile.json' } }, null, 2))
    return { ok: true, pluginId: id, name: displayName, dir, format: 'live2d', detected: 'live2d', warnings: ['动作与表情取决于模型已有绑定；模型与 Core 的许可需分别保留。'] }
  } catch (error) { return { ok: false, detected: 'live2d', warnings: [], error: String((error as Error).message) } }
}
