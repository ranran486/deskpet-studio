import type { AppConfig, PluginRecord, ResolvedSkin, States, ThemeTokens } from '../shared/types.js'
import type { BehaviorSignal } from '../shared/action-model.js'
import type { DialogueSettingsSnapshot } from '../shared/dialogue-settings.js'
import type { PetLifeSnapshot, PetInteraction, FoodId, PetExpression } from '../shared/pet-life.js'

export interface BootstrapData {
  version: string
  config: AppConfig
  skin: ResolvedSkin | null
  states: States | null
  theme: ThemeTokens | null
  /** 已脱敏的密钥表（只用于显示"是否已设置"），真值只在主进程里 */
  secrets: Record<string, string>
  plugins: PluginRecord[]
  providers: Array<{ pluginId: string; name: string; def: { type: string; model: string } }>
  commands: Array<{ pluginId: string; id: string; title: string; key: string }>
  triggers: Array<{ key: string; on: string }>
  loadedCodePlugins: string[]
  selfcheck: boolean
  capabilities?: { live2d: boolean }
  petLife?: PetLifeSnapshot
}

export interface DeskPetApi {
  bootstrap(): Promise<BootstrapData>
  getConfig(): Promise<AppConfig>
  showContextMenu(): Promise<void>
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  setSkin(pluginId: string): Promise<{ ok: boolean; error?: string }>
  exportActionProfile(): Promise<{ ok: boolean; dir?: string; error?: string }>
  dialogueSettings(): Promise<DialogueSettingsSnapshot>
  saveDialogue(groups: Record<string, string[]>): Promise<{ ok: boolean; snapshot?: DialogueSettingsSnapshot; error?: string }>
  previewDialogue(group: string, lines: string[]): Promise<{ ok: boolean; text?: string; shown?: boolean; error?: string }>
  /** 打开系统选择框并把素材装成皮肤插件；ok=false 时 error 说明原因（含"识别到但不支持"） */
  skinImport(kind: 'auto' | 'frames' | 'sheet' | 'image' | 'psd' | 'live2d'): Promise<{
    ok: boolean
    pluginId?: string
    name?: string
    frames?: number
    states?: Array<{ name: string; frames: number }>
    warnings: string[]
    error?: string
    detected?: string
  }>
  skinDelete(pluginId: string): Promise<{ ok: boolean; error?: string }>
  pluginConfigGet(id: string): Promise<Record<string, unknown>>
  pluginConfigSet(id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>
  secretSet(ref: string, value: string): Promise<{ ok: boolean }>
  secretClear(ref: string): Promise<{ ok: boolean }>
  openPath(which: 'data' | 'plugins' | 'project' | 'imported'): Promise<{ ok: boolean }>
  diag(): Promise<{
    logs: string[]
    displays: Array<{ id: number; bounds: { x: number; y: number; width: number; height: number }; workArea: unknown; scaleFactor: number; primary: boolean }>
    paths: { userData: string }
    versions: { app: string; electron: string; chrome: string; node: string }
  }>
  listPlugins(): Promise<PluginRecord[]>
  togglePlugin(id: string, enabled: boolean): Promise<PluginRecord[]>
  reloadPlugins(): Promise<PluginRecord[]>
  chatProviders(): Promise<
    Array<{ pluginId: string; name: string; model: string; type: string; reachable: boolean; detail: string; models?: string[] }>
  >
  chatSend(payload: { requestId: number; text: string; providerId?: string }): Promise<{ ok: boolean; text?: string; error?: string }>
  chatAbort(requestId: number): Promise<{ ok: boolean }>
  petInteract(kind: PetInteraction, food?: FoodId): Promise<{ ok: boolean; snapshot?: PetLifeSnapshot; error?: string }>
  onPetLife(cb: (state: PetLifeSnapshot) => void): () => void
  onFeedPanel(cb: () => void): () => void
  invokePlugin(payload: {
    kind: 'handler' | 'command'
    pluginId: string
    name: string
    args?: Record<string, unknown>
  }): Promise<{ ok: boolean; result?: unknown; error?: string }>
  setInteractive(interactive: boolean): void
  dragStart(anchor?: { x: number; y: number }): void
  dragEnd(): void
  report(event: string, data?: Record<string, unknown>): void
  log(...args: unknown[]): void
  hitTest(payload: { interactive: boolean; hit: string | null; probe?: string }): void
  onEvent(cb: (payload: { type: string; data?: Record<string, unknown> }) => void): () => void
  onChatDelta(cb: (payload: { requestId: number; chunk: string }) => void): () => void
  onChatDone(cb: (payload: { requestId: number; text: string; error?: string; source?: 'local' | 'api' }) => void): () => void
  onBubble(cb: (payload: { text?: string; pluginId?: string; durationMs?: number; hide?: boolean; input?: boolean; local?: boolean; allowWhileResting?: boolean; allowWhileDragging?: boolean }) => void): () => void
  onStateRequest(cb: (payload: { state: string; reset?: boolean }) => void): () => void
  onExpression(cb: (payload: { emotion: PetExpression; action?: 'wave' | 'nod' | 'tilt' }) => void): () => void
  onSkinApply(cb: (payload: { skin: ResolvedSkin; states: States | null }) => void): () => void
  onThemeApply(cb: (payload: ThemeTokens) => void): () => void
  onConfigChanged(cb: (payload: AppConfig) => void): () => void
  onSettingsTab(cb: (payload: { tab: string }) => void): () => void
  onCursor(cb: (payload: { dx: number; dy: number; dist: number }) => void): () => void
  onInteraction(cb: (payload: BehaviorSignal & { idleMode?: boolean; peek?: number; quietMode?: boolean }) => void): () => void
}

declare global {
  interface Window {
    deskpet: DeskPetApi
  }
}
