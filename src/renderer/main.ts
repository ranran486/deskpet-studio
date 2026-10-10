import type { BootstrapData } from './api.js'
import { Bubble } from './bubble.js'
import { SpritePlayer } from './sprite.js'
import { RiggedView } from './rigged.js'
import { Live2DView } from './live2d.js'
import { CursorFollow, normalizeCursor } from './interaction.js'
import { PetPlayUI, wirePetGestures } from './pet-play.js'
import type { SkinView } from './skinview.js'
import type { AppConfig, ResolvedSkin, States, ThemeTokens } from '../shared/types.js'
import { DEFAULT_BEHAVIOR, bodyForSignal, type BehaviorSignal } from '../shared/action-model.js'
import { actionBindingReport } from '../shared/action-profile.js'

const api = window.deskpet

let config: AppConfig
let boot: BootstrapData
let view: SkinView
let bubble: Bubble
let play: PetPlayUI
let localChat = false
let restingBubbleUntil = 0
let dragBubbleUntil = 0
let chatSeq = 0
let lastHit: string | null = null
let pointer = { x: -1, y: -1 }
let dragging = false
let pointerDownOnPet = false
let cursorFollow: CursorFollow | null = null
let skinUpdates = Promise.resolve()
let behavior: BehaviorSignal = { ...DEFAULT_BEHAVIOR }

function syncPosturePresentation(): void {
  if (!play || !bubble || !view?.ready) return
  const posture = bodyForSignal(behavior)
  const bound = actionBindingReport(boot.states?.states ?? {}, boot.skin?.actionProfile).some(item => item.action === posture && item.mode === 'bound')
  const resting = !dragging && !behavior.dragging && behavior.resting && bound
  const shown = resting ? posture : 'none'
  const bottom = shown === 'hang-top' ? '120px' : '0px'
  const moved = canvas.style.bottom !== bottom
  canvas.style.bottom = bottom
  canvas.dataset.posture = shown
  const rect = view.bounds()
  const clipped = shown === 'lounge-bottom' && behavior.surface ? Math.max(0, rect.bottom - behavior.surface.bottom) : 0
  canvas.style.clipPath = clipped > 0 ? `inset(0px 0px ${clipped}px 0px)` : 'none'
  play.setSurface(behavior.surface); play.setPosture(shown)
  bubble.setPosture(shown, behavior.surface)
  if (moved) reportGeometry()
}
function visibleAlpha(x: number, y: number): number {
  if (canvas.dataset.posture === 'lounge-bottom' && behavior.surface && y >= behavior.surface.bottom) return 0
  return view.alphaAt(x, y)
}

function followConfig() { return { ...config.interaction, look: config.interaction.look && !dragging && !behavior.dragging && !behavior.resting && !play?.state.dozing } }
function reportGeometry(): void {
  const geometry = view.geometry()
  api.report('pet:size', { width: Math.round(geometry.width), height: Math.round(geometry.height) })
  api.report('pet:geometry', { ...geometry })
}

const canvas = document.getElementById('pet') as HTMLCanvasElement

/* ------------------------------------------------------------------ *
 * 主题
 * ------------------------------------------------------------------ */

function applyTheme(tokens: ThemeTokens | null): void {
  if (!tokens) return
  const map: Record<string, string | undefined> = {
    '--bubble-bg': tokens.bubbleBackground,
    '--bubble-color': tokens.bubbleColor,
    '--bubble-radius': tokens.bubbleRadius,
    '--bubble-font': tokens.bubbleFontFamily,
    '--bubble-size': tokens.bubbleFontSize,
    '--bubble-max-width': tokens.bubbleMaxWidth,
    '--bubble-shadow': tokens.bubbleShadow,
    '--accent': tokens.accent,
  }
  for (const [key, value] of Object.entries(map)) {
    if (value) document.documentElement.style.setProperty(key, value)
  }
  for (const [key, value] of Object.entries(tokens.extra ?? {})) {
    document.documentElement.style.setProperty(key.startsWith('--') ? key : `--${key}`, value)
  }
  const bubbleEl = document.getElementById('bubble')
  if (bubbleEl && tokens.bubbleBorder) bubbleEl.style.border = tokens.bubbleBorder
}

/* ------------------------------------------------------------------ *
 * 命中判定 → 点击穿透开关
 * ------------------------------------------------------------------ */

