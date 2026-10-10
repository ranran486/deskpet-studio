import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc.js'
import type { BehaviorSignal } from '../shared/action-model.js'
import type { PetLifeSnapshot, PetExpression } from '../shared/pet-life.js'

/**
 * 渲染进程唯一的对外通道。渲染层拿不到 Node、拿不到 ipcRenderer 本身，
 * 只能用下面这些具名方法——插件与页面代码因此没有绕过权限模型的入口。
 */

type Listener<T> = (payload: T) => void

function subscribe<T>(channel: string, listener: Listener<T>): () => void {
  const wrapped = (_event: unknown, payload: T) => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api = {
  // ---- 启动数据 ----
  bootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  getConfig: () => ipcRenderer.invoke(IPC.configGet),
  setConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke(IPC.configSet, patch),
  setSkin: (pluginId: string) => ipcRenderer.invoke(IPC.setSkin, pluginId),
  skinImport: (kind: string) => ipcRenderer.invoke(IPC.skinImport, { kind }),
  exportActionProfile: () => ipcRenderer.invoke(IPC.exportActionProfile),
  dialogueSettings: () => ipcRenderer.invoke(IPC.dialogueGet),
  saveDialogue: (groups: Record<string, string[]>) => ipcRenderer.invoke(IPC.dialogueSave, groups),
  previewDialogue: (group: string, lines: string[]) => ipcRenderer.invoke(IPC.dialoguePreview, { group, lines }),
  skinDelete: (pluginId: string) => ipcRenderer.invoke(IPC.skinDelete, pluginId),
  pluginConfigGet: (id: string) => ipcRenderer.invoke(IPC.pluginConfigGet, id),
  pluginConfigSet: (id: string, patch: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC.pluginConfigSet, { id, patch }),
  secretSet: (ref: string, value: string) => ipcRenderer.invoke(IPC.secretSet, { ref, value }),
  secretClear: (ref: string) => ipcRenderer.invoke(IPC.secretClear, { ref }),
  openPath: (which: 'data' | 'plugins' | 'project' | 'imported') => ipcRenderer.invoke(IPC.openPath, which),
  diag: () => ipcRenderer.invoke('deskpet:diag'),
  showContextMenu: () => ipcRenderer.invoke(IPC.contextMenu),
  listPlugins: () => ipcRenderer.invoke(IPC.pluginList),
  listPacks: () => ipcRenderer.invoke(IPC.packList),
  togglePlugin: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.pluginToggle, { id, enabled }),
  reloadPlugins: () => ipcRenderer.invoke(IPC.pluginReload),
  invokePlugin: (payload: { kind: 'handler' | 'command'; pluginId: string; name: string; args?: Record<string, unknown> }) =>
    ipcRenderer.invoke(IPC.pluginInvokeHandler, payload),

  // ---- 聊天 ----
  chatSend: (payload: { requestId: number; text: string; providerId?: string }) => ipcRenderer.invoke(IPC.chatSend, payload),
  chatAbort: (requestId: number) => ipcRenderer.invoke(IPC.chatAbort, requestId),
  petInteract: (kind: string, food?: string) => ipcRenderer.invoke(IPC.petInteract, { kind, food }),
  onPetLife: (cb: Listener<PetLifeSnapshot>) => subscribe(IPC.petLife, cb),
  onFeedPanel: (cb: () => void) => subscribe(IPC.feedPanel, cb),
  chatProviders: () => ipcRenderer.invoke(IPC.chatProviders),

  // ---- 窗口交互（fire-and-forget，避免拖动时 IPC 往返抖动） ----
  setInteractive: (interactive: boolean) => ipcRenderer.send(IPC.setInteractive, interactive),
  dragStart: (anchor?: { x: number; y: number }) => ipcRenderer.send(IPC.dragStart, anchor),
  dragEnd: () => ipcRenderer.send(IPC.dragEnd),
  report: (event: string, data?: Record<string, unknown>) => ipcRenderer.send(IPC.rendererEvent, { event, data }),
  log: (...args: unknown[]) => ipcRenderer.send(IPC.log, args.map((a) => String(a))),
  hitTest: (payload: { interactive: boolean; hit: string | null; probe?: string }) =>
    ipcRenderer.send(IPC.hitTestReport, payload),

  // ---- 主进程推送 ----
  onEvent: (cb: Listener<{ type: string; data?: Record<string, unknown> }>) => subscribe(IPC.event, cb),
  onChatDelta: (cb: Listener<{ requestId: number; chunk: string }>) => subscribe(IPC.chatDelta, cb),
  onChatDone: (cb: Listener<{ requestId: number; text: string; error?: string; source?: 'local' | 'api' }>) => subscribe(IPC.chatDone, cb),
  onBubble: (cb: Listener<{ text?: string; pluginId?: string; durationMs?: number; hide?: boolean; input?: boolean; local?: boolean; allowWhileResting?: boolean; allowWhileDragging?: boolean }>) =>
    subscribe(IPC.bubbleShow, cb),
  onStateRequest: (cb: Listener<{ state: string; reset?: boolean }>) => subscribe(IPC.stateRequest, cb),
  onExpression: (cb: Listener<{ emotion: PetExpression; action?: 'wave' | 'nod' | 'tilt' }>) => subscribe(IPC.expressionApply, cb),
  onSkinApply: (cb: Listener<{ skin: unknown; states: unknown }>) => subscribe(IPC.skinApply, cb),
  onThemeApply: (cb: Listener<Record<string, string>>) => subscribe(IPC.themeApply, cb),
  onConfigChanged: (cb: Listener<Record<string, unknown>>) => subscribe(IPC.configChanged, cb),
  onSettingsTab: (cb: Listener<{ tab: string }>) => subscribe(IPC.settingsTab, cb),
  onCursor: (cb: Listener<{ dx: number; dy: number; dist: number }>) => subscribe(IPC.cursor, cb),
  onInteraction: (cb: Listener<BehaviorSignal & { idleMode?: boolean; peek?: number }>) => subscribe(IPC.interaction, cb),
}

contextBridge.exposeInMainWorld('deskpet', api)

export type DeskPetApi = typeof api
