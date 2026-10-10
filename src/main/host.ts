import { Notification, screen } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '../shared/ipc.js'
import type {
  ChatMessage,
  ChatProviderDef,
  ChatRequest,
  ChatResult,
  Permission,
  PetAction,
  PluginRecord,
  ThemeTokens,
  TriggerEvent,
} from '../shared/types.js'
import { log } from './logger.js'
import { bus, type PetEventPayload } from './events.js'
import type { ConfigStore } from './config.js'
import type { PluginRegistry } from './plugins/registry.js'
import { CommandRegistry, type RegisteredCommand } from './plugins/commands.js'
import type { PetWindow } from './window.js'
import { resolveProvider, streamChat } from './chat/providers.js'
import { checkActions } from './permissions.js'
import { EmotionFilter, EXPRESSION_INSTRUCTION } from './chat/emotion-filter.js'
import type { PetLifeService } from './gameplay/service.js'


export interface HostStorage {
  get<T = unknown>(key: string, fallback?: T): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
  all(): Record<string, unknown>
}

/**
 * 宿主服务：把"宠物能做的事"收敛到一处，并对调用方做权限校验。
 * 声明式触发器、代码插件沙箱、IPC、托盘命令全部走这里，行为因此完全一致。
 */
export class PetHost {
  win: PetWindow | null = null
  private history: ChatMessage[] = []
  private readonly commands = new CommandRegistry()
  private chatSeq = 0
  private rendererAborters = new Map<number, AbortController>()
  quietMode = false
  petLife: PetLifeService | null = null
  get sleeping(): boolean { return this.petLife?.engine.dozing ?? false }

  constructor(
    readonly config: ConfigStore,
    readonly registry: PluginRegistry,
    /** 数据目录：插件私有存储落在 <dataDir>/plugin-data/ */
    private readonly dataDir: string,
  ) {}

  /* -------------------- 与渲染进程通信 -------------------- */

  send(channel: string, payload?: unknown): void {
    this.win?.win?.webContents.send(channel, payload)
  }

  /* -------------------- 权限 -------------------- */

  can(permissions: readonly Permission[], action: PetAction): boolean {
    const [violation] = checkActions([action], permissions)
    if (!violation) return true
    log.warn(`权限不足，动作 ${violation.action} 被跳过（缺少 ${violation.required}）`)
    return false
  }

  /* -------------------- 动作执行 -------------------- */

  async runActions(actions: PetAction[], permissions: readonly Permission[], pluginId: string): Promise<void> {
    for (const action of actions) {
      if (!this.can(permissions, action)) continue
      try {
        await this.runAction(action, pluginId)
      } catch (err) {
        log.error(`插件 ${pluginId} 的动作 ${action.type} 执行失败`, err)
      }
    }
  }

  private async runAction(action: PetAction, pluginId: string): Promise<void> {
    switch (action.type) {
      case 'pet.speak':
        this.say(action.message, pluginId, action.durationMs)
        break
      case 'pet.react':
        this.react(action.reaction, pluginId)
        break
      case 'pet.setState':
        this.setState(action.state)
        break
      case 'pet.skin':
        this.setSkin(action.skin, pluginId)
        break
      case 'pet.move':
        this.move(action, pluginId)
        break
      case 'bubble.hide':
        this.send(IPC.bubbleShow, { hide: true })
        break
      case 'notify':
        new Notification({ title: action.title, body: action.body ?? '' }).show()
        break
      case 'storage.set':
        this.storage(pluginId).set(action.key, action.value)
        break
      case 'storage.inc': {
        const store = this.storage(pluginId)
        const current = Number(store.get(action.key, 0)) || 0
        store.set(action.key, current + (action.by ?? 1))
        break
      }
      case 'log':
        log.info(`[插件 ${pluginId}] ${action.message}`)
        break
      case 'chat.ask': {
        const result = await this.chat({ messages: [{ role: 'user', content: action.prompt }] }, pluginId)
        this.say(result.text, pluginId)
        break
      }
      case 'run':
        await this.invokeHandler(pluginId, action.handler, action.args ?? {})
        break
      default:
        log.warn(`未知动作 ${(action as { type: string }).type}`)
    }
  }

  /* -------------------- 具体能力 -------------------- */

  say(text: string, pluginId: string, durationMs?: number): void {
    if (this.quietMode || this.sleeping) return
    log.info(`[${pluginId}] 宠物说话：${text.slice(0, 60)}`)
    this.send(IPC.bubbleShow, { text, pluginId, durationMs })
    const record = this.registry.get(pluginId)
    const talkState = this.registry.mergedStates(this.config.data.skin)?.talk ?? 'talk'
    if (record?.manifest.kind !== 'skin') this.setState(talkState)
  }