function computeHit(): string | null {
  if (dragging || behavior.dragging || pointerDownOnPet) return 'pet'
  const food = play?.rect()
  if (food && pointer.x >= food.left && pointer.x <= food.right && pointer.y >= food.top && pointer.y <= food.bottom) return 'feeding'
  const rect = bubble?.rect()
  if (
    rect &&
    pointer.x >= rect.left &&
    pointer.x <= rect.right &&
    pointer.y >= rect.top &&
    pointer.y <= rect.bottom
  ) {
    return 'bubble'
  }
  if (pointer.x < 0 || pointer.y < 0) return null
  if (view?.ready && visibleAlpha(pointer.x, pointer.y) > 16) return 'pet'
  return null
}

function evaluateHit(report = false): void {
  const hit = computeHit()
  if (hit === lastHit) return
  lastHit = hit
  api.setInteractive(!!hit)
  api.hitTest({ interactive: !!hit, hit })
  if (report) api.log(`命中判定 → ${hit ?? '穿透'}`)
}

let hitTicks = 0

function heartbeat(): void {
  if (++hitTicks % 5 !== 0) return
  const rect = view.bounds()
  const alpha = view.alphaAt(rect.left + rect.width / 2, rect.top + rect.height / 2)
  api.hitTest({ interactive: !!lastHit, hit: lastHit, probe: alpha > 16 ? 'pet' : 'transparent' })
}

function startHitLoop(): void {
  window.addEventListener(
    'pointermove',
    (e) => {
      pointer = { x: e.clientX, y: e.clientY }
      evaluateHit()
    },
    { passive: true },
  )
  document.addEventListener('mouseleave', () => {
    pointer = { x: -1, y: -1 }
    evaluateHit()
  })
  // 指针不动时也要复评：拖动、气泡出现/消失都会改变命中区域。
  // 另外周期性把状态与"宠物中心合成探针"上报给主进程 —— 只在变化时上报的话，
  // 指针不动就完全观测不到命中判定是否还活着（selfcheck 曾经因此误报）。
  window.setInterval(() => {
    evaluateHit()
    heartbeat()
  }, 350)
  evaluateHit(true)
  heartbeat()
}

/* ------------------------------------------------------------------ *
 * 聊天
 * ------------------------------------------------------------------ */

async function send(text: string): Promise<void> {
  const requestId = ++chatSeq
  bubble.startStreaming('思考中…')
  view.talk(true)
  api.report('chat:message', { text })
  const res = await api.chatSend({ requestId, text, ...(localChat ? { providerId: 'builtin.local-text' } : {}) })
  if (requestId !== chatSeq) return
  if (!res.ok) {
    view.talk(false)
    bubble.finishStreaming({ error: res.error ?? '聊天失败' })
  }
}

function wireChat(): void {
  api.onChatDelta(({ requestId, chunk }) => {
    if (requestId !== chatSeq) return
    bubble.appendDelta(chunk)
  })
  api.onChatDone(({ requestId, text, error, source }) => {
    if (requestId !== chatSeq) return
    view.talk(false)
    bubble.finishStreaming({ text, error, hint: source === 'local' ? '本地文案回应 · 无需 API' : '' })
    canvas.dataset.chatSource = source ?? 'api'
  })
}

/* ------------------------------------------------------------------ *
 * 交互
 * ------------------------------------------------------------------ */

/** 命令菜单：右键弹出，执行完重新拉一次（开关类命令的标题会变） */
function showCommandMenu(): void { void api.showContextMenu() }

function wireInteraction(): void {
  wirePetGestures({
    canvas, bounds: () => view.bounds(), hit: (x, y) => view.ready && visibleAlpha(x, y) > 16, dozing: () => play.state.dozing,
    interact: kind => { if ((kind === 'pat' || kind === 'rub') && !config.interaction.pet) return; void api.petInteract(kind); if (kind === 'pat' || kind === 'rub') api.report('click', { pat: true, localHandled: true }) },
    pressed: on => { pointerDownOnPet = on; evaluateHit() },
    dragStart: () => { dragging = true; canvas.classList.add('dragging'); cursorFollow?.reset(); play.hide(); view.drag(true); syncPosturePresentation(); reportGeometry(); const geometry = view.geometry(); api.dragStart({ x: geometry.collarX, y: geometry.collarY }) },
    dragEnd: () => { dragging = false; canvas.classList.remove('dragging'); view.drag(false); api.dragEnd(); evaluateHit(true) },
    feed: () => { api.report('double-click', {}); void api.invokePlugin({ kind: 'command', pluginId: 'builtin', name: 'feed' }) },
  })

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (!view.ready || visibleAlpha(e.clientX, e.clientY) <= 16) return
    api.report('right-click', {})
    showCommandMenu()
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { bubble.hide(); play.hide() }
  })
}

