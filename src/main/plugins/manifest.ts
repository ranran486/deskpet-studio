import fs from 'node:fs'
import { validateActionProfile } from '../../shared/action-profile.js'
import path from 'node:path'
import {
  ALL_PERMISSIONS,
  DESKPET_VERSION,
  MANIFEST_FILENAME,
  type Permission,
  type PluginKind,
  type PluginManifest,
  type PluginRuntime,
} from '../../shared/types.js'
import { satisfies } from '../semver.js'

export interface ManifestCheck {
  manifest: PluginManifest | null
  errors: string[]
  warnings: string[]
}

const KINDS: PluginKind[] = ['skin', 'action', 'theme', 'chat', 'behavior']
const RUNTIMES: PluginRuntime[] = ['data', 'declarative', 'javascript']
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** 相对路径安全检查：拒绝绝对路径、`..` 逃逸、盘符与符号链接式写法。 */
export function safeJoin(baseDir: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null
  const normalized = path.normalize(rel)
  if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) return null
  const full = path.resolve(baseDir, normalized)
  const root = path.resolve(baseDir)
  if (full !== root && !full.startsWith(root + path.sep)) return null
  return full
}

export function readManifest(dir: string): ManifestCheck {
  const errors: string[] = []
  const warnings: string[] = []
  const file = path.join(dir, MANIFEST_FILENAME)
  if (!fs.existsSync(file)) {
    return { manifest: null, errors: [`缺少 ${MANIFEST_FILENAME}`], warnings }
  }
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return { manifest: null, errors: [`${MANIFEST_FILENAME} 不是合法 JSON: ${(err as Error).message}`], warnings }
  }
  const m = raw as Partial<PluginManifest>
  const need = (cond: boolean, msg: string) => {
    if (!cond) errors.push(msg)
  }

  need(m.manifestVersion === 1, `manifestVersion 必须是 1，实际 ${String(m.manifestVersion)}`)
  need(typeof m.id === 'string' && ID_RE.test(m.id), `id 非法：${String(m.id)}（只允许字母数字与 . _ -）`)
  need(typeof m.name === 'string' && m.name.trim().length > 0, 'name 不能为空')
  need(typeof m.version === 'string' && VERSION_RE.test(m.version), `version 必须是 x.y.z：${String(m.version)}`)
  need(!!m.kind && KINDS.includes(m.kind), `kind 必须是 ${KINDS.join('/')} 之一：${String(m.kind)}`)
  need(!!m.runtime && RUNTIMES.includes(m.runtime), `runtime 必须是 ${RUNTIMES.join('/')} 之一：${String(m.runtime)}`)
  need(!!m.engine && typeof m.engine.deskpet === 'string', 'engine.deskpet 缺失（用于版本协商，例如 ">=0.1.0 <1.0.0"）')

  if (m.engine?.deskpet && !satisfies(DESKPET_VERSION, m.engine.deskpet)) {
    errors.push(`版本不兼容：插件要求 deskpet ${m.engine.deskpet}，当前 ${DESKPET_VERSION}`)
  }

  const perms = m.permissions ?? []
  if (!Array.isArray(perms)) errors.push('permissions 必须是数组')
  else {
    for (const p of perms) {
      if (!ALL_PERMISSIONS.includes(p as Permission)) errors.push(`未知权限：${String(p)}`)
    }
  }
  if (perms.includes('network' as Permission) && !(m.network?.hosts?.length)) {
    errors.push('申请了 network 权限但没写 network.hosts 白名单')
  }

  if (m.runtime === 'javascript') {
    need(typeof m.entry === 'string' && m.entry.length > 0, 'runtime=javascript 必须提供 entry')
    need(!!m.sdkVersion, 'runtime=javascript 建议声明 sdkVersion（缺失会告警）')
    if (!m.sdkVersion) warnings.push('未声明 sdkVersion')
    if (typeof m.entry === 'string') {
      const full = safeJoin(dir, m.entry)
      if (!full) errors.push(`entry 路径非法（不允许绝对路径或 .. 逃逸）：${m.entry}`)
      else if (!fs.existsSync(full)) errors.push(`entry 文件不存在：${m.entry}`)
    }
    if (perms.length === 0) warnings.push('代码插件未申请任何权限，多数能力会被拒绝')
  }

  if (m.kind === 'skin') {
    // 两种形态：精灵图（spritesheet+atlas+states）或 2.5D 装配（rig）
    const sprite = !!(m.data?.spritesheet && m.data?.atlas && m.data?.states)
    need(sprite || !!m.data?.rig || !!m.data?.live2d, 'kind=skin 需要精灵图、rig 或 Live2D model3.json')
  }
  if (m.kind === 'theme') need(!!m.data?.tokens, 'kind=theme 需要 data.tokens')
  if (m.kind === 'chat') {
    need(!!m.data?.chat, 'kind=chat 需要 data.chat')
    const c = m.data?.chat
    if (c) {
      const isRef = (v: unknown): boolean =>
        typeof v === 'object' && v !== null && typeof (v as { config?: unknown }).config === 'string'
      need(c.type === 'ollama' || c.type === 'openai-compatible', `data.chat.type 非法：${String(c.type)}`)
      need(
        isRef(c.baseUrl) || (typeof c.baseUrl === 'string' && /^https?:\/\//.test(c.baseUrl)),
        `data.chat.baseUrl 非法：${JSON.stringify(c.baseUrl)}`,
      )
      need(
        isRef(c.model) || (typeof c.model === 'string' && c.model.length > 0),
        'data.chat.model 不能为空（也支持 { "config": "model" } 引用插件配置）',
      )
    }
  }
  if (m.kind === 'action' && (m.triggers?.length ?? 0) === 0) {
    warnings.push('kind=action 但没有 triggers，也不提供 states，属于空包')
  }

  // 数据文件存在性
  for (const key of ['spritesheet', 'atlas', 'states', 'tokens', 'rig', 'live2d', 'actionProfile'] as const) {
    const rel = m.data?.[key]
    if (!rel) continue
    const full = safeJoin(dir, rel)
    if (!full) errors.push(`data.${key} 路径非法：${rel}`)
    else if (!fs.existsSync(full)) errors.push(`data.${key} 文件不存在：${rel}`)
    else if (key === 'actionProfile') {
      try { if (fs.statSync(full).size > 65536) throw new Error('动作模板超过 64KB'); validateActionProfile(JSON.parse(fs.readFileSync(full, 'utf8'))) }
      catch (error) { errors.push(`data.actionProfile 无效：${String((error as Error).message)}`) }
    }
  }

  for (const [i, t] of (m.triggers ?? []).entries()) {
    if (!t || typeof t !== 'object') {
      errors.push(`triggers[${i}] 不是对象`)
      continue
    }
    if (!t.when || typeof t.when.on !== 'string') errors.push(`triggers[${i}].when.on 缺失`)
    if (!Array.isArray(t.actions) || t.actions.length === 0) errors.push(`triggers[${i}].actions 为空`)
    if (t.when?.match) {
      try {
        new RegExp(t.when.match)
      } catch {
        errors.push(`triggers[${i}].when.match 不是合法正则`)
      }
    }
  }

  for (const [key, field] of Object.entries(m.configSchema ?? {})) {
    if (!field || typeof field !== 'object' || typeof (field as { type?: unknown }).type !== 'string') {
      errors.push(`configSchema.${key} 缺少 type`)
      continue
    }
    if ((field as { type: string }).type === 'select' && !Array.isArray((field as { options?: unknown[] }).options)) {
      errors.push(`configSchema.${key} 是 select 但没有 options`)
    }
  }

  if (!m.description) warnings.push('缺少 description')
  if (!m.author) warnings.push('缺少 author')

  return { manifest: errors.length === 0 ? (m as PluginManifest) : (m as PluginManifest), errors, warnings }
}
