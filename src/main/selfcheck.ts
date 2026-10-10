import { app, BrowserWindow, nativeImage, screen } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '../shared/ipc.js'
import { log, recentLogs } from './logger.js'
import type { PetHost } from './host.js'
import type { TriggerEngine } from './plugins/declarative.js'
import { probeProvider, resolveProvider } from './chat/providers.js'
import { appRoot, type PetWindow } from './window.js'
import { openSettingsWindow } from './settings-window.js'
import type { InteractionLoop } from './interaction/loop.js'
import { DEFAULT_INTERACTION } from '../shared/types.js'
import { importFrameSequence, inspectLive2D, inspectPsd } from './skin/import.js'
import { importPsd } from './skin/psd-import.js'
import { constrainToGround } from '../shared/action-model.js'

interface Check {
  name: string
  ok: boolean
  detail: string
}

export interface SelfCheckDeps {
  host: PetHost
  engine: TriggerEngine
  petWindow: PetWindow
  interaction: InteractionLoop
  state: {
    bootstrapped: boolean
    settingsReady: boolean
    hitTestReports: number
    lastHit: string | null
    lastProbe: string | null
    stateChanges: string[]
  }
  rendererErrors: string[]
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => boolean, timeoutMs: number, everyMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await wait(everyMs)
  }
  return check()
}

function diffPixels(a: string, b: string): { differing: number; total: number } {
  try {
    const imgA = nativeImage.createFromPath(a)
    const imgB = nativeImage.createFromPath(b)
    const bufA = imgA.toBitmap()
    const bufB = imgB.toBitmap()
    const len = Math.min(bufA.length, bufB.length)
    let differing = 0
    for (let i = 0; i < len; i += 4) {
      if (
        Math.abs(bufA[i] - bufB[i]) > 8 ||
        Math.abs(bufA[i + 1] - bufB[i + 1]) > 8 ||
        Math.abs(bufA[i + 2] - bufB[i + 2]) > 8 ||
        Math.abs(bufA[i + 3] - bufB[i + 3]) > 8
      ) {
        differing++
      }
    }
    return { differing, total: len / 4 }
  } catch (err) {
    log.error('像素比对失败', err)
    return { differing: 0, total: 0 }
  }
}

/**
 * 真机自检：启动 → 等渲染 → 截图（待机 / 换动作+气泡）→ 深度校验 → 写报告。
 * 这是"框架能不能跑"的可重复证据，而不是靠肉眼看窗口。
 */
