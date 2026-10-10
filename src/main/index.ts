import { app, BrowserWindow, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { ConfigStore } from './config.js'
import { initLogger, log } from './logger.js'
import { PluginRegistry } from './plugins/registry.js'
import { PetHost } from './host.js'
import { PetWindow, appRoot } from './window.js'
import { installProtocolHandler, registerScheme } from './protocol.js'
import { TriggerEngine } from './plugins/declarative.js'
import { CodePluginRuntime } from './plugins/sandbox.js'
import { maskSecrets, registerIpc } from './ipc.js'
import { runSelfCheck } from './selfcheck.js'
import { openSettingsWindow, setSettingsFocusHook } from './settings-window.js'
import { InteractionLoop } from './interaction/loop.js'
import { IPC } from '../shared/ipc.js'
import { installDesktopControls } from './desktop-controls.js'
import { PetLifeService } from './gameplay/service.js'

const selfcheckMode = process.argv.includes('--selfcheck')
const doctorMode = process.argv.includes('--doctor')

// 数据目录遵循「一个文件夹」原则：检出/开发运行时默认把配置、日志、插件数据、密钥
// 全部放进项目内的 .runtime/userdata，项目外不留任何文件；打包后的正式版仍用系统
// userData，除非用 `--data-dir=<路径>` 或 DESKPET_DATA_DIR 显式指定。
{
  const arg = process.argv.find((a) => a.startsWith('--data-dir='))
  const override = arg?.slice('--data-dir='.length) || process.env.DESKPET_DATA_DIR
  const target = override ?? (app.isPackaged ? null : '.runtime/userdata')
  if (target) {
    const resolved = path.resolve(appRoot, target)
    fs.mkdirSync(resolved, { recursive: true })
    app.setPath('userData', resolved)
  }
}

// 必须在 app ready 之前注册特权协议
registerScheme()

const selfcheckState = {
  bootstrapped: false,
  settingsReady: false,
  hitTestReports: 0,
  lastHit: null as string | null,
  lastProbe: null as string | null,
  stateChanges: [] as string[],
}
const rendererErrors: string[] = []

async function main(): Promise<void> {
  const userData = app.getPath('userData')
  const config = new ConfigStore(userData)
  initLogger(path.join(userData, 'logs'), config.data.debug)
  app.setAppUserModelId('dev.deskpet.app')
  log.info(`deskpet ${new Date().toISOString()} 启动（${selfcheckMode ? 'selfcheck' : doctorMode ? 'doctor' : 'normal'}）`)
  log.info(`项目根 ${appRoot}，userData ${userData}`)

  const userPluginsDir = path.join(userData, 'plugins')
  const projectPluginsDir = path.join(appRoot, 'plugins')
  fs.mkdirSync(userPluginsDir, { recursive: true })
  if (!app.isPackaged) fs.mkdirSync(projectPluginsDir, { recursive: true })

  // 两个用户插件目录：项目内的 plugins/ 优先（能跟着代码做版本管理），
  // 其次是数据目录里的 plugins/（运行期热装）。
  const registry = new PluginRegistry(path.join(appRoot, 'packs'), app.isPackaged ? userPluginsDir : [projectPluginsDir, userPluginsDir], config)
  registry.scan()
  if (!registry.resolveSkin(config.data.skin)) {
    const fallback = registry.enabledOfKind('skin')[0]
    if (fallback) config.patch({ skin: fallback.id })
  }

  if (doctorMode) {
    const report = registry.list().map((p) => ({
      id: p.id,
      kind: p.manifest.kind,
      runtime: p.manifest.runtime,
      ok: p.ok,
      enabled: p.enabled,
      errors: p.errors,
      warnings: p.warnings,
    }))
    log.info('---- doctor ----')
    for (const row of report) {
      log.info(
        `${row.ok ? 'OK  ' : 'BAD '} ${row.id.padEnd(26)} ${row.kind.padEnd(10)} ${row.runtime.padEnd(12)} ${row.enabled ? 'enabled' : 'disabled'}${
          row.errors.length ? ' | ' + row.errors.join('; ') : ''
        }`,
      )
    }
    const skin = registry.resolveSkin(config.data.skin)
    log.info(`默认皮肤：${skin ? `${skin.name}（${skin.kind === 'sprite' ? Object.keys(skin.atlas.frames).length + ' 帧' : skin.kind === 'rig' ? skin.rig.layers.length + ' 图层' : 'Live2D'}）` : '不可用'}`)
    log.info(`聊天后端：${registry.chatProviders().map((c) => c.pluginId).join(', ') || '无'}`)
    app.exit(registry.list().every((p) => p.ok) ? 0 : 1)
    return
  }

  const host = new PetHost(config, registry, userData)
  installProtocolHandler(registry)

  const petWindow = new PetWindow(config.data, {
    onPositionChange: (position, displayId) => {
      config.patch({ position, displayId })
    },
  })
  host.win = petWindow
  const win = petWindow.create()

  // 渲染进程的报错统一往这里收，selfcheck 据此判定"干净"
  host.on('*', (event) => {
    if ((event.type as string) === 'settings:ready') {
      selfcheckState.settingsReady = true
    }
    if ((event.type as string) === 'renderer:error') {
      rendererErrors.push(String(event.data?.message ?? '未知错误'))
      log.error(`[renderer] ${String(event.data?.message ?? '')}`)
    }
    if (!event.type.startsWith('tick')) host.send('deskpet:event', event)
  })

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    rendererErrors.push(`did-fail-load ${code} ${desc} ${url}`)
  })
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    rendererErrors.push(`preload-error ${preloadPath}: ${error.message}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    rendererErrors.push(`render-process-gone ${details.reason}`)
  })

  const engine = new TriggerEngine(host)
  engine.start()

  const runtime = new CodePluginRuntime(host)
  await runtime.activateAll()

  registerIpc({ host, engine, runtime, selfcheck: selfcheckState })

  // 互动循环：漫游与躲避要移动窗口，只有主进程能做
  const interaction = new InteractionLoop({ petWindow, config, host })
  interaction.start()
  const petLife = new PetLifeService(host, appRoot, userData)
  host.petLife = petLife
  petLife.start()
  app.once('before-quit', () => petLife.stop())
  host.on('gameplay:interaction' as never, () => { interaction.wake(); interaction.suspend(5000) })

  /** 改互动设置并让界面立刻反映出来（菜单标题带开关状态） */
  const applyInteraction = (patch: Partial<typeof config.data.interaction>): void => {
    config.patch({ interaction: { ...config.data.interaction, ...patch } })
    registerInteractionCommands()
    host.send(IPC.configChanged, maskSecrets(config.data))
  }

  function registerInteractionCommands(): void {
    const ia = config.data.interaction
    const mark = (on: boolean): string => (on ? '开' : '关')
    const levelLabel = ia.activity === 'low' ? '低' : ia.activity === 'high' ? '高' : '中'
    host.registerCommand({ pluginId: 'builtin', id: 'toggle-look', title: `视线跟随：${mark(ia.look)}`, order: 30, run: () => applyInteraction({ look: !ia.look }) })
    host.registerCommand({ pluginId: 'builtin', id: 'toggle-avoid', title: `躲避鼠标：${mark(ia.avoid)}`, order: 31, run: () => applyInteraction({ avoid: !ia.avoid }) })
    host.registerCommand({ pluginId: 'builtin', id: 'toggle-wander', title: `闲逛漫游：${mark(ia.wander)}`, order: 32, run: () => applyInteraction({ wander: !ia.wander }) })
    host.registerCommand({
      pluginId: 'builtin',
      id: 'cycle-activity',
      title: `活动频率：${levelLabel}`,
      order: 33,
      run: () => {
        const next = ia.activity === 'low' ? 'mid' : ia.activity === 'mid' ? 'high' : 'low'
        applyInteraction({ activity: next })
      },
    })
    host.registerCommand({
      pluginId: 'builtin',
      id: 'toggle-idle',
      title: `待机模式：${mark(ia.idleMode)}`,
      order: 34,
      run: () => applyInteraction({ idleMode: !ia.idleMode }),
    })
  }

  // 摸头：累加亲密度（同时也会触发插件里 on: "click" 的触发器）
  host.on('click', () => {
    const ia = config.data.interaction
    config.patch({ interaction: { ...ia, patCount: ia.patCount + 1 } })
  })
  // 拖动期间冻结自动移动（Petra：按下 30s、松手 1.5s）
  host.on('drag:start', () => interaction.suspend(30_000))
  host.on('drag:end', () => interaction.suspend(1_500))
  host.on('behavior:changed' as never, () => registerInteractionCommands())

  // 内置命令：桌宠必须能自己退出、能打开数据目录、能重载插件 ——
  // 否则"桌面双击启动"之后就再没有任何办法把它关掉了。
  host.registerCommand({
    pluginId: 'builtin',
    id: 'settings',
    title: '设置…',
    order: 5,
    run: () => {
      openSettingsWindow('model')
    },
  })
  host.registerCommand({
    pluginId: 'builtin',
    id: 'open-data-dir',
    title: '打开数据目录',
    order: 10,
    run: () => void shell.openPath(userData),
  })
  host.registerCommand({
    pluginId: 'builtin',
    id: 'reload-plugins',
    title: '重新加载插件',
    order: 20,
    run: async () => {
      registry.reload()
      await runtime.reload()
      engine.restart()
      host.setSkin(config.data.skin, 'builtin')
    },
  })
  // 退出排最后：避免手滑点到第一项就把宠物关了
  host.registerCommand({ pluginId: 'builtin', id: 'quit', title: '退出桌宠', order: 90, run: () => app.quit() })
  host.registerCommand({ pluginId: 'builtin', id: 'chat', title: '聊天', order: 6, run: () => { interaction.wake(); host.win?.ensureStageVisible(); host.send(IPC.bubbleShow, { input: true }) } })
  host.registerCommand({ pluginId: 'builtin', id: 'local-chat', title: '离线闲聊', order: 7, run: () => { interaction.wake(); host.win?.ensureStageVisible(); host.send(IPC.bubbleShow, { input: true, local: true }) } })
  host.registerCommand({ pluginId: 'builtin', id: 'feed', title: '喂点心', order: 8, run: () => { interaction.wake(); interaction.suspend(5000); host.petLife?.interact('open-feed'); host.win?.ensureStageVisible(); host.send(IPC.feedPanel) } })
  for (const kind of ['praise', 'tease'] as const) host.registerCommand({ pluginId: 'builtin', id: kind, title: kind === 'praise' ? '夸夸它' : '逗逗它', order: 9, run: () => { interaction.wake(); interaction.suspend(5000); host.petLife?.interact(kind) } })
  host.registerCommand({ pluginId: 'builtin', id: 'wake', title: '唤醒宠物', order: 35, run: () => interaction.wake() })
  for (const edge of ['left', 'right', 'bottom', 'top'] as const) host.registerCommand({ pluginId: 'builtin', id: `dock-${edge}`, title: ({ left: '左边缘窥探', right: '右边缘窥探', bottom: '底边趴桌沿', top: '顶边倒挂' })[edge], order: 36, run: () => { petLife.interact('touch'); interaction.dock(edge) } })
  for (const [state, title] of Object.entries({ front: '正面预览', side: '侧面预览', back: '背面预览', wave: '打招呼', walk: '移动', shy: '害羞', happy: '开心', surprised: '惊讶', angry: '生气', sleepy: '瞌睡', dizzy: '晕鱼', love: '喜欢', unimpressed: '无语', sad: '悲伤', neutral: '平静', 'sleep-curl': '蜷缩睡眠' })) {
    host.registerCommand({ pluginId: 'builtin', id: `pose-${state}`, title, order: 40, run: () => {
      petLife.interact('touch')
      interaction.wake()
      interaction.suspend(2800)
      host.react(state, 'builtin')
      petLife.sayAction(state)
    } })
  }

  // 命令一定要打进日志：桌面双击启动之后，用户唯一的操作入口就是这个右键菜单
  registerInteractionCommands()
  log.info('已注册命令：' + host.listCommands().map((c) => c.title).join(' / '))

  // 自己的设置窗口作为子窗口显示；保持宠物高于任务栏，避免取消置顶导致被遮挡。
  setSettingsFocusHook((focused) => {
    host.win?.setSettingsFocused(focused)
  })

  // 应用主题与默认皮肤
  host.applyTheme(config.data.theme)

  if (selfcheckMode) {
    const code = await runSelfCheck({
      host,
      engine,
      petWindow,
      interaction,
      state: selfcheckState,
      rendererErrors,
    })
    log.info(`selfcheck 结束，退出码 ${code}`)
    engine.stop()
    interaction.stop()
    petLife.stop()
    petWindow.close()
    app.exit(code)
    return
  }

  installDesktopControls(host, petWindow, interaction)

  log.info('deskpet 已就绪：双击喂食，按住头顶轻抚，戳肚子，右键聊天与互动。')
}

// 单实例：再点一次图标就聚焦到已有实例，避免多只宠物抢同一份配置
if (!app.requestSingleInstanceLock() && !selfcheckMode && !doctorMode) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      win.showInactive()
      log.info('已有实例在运行，忽略第二次启动')
    }
  })

  app.whenReady().then(main).catch((err) => {
    log.error('启动失败', err)
    app.exit(2)
  })

  app.on('window-all-closed', () => app.quit())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void main()
  })
}

process.on('unhandledRejection', (reason) => log.error('未处理的 Promise 拒绝', reason))
process.on('uncaughtException', (err) => log.error('未捕获异常', err))
