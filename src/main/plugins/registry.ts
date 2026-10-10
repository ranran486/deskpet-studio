import fs from 'node:fs'
import path from 'node:path'
import type {
  Atlas,
  ChatProviderDef,
  PluginRecord,
  ResolvedSkin,
  RigSkinData,
  States,
  ThemeTokens,
} from '../../shared/types.js'
import type { ConfigStore } from '../config.js'
import { log } from '../logger.js'
import { validateActionProfile } from '../../shared/action-profile.js'
import { readManifest, safeJoin } from './manifest.js'
import { live2dAssets, type Live2DDefinition } from '../skin/live2d-import.js'

export interface ChatProviderEntry {
  pluginId: string
  name: string
  def: ChatProviderDef
  /** 该插件的配置，用于解析 data.chat 里的 {config:"x"} 引用 */
  config: Record<string, unknown>
}

/**
 * 插件仓库：扫描 → 校验 → 启停 → 资源解析。
 *
 * 两类来源：
 *  - builtin：随应用分发的 `packs/`（默认皮肤、默认主题、内置聊天后端、示例插件）
 *  - user：`<项目>/plugins/`（优先）与 `<数据目录>/plugins/`，用户自己丢进来的包，改完调 reload 即生效
 */
export class PluginRegistry {
  private records = new Map<string, PluginRecord>()
  private jsonCache = new Map<string, unknown>()

  readonly userDirs: string[]

  constructor(
    readonly builtinDir: string,
    userDirs: string | string[],
    private readonly config: ConfigStore,
  ) {
    this.userDirs = Array.isArray(userDirs) ? userDirs : [userDirs]
  }

