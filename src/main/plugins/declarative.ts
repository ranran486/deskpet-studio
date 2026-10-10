import type { PluginRecord, Trigger, TriggerEvent, TriggerWhen, ValueOrConfig } from '../../shared/types.js'
import { isConfigRef } from '../../shared/types.js'
import type { PetHost } from '../host.js'
import { log } from '../logger.js'

interface Registration {
  key: string
  pluginId: string
  trigger: Trigger
  off?: () => void
}

function num(value: ValueOrConfig<number> | undefined, config: Record<string, unknown>, fallback: number): number {
  if (value === undefined) return fallback
  if (isConfigRef(value)) return Number(config[value.config] ?? fallback) || fallback
  return Number(value) || fallback
}

function str(value: ValueOrConfig<string> | undefined, config: Record<string, unknown>, fallback: string): string {
  if (value === undefined) return fallback
  if (isConfigRef(value)) return String(config[value.config] ?? fallback)
  return String(value)
}

/**
 * 声明式触发器引擎。
 *
 * 插件作者只写 `when` + `actions`，执行完全由宿主完成——这是零代码门槛那一档。
 * 事件（点击/双击/拖动/聊天/状态变化）和定时（每 N 分钟、每天 HH:mm）都支持，
 * 每个动作仍然过权限表（和代码插件同一张表），所以声明式不等于无约束。
 */
export class TriggerEngine {
  private regs: Registration[] = []
  private timers: Array<ReturnType<typeof setInterval>> = []
  private lastFired = new Map<string, number>()
  private onceFired = new Set<string>()
  private lastActivity = Date.now()
  private disposers: Array<() => void> = []

  constructor(private readonly host: PetHost) {}

  start(): void {
    this.stop()
    const configs = new Map<string, Record<string, unknown>>()
    for (const record of this.host.registry.enabled) {
      configs.set(record.id, record.config)
    }

    for (const record of this.host.registry.enabled) {
      if (record.manifest.runtime === 'data') continue
      const triggers = record.manifest.triggers ?? []
      if (!triggers.length) continue
      for (const [index, trigger] of triggers.entries()) {
        if (trigger.enabled === false) continue
        this.register(record, trigger, index)
      }
      log.info(`插件 ${record.id} 注册了 ${triggers.length} 个触发器`)
    }

    // 空闲判定需要"最后一次人类活动"的时间
    for (const ev of ['click', 'double-click', 'right-click', 'drag:start', 'chat:message'] as TriggerEvent[]) {
      this.disposers.push(this.host.on(ev, () => (this.lastActivity = Date.now())))
    }

    this.timers.push(
      setInterval(() => {
        this.host.emit('tick')
        this.checkIdle()
      }, 1000),
    )
    this.timers.push(setInterval(() => this.checkClock(), 20_000))

    // 启动事件延后一点，等窗口与渲染进程就绪
    setTimeout(() => {
      this.fireEvent('startup')
      this.fireEvent('ready')
    }, 800)
  }

  stop(): void {
    for (const reg of this.regs) reg.off?.()
    this.regs = []
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    for (const off of this.disposers) off()
    this.disposers = []
    this.lastFired.clear()
    this.onceFired.clear()
  }

  restart(): void {
    this.start()
  }

  private register(record: PluginRecord, trigger: Trigger, index: number): void {
    const config = record.config
    const key = `${record.id}#${trigger.id ?? index}`
    const when = trigger.when
    const reg: Registration = { key, pluginId: record.id, trigger }

    if (when.on === 'timer') {
      const everyMinutes = num(when.everyMinutes, config, 0)
      if (everyMinutes > 0) {
        const ms = Math.max(1, everyMinutes) * 60_000
        log.info(`触发器 ${key}：每 ${everyMinutes} 分钟`)
        const timer = setInterval(() => this.fire(reg), ms)
        this.timers.push(timer)
        reg.off = () => clearInterval(timer)
      } else if (when.at) {
        log.info(`触发器 ${key}：每天 ${str(when.at, config, '')}`)
      } else {
        log.warn(`触发器 ${key} 是 timer 类型，但既没有 everyMinutes 也没有 at，已忽略`)
        return
      }
    } else if (when.on === 'idle') {
      log.info(`触发器 ${key}：空闲 ${num(when.idleSeconds, config, 60)} 秒后触发`)
    } else if (when.on === 'startup' || when.on === 'ready') {
      // 由 start() 统一触发
    } else {
      reg.off = this.host.on(when.on, () => {
        if (when.match && !this.matchEvent(when, this.host)) return
        this.fire(reg)
      })
    }
    this.regs.push(reg)
  }

  /** chat:message 的 match 过滤；目前只在事件里带文本时可用 */
  private matchEvent(when: TriggerWhen, _host: PetHost): boolean {
    if (!when.match) return true
    const text = this.lastEventText
    if (!text) return false
    try {
      return new RegExp(when.match, 'i').test(text)
    } catch {
      return false
    }
  }

  private lastEventText = ''

  /** 由 ipc 层在收到聊天消息 / 渲染事件时调用，供 match 过滤使用 */
  noteEventText(text: string): void {
    this.lastEventText = text
  }

  noteActivity(): void {
    this.lastActivity = Date.now()
  }

  private fireEvent(event: TriggerEvent): void {
    for (const reg of this.regs) {
      if (reg.trigger.when.on === event) this.fire(reg)
    }
  }

  private checkIdle(): void {
    const now = Date.now()
    for (const reg of this.regs) {
      const when = reg.trigger.when
      if (when.on !== 'idle') continue
      const config = this.host.registry.get(reg.pluginId)?.config ?? {}
      const seconds = num(when.idleSeconds, config, 60)
      if (now - this.lastActivity < seconds * 1000) continue
      if (!this.cooldownOk(reg, now)) continue
      this.fire(reg)
      // 触发过一次空闲动作后重新计时，避免每秒重复触发
      this.lastActivity = now
    }
  }

  private checkClock(): void {
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    for (const reg of this.regs) {
      const when = reg.trigger.when
      if (when.on !== 'timer' || !when.at) continue
      const config = this.host.registry.get(reg.pluginId)?.config ?? {}
      if (str(when.at, config, '') !== hhmm) continue
      this.fire(reg)
    }
  }

  private cooldownOk(reg: Registration, now: number): boolean {
    const seconds = num(reg.trigger.when.cooldownSeconds, this.host.registry.get(reg.pluginId)?.config ?? {}, 0)
    if (seconds <= 0) return true
    const last = this.lastFired.get(reg.key) ?? 0
    return now - last >= seconds * 1000
  }

  private fire(reg: Registration): void {
    const now = Date.now()
    if (this.onceFired.has(reg.key)) return
    if (!this.cooldownOk(reg, now)) return
    const record = this.host.registry.get(reg.pluginId)
    if (!record) return
    this.lastFired.set(reg.key, now)
    if (reg.trigger.when.once) this.onceFired.add(reg.key)
    log.info(`触发器命中 ${reg.key}`)
    void this.host.runActions(reg.trigger.actions, record.manifest.permissions ?? [], reg.pluginId)
  }

  describe(): Array<{ key: string; on: string }> {
    return this.regs.map((r) => ({ key: r.key, on: r.trigger.when.on }))
  }
}
