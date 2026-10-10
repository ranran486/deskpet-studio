import type { TriggerEvent } from '../shared/types.js'
import { log } from './logger.js'

export interface PetEventPayload {
  type: TriggerEvent
  /** 事件发生时间（单调时钟毫秒） */
  at: number
  data?: Record<string, unknown>
}

type Handler = (event: PetEventPayload) => void

/**
 * 全局事件总线。所有"宠物发生了什么"都从这里过：
 * 插件触发器、托盘命令、渲染进程交互、聊天状态机都只是发布者/订阅者。
 */
export class EventBus {
  private handlers = new Map<TriggerEvent | '*', Set<Handler>>()

  on(event: TriggerEvent | '*', handler: Handler): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler)
    return () => set!.delete(handler)
  }

  emit(event: TriggerEvent, data?: Record<string, unknown>, now = Date.now()): void {
    const payload: PetEventPayload = { type: event, at: now, data }
    for (const key of [event, '*'] as const) {
      const set = this.handlers.get(key)
      if (!set) continue
      for (const handler of [...set]) {
        try {
          handler(payload)
        } catch (err) {
          log.error(`事件处理出错 ${event}`, err)
        }
      }
    }
  }

  clear(): void {
    this.handlers.clear()
  }
}

export const bus = new EventBus()