  scan(): PluginRecord[] {
    this.records.clear()
    this.jsonCache.clear()
    const found: Array<{ dir: string; source: 'builtin' | 'user' }> = []
    const bases: Array<{ base: string; source: 'builtin' | 'user' }> = [
      { base: this.builtinDir, source: 'builtin' },
      ...this.userDirs.map((base) => ({ base, source: 'user' as const })),
    ]
    for (const { base, source } of bases) {
      if (!fs.existsSync(base)) continue
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) found.push({ dir: path.join(base, entry.name), source })
      }
    }

    for (const { dir, source } of found) {
      const { manifest, errors, warnings } = readManifest(dir)
      if (!manifest) {
        log.warn(`跳过 ${dir}：${errors.join('; ')}`)
        continue
      }
      const id = manifest.id ?? path.basename(dir)
      if (this.records.has(id)) {
        log.warn(`插件 id 冲突，忽略 ${dir}（${id} 已被占用）`)
        continue
      }
      const record: PluginRecord = {
        id,
        dir,
        source,
        manifest,
        enabled: !this.config.data.disabled.includes(id),
        ok: errors.length === 0,
        errors,
        warnings,
        config: this.config.pluginConfig(id, manifest.configSchema),
      }
      this.records.set(id, record)
      if (!record.ok) log.warn(`插件 ${id} 校验未通过：${errors.join('; ')}`)
      else log.info(`插件就绪 ${id} (${manifest.kind}/${manifest.runtime})${record.enabled ? '' : ' [已禁用]'}`)
    }
    return this.list()
  }

  list(): PluginRecord[] {
    return [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  get(id: string): PluginRecord | undefined {
    return this.records.get(id)
  }

  get enabled(): PluginRecord[] {
    return this.list().filter((r) => r.ok && r.enabled)
  }

  enabledOfKind(kind: PluginRecord['manifest']['kind']): PluginRecord[] {
    return this.enabled.filter((r) => r.manifest.kind === kind)
  }

  setEnabled(id: string, enabled: boolean): void {
    const record = this.records.get(id)
    if (!record) return
    record.enabled = enabled
    const disabled = new Set(this.config.data.disabled)
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    this.config.patch({ disabled: [...disabled] })
    log.info(`${enabled ? '启用' : '禁用'}插件 ${id}`)
  }

  reload(): PluginRecord[] {
    return this.scan()
  }

  /* -------------------- 资源解析 -------------------- */

  private readJson<T>(dir: string, rel: string | undefined): T | null {
    if (!rel) return null
    const full = safeJoin(dir, rel)
    if (!full) return null
    try {
      if (!this.jsonCache.has(full)) this.jsonCache.set(full, JSON.parse(fs.readFileSync(full, 'utf8')))
      return structuredClone(this.jsonCache.get(full)) as T
    } catch (err) {
      log.error(`读取 ${rel} 失败`, err)
      return null
    }
  }

  /** 皮肤插件的图片 URL（走自定义协议，渲染进程用 <img>/canvas 直接加载） */
  assetUrl(pluginId: string, rel: string): string {
    return `deskpet://pack/${encodeURIComponent(pluginId)}/${rel.split('/').map(encodeURIComponent).join('/')}`
  }

  resolveSkin(pluginId: string): ResolvedSkin | null {
    const record = this.records.get(pluginId)
    if (!record || !record.ok || !record.enabled || record.manifest.kind !== 'skin') return null
    const { dir } = record
    let actionProfile: import('../../shared/action-profile.js').ActionProfile | undefined
    if (record.manifest.data?.actionProfile) {
      try { actionProfile = validateActionProfile(this.readJson<unknown>(dir, record.manifest.data.actionProfile)) }
      catch (error) { log.error('人物动作绑定无效', error); return null }
    }
    if (record.manifest.data?.live2d) {
      const rel = record.manifest.data.live2d
      const model = this.readJson<Live2DDefinition>(dir, rel)
      if (!model) return null
      try {
        const base = path.dirname(safeJoin(dir, rel)!)
        if (live2dAssets(model).some(file => !safeJoin(base, file) || !fs.existsSync(safeJoin(base, file)!))) return null
      } catch (error) { log.error('Live2D 模型校验失败', error); return null }
      const sizing = record.manifest as unknown as { frameSize?: { w: number; h: number }; scale?: number }
      if (actionProfile && actionProfile.kind !== 'live2d') return null
      return { kind: 'live2d', actionProfile, id: record.id, pluginId, name: record.manifest.name, modelUrl: this.assetUrl(pluginId, rel), motions: Object.keys(model.FileReferences.Motions ?? {}), motionCounts: Object.fromEntries(Object.entries(model.FileReferences.Motions ?? {}).map(([name, motions]) => [name, motions.length])), expressions: (model.FileReferences.Expressions ?? []).map(item => item.Name), frameSize: sizing.frameSize ?? { w: 260, h: 320 }, scale: sizing.scale ?? 1 }
    }

    // 2.5D 装配外形（分层 PSD 导入产物）：只有 skin.json + 一层一张 PNG
    const rigRel = record.manifest.data?.rig
    if (rigRel) {
      if (actionProfile && actionProfile.kind !== 'rig') return null
      const rig = this.readJson<RigSkinData>(dir, rigRel)
      if (!rig?.layers?.length) {
        log.error(`外形 ${pluginId} 的 ${rigRel} 不可用或没有图层`)
        return null
      }
      const layerUrls: Record<string, string> = {}
      for (const layer of rig.layers) layerUrls[layer.png] = this.assetUrl(pluginId, layer.png)
      const loose = record.manifest as unknown as { scale?: number }
      return {
        kind: 'rig',
        actionProfile,
        pluginId,
        id: record.manifest.id,
        name: record.manifest.name,
        rig,
        layerUrls,
        scale: loose.scale ?? 1,
      }
    }
    const atlas = this.readJson<Atlas>(dir, record.manifest.data?.atlas)
    const states = this.readJson<States>(dir, record.manifest.data?.states)
    if (actionProfile && actionProfile.kind !== 'sprite') return null
    if (!atlas || !states) return null
    const loose = record.manifest as unknown as {
      anchor?: { x: number; y: number }
      scale?: number
      frameSize?: { w: number; h: number }
    }
    const first = Object.values(atlas.frames)[0]
    const frameSize =
      atlas.meta?.frameSize ??
      loose.frameSize ??
      (first ? { w: first.w, h: first.h } : { w: 128, h: 128 })
    return {
      kind: 'sprite',
      actionProfile,
      pluginId,
      id: record.manifest.id,
      name: record.manifest.name,
      imageUrl: this.assetUrl(pluginId, record.manifest.data!.spritesheet!),
      atlas,
      states,
      frameSize,
      anchor: loose.anchor ?? { x: 0.5, y: 1 },
      scale: loose.scale ?? 1,
    }
  }

  /** 皮肤状态 + 所有启用的动作包状态（同名状态以动作包为准，新状态追加） */
  mergedStates(skinPluginId: string): States | null {
    const resolved = this.resolveSkin(skinPluginId)
    const base = resolved?.kind === 'sprite' ? resolved.states : null
    const merged: States = base
      ? { ...base, states: { ...base.states } }
      : { default: 'idle', states: {} }

    for (const record of this.enabledOfKind('action')) {
      const extra = this.readJson<States>(record.dir, record.manifest.data?.states)
      if (!extra) continue
      let applied = 0
      for (const [name, state] of Object.entries(extra.states ?? {})) {
        // 动作包可触发通用语义，但它贡献的帧只能用于含有这些帧的精灵图。
        if (resolved?.kind !== 'sprite' || !state.clips?.length ||
          state.clips.some((clip) => !clip.frames?.length || clip.frames.some((frame) => !resolved.atlas.frames[frame]))) continue
        merged.states[name] = state
        applied++
      }
      if (extra.default && merged.states[extra.default]) merged.default ??= extra.default
      if (extra.drag && merged.states[extra.drag]) merged.drag ??= extra.drag
      if (extra.talk && merged.states[extra.talk]) merged.talk ??= extra.talk
      log.info(`动作包 ${record.id} 合并了 ${applied} 个兼容状态`)
    }
    if (!merged.default) merged.default = 'idle'
    return Object.keys(merged.states).length > 0 ? merged : null
  }

  resolveTheme(pluginId: string): ThemeTokens | null {
    const record = this.records.get(pluginId)
    if (!record || record.manifest.kind !== 'theme') return null
    return this.readJson<ThemeTokens>(record.dir, record.manifest.data?.tokens)
  }

  chatProviders(): ChatProviderEntry[] {
    return this.enabledOfKind('chat')
      .map((r) => ({
        pluginId: r.id,
        name: r.manifest.name,
        def: r.manifest.data?.chat as ChatProviderDef,
        config: r.config,
      }))
      .filter((p) => !!p.def)
  }

  chatProvider(id: string | undefined): ChatProviderEntry | null {
    const list = this.chatProviders()
    if (id) return list.find((p) => p.pluginId === id) ?? null
    return list[0] ?? null
  }
}