/* ------------------------------------------------------------------ *
 * 主进程推送
 * ------------------------------------------------------------------ */

function wireIpc(): void {
  api.onFeedPanel(() => { bubble.hide(); play.show(); evaluateHit() })
  api.onPetLife(state => {
    play.update(state)
    if (view.expression) view.expression(state.expression, undefined, state.durationMs)
    else if (state.expression === 'neutral') view.resetToBase()
    else view.react(state.expression, state.durationMs)
    if (state.dozing) { cursorFollow?.reset(); view.setLook?.(0, 0) }
    canvas.dataset.dozing = String(state.dozing); canvas.dataset.expression = state.expression; canvas.dataset.mood = String(state.mood)
  })
  api.onExpression(({ emotion, action }) => { if (view.expression) view.expression(emotion, action); else view.react(emotion, 3200) })
  api.onBubble((payload) => {
    if (payload.hide) {
      bubble.hide()
      return
    }
    if (payload.input) { localChat = !!payload.local; play.hide(); bubble.toggleInput(true); return }
    if (payload.allowWhileResting) restingBubbleUntil = performance.now() + (payload.durationMs ?? 3500)
    if (payload.allowWhileDragging) { dragBubbleUntil = performance.now() + (payload.durationMs ?? 3500); document.getElementById('bubble')?.classList.remove('drag-hidden') }
    if (payload.text && (!dragging || payload.allowWhileDragging) && (!behavior.resting || payload.allowWhileResting) && !behavior.paused) bubble.show(payload.text, { typewriter: !payload.allowWhileDragging, durationMs: payload.durationMs })
  })

  api.onStateRequest(({ state, reset }) => {
    if (reset) view.resetToBase()
    else view.react(state, 2600)
  })

  api.onSkinApply(({ skin, states }) => {
    skinUpdates = skinUpdates.then(() => applySkin(skin, states))
  })

  api.onThemeApply((tokens) => applyTheme(tokens))

  api.onConfigChanged((next) => {
    const scaleChanged = config.scale !== next.scale
    config = next
    if (scaleChanged && boot.skin) skinUpdates = skinUpdates.then(() => applySkin(boot.skin!, boot.states))
  })

  api.onEvent((payload) => {
    if (payload.type === 'config:reload-theme') applyTheme(boot.theme)
  })
}