  react(state: string, pluginId: string): void {
    this.setState(state)
    bus.emit('state:enter', { state, pluginId })
  }

  setState(state: string): void {
    this.send(IPC.stateRequest, { state })
  }

  setSkin(pluginId: string, byPlugin: string): void {
    const skin = this.registry.resolveSkin(pluginId)
    if (!skin) {
      log.warn(`插件 ${byPlugin} 想切到不存在的皮肤 ${pluginId}`)
      return
    }
    this.config.patch({ skin: pluginId })
    this.send(IPC.skinApply, { skin, states: this.registry.mergedStates(pluginId) })
    bus.emit('skin:changed', { skin: pluginId, by: byPlugin })
  }

  applyTheme(pluginId: string): ThemeTokens | null {
    const tokens = this.registry.resolveTheme(pluginId)
    if (tokens) this.send(IPC.themeApply, tokens)
    return tokens
  }

  private move(action: Extract<PetAction, { type: 'pet.move' }>, pluginId: string): void {
    const win = this.win?.win
    if (!win) return
    const [w, h] = win.getSize()
    const pos = this.win?.getPosition()
    if (!pos) return
    if (action.to) {
      const area = screen.getDisplayMatching(win.getBounds()).workArea
      const target =
        action.to === 'left'
          ? { x: area.x + 8, y: pos.y }
          : action.to === 'right'
            ? { x: area.x + area.width - w - 8, y: pos.y }
            : action.to === 'top'
              ? { x: pos.x, y: area.y + 8 }
              : action.to === 'bottom'
                ? { x: pos.x, y: area.y + area.height - h - 8 }
                : { x: area.x + Math.round((area.width - w) / 2), y: area.y + Math.round((area.height - h) / 2) }
      win.setPosition(target.x, target.y)
    } else {
      win.setPosition(pos.x + (action.dx ?? 0), pos.y + (action.dy ?? 0))
    }
    this.win?.enforceGround()
    log.debug(`插件 ${pluginId} 移动了宠物`)
  }

  notify(title: string, body?: string): void {
    new Notification({ title, body: body ?? '' }).show()
  }

  /* -------------------- 存储 -------------------- */

