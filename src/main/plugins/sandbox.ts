import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import type {
  Permission,
  PluginContext,
  PluginModule,
  PluginRecord,
  PluginStorage,
  TriggerEvent,
} from '../../shared/types.js'
import type { PetHost } from '../host.js'
import { log } from '../logger.js'
import { safeJoin } from './manifest.js'

interface Loaded {
  record: PluginRecord
  timers: Set<ReturnType<typeof setTimeout>>
  disposers: Array<() => void>
  module: PluginModule | null
  context: vm.Context | null
  active: boolean
}

/**
 * activate()/deactivate() 的看门狗。
 * 用环境变量可调，测试里调小以保持快速。
 */
const HOOK_TIMEOUT_MS = Number(process.env.DESKPET_PLUGIN_HOOK_TIMEOUT_MS ?? 10_000)
/** 插件顶层脚本的求值上限 */
const TOP_LEVEL_TIMEOUT_MS = Number(process.env.DESKPET_PLUGIN_LOAD_TIMEOUT_MS ?? 5_000)

/** 主机名白名单匹配：支持 `api.example.com`、`*.example.com`、`*` */
function hostAllowed(hostname: string, patterns: string[] | undefined): boolean {
  if (!patterns?.length) return false
  return patterns.some((p) => {
    if (p === '*') return true
    if (p.startsWith('*.')) {
      const suffix = p.slice(1) // ".example.com"
      return hostname.endsWith(suffix) || hostname === p.slice(2)
    }
    return hostname === p
  })
}

/**
 * 代码插件运行时。
 *
 * 用 `node:vm` 起一个新的 V8 realm：插件拿不到 `process` / `require` / Node 内置模块，
 * 只能看到我们注入的 `ctx`。所有能力都过权限表（manifest.permissions），
 * network 还要过 manifest.network.hosts 白名单。
 *
 * 诚实说明（见 docs/PLUGIN.md）：这是**能力边界与防误伤**，不是敌意代码沙箱——
 * vm 不是安全边界，注入的外域对象存在原型链逃逸的可能。要跑不可信插件时，
 * 应把 loadPlugin 换成 utilityProcess/worker_threads + MessagePort 隔离
 * （本文件的接口就是为这种替换留的：只依赖 ctx 这一个契约）。
 */
export class CodePluginRuntime {
  private loaded = new Map<string, Loaded>()

  constructor(private readonly host: PetHost) {}

  listLoaded(): string[] {
    return [...this.loaded.keys()]
  }

  async activateAll(): Promise<void> {
    for (const record of this.host.registry.enabled) {
      if (record.manifest.runtime !== 'javascript') continue
      await this.activate(record)
    }
  }

