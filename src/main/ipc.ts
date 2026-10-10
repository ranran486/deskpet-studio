import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import { IPC } from '../shared/ipc.js'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../shared/types.js'
import type { PetHost } from './host.js'
import { log, recentLogs } from './logger.js'
import type { TriggerEngine } from './plugins/declarative.js'
import type { CodePluginRuntime } from './plugins/sandbox.js'
import { probeProvider, resolveProvider } from './chat/providers.js'
import { DEFAULT_CONFIG, DESKPET_VERSION } from '../shared/types.js'
import { appRoot, distRoot } from './window.js'
import { importFrameSequence, importSpriteSheet, importStaticImage, importAnyPath, detectFolderFormat } from './skin/import.js'
import { importPsd } from './skin/psd-import.js'
import type { ImportResult } from './skin/import.js'
import { buildPetMenu } from './desktop-controls.js'
import { importLive2D } from './skin/live2d-import.js'
import { isFoodId, type PetInteraction } from '../shared/pet-life.js'
import { createActionProfile } from '../shared/action-profile.js'

export interface IpcDeps {
  host: PetHost
  engine: TriggerEngine
  runtime: CodePluginRuntime
  /** 由 selfcheck 置位：让它能观测渲染进程是否真的上报了状态 */
  selfcheck: {
    bootstrapped: boolean
    hitTestReports: number
    lastHit: string | null
    lastProbe: string | null
    stateChanges: string[]
  }
}

/**
 * 送往渲染层前把密钥脱敏。
 *
 * 渲染层只需要知道"这个 key 设过没有"，不需要、也不该拿到真值——否则它会出现在
 * DevTools、截图、以及任何一次 renderer 崩溃转储里。真值只留在主进程的 config 里。
 */
export function maskSecrets(config: AppConfig): AppConfig {
  const mask = (v: string): string => (v.length <= 8 ? '****' : `${v.slice(0, 3)}****${v.slice(-4)}`)
  return {
    ...config,
    secrets: Object.fromEntries(Object.entries(config.secrets ?? {}).map(([k, v]) => [k, mask(String(v))])),
  }
}

