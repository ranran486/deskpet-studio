import fs from 'node:fs'
import type { DialogueCatalog, DialogueSettingsSnapshot } from '../../shared/dialogue-settings.js'
import { validateCatalog, upgradePoseDialogue } from './dialogue.js'
import { log } from '../logger.js'

/** Single shared text store; validate all edits before one atomic write. */
export class DialogueStore {
  readonly defaults: DialogueCatalog
  private catalog: DialogueCatalog
  constructor(assetFile: string, private readonly customFile: string) {
    this.defaults = validateCatalog(JSON.parse(fs.readFileSync(assetFile, 'utf8')))
    this.catalog = structuredClone(this.defaults)
    if (!fs.existsSync(customFile)) this.write(this.catalog)
    else try {
      const original = validateCatalog(JSON.parse(fs.readFileSync(customFile, 'utf8'))), custom = upgradePoseDialogue(original, this.defaults)
      this.catalog = this.merge(custom)
      if (custom !== original) this.write(this.catalog)
    } catch (error) { log.warn('本地文案格式异常，使用内置文案', error) }
  }
  private merge(custom: DialogueCatalog): DialogueCatalog { return { ...this.defaults, ...custom, groups: { ...this.defaults.groups, ...custom.groups } } }
  private write(catalog: DialogueCatalog): void {
    const temp = this.customFile + '.editing.tmp'
    try { fs.writeFileSync(temp, JSON.stringify(catalog, null, 2)); fs.renameSync(temp, this.customFile) }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
  }
  snapshot(): DialogueSettingsSnapshot { return structuredClone({ catalog: this.catalog, defaults: this.defaults }) }
  validateEdits(raw: unknown): Record<string, string[]> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length || Object.keys(raw).length > 128) throw new Error('请选择要保存的文案分组')
    const groups: Record<string, string[]> = {}
    for (const [group, lines] of Object.entries(raw)) {
      if (['__proto__', 'constructor', 'prototype'].includes(group) || !(Object.hasOwn(this.catalog.groups, group) || Object.hasOwn(this.defaults.groups, group))) throw new Error('不支持的文案分组')
      if (!Array.isArray(lines) || !lines.length || lines.length > 100 || lines.some(line => typeof line !== 'string' || !line.trim() || line.trim().length > 180)) throw new Error('每组请填写 1–100 句，每句最多 180 字符')
      groups[group] = lines.map(line => line.trim())
    }
    return groups
  }
  save(raw: unknown): DialogueSettingsSnapshot {
    const updates = this.validateEdits(raw)
    // Preserve unrelated edits made directly in the local file while settings was open.
    let latest = this.catalog
    if (fs.existsSync(this.customFile)) latest = this.merge(validateCatalog(JSON.parse(fs.readFileSync(this.customFile, 'utf8'))))
    const next = validateCatalog({ ...latest, groups: { ...latest.groups, ...updates } })
    this.write(next); this.catalog = next
    return this.snapshot()
  }
}