  async activate(record: PluginRecord): Promise<void> {
    if (this.loaded.has(record.id)) return
    const entryRel = record.manifest.entry
    const entry = entryRel ? safeJoin(record.dir, entryRel) : null
    if (!entry || !fs.existsSync(entry)) {
      log.error(`代码插件 ${record.id} 的 entry 不可用：${String(entryRel)}`)
      return
    }

    const state: Loaded = {
      record,
      timers: new Set(),
      disposers: [],
      module: null,
      context: null,
      active: false,
    }
    const ctx = this.createContext(state)

    const moduleObj: { exports: PluginModule } = { exports: {} }

    // 新 realm：插件看不到 process/require，只有我们注入的东西。
    // module / exports / ctx 以全局形式注入：插件顶层写 `let ctx = null` 这类声明
    // 只会遮蔽全局属性，不会和包装参数撞名（初版用函数包装就死在这上面）。
    const sandbox: Record<string, unknown> = {
      console: {
        log: (...a: unknown[]) => log.info(`[插件 ${record.id}]`, ...a),
        warn: (...a: unknown[]) => log.warn(`[插件 ${record.id}]`, ...a),
        error: (...a: unknown[]) => log.error(`[插件 ${record.id}]`, ...a),
        debug: (...a: unknown[]) => log.debug(`[插件 ${record.id}]`, ...a),
      },
      setTimeout: (fn: () => void, ms?: number) => {
        const t = setTimeout(fn, ms)
        state.timers.add(t)
        return t
      },
      clearTimeout: (t: ReturnType<typeof setTimeout>) => {
        state.timers.delete(t)
        clearTimeout(t)
      },
      setInterval: (fn: () => void, ms?: number) => {
        const t = setInterval(fn, ms)
        state.timers.add(t)
        return t
      },
      clearInterval: (t: ReturnType<typeof setTimeout>) => {
        state.timers.delete(t)
        clearInterval(t)
      },
      queueMicrotask,
      structuredClone,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      atob,
      btoa,
      ctx,
      module: moduleObj,
      exports: moduleObj.exports,
    }
    const context = vm.createContext(sandbox)
    state.context = context

    const code = fs.readFileSync(entry, 'utf8')
    try {
      // 源码按脚本直接求值，不再套函数包装：兼容 module.exports 写法，
      // 也避免包装参数与插件顶层的 `let ctx` 之类的声明重名。
      vm.runInContext(`'use strict';
${code}`, context, { filename: entry, timeout: TOP_LEVEL_TIMEOUT_MS })
      state.module = moduleObj.exports
      state.active = true
      if (typeof moduleObj.exports.activate === 'function') {
        // 必须在 vm 内调用：vm 的 timeout 只作用于 runInContext 执行的代码，
        // 若从宿主 realm 直接调 activate()，插件里的死循环会挂死整个桌宠。
        await callInVm(context, entry, moduleObj, ctx, 'activate', record.id)
      }
      this.loaded.set(record.id, state)
      log.info(`代码插件已激活 ${record.id}（已注入 ${state.disposers.length} 个订阅）`)
    } catch (err) {
      this.dispose(state)
      log.error(`代码插件 ${record.id} 加载失败`, err)
    }
  }

  async deactivate(id: string): Promise<void> {
    const state = this.loaded.get(id)
    if (!state) return
    if (state.module?.deactivate && state.context) {
      try {
        await callInVm(state.context, 'deactivate', { exports: state.module }, null, 'deactivate', id)
      } catch (err) {
        log.error(`插件 ${id} deactivate() 抛错`, err)
      }
    }
    this.dispose(state)
    this.loaded.delete(id)
    log.info(`代码插件已卸载 ${id}`)
  }

  async reload(): Promise<void> {
    for (const id of [...this.loaded.keys()]) await this.deactivate(id)
    await this.activateAll()
  }

  private dispose(state: Loaded): void {
    for (const t of state.timers) {
      clearTimeout(t)
      clearInterval(t)
    }
    state.timers.clear()
    for (const off of state.disposers) {
      try {
        off()
      } catch {
        /* ignore */
      }
    }
    state.disposers = []
    this.host.unregisterCommands(state.record.id)
    this.host.unregisterHandlers(state.record.id)
    state.active = false
  }

  /* ------------------------------------------------------------------ */