async function applySkin(skin: ResolvedSkin, states: States | null): Promise<void> {
  const previousSkin = boot.skin
  const previousStates = boot.states
  try {
    boot.skin = skin
    boot.states = states
    view.stop()
    view.dispose?.()
    cursorFollow?.stop()
    cursorFollow = null
    view = createView(skin)
    await view.load(skin, states, config.scale)
    view.start()
    if (skin.kind === 'sprite') {
      cursorFollow = new CursorFollow({ canvas, getConfig: followConfig })
      cursorFollow.start()
    }
    const rect = view.bounds()
    document.documentElement.style.setProperty('--pet-height', `${Math.round(rect.height)}px`)
    view.setBehavior(behavior)
    syncPosturePresentation()
    if (behavior.paused) view.stop()
    else view.start()
    reportGeometry()
    api.log(`已切换外形：${skin.name}`)
    bubble.show(`换好啦：${skin.name}`, { durationMs: 1600 })
  } catch (err) {
    // 加载失败后恢复上一个可用模型，避免透明窗口里只剩空画布。
    if (previousSkin) {
      view.stop()
      view.dispose?.()
      boot.skin = previousSkin
      boot.states = previousStates
      view = createView(previousSkin)
      await view.load(previousSkin, previousStates, config.scale)
      view.start()
    }
    api.log('切换外形失败', String(err))
    bubble.show(`外形加载失败：${String(err)}`, { typewriter: false })
  }
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

/** 动画状态上报（精灵图状态机用；2.5D 视图没有帧状态，不需要） */
function reportState(state: string, reason: string): void {
  if (reason.startsWith('missing') || reason.startsWith('error')) {
    api.log('动画告警', state, reason)
    api.report('renderer:error', { message: `${reason} (${state})` })
    return
  }
  if (reason !== 'load') api.report('state:enter', { state })
}

/** 按外形类型选渲染视图：精灵图走帧动画，rig 走 2.5D 逐层变换 */
function createView(skin: ResolvedSkin | null): SkinView {
  if (skin?.kind === 'live2d') { cursorFollow?.stop(); cursorFollow = null; return new Live2DView(canvas) }
  if (skin?.kind === 'rig') {
    cursorFollow?.stop()
    cursorFollow = null
    return new RiggedView(canvas)
  }
  return new SpritePlayer({ canvas, scale: config.scale, onStateChange: reportState })
}

async function main(): Promise<void> {
  window.addEventListener('resize', () => { if (view?.ready) { syncPosturePresentation(); reportGeometry() } })
  window.addEventListener('error', (e) => {
    api.report('renderer:error', { message: `${e.message} @ ${e.filename}:${e.lineno}` })
  })
  window.addEventListener('unhandledrejection', (e) => {
    api.report('renderer:error', { message: `unhandledrejection: ${String(e.reason)}` })
  })

  boot = await api.bootstrap()
  config = boot.config
  applyTheme(boot.theme)

  view = createView(boot.skin)

  bubble = new Bubble({ onSend: (text) => void send(text), getPetBounds: () => view.bounds(), onCancel: () => { void api.chatAbort(chatSeq); chatSeq++; view.talk(false) } })

  if (!boot.skin || (boot.skin.kind === 'sprite' && !boot.states)) {
    api.log('没有可用皮肤')
    bubble.show('没有可用的外形包。检查 packs/ 目录，或看 --doctor 输出里的插件校验错误。', { typewriter: false })
    return
  }

  try {
    await view.load(boot.skin, boot.states, config.scale)
  } catch (err) {
    api.log('皮肤加载失败', String(err))
    bubble.show(`外形加载失败：${String(err)}`, { typewriter: false })
    return
  }

  view.start()
  play = new PetPlayUI(() => view.bounds())
  if (boot.petLife) play.update(boot.petLife)

  cursorFollow = boot.skin.kind === 'sprite' ? new CursorFollow({ canvas, getConfig: followConfig }) : null
  cursorFollow?.start()
  api.onCursor(({ dx, dy }) => {
    if (cursorFollow) {
      cursorFollow.onCursor(dx, dy)
      return
    }
    // 2.5D 外形：视线交给视图做逐层视差与虹膜偏移
    const ia = config.interaction
    if (!ia.look || dragging || behavior.resting || play.state.dozing || !view.setLook) {
      view.setLook?.(0, 0)
      return
    }
    const n = normalizeCursor(dx, dy, ia.lookDeadzone, ia.lookRange)
    view.setLook(n.x, n.y)
  })
  api.onInteraction((payload) => {
    const wasResting = behavior.resting
    behavior = { ...DEFAULT_BEHAVIOR, ...payload }
    if (payload.viewport) { bubble.setViewport(payload.viewport); play.setViewport(payload.viewport) }
    view.setBehavior(behavior)
    syncPosturePresentation()
    if (behavior.paused) { view.stop(); cursorFollow?.stop() }
    else { view.start(); cursorFollow?.start() }
    document.getElementById('bubble')?.classList.toggle('drag-hidden', !!behavior.dragging && performance.now() > dragBubbleUntil)
    document.getElementById('bubble')?.classList.toggle('quiet-hidden', !!payload.quietMode)
    document.getElementById('feed-panel')?.classList.toggle('quiet-hidden', !!payload.quietMode)
    canvas.dataset.paused = String(!!behavior.paused)
    evaluateHit()
    if (behavior.resting) { cursorFollow?.reset(); view.setLook?.(0, 0); if (performance.now() > restingBubbleUntil) bubble.hide() }
    if (wasResting !== behavior.resting) api.log(`互动状态：${behavior.resting ? '边缘待机 ' + behavior.edge : '正常'}`)
  })
  // 报名宠物尺寸：主进程靠它算待机模式该露出多少
  const rect = view.bounds()
  document.documentElement.style.setProperty('--pet-height', `${Math.round(rect.height)}px`)
  reportGeometry()

  wireInteraction()
  wireChat()
  wireIpc()
  startHitLoop()

  api.log(
    `deskpet 渲染层就绪：${boot.skin.name} · ${Object.keys(boot.states?.states ?? {}).length} 个状态 · ${boot.plugins.length} 个插件 · ${boot.providers.length} 个聊天后端`,
  )
}

void main().catch((err) => {
  api.report('renderer:error', { message: `main() 失败: ${String(err)}` })
  api.log('main() 失败', String(err))
})