export function registerIpc(deps: IpcDeps): void {
  const { host, engine, runtime, selfcheck } = deps
  const config = host.config

  const snapshot = () => {
    const skinId = config.data.skin
    const skin = host.registry.resolveSkin(skinId)
    return {
      version: app.isPackaged ? app.getVersion() : DESKPET_VERSION,
      config: maskSecrets(config.data),
      secrets: maskSecrets(config.data).secrets,
      skin,
      states: host.registry.mergedStates(skinId),
      theme: host.registry.resolveTheme(config.data.theme),
      plugins: host.registry.list(),
      providers: host.chatProviders(),
      commands: host.listCommands(),
      triggers: engine.describe(),
      loadedCodePlugins: runtime.listLoaded(),
      selfcheck: selfcheck.bootstrapped,
      capabilities: { live2d: fs.existsSync(path.join(distRoot, 'renderer/vendor/live2dcubismcore.min.js')) },
      petLife: host.petLife?.engine.snapshot(),
    }
  }

  ipcMain.handle(IPC.bootstrap, () => {
    selfcheck.bootstrapped = true
    const data = snapshot()
    log.info(
      `渲染进程就绪：皮肤 ${data.skin?.name ?? '(无)'}，状态 ${Object.keys(data.states?.states ?? {}).length} 个，插件 ${data.plugins.length} 个`,
    )
    return data
  })

  ipcMain.handle(IPC.configGet, () => maskSecrets(config.data))
  ipcMain.handle(IPC.dialogueGet, () => host.petLife?.dialogueSettings())
  ipcMain.handle(IPC.dialogueSave, (_event, groups: unknown) => {
    try {
      if (!host.petLife) throw new Error('互动语言尚未就绪')
      return { ok: true, snapshot: host.petLife.saveDialogue(groups) }
    } catch (error) { return { ok: false, error: (error as Error).message } }
  })
  ipcMain.handle(IPC.dialoguePreview, (_event, payload: { group?: string; lines?: unknown }) => {
    try {
      if (!host.petLife || typeof payload?.group !== 'string') throw new Error('请选择文案分组')
      return { ok: true, ...host.petLife.previewDialogue(payload.group, payload.lines) }
    } catch (error) { return { ok: false, error: (error as Error).message } }
  })
  ipcMain.handle(IPC.petInteract, (_event, payload: { kind: string; food?: unknown }) => {
    const kinds: PetInteraction[] = ['touch', 'pat', 'rub', 'tickle', 'feed', 'praise', 'tease', 'wake', 'drag', 'open-feed']
    if (!payload || !kinds.includes(payload.kind as PetInteraction) || (payload.kind === 'feed' && !isFoodId(payload.food))) return { ok: false, error: '不支持的互动或食物' }
    host.emit('gameplay:interaction' as never, { kind: payload.kind })
    host.petLife?.interact(payload.kind as PetInteraction, isFoodId(payload.food) ? payload.food : undefined)
    return { ok: true, snapshot: host.petLife?.engine.snapshot() }
  })
  ipcMain.handle(IPC.contextMenu, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) buildPetMenu(host).popup({ window })
  })
  ipcMain.handle(IPC.configSet, (_e, patch: Partial<AppConfig>) => {
    const before = config.data
    // secrets 只能走 secretSet/secretClear：渲染层拿到的是脱敏串，整包回写会把真 key 毁掉
    const { secrets: _ignoredSecrets, ...safePatch } = patch
    const next = config.patch(safePatch)
    if (patch.clickThrough !== undefined && patch.clickThrough !== before.clickThrough) {
      host.win?.setClickThrough(patch.clickThrough)
    }
    if (patch.alwaysOnTop !== undefined && patch.alwaysOnTop !== before.alwaysOnTop) {
      host.win?.setAlwaysOnTop(patch.alwaysOnTop)
    }
    if (patch.stage && (patch.stage.width !== before.stage.width || patch.stage.height !== before.stage.height)) {
      host.win?.setStageSize(patch.stage.width, patch.stage.height)
    }
    host.send(IPC.configChanged, maskSecrets(next))
    return maskSecrets(next)
  })

  ipcMain.handle(IPC.secretSet, (_e, payload: { ref: string; value: string }) => {
    if (!payload?.ref) return { ok: false }
    const secrets = { ...config.data.secrets }
    if (payload.value) secrets[payload.ref] = payload.value
    else delete secrets[payload.ref]
    config.patch({ secrets })
    log.info(`密钥 ${payload.ref} ${payload.value ? '已更新' : '已清除'}（仅存本机配置）`)
    return { ok: true }
  })

  ipcMain.handle(IPC.secretClear, (_e, payload: { ref: string }) => {
    const secrets = { ...config.data.secrets }
    delete secrets[payload?.ref]
    config.patch({ secrets })
    return { ok: true }
  })

  ipcMain.handle(IPC.openPath, async (_e, which: 'data' | 'plugins' | 'project' | 'imported') => {
    const target =
      which === 'data'
        ? app.getPath('userData')
        : which === 'plugins'
          ? path.join(app.isPackaged ? app.getPath('userData') : appRoot, 'plugins')
          : which === 'imported'
            ? path.join(app.getPath('userData'), 'plugins')
            : appRoot
    const error = await shell.openPath(target)
    if (error) log.warn(`打开目录失败 ${target}：${error}`)
    return { ok: !error }
  })

  /** 导入向导：按类型弹选择框 → 跑导入器 → 重新扫描插件（这样新皮肤立刻可用） */
  ipcMain.handle(IPC.exportActionProfile, async () => {
    const skin = host.registry.resolveSkin(config.data.skin)
    if (!skin) return { ok: false, error: '没有可用的人物模型' }
    const picked = await dialog.showOpenDialog({ title: '选择动作模板导出目录', properties: ['openDirectory', 'createDirectory'] })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: '已取消' }
    const dir = path.join(picked.filePaths[0], `deskpet-actions-${Date.now()}`)
    const source = app.isPackaged ? path.join(process.resourcesPath, 'templates/actions-v1') : path.join(appRoot, 'templates/actions-v1')
    if (!fs.existsSync(source)) return { ok: false, error: '请先运行 template:actions 生成现有动作模板' }
    try {
      fs.cpSync(source, dir, { recursive: true, errorOnExist: true, force: false })
      fs.writeFileSync(path.join(dir, 'action-profile.json'), JSON.stringify(skin.actionProfile ?? createActionProfile(skin.kind, skin.kind === 'sprite' ? skin.states.states : undefined), null, 2))
      return { ok: true, dir }
    } catch { return { ok: false, error: '导出失败，请选择有写入权限的目录' } }
  })

  ipcMain.handle(IPC.skinImport, async (_e, payload: { kind: string }) => {
    const destRoot = path.join(app.getPath('userData'), 'plugins')
    fs.mkdirSync(destRoot, { recursive: true })
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
    const kind = payload?.kind ?? 'auto'
    const live2dAvailable = fs.existsSync(path.join(distRoot, 'renderer/vendor/live2dcubismcore.min.js'))
    if (kind === 'live2d' && !live2dAvailable) return { ok: false, warnings: [], error: '此框架内测包未包含 Live2D 运行库，请使用已确认分发许可的 Live2D 版本。' }
    let result: ImportResult

    try {
      if (kind === 'frames' || kind === 'auto' || kind === 'live2d') {
        const picked = await dialog.showOpenDialog(parent as BrowserWindow, {
          title: kind === 'frames' ? '选择帧序列文件夹' : kind === 'live2d' ? '选择 Live2D 模型目录' : '选择素材文件夹（自动识别）',
          properties: ['openDirectory'],
        })
        if (picked.canceled || !picked.filePaths[0]) return { ok: false, warnings: [], error: '已取消' }
        const dir = picked.filePaths[0]
        if (kind === 'auto' && !live2dAvailable && detectFolderFormat(dir).kind === 'live2d') return { ok: false, warnings: [], error: '检测到 Live2D 模型；此框架内测包未包含相应运行库，尚不能导入。' }
        result =
          kind === 'live2d'
            ? importLive2D(dir, destRoot)
            : kind === 'frames'
              ? importFrameSequence(dir, destRoot)
              : await importAnyPath(dir, destRoot)
      } else if (kind === 'sheet') {
        const picked = await dialog.showOpenDialog(parent as BrowserWindow, {
          title: '选择精灵图 PNG 与 Aseprite JSON（可多选）',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '精灵图与图集', extensions: ['png', 'json', 'webp'] }],
        })
        if (picked.canceled || !picked.filePaths.length) return { ok: false, warnings: [], error: '已取消' }
        const json = picked.filePaths.find((f) => f.toLowerCase().endsWith('.json'))
        const image = picked.filePaths.find((f) => /\.(png|webp)$/i.test(f))
        result = json && image
          ? importSpriteSheet(image, json, destRoot)
          : { ok: false, warnings: [], error: '需要同时选中一张图片和一个 JSON（Aseprite 图集）' }
      } else if (kind === 'psd') {
        const picked = await dialog.showOpenDialog(parent as BrowserWindow, {
          title: '选择 PSD（本版本只识别）',
          properties: ['openFile'],
          filters: [{ name: 'Photoshop 文档', extensions: ['psd'] }],
        })
        if (picked.canceled || !picked.filePaths[0]) return { ok: false, warnings: [], error: '已取消' }
        result = await importPsd(picked.filePaths[0], destRoot)
      } else {
        const picked = await dialog.showOpenDialog(parent as BrowserWindow, {
          title: '选择图片',
          properties: ['openFile'],
          filters: [{ name: '图片', extensions: ['png', 'gif', 'webp', 'jpg', 'jpeg', 'apng'] }],
        })
        if (picked.canceled || !picked.filePaths[0]) return { ok: false, warnings: [], error: '已取消' }
        result = importStaticImage(picked.filePaths[0], destRoot)
      }
    } catch (err) {
      result = { ok: false, warnings: [], error: err instanceof Error ? err.message : String(err) }
    }

    if (result.ok) {
      host.registry.reload()
      log.info(`模型导入成功：${result.pluginId}（${result.frames} 帧 / ${result.states?.length ?? 0} 个状态）`)
    } else {
      log.info(`模型导入未完成（识别=${result.detected ?? 'unknown'}）：${result.error ?? ''}`)
    }
    return result
  })

  ipcMain.handle(IPC.skinDelete, (_e, pluginId: string) => {
    const record = host.registry.get(pluginId)
    if (!record) return { ok: false, error: '插件不存在' }
    if (record.source !== 'user') return { ok: false, error: '内置外形不能删除' }
    const importedRoot = path.join(app.getPath('userData'), 'plugins')
    if (!path.resolve(record.dir).startsWith(path.resolve(importedRoot))) {
      return { ok: false, error: '只允许删除"导入目录"里的外形' }
    }
    fs.rmSync(record.dir, { recursive: true, force: true })
    // 删掉的正好是当前皮肤时，先把配置切回默认，否则桌宠会指向一个不存在的包
    const removedCurrent = config.data.skin === pluginId
    if (removedCurrent) config.patch({ skin: DEFAULT_CONFIG.skin })
    host.registry.reload()
    if (removedCurrent) host.setSkin(DEFAULT_CONFIG.skin, 'builtin')
    log.info(`已删除导入的外形：${pluginId}`)
    return { ok: true }
  })

  ipcMain.handle(IPC.setSkin, (_e, pluginId: string) => {
    const skin = host.registry.resolveSkin(pluginId)
    if (!skin) return { ok: false, error: `皮肤 ${pluginId} 不可用` }
    config.patch({ skin: pluginId })
    const states = host.registry.mergedStates(pluginId)
    host.send(IPC.skinApply, { skin, states })
    host.emit('skin:changed', { skin: pluginId, by: 'renderer' })
    return { ok: true, skin, states }
  })

  ipcMain.handle(IPC.packList, () => host.registry.list())
  ipcMain.handle(IPC.pluginList, () => host.registry.list())

  ipcMain.handle(IPC.pluginToggle, async (_e, payload: { id: string; enabled: boolean }) => {
    host.registry.setEnabled(payload.id, payload.enabled)
    await runtime.reload()
    engine.restart()
    if (payload.id === config.data.skin && !payload.enabled) {
      const fallback = host.registry.enabledOfKind('skin')[0]
      if (fallback) host.setSkin(fallback.id, 'builtin')
    }
    host.send(IPC.configChanged, maskSecrets(config.data))
    return host.registry.list()
  })

  ipcMain.handle(IPC.pluginReload, async () => {
    host.registry.reload()
    await runtime.reload()
    engine.restart()
    host.setSkin(config.data.skin, 'builtin')
    return host.registry.list()
  })

  ipcMain.handle(IPC.pluginConfigGet, (_e, id: string) => {
    const record = host.registry.get(id)
    return record ? host.registry.get(id)!.config : {}
  })

  ipcMain.handle(IPC.pluginConfigSet, (_e, payload: { id: string; patch: Record<string, unknown> }) => {
    const next = config.setPluginConfig(payload.id, payload.patch)
    const record = host.registry.get(payload.id)
    if (record) record.config = { ...record.config, ...payload.patch }
    engine.restart()
    return next
  })

  ipcMain.handle(
    IPC.pluginInvokeHandler,
    async (_e, payload: { kind: 'handler' | 'command'; pluginId: string; name: string; args?: Record<string, unknown> }) => {
      try {
        if (payload.kind === 'command') {
          const ok = await host.runCommand(payload.pluginId, payload.name)
          return ok ? { ok: true } : { ok: false, error: `命令 ${payload.pluginId}:${payload.name} 不存在` }
        }
        const result = await host.invokeHandler(payload.pluginId, payload.name, payload.args ?? {})
        return { ok: true, result: result ?? null }
      } catch (err) {
        log.error('插件调用失败', err)
        return { ok: false, error: (err as Error).message }
      }
    },
  )

  ipcMain.handle(IPC.chatSend, async (_e, payload: { requestId: number; text: string; providerId?: string }) => {
    engine.noteActivity()
    engine.noteEventText(payload.text)
    host.emit('chat:message', { text: payload.text, requestId: payload.requestId })
    try {
      const result = await host.chatFromRenderer(payload.text, payload.providerId, payload.requestId)
      host.send(IPC.chatDone, { requestId: payload.requestId, text: result.text, source: result.source ?? 'api' })
      host.emit('chat:reply', { text: result.text, provider: result.providerId, model: result.model })
      return { ok: true, text: result.text, model: result.model }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      const hint = (err as { hint?: string }).hint
      if ((err as Error).name === 'AbortError') log.info('聊天已取消')
      else log.error(`聊天失败：${error}${hint ? ' | ' + hint : ''}`)
      host.send(IPC.chatDone, { requestId: payload.requestId, text: '', error: hint ? `${error}（${hint}）` : error })
      return { ok: false, error }
    }
  })

  ipcMain.handle(IPC.chatAbort, (_e, requestId: number) => {
    host.abortChat(requestId)
    return { ok: true }
  })

  ipcMain.handle(IPC.chatProviders, async () => {
    const list = host.chatProviders()
    const probes = await Promise.all(
      list.map(async (p) => ({
        pluginId: p.pluginId,
        name: p.name,
        model: resolveProvider(p.def, p.config).model,
        type: p.def.type,
        ...(await probeProvider(resolveProvider(p.def, p.config), host.resolveApiKey(p.def))),
      })),
    )
    return probes
  })

  /* ---------------- 渲染进程 → 主进程（无返回） ---------------- */

  ipcMain.on(IPC.setInteractive, (_e, interactive: boolean) => {
    host.win?.setInteractive(!!interactive)
  })

  ipcMain.on(IPC.dragStart, (_event, anchor?: { x: number; y: number }) => {
    engine.noteActivity()
    host.win?.startDrag(anchor)
  })

  ipcMain.on(IPC.dragEnd, () => {
    host.win?.stopDrag()
  })

  ipcMain.on(IPC.hitTestReport, (_e, payload: { interactive: boolean; hit: string | null; probe?: string }) => {
    selfcheck.hitTestReports++
    selfcheck.lastHit = payload.hit
    if (payload.probe) selfcheck.lastProbe = payload.probe
  })

  ipcMain.on(IPC.rendererEvent, (_e, payload: { event: string; data?: Record<string, unknown> }) => {
    engine.noteActivity()
    if (payload.event === 'state:enter' && typeof payload.data?.state === 'string') {
      selfcheck.stateChanges.push(payload.data.state as string)
    }
    if (payload.event === 'pet:geometry') host.win?.setPetGeometry(payload.data as never)
    host.emit(payload.event as never, payload.data)
  })

  ipcMain.on(IPC.log, (_e, args: string[]) => {
    log.info('[renderer]', ...args)
  })

  ipcMain.handle('deskpet:diag', () => ({
    logs: recentLogs().slice(-80),
    displays: screen.getAllDisplays().map((d) => ({
      id: d.id,
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
      primary: d.id === screen.getPrimaryDisplay().id,
    })),
    paths: { userData: app.getPath('userData') },
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
  }))
}