  storage(pluginId: string): HostStorage {
    const dir = path.join(this.dataDir, 'plugin-data')
    const file = path.join(dir, `${pluginId}.json`)
    const read = (): Record<string, unknown> => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
      } catch {
        return {}
      }
    }
    let cache = read()
    const flush = () => {
      try {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8')
      } catch (err) {
        log.error(`插件 ${pluginId} 存储写入失败`, err)
      }
    }
    return {
      get: <T,>(key: string, fallback?: T) => (key in cache ? (cache[key] as T) : fallback),
      set: (key, value) => {
        cache[key] = value
        flush()
      },
      delete: (key) => {
        delete cache[key]
        flush()
      },
      all: () => ({ ...cache }),
    }
  }

  /* -------------------- 命令 -------------------- */

  registerCommand(cmd: RegisteredCommand): void {
    this.commands.register(cmd)
  }

  unregisterCommands(pluginId: string): void {
    this.commands.unregisterPlugin(pluginId)
  }

  listCommands(): Array<{ pluginId: string; id: string; title: string; key: string }> {
    return this.commands.list()
  }

  /**
   * 执行注册过的命令。
   *
   * 注意这里调的是命令自己的 `run()`，而不是"同名 handler"——早期实现走的是
   * invokeHandler(name)，于是插件用 registerCommand 注册的命令全部静默失效
   * （找不到同名 handler 就只写一条 warn，对调用方却返回成功）。
   */
  runCommand(pluginId: string, id: string): Promise<boolean> {
    return this.commands.run(pluginId, id)
  }

  /* -------------------- 代码插件 handler 调用 -------------------- */

  private handlers = new Map<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>()

  registerHandler(pluginId: string, name: string, fn: (args: Record<string, unknown>) => unknown | Promise<unknown>): void {
    this.handlers.set(`${pluginId}:${name}`, fn)
  }

  unregisterHandlers(pluginId: string): void {
    for (const key of [...this.handlers.keys()]) {
      if (key.startsWith(pluginId + ':')) this.handlers.delete(key)
    }
  }

  async invokeHandler(pluginId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const fn = this.handlers.get(`${pluginId}:${name}`)
    if (!fn) {
      log.warn(`插件 ${pluginId} 没有注册 handler「${name}」`)
      return undefined
    }
    return await fn(args)
  }

  /* -------------------- 聊天 -------------------- */

  chatProviders(): Array<{ pluginId: string; name: string; def: ChatProviderDef; config: Record<string, unknown> }> {
    return this.registry.chatProviders()
  }

  resolveApiKey(def: ChatProviderDef): string | undefined {
    if (!def.apiKeyRef) return undefined
    return this.config.data.secrets[def.apiKeyRef]
  }

  /**
   * 统一的聊天入口：渲染进程的气泡对话与插件的 `chat.ask` 都走这里，
   * 因此"谁在跟模型说话"是可观测的（日志里带 pluginId）。
   */
  async chat(
    req: ChatRequest,
    caller = 'renderer',
    onDelta?: (chunk: string) => void,
  ): Promise<ChatResult> {
    const emit = (chunk: string) => (onDelta ?? req.onDelta)?.(chunk)
    const entry = this.registry.chatProvider(req.providerId ?? this.config.data.chatProvider)
    if (caller === 'renderer' && this.petLife && (req.providerId === 'builtin.local-text' || !entry)) return this.petLife.reply(req, emit)
    if (!entry) throw new Error('没有可用的聊天后端插件（检查 kind=chat 的插件是否启用）')
    const def = resolveProvider(entry.def, this.registry.get(entry.pluginId)?.config ?? {})
    if (caller === 'renderer' && this.petLife && def.requiresApiKey && !this.resolveApiKey(def)) return this.petLife.reply(req, emit)
    const animate = caller === 'renderer' && entry.config.animateReply === true
    if (animate) def.systemPrompt = (def.systemPrompt ?? '') + EXPRESSION_INSTRUCTION
    const messages: ChatMessage[] = [...req.messages]
    ++this.chatSeq
    log.info(`[${entry.pluginId}] 聊天请求（来自 ${caller}，${messages.length} 条消息，模型 ${def.model}）`)
    const filter = animate ? new EmotionFilter(emit) : null
    let emitted = false
    let result: ChatResult
    try { result = await streamChat(
      def,
      { messages, onDelta: (chunk) => { emitted = true; if (filter) filter.feed(chunk); else emit(chunk) }, signal: req.signal },
      this.resolveApiKey(def),
      entry.pluginId,
    ) } catch (error) {
      if (caller === 'renderer' && this.petLife && !emitted && !req.signal?.aborted && (error as Error).name !== 'AbortError') {
        log.info('接口暂不可用，改用本地互动文案')
        return this.petLife.reply(req, emit)
      }
      throw error
    }
    if (filter) {
      result.text = filter.finish()
      if (filter.expression) this.send(IPC.expressionApply, filter.expression)
    }
    return result
  }

  /** 渲染进程的气泡对话：带会话历史，流式推回增量 */
  async chatFromRenderer(text: string, providerId?: string, requestId = 0): Promise<ChatResult> {
    const userMessage: ChatMessage = { role: 'user', content: text }
    const messages = [...this.history, userMessage]
    const controller = new AbortController()
    this.rendererAborters.get(requestId)?.abort()
    this.rendererAborters.set(requestId, controller)
    this.petLife?.beginChat()
    try {
      const result = await this.chat({ messages, providerId, signal: controller.signal }, 'renderer', (chunk) => {
        this.send(IPC.chatDelta, { requestId, chunk })
      })
      this.history.push(userMessage, { role: 'assistant', content: result.text })
      this.trimHistory()
      return result
    } finally { this.petLife?.endChat(); if (this.rendererAborters.get(requestId) === controller) this.rendererAborters.delete(requestId) }
  }

  abortChat(requestId: number): void {
    this.rendererAborters.get(requestId)?.abort()
  }

  clearHistory(): void {
    this.history = []
  }

  private trimHistory(): void {
    const max = 40
    if (this.history.length > max) this.history = this.history.slice(-max)
  }

  /* -------------------- 事件 -------------------- */

  on(event: TriggerEvent | '*', handler: (e: PetEventPayload) => void): () => void {
    return bus.on(event, handler)
  }

  emit(event: TriggerEvent, data?: Record<string, unknown>): void {
    bus.emit(event, data)
  }

  describe(): Record<string, unknown> {
    return {
      history: this.history.length,
      commands: this.listCommands().length,
      handlers: this.handlers.size,
      chatSeq: this.chatSeq,
    }
  }
}

/** 供插件使用的只读权限判断（沙箱里复用） */
export function hasPermission(record: PluginRecord, permission: Permission): boolean {
  return (record.manifest.permissions ?? []).includes(permission)
}