export async function runSelfCheck(deps: SelfCheckDeps): Promise<number> {
  const { host, engine, petWindow, interaction, state, rendererErrors } = deps
  const outDir = path.join(appRoot, '.runtime', 'selfcheck')
  fs.mkdirSync(outDir, { recursive: true })
  const checks: Check[] = []
  const capture = async (name: string): Promise<string> => {

  const win = BrowserWindow.getAllWindows()[0]
    const file = path.join(outDir, `${name}.png`)
    if (!win) return file
    const image = await win.webContents.capturePage()
    fs.writeFileSync(file, image.toPNG())
    return file
  }

  // 自检要可重复：先关掉会自动移动窗口的行为（否则截图位置会漂）
  const iaBefore = host.config.data.interaction
  host.config.patch({ interaction: { ...iaBefore, look: false, avoid: false, wander: false, idleMode: false, hourlyChime: false, fullscreenQuiet: false } })
  await wait(250)

  const bootstrapped = await waitFor(() => state.bootstrapped, 20_000)
  checks.push({
    name: '渲染进程完成 bootstrap',
    ok: bootstrapped,
    detail: bootstrapped ? 'deskpet://renderer 加载并调用 API 成功' : '20 秒内没有收到 bootstrap',
  })
  // 确定性取景：startup 触发器在 800ms 后才说话（会顺手挥手 + 弹气泡），
  // 所以要等它们全部说完，再关气泡、重置到待机底座，否则"待机"帧里全是启动问候。
  await wait(1700)
  host.send(IPC.bubbleShow, { hide: true })
  host.send(IPC.stateRequest, { state: 'idle', reset: true })
  await wait(700)
  const idleShot = await capture('window-idle')

  // 让渲染进程切到 wave + 显示气泡，验证"状态切换"与"气泡渲染"两条链路
  host.send(IPC.stateRequest, { state: 'wave' })
  host.send(IPC.bubbleShow, { text: '自检：这是气泡渲染测试 ✨', pluginId: 'selfcheck' })
  await wait(900)
  const talkShot = await capture('window-wave-bubble')

  const idleVsWave = diffPixels(idleShot, talkShot)
  checks.push({
    name: '动画/状态切换改变画面',
    ok: idleVsWave.differing > 200,
    detail: `待机帧与 wave+气泡帧相差 ${idleVsWave.differing} 像素（阈值 200）`,
  })

  host.send(IPC.bubbleShow, { hide: true })
  await wait(600)
  const clearedShot = await capture('window-bubble-cleared')
  const waveVsCleared = diffPixels(talkShot, clearedShot)
  checks.push({
    name: '气泡可关闭',
    ok: waveVsCleared.differing > 100,
    detail: `关闭气泡后相差 ${waveVsCleared.differing} 像素`,
  })

  const skin = host.registry.resolveSkin(host.config.data.skin)
  const sprite = skin?.kind === 'sprite' ? skin : null
  const atlasFrames = sprite ? Object.keys(sprite.atlas.frames) : []
  const states = host.registry.mergedStates(host.config.data.skin)
  const missingFrames: string[] = []
  for (const [name, st] of Object.entries(states?.states ?? {})) {
    for (const clip of st.clips ?? []) {
      for (const f of clip.frames) if (!atlasFrames.includes(f)) missingFrames.push(`${name}:${f}`)
    }
  }
  checks.push({
    name: '皮肤已解析',
    ok: !!skin && (skin.kind === 'rig' ? skin.rig.layers.length > 0 : skin.kind === 'live2d' ? !!skin.modelUrl : atlasFrames.length > 0),
    detail: skin
      ? skin.kind === 'rig'
        ? `${skin.name}（${skin.pluginId}）：2.5D 装配 ${skin.rig.layers.length} 层`
        : skin.kind === 'live2d' ? `${skin.name}：Live2D，${skin.motions.length} 组原生动作`
        : `${skin.name}（${skin.pluginId}）：${atlasFrames.length} 帧 / ${Object.keys(states?.states ?? {}).length} 状态`
      : '没有可用的皮肤（检查 packs/ 里的皮肤插件是否 ok）',
  })
  checks.push({
    name: '状态引用的帧都在图集里',
    ok: skin !== null && missingFrames.length === 0,
    detail: missingFrames.length ? `缺失：${missingFrames.slice(0, 6).join(', ')}` : '全部命中',
  })

  const broken = host.registry.list().filter((p) => !p.ok)
  checks.push({
    name: '所有插件清单校验通过',
    ok: broken.length === 0,
    detail: broken.length ? broken.map((p) => `${p.id}: ${p.errors.join('; ')}`).join(' | ') : `${host.registry.list().length} 个插件全部通过`,
  })

  const providers = host.chatProviders()
  const probes = await Promise.all(
    providers.map(async (p) => ({
      pluginId: p.pluginId,
      type: p.def.type,
      model: resolveProvider(p.def, p.config).model,
      ...(await probeProvider(resolveProvider(p.def, p.config), host.resolveApiKey(p.def))),
    })),
  )
  const reachable = probes.filter((p) => p.reachable)
  checks.push({
    name: '聊天后端已声明',
    ok: providers.length > 0,
    detail: providers.map((p) => `${p.pluginId}(${p.def.type})`).join(', ') || '没有任何 kind=chat 的插件',
  })

  checks.push({
    name: '渲染进程无 JS 报错',
    ok: rendererErrors.length === 0,
    detail: rendererErrors.length ? rendererErrors.slice(0, 3).join(' | ') : '干净',
  })

  // 命中判定是"默认穿透 + 只在实际内容上可点"的核心：让渲染层周期性上报，
  // 并在宠物中心做一次合成探针，确认 alpha 掩膜真的能分辨"宠物本体"与"透明区域"
  const hitAlive = await waitFor(() => state.hitTestReports > 0, 5000)
  checks.push({
    name: '命中判定循环在上报',
    ok: hitAlive,
    detail: `收到 ${state.hitTestReports} 次上报，最近命中：${state.lastHit ?? '（指针不在宠物上，正常）'}`,
  })
  checks.push({
    name: '像素级命中判定可用（宠物中心判定为命中）',
    ok: state.lastProbe === 'pet',
    detail: `合成探针结果：${state.lastProbe ?? '（没有收到探针）'}（期望 pet）`,
  })

  const win = BrowserWindow.getAllWindows()[0]
    // ---- 设置中心：独立窗口、独立页面、独立 preload，值得单独验一遍 ----
  const settingsWin = openSettingsWindow('chat')
  const settingsReady = await waitFor(() => state.settingsReady, 15_000)
  await wait(600)
  const settingsShot = path.join(outDir, 'settings-window.png')
  try {
    const image = await settingsWin.webContents.capturePage()
    fs.writeFileSync(settingsShot, image.toPNG())
  } catch (err) {
    log.warn('设置窗口截图失败', err)
  }
  const settingsBytes = fs.existsSync(settingsShot) ? fs.statSync(settingsShot).size : 0
  checks.push({
    name: '设置中心窗口能打开并渲染',
    ok: settingsReady && settingsBytes > 5000,
    detail: settingsReady
      ? `渲染层就绪，截图 ${settingsBytes} 字节 -> ${path.relative(appRoot, settingsShot)}`
      : '15 秒内没有收到设置中心的 ready 上报',
  })
  checks.push({
    name: '设置中心加载后仍无渲染层报错',
    ok: rendererErrors.length === 0,
    detail: rendererErrors.length ? rendererErrors.slice(0, 3).join(' | ') : '干净',
  })
  openSettingsWindow('model')
  await wait(250)
  fs.writeFileSync(path.join(outDir, 'settings-model.png'), (await settingsWin.webContents.capturePage()).toPNG())
  const modelControls = await settingsWin.webContents.executeJavaScript(`({
    models: document.querySelectorAll('#skin-list .skin').length,
    actions: document.querySelectorAll('#skin-current button').length,
    scale: !!document.querySelector('#skin-current input[type="number"]')
  })`)
  checks.push({ name: '模型页提供角色选择、动作预览与大小设置', ok: modelControls.models >= 2 && modelControls.actions >= 4 && modelControls.scale, detail: JSON.stringify(modelControls) })
  settingsWin.destroy()

  // ---- 互动：配置完整性、视线跟随链路、摸头计数、循环存活 ----
  const ia = host.config.data.interaction
  const expectedKeys = Object.keys(DEFAULT_INTERACTION)
  const missingKeys = expectedKeys.filter((k) => !(k in ia))
  checks.push({
    name: '互动配置已就位（字段齐全）',
    ok: missingKeys.length === 0 && ['low', 'mid', 'high'].includes(ia.activity),
    detail: missingKeys.length ? `缺字段：${missingKeys.join(',')}` : `${expectedKeys.length} 个字段，活动档位 ${ia.activity}`,
  })

  host.config.patch({ interaction: { ...host.config.data.interaction, look: true } })
  await wait(200)
  const lookBefore = await capture('window-look-off')
  host.send(IPC.cursor, { dx: 900, dy: 0, dist: 900 })
  await wait(500)
  const lookAfter = await capture('window-look-on')
  const lookDiff = diffPixels(lookBefore, lookAfter)
  checks.push({
    name: '视线跟随链路：合成光标偏移会改变宠物画面',
    ok: lookDiff.differing > 150,
    detail: `偏移前后相差 ${lookDiff.differing} 像素（阈值 150）`,
  })

  const patBefore = host.config.data.interaction.patCount
  host.emit('click', { pluginId: 'selfcheck', pat: true })
  await wait(250)
  const patAfter = host.config.data.interaction.patCount
  checks.push({
    name: '摸头事件会累加亲密度并触发 click 触发器',
    ok: patAfter === patBefore + 1,
    detail: `patCount ${patBefore} → ${patAfter}`,
  })
  host.config.patch({ interaction: { ...host.config.data.interaction, patCount: patBefore } })

  const snapshot = interaction.getSnapshot()
  const petSize = snapshot.petSize as { width: number; height: number }
  checks.push({
    name: '互动循环存活且拿到渲染层报名的宠物尺寸',
    ok: Number(petSize?.width) > 0,
    detail: `petSize = ${petSize?.width}x${petSize?.height}，漫游目标 = ${JSON.stringify(snapshot.target)}`,
  })

  // 正式宿主的新动作：通过与菜单相同的命令链路调用，不使用预览页。
  if (host.config.data.skin === 'builtin.blue-maid' && win) {
    const actionFailures: string[] = []
    for (const action of ['walk', 'happy', 'angry', 'sad', 'neutral', 'sleep-curl']) {
      await host.runCommand('builtin', `pose-${action}`)
      await wait(230)
      const current = await win.webContents.executeJavaScript(`document.getElementById('pet').dataset.state`)
      if (current !== action) actionFailures.push(`${action} -> ${current}`)
      await capture(`window-action-${action}`)
    }
    checks.push({ name: '正式桌宠支持移动、喜怒哀乐和蜷缩动作', ok: actionFailures.length === 0, detail: actionFailures.join(' | ') || '6 个动作均通过宿主命令切换' })
    for (const edge of ['left', 'right', 'bottom'] as const) {
      await host.runCommand('builtin', `dock-${edge}`)
      await wait(250)
      const current = await win.webContents.executeJavaScript(`document.getElementById('pet').dataset.body`)
      const expected = edge === 'bottom' ? 'lounge-bottom' : `peek-${edge}`
      const position = petWindow.getPosition()!, geometry = petWindow.geometry
      const display = screen.getDisplayMatching(win.getBounds())
      const area = edge === 'bottom' && geometry.loungeLine !== undefined ? display.workArea : display.bounds
      const line = edge === 'bottom' ? position.y + geometry.y + (geometry.loungeLine ?? geometry.height) : position.x + geometry.x + (edge === 'left' ? geometry.leftLine : geometry.rightLine)
      const boundary = edge === 'bottom' ? area.y + area.height : edge === 'left' ? area.x : area.x + area.width
      checks.push({ name: `正式桌宠 ${edge} 边缘动作与裁切位置正确`, ok: current === expected && Math.abs(line - boundary) < 2, detail: `${current} · 裁切偏差 ${Math.abs(line - boundary).toFixed(2)}px` })
      const screenshot = await win.webContents.capturePage()
      const size = screenshot.getSize(), bounds = win.getBounds(), sx = size.width / bounds.width, sy = size.height / bounds.height
      const left = Math.max(0, area.x - bounds.x), top = Math.max(0, area.y - bounds.y)
      const right = Math.min(bounds.width, area.x + area.width - bounds.x), bottom = Math.min(bounds.height, area.y + area.height - bounds.y)
      if (right > left && bottom > top) fs.writeFileSync(path.join(outDir, `window-dock-${edge}.png`), screenshot.crop({ x: Math.round(left * sx), y: Math.round(top * sy), width: Math.max(1, Math.floor((right - left) * sx)), height: Math.max(1, Math.floor((bottom - top) * sy)) }).toPNG())
      await host.runCommand('builtin', 'wake')
      await wait(150)
    }
    const anchor = { x: petWindow.geometry.collarX, y: petWindow.geometry.collarY }
    petWindow.startDrag(anchor)
    await wait(150)
    const dragState = await win.webContents.executeJavaScript(`document.getElementById('pet').dataset.body`)
    let cornerError = 0
    const display = screen.getPrimaryDisplay().bounds
    for (const point of [{ x: display.x, y: display.y }, { x: display.x + display.width - 1, y: display.y }, { x: display.x, y: display.y + display.height - 1 }, { x: display.x + display.width - 1, y: display.y + display.height - 1 }]) {
      petWindow.moveDragTo(point)
      const pos = petWindow.getPosition()!
      const expected = constrainToGround({ x: point.x - anchor.x, y: point.y - anchor.y }, petWindow.geometry, display)
      cornerError = Math.max(cornerError, Math.abs(pos.x - expected.x), Math.abs(pos.y - expected.y))
      if (pos.y + petWindow.geometry.y + petWindow.geometry.height > display.y + display.height + 1) cornerError = 10000
    }
    checks.push({ name: '正式窗口拖到屏幕四角时保持实地边界且使用提衣领动作', ok: cornerError < 2 && dragState === 'drag-lift', detail: `${dragState} · 地面约束偏差 ${cornerError.toFixed(2)}px` })
    petWindow.stopDrag()
    await host.runCommand('builtin', 'wake')
    host.send(IPC.stateRequest, { state: 'idle', reset: true })
    await wait(200)
  }

  // ---- 模型导入：合成一段帧序列 → 走真实导入器 → 装成皮肤 → 切过去看画面是否真变 ----
  const importRoot = path.join(app.getPath('userData'), 'plugins')
  const synthDir = path.join(app.getPath('userData'), 'selfcheck-import-src')
  const skinBeforeImport = host.config.data.skin
  fs.rmSync(synthDir, { recursive: true, force: true })
  fs.mkdirSync(synthDir, { recursive: true })

  const makeFrame = (file: string, rgb: [number, number, number]): void => {
    const size = 64
    const buf = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = (y * size + x) * 4
        const edge = x < 3 || y < 3 || x >= size - 3 || y >= size - 3
        buf[i] = edge ? 255 : rgb[2]
        buf[i + 1] = edge ? 255 : rgb[1]
        buf[i + 2] = edge ? 255 : rgb[0]
        buf[i + 3] = 255
      }
    }
    fs.writeFileSync(file, nativeImage.createFromBitmap(buf, { width: size, height: size }).toPNG())
  }
  makeFrame(path.join(synthDir, 'idle_0.png'), [30, 80, 210])
  makeFrame(path.join(synthDir, 'idle_1.png'), [40, 110, 230])
  makeFrame(path.join(synthDir, 'wave_0.png'), [220, 90, 40])
  makeFrame(path.join(synthDir, 'wave_1.png'), [240, 130, 60])

  const imported = importFrameSequence(synthDir, importRoot, '自检合成皮肤')
  checks.push({
    name: '帧序列导入：装成标准皮肤插件包',
    ok: imported.ok && !!imported.pluginId,
    detail: imported.ok
      ? `${imported.pluginId} · ${imported.frames} 帧 · ${(imported.states ?? []).map((s) => `${s.name}(${s.frames})`).join('/')}`
      : (imported.error ?? '未知原因'),
  })

  const pkgDir = imported.pluginId ? path.join(importRoot, imported.pluginId) : ''
  const required = ['plugin.json', 'atlas.json', 'states.json', 'spritesheet.png']
  const missingFiles = pkgDir ? required.filter((f) => !fs.existsSync(path.join(pkgDir, f))) : required
  checks.push({
    name: '导入产物齐全（plugin/atlas/states/spritesheet）',
    ok: !!pkgDir && missingFiles.length === 0,
    detail: missingFiles.length ? `缺：${missingFiles.join(',')}` : required.join(' / '),
  })

  let importedStates: { default?: string; states?: Record<string, unknown> } | null = null
  try {
    importedStates = JSON.parse(fs.readFileSync(path.join(pkgDir, 'states.json'), 'utf8'))
  } catch {
    importedStates = null
  }
  checks.push({
    name: '导入的帧按前缀正确分组（idle + wave）',
    ok: !!importedStates?.states?.idle && !!importedStates?.states?.wave,
    detail: importedStates ? `状态：${Object.keys(importedStates.states ?? {}).join(',')}` : '没读到 states.json',
  })

  host.registry.reload()
  const importedRecord = imported.pluginId ? host.registry.get(imported.pluginId) : undefined
  checks.push({
    name: '重新扫描后新皮肤被识别且校验通过',
    ok: !!importedRecord && importedRecord.ok && importedRecord.manifest.kind === 'skin',
    detail: importedRecord ? `id=${importedRecord.id} source=${importedRecord.source} errors=${importedRecord.errors.length}` : '注册表里没有它',
  })

  const skinShotBefore = await capture('window-skin-builtin')
  if (imported.pluginId) host.setSkin(imported.pluginId, 'selfcheck')
  await wait(900)
  const skinShotAfter = await capture('window-skin-imported')
  const skinDiff = diffPixels(skinShotBefore, skinShotAfter)
  checks.push({
    name: '切到导入的外形后画面确实变了',
    ok: skinDiff.differing > 800,
    detail: `切换前后相差 ${skinDiff.differing} 像素（阈值 800）`,
  })

  // 还原：先切回原皮肤，再删掉导入包，不给用户留垃圾
  if (skinBeforeImport) host.setSkin(skinBeforeImport, 'selfcheck')
  await wait(300)
  if (pkgDir) fs.rmSync(pkgDir, { recursive: true, force: true })
  fs.rmSync(synthDir, { recursive: true, force: true })
  host.registry.reload()

  // ---- 分层 PSD：合成一个分层 PSD → 走真装配 → 装成 2.5D 皮肤 → 切过去看它是否在动 ----
  try {
    const agPsd = await import('ag-psd')
    const ellipse = (w: number, h: number, rgb: [number, number, number], scale = 1): { width: number; height: number; data: Uint8ClampedArray } => {
      const data = new Uint8ClampedArray(w * h * 4)
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const nx = (x - w / 2) / ((w / 2) * scale)
          const ny = (y - h / 2) / ((h / 2) * scale)
          const inside = nx * nx + ny * ny <= 1
          const i = (y * w + x) * 4
          data[i] = rgb[0]
          data[i + 1] = rgb[1]
          data[i + 2] = rgb[2]
          data[i + 3] = inside ? 255 : 0
        }
      }
      return { width: w, height: h, data }
    }
    const psdLayer = (name: string, left: number, top: number, img: { width: number; height: number; data: Uint8ClampedArray }) => ({
      name,
      left,
      top,
      right: left + img.width,
      bottom: top + img.height,
      imageData: img,
    })
    const synthetic = {
      width: 220,
      height: 260,
      children: [
        psdLayer('back hair', 40, 15, ellipse(140, 120, [90, 60, 40])),
        psdLayer('body', 60, 150, ellipse(100, 110, [70, 110, 200])),
        psdLayer('neck', 95, 130, ellipse(30, 30, [240, 210, 180])),
        psdLayer('face', 45, 30, ellipse(130, 130, [248, 220, 190])),
        psdLayer('eyewhite', 66, 68, ellipse(101, 24, [255, 255, 255])),
        psdLayer('irides', 66, 70, ellipse(101, 18, [60, 40, 90], 0.55)),
        psdLayer('mouth_open', 95, 112, ellipse(30, 16, [180, 70, 80])),
        psdLayer('mouth_close', 99, 116, ellipse(22, 8, [150, 60, 70])),
        psdLayer('front hair', 45, 22, ellipse(130, 60, [120, 80, 50])),
      ],
    }
    const psdPath = path.join(app.getPath('userData'), 'selfcheck-synthetic.psd')
    fs.writeFileSync(psdPath, agPsd.writePsdBuffer(synthetic, { generateThumbnail: false }))

    const importedPsd = await importPsd(psdPath, importRoot, '自检 PSD 角色')
    checks.push({
      name: '分层 PSD 装配：装成 2.5D 皮肤包',
      ok: importedPsd.ok && !!importedPsd.pluginId,
      detail: importedPsd.ok
        ? `${importedPsd.pluginId} · ${importedPsd.layers} 层 · ${JSON.stringify(importedPsd.rig)}`
        : (importedPsd.error ?? '未知原因').slice(0, 110),
    })

    host.registry.reload()
    const rigSkin = importedPsd.pluginId ? host.registry.resolveSkin(importedPsd.pluginId) : null
    checks.push({
      name: '装配结果被注册表解析为 2.5D 外形',
      ok: !!rigSkin && rigSkin.kind === 'rig' && rigSkin.rig.layers.length > 5,
      detail: rigSkin ? `kind=${rigSkin.kind} 图层=${rigSkin.kind === 'rig' ? rigSkin.rig.layers.length : '-'}` : '解析失败',
    })

    if (importedPsd.ok && importedPsd.pluginId) {
      host.registry.reload()
      host.setSkin(importedPsd.pluginId, 'selfcheck')
      await wait(1400)
      const rigShot = await capture('window-rigged')
      const rigDiff = diffPixels(skinShotBefore, rigShot)
      checks.push({
        name: '切到 2.5D 外形后画面确实变了（渲染层在画）',
        ok: rigDiff.differing > 2000,
        detail: `与精灵图外形相差 ${rigDiff.differing} 像素（阈值 2000）`,
      })
      await wait(600)
      const rigShot2 = await capture('window-rigged-2')
      const motion = diffPixels(rigShot, rigShot2)
      checks.push({
        name: '2.5D 外形在持续动（呼吸 / 眨眼 / 视线）',
        ok: motion.differing > 50,
        detail: `相隔 600ms 的两帧相差 ${motion.differing} 像素（阈值 50）`,
      })
      host.setSkin(skinBeforeImport, 'selfcheck')
      await wait(300)
      fs.rmSync(path.join(importRoot, importedPsd.pluginId), { recursive: true, force: true })
      host.registry.reload()
    }
    fs.rmSync(psdPath, { force: true })
  } catch (err) {
    checks.push({
      name: '分层 PSD 装配',
      ok: false,
      detail: `异常：${err instanceof Error ? err.message : String(err)}`,
    })
  }

  // 识别路径：PSD 与 Live2D（本版本都只识别不装）
  const fakePsd = path.join(app.getPath('userData'), 'selfcheck-fake.psd')
  fs.writeFileSync(fakePsd, Buffer.concat([Buffer.from('8BPS', 'ascii'), Buffer.alloc(64)]))
  const psdInspect = inspectPsd(fakePsd)
  fs.rmSync(fakePsd, { force: true })
  checks.push({
    name: 'PSD 识别：认出 8BPS 并说明为何暂不支持',
    ok: psdInspect.detected === 'psd' && /ag-psd/.test(psdInspect.error ?? ''),
    detail: (psdInspect.error ?? '').slice(0, 70),
  })

  const l2dDir = path.join(app.getPath('userData'), 'selfcheck-live2d')
  fs.mkdirSync(l2dDir, { recursive: true })
  fs.writeFileSync(path.join(l2dDir, 'test.model3.json'), '{}')
  const l2dInspect = inspectLive2D(l2dDir)
  fs.rmSync(l2dDir, { recursive: true, force: true })
  checks.push({
    name: 'Live2D 识别：认出 model3.json 并说明授权限制',
    ok: l2dInspect.detected === 'live2d' && /授权/.test(l2dInspect.error ?? ''),
    detail: (l2dInspect.error ?? '').slice(0, 70),
  })

  // 自检为了截图稳定改过互动配置，结束前必须还原，否则会把用户的设置留成关掉的
  host.config.patch({ interaction: iaBefore })
  checks.push({ name: '模型导入与切换后渲染层仍无报错', ok: rendererErrors.length === 0, detail: rendererErrors.length ? rendererErrors.slice(0, 5).join(' | ') : '干净' })

  const report = {
    generatedAt: new Date().toISOString(),
    app: { version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    platform: process.platform,
    display: win ? { bounds: win.getBounds(), alwaysOnTop: win.isAlwaysOnTop() } : null,
    config: host.config.data,
    skin: skin
      ? { pluginId: skin.pluginId, name: skin.name, frames: atlasFrames.length, states: Object.keys(states?.states ?? {}) }
      : null,
    plugins: host.registry.list().map((p) => ({
      id: p.id,
      kind: p.manifest.kind,
      runtime: p.manifest.runtime,
      version: p.manifest.version,
      source: p.source,
      enabled: p.enabled,
      ok: p.ok,
      errors: p.errors,
      warnings: p.warnings,
      permissions: p.manifest.permissions ?? [],
    })),
    triggers: engine.describe(),
    commands: host.listCommands(),
    chatProviders: probes,
    reachableChatProviders: reachable.length,
    pixelDiffs: { idleVsWave, waveVsCleared },
    screenshots: {
      idle: path.relative(appRoot, idleShot),
      waveBubble: path.relative(appRoot, talkShot),
      bubbleCleared: path.relative(appRoot, clearedShot),
    },
    checks,
    failed: checks.filter((c) => !c.ok).map((c) => c.name),
    logs: recentLogs().slice(-60),
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')

  log.info('================ selfcheck ================')
  for (const c of checks) log.info(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`)
  log.info(`报告：${path.join(outDir, 'report.json')}`)
  if (reachable.length === 0) {
    log.warn('没有可达的聊天后端（不影响框架自检；接上 Ollama 或填 API key 后即可对话）')
  }
  host.registry.list()
  return checks.some((c) => !c.ok) ? 1 : 0
}