  private createContext(state: Loaded): PluginContext {
    const { record } = state
    const id = record.id
    const granted = new Set<Permission>(record.manifest.permissions ?? [])
    const config = this.host.registry.get(id)?.config ?? {}

    const need = (permission: Permission): void => {
      if (!granted.has(permission)) {
        throw new Error(`插件 ${id} 未申请权限「${permission}」，调用被拒绝`)
      }
    }

    const storage: PluginStorage = {
      get: <T,>(key: string, fallback?: T) => {
        need('storage')
        return this.host.storage(id).get<T>(key, fallback)
      },
      set: (key, value) => {
        need('storage')
        this.host.storage(id).set(key, value)
      },
      delete: (key) => {
        need('storage')
        this.host.storage(id).delete(key)
      },
      all: () => {
        need('storage')
        return this.host.storage(id).all()
      },
    }

    const ctx: PluginContext = {
      id,
      version: record.manifest.version,
      config,
      permissions: [...granted],
      has: (p) => granted.has(p),
      log: (...args) => log.info(`[插件 ${id}]`, ...args),
      on: (event: TriggerEvent, handler: (payload: unknown) => void) => {
        const off = this.host.on(event, (e) => handler(e))
        state.disposers.push(off)
        return off
      },
      handle: (name, fn) => this.host.registerHandler(id, name, fn),
      say: (text, options) => {
        need('pet:speak')
        this.host.say(text, id, options?.durationMs)
      },
      react: (reaction) => {
        need('pet:react')
        this.host.react(reaction, id)
      },
      setState: (nextState) => {
        need('pet:state')
        this.host.setState(nextState)
      },
      setSkin: (skinId) => {
        need('pet:skin')
        this.host.setSkin(skinId, id)
      },
      move: (delta) => {
        need('pet:move')
        void this.host.runActions(
          [
            {
              type: 'pet.move',
              dx: delta.dx,
              dy: delta.dy,
              to: delta.to as 'left' | 'right' | 'top' | 'bottom' | 'center' | undefined,
            },
          ],
          ['pet:move'],
          id,
        )
      },
      registerCommand: (command) => {
        need('command')
        this.host.registerCommand({ pluginId: id, id: command.id, title: command.title, run: command.run })
      },
      storage,
      notify: (title, body) => {
        need('notify')
        this.host.notify(title, body)
      },
      fetch: async (url, init) => {
        need('network')
        const parsed = new URL(url)
        if (!hostAllowed(parsed.hostname, record.manifest.network?.hosts)) {
          throw new Error(`插件 ${id} 访问 ${parsed.hostname} 不在 network.hosts 白名单内`)
        }
        return await fetch(url, init)
      },
      chat: async (messages, options) => {
        need('chat')
        const result = await this.host.chat({ messages, providerId: options?.provider }, id, options?.onDelta)
        return result.text
      },
      timer: {
        every: (ms, fn) => {
          need('timer')
          const t = setInterval(fn, ms)
          state.timers.add(t)
          return () => {
            state.timers.delete(t)
            clearInterval(t)
          }
        },
        after: (ms, fn) => {
          need('timer')
          const t = setTimeout(fn, ms)
          state.timers.add(t)
          return () => {
            state.timers.delete(t)
            clearTimeout(t)
          }
        },
      },
    }
    return ctx
  }
}

/**
 * 在插件的 vm realm 内部调用它的 hook。
 *
 * vm 的 timeout 只覆盖 `runInContext` 执行的代码，所以绝不能从宿主 realm 直接
 * `module.exports.activate(ctx)` —— 那样插件里一个 `while(true){}` 就能冻结整个应用。
 * 这里用 realm 内的 runner 包裹调用，同步死循环会被 vm 掐断，异步的由 withTimeout 兜底。
 */
async function callInVm(
  context: vm.Context,
  filename: string,
  moduleObj: { exports: PluginModule },
  ctx: PluginContext | null,
  hook: 'activate' | 'deactivate',
  pluginId: string,
): Promise<unknown> {
  // 关键：调用本身必须发生在 runInContext 的那一次脚本执行里。
  // vm 的 timeout 只覆盖"这一次脚本执行"；若在 runInContext 里只返回函数、
  // 再回宿主 realm 调用它，死循环就完全脱离看门狗（初版实现正是这个 bug）。
  const scope = context as unknown as Record<string, unknown>
  scope.__deskpet_exports = moduleObj.exports
  scope.__deskpet_hook_ctx = ctx
  try {
    const result = vm.runInContext(`__deskpet_exports.${hook}(__deskpet_hook_ctx)`, context, {
      filename,
      timeout: HOOK_TIMEOUT_MS,
    })
    return await withTimeout(
      Promise.resolve(result),
      HOOK_TIMEOUT_MS,
      `插件 ${pluginId} ${hook}() 超时（${HOOK_TIMEOUT_MS}ms）`,
    )
  } finally {
    delete scope.__deskpet_exports
    delete scope.__deskpet_hook_ctx
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function pluginEntryPath(record: PluginRecord): string | null {
  const entry = record.manifest.entry
  if (!entry) return null
  const full = safeJoin(record.dir, entry)
  return full && fs.existsSync(full) ? path.resolve(full) : null
}
