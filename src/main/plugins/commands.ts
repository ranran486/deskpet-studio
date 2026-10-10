/**
 * 命令表。
 *
 * 插件用 `ctx.registerCommand(...)` 注册，宿主自己也注册几条内置命令
 * （退出桌宠 / 打开数据目录 / 重新加载插件）——否则"桌面双击启动"之后
 * 用户没有任何办法把桌宠关掉。
 *
 * 之所以独立成不依赖 Electron 的模块：命令调用链曾经静默失效（调了同名
 * handler 而不是命令自己的 run()），而这种错误只有能脱离 GUI 单测才容易被
 * 钉住。见 tools/selftest.mjs 第 7 节。
 */
export interface RegisteredCommand {
  pluginId: string
  id: string
  title: string
  /** 菜单里的显示顺序，越小越靠前；插件命令缺省排在所有内置命令之后 */
  order?: number
  run: () => void | Promise<void>
}

export interface CommandListing {
  pluginId: string
  id: string
  title: string
  key: string
}

export class CommandRegistry {
  private readonly commands = new Map<string, RegisteredCommand>()

  static key(pluginId: string, id: string): string {
    return `${pluginId}:${id}`
  }

  register(command: RegisteredCommand): void {
    this.commands.set(CommandRegistry.key(command.pluginId, command.id), command)
  }

  /** 插件被禁用/卸载时调用：只清它自己的命令，内置命令不受影响 */
  unregisterPlugin(pluginId: string): void {
    for (const [key, command] of [...this.commands]) {
      if (command.pluginId === pluginId) this.commands.delete(key)
    }
  }

  list(): CommandListing[] {
    return [...this.commands.values()]
      .sort(
        (a, b) =>
          (a.order ?? 100) - (b.order ?? 100) ||
          CommandRegistry.key(a.pluginId, a.id).localeCompare(CommandRegistry.key(b.pluginId, b.id)),
      )
      .map((c) => ({ pluginId: c.pluginId, id: c.id, title: c.title, key: CommandRegistry.key(c.pluginId, c.id) }))
  }

  get(pluginId: string, id: string): RegisteredCommand | undefined {
    return this.commands.get(CommandRegistry.key(pluginId, id))
  }

  /** 返回 false 表示命令不存在（调用方应据此报错，而不是假装成功） */
  async run(pluginId: string, id: string): Promise<boolean> {
    const command = this.get(pluginId, id)
    if (!command) return false
    await command.run()
    return true
  }

  get size(): number {
    return this.commands.size
  }
}
