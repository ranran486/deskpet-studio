import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_CONFIG, DEFAULT_INTERACTION, type AppConfig, type ConfigField } from '../shared/types.js'
import { log } from './logger.js'

/** 把 schema 的 default 摊平成一份配置初值 */
export function defaultsFromSchema(schema: Record<string, ConfigField> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema ?? {})) {
    if ('default' in field && field.default !== undefined) out[key] = field.default
    else if (field.type === 'boolean') out[key] = false
    else if (field.type === 'number') out[key] = 0
    else out[key] = ''
  }
  return out
}

/** 配置持久化到 <数据目录>/config.json；读的时候和默认值深合并，缺字段不会炸。 */
export class ConfigStore {
  readonly file: string
  data: AppConfig

  constructor(private readonly dir: string) {
    this.file = path.join(dir, 'config.json')
    this.data = this.load()
    // 首次启动就把配置文件落盘：否则用户想手改设置（模型、皮肤、key）会找不到文件。
    // 里面写的是完整默认值，未覆盖的插件配置项仍由插件的 configSchema 提供。
    if (!fs.existsSync(this.file)) this.save()
  }

  private load(): AppConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<AppConfig>
      return {
        ...DEFAULT_CONFIG,
        ...raw,
        alwaysOnTop: true,
        stage: { ...DEFAULT_CONFIG.stage, ...(raw.stage ?? {}) },
        // 嵌套对象一律深合并：文件里出现空对象/旧版本文件时，缺的字段要用默认值补齐。
        // 曾经因为只做浅合并，一个 `interaction: {}` 就把 18 个互动字段全丢了。
        interaction: { ...DEFAULT_INTERACTION, ...(raw.interaction ?? {}) },
        pluginConfig: { ...(raw.pluginConfig ?? {}) },
        secrets: { ...(raw.secrets ?? {}) },
        disabled: [...(raw.disabled ?? [])],
      }
    } catch {
      return structuredClone(DEFAULT_CONFIG)
    }
  }

  save(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (err) {
      log.error('配置写入失败', err)
    }
  }

  patch(patch: Partial<AppConfig>): AppConfig {
    const next: AppConfig = { ...this.data, ...patch, alwaysOnTop: true }
    // 同理：patch({ interaction: { look: false } }) 不能把其它互动字段整片抹掉
    if (patch.interaction) next.interaction = { ...this.data.interaction, ...patch.interaction }
    if (patch.stage) next.stage = { ...this.data.stage, ...patch.stage }
    this.data = next
    this.save()
    return this.data
  }

  pluginConfig(id: string, schema?: Record<string, ConfigField>): Record<string, unknown> {
    return { ...defaultsFromSchema(schema), ...(this.data.pluginConfig[id] ?? {}) }
  }

  setPluginConfig(id: string, patch: Record<string, unknown>): Record<string, unknown> {
    const next = { ...(this.data.pluginConfig[id] ?? {}), ...patch }
    this.data.pluginConfig[id] = next
    this.save()
    return next
  }
}
