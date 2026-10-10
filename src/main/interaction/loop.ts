import { screen } from 'electron'
import { IPC } from '../../shared/ipc.js'
import type { ActivityLevel } from '../../shared/types.js'
import type { ConfigStore } from '../config.js'
import type { PetHost } from '../host.js'
import type { PetWindow } from '../window.js'
import { log } from '../logger.js'
import { FullscreenWatcher } from './fullscreen.js'
import { dockPosition, nearestDockEdge, ACTION_TIMING, type DockEdge, type BehaviorSignal, type BodyAction } from '../../shared/action-model.js'
import {
  ACTIVITY_LEVELS,
  AVOID_DURATION_MS,
  AVOID_REST_MS,
  AVOID_SPEED,
  clampToWorkArea,
  centerOf,
  dampAtEdge,
  fleeTarget,
  msUntilNextHour,
  nextWanderTarget,
  shouldChime,
  shouldFlee,
  stepToward,
  chimeLine,
  type Point,
  type Size,
} from './behavior.js'

const TICK_MS = 16
const CURSOR_MS = 60

export interface InteractionDeps {
  petWindow: PetWindow
  config: ConfigStore
  host: PetHost
}

/**
 * 主进程侧的互动循环。
 *
 * 为什么互动放在主进程：漫游与躲避要**移动窗口**，而窗口位移只有主进程能做
 * （Petra 是 Rust mover 线程；这里对应 Electron 的 setInterval + setPosition）。
 * 视线跟随只需要光标相对窗口中心的偏移，也顺手在这里以 60ms 节流推给渲染层。
 *
 * 优先级（照 Petra 的早退顺序）：拖动/挂起 → 待机模式 → 躲避 → 漫游 → 休息。
 */
export class InteractionLoop {
  private ticker: ReturnType<typeof setInterval> | null = null
  private cursorTicker: ReturnType<typeof setInterval> | null = null
  private chimeTimer: ReturnType<typeof setTimeout> | null = null
  private suspendUntil = 0
  private fleeUntil = 0
  private restUntil = 0
  private target: Point | null = null
  private lastTick = 0
  private petSize: Size = { width: 128, height: 128 }
  private idleApplied = false
  private disposed = false
  private docked: DockEdge = 'none'
  private posture: BodyAction | undefined
  private poseUntil = 0
  private poseCooldownUntil = 0
  private idleOrigin: Point | null = null
  private lastPosition: Point | null = null
  private lastCursorX: number | null = null
  private movingUntil = 0
  private direction: -1 | 1 = -1
  private lastSignal = ''
  private lastPush = 0
  private subpixel = { x: 0, y: 0 }
  private disposers: Array<() => void> = []
  private fullscreen = false
  private watcher = new FullscreenWatcher(quiet => { this.fullscreen = quiet })

  constructor(private readonly deps: InteractionDeps) {}

  /* ------------------------------ 生命周期 ------------------------------ */

  start(): void {
    if (this.ticker) return
    this.disposed = false
    this.lastTick = Date.now()
    this.watcher.start()
    this.ticker = setInterval(() => this.tick(), TICK_MS)
    this.cursorTicker = setInterval(() => this.pushCursor(), CURSOR_MS)
    // 渲染层每次换皮肤/换缩放后会报名宠物尺寸，待机露出多少要靠它
    this.disposers.push(this.deps.host.on('*', (event) => {
      if ((event.type as string) === 'pet:size') {
        const w = Number(event.data?.width)
        const h = Number(event.data?.height)
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
          this.petSize = { width: w, height: h }
        }
      }
    }))
    this.scheduleChime()
    this.disposers.push(this.deps.host.on('drag:start', () => this.wake(false)))
    this.disposers.push(this.deps.host.on('drag:end', () => {
      this.resume(); this.suspend(1500)
      const cursor = screen.getCursorScreenPoint(), area = screen.getDisplayNearestPoint(cursor).bounds
      const edge = nearestDockEdge(cursor, area)
      const gap = edge === 'left' ? cursor.x - area.x : edge === 'right' ? area.x + area.width - cursor.x : edge === 'top' ? cursor.y - area.y : area.y + area.height - cursor.y
      if (gap <= 44) this.dock(edge)
      else this.deps.petWindow.ensureVisible()
    }))
    log.info('互动循环已启动')
  }

  stop(): void {
    this.disposed = true
    this.watcher.stop()
    this.deps.host.quietMode = false
    for (const dispose of this.disposers.splice(0)) dispose()
    if (this.ticker) clearInterval(this.ticker)
    if (this.cursorTicker) clearInterval(this.cursorTicker)
    if (this.chimeTimer) clearTimeout(this.chimeTimer)
    this.ticker = null
    this.cursorTicker = null
    this.chimeTimer = null
  }

  /** 用户交互时冻结自动移动（Petra：按下 30s / 松手 1.5s / 待机 1h） */
  suspend(ms: number): void {
    this.suspendUntil = Math.max(this.suspendUntil, Date.now() + ms)
  }

  resume(): void {
    this.suspendUntil = 0
  }

  private updateIdleConfig(idleMode: boolean): void {
    const config = this.deps.config
    if (config.data.interaction.idleMode !== idleMode) config.patch({ interaction: { ...config.data.interaction, idleMode } })
    this.deps.host.send(IPC.configChanged, { ...config.data, secrets: Object.fromEntries(Object.keys(config.data.secrets).map(key => [key, '****'])) })
    this.deps.host.emit('behavior:changed' as never, { idleMode, edge: this.docked, posture: this.posture })
  }

  dock(edge: Exclude<DockEdge, 'none'>, posture?: BodyAction): void {
    if (!this.idleOrigin) this.idleOrigin = this.deps.petWindow.getPosition()
    this.docked = edge; this.idleApplied = true; this.target = null
    this.posture = posture ?? (edge === 'bottom' ? 'lounge-bottom' : edge === 'top' ? 'hang-top' : edge === 'left' ? 'peek-left' : 'peek-right')
    this.poseUntil = this.posture === 'lounge-bottom' || this.posture === 'hang-top' ? Date.now() + ACTION_TIMING.poseMinMs + Math.random() * (ACTION_TIMING.poseMaxMs - ACTION_TIMING.poseMinMs) : 0
    this.deps.petWindow.setResting(true, this.posture)
    this.updateIdleConfig(true)
    this.applyDockPosition()
    this.publishMotion(true)
  }

  wake(restore = true): void {
    const origin = this.idleOrigin
    this.docked = 'none'; this.posture = undefined; this.poseUntil = 0; this.idleApplied = false; this.idleOrigin = null
    this.deps.petWindow.setResting(false)
    this.updateIdleConfig(false)
    if (restore && origin && this.deps.petWindow.win) {
      this.deps.petWindow.moveTo(origin.x, origin.y)
      this.deps.petWindow.ensureVisible()
    }
    this.resume(); this.suspend(1500); this.movingUntil = 0
    this.publishMotion(true)
  }

  private applyDockPosition(): void {
    const pet = this.deps.petWindow, win = pet.win, position = pet.getPosition()
    if (!win || !position || this.docked === 'none') return
    const g = pet.geometry
    const center = { x: Math.round(position.x + g.x + g.width / 2), y: Math.round(position.y + g.y + g.height / 2) }
    const area = screen.getDisplayNearestPoint(center).bounds
    const lounge = this.posture === 'lounge-bottom' && g.loungeLine !== undefined
    const surfaceArea = lounge ? screen.getDisplayNearestPoint(center).workArea : area
    const geometry = this.docked === 'bottom' && !lounge ? { ...g, loungeLine: undefined } : g
    const target = dockPosition(this.docked, position, geometry, surfaceArea)
    if (Math.abs(target.x - position.x) >= 1 || Math.abs(target.y - position.y) >= 1) pet.moveTo(target.x, target.y)
  }

  private publishMotion(force = false): void {
    const now = Date.now(), pet = this.deps.petWindow, position = pet.getPosition()
    if (!position) return
    const dragging = pet.isDragging()
    if (this.lastPosition && !dragging && this.docked === 'none') {
      const dx = position.x - this.lastPosition.x, dy = position.y - this.lastPosition.y
      if (Math.hypot(dx, dy) >= 1) { this.movingUntil = now + 140; if (Math.abs(dx) >= 1) this.direction = dx > 0 ? 1 : -1 }
    }
    this.lastPosition = position
    const cursorX = screen.getCursorScreenPoint().x
    const dragDelta = dragging && this.lastCursorX !== null ? cursorX - this.lastCursorX : 0
    this.lastCursorX = cursorX
    const bounds = pet.win?.getBounds()
    const displayInfo = bounds ? screen.getDisplayMatching(bounds) : null
    const display = displayInfo?.bounds
    const viewport = bounds && display ? { left: Math.max(0, display.x - bounds.x), top: Math.max(0, display.y - bounds.y), right: Math.min(bounds.width, display.x + display.width - bounds.x), bottom: Math.min(bounds.height, display.y + display.height - bounds.y) } : undefined
    const quiet = this.fullscreen && this.cfg.fullscreenQuiet
    this.deps.host.quietMode = quiet
    const surface = bounds && displayInfo ? { top: displayInfo.bounds.y - bounds.y, bottom: displayInfo.workArea.y + displayInfo.workArea.height - bounds.y } : undefined
    const signal: BehaviorSignal = { moving: !quiet && !this.deps.host.sleeping && !dragging && this.docked === 'none' && now < this.movingUntil, direction: this.direction, edge: this.docked, posture: this.posture, resting: this.docked !== 'none', dragging, paused: quiet || !pet.win?.isVisible(), viewport, surface, ...(dragging ? { dragDelta } : {}) }
    const signature = JSON.stringify({ ...signal, dragDelta: undefined })
    if (force || signature !== this.lastSignal || now - this.lastPush > (dragging ? 30 : 500)) {
      this.lastSignal = signature; this.lastPush = now
      this.deps.host.send(IPC.interaction, { ...signal, idleMode: signal.resting, quietMode: quiet })
    }
  }

  private move(position: Point): void {
    const exact = { x: position.x + this.subpixel.x, y: position.y + this.subpixel.y }
    const rounded = { x: Math.round(exact.x), y: Math.round(exact.y) }
    this.subpixel = { x: exact.x - rounded.x, y: exact.y - rounded.y }
    this.deps.petWindow.moveTo(rounded.x, rounded.y)
  }

  private get cfg() {
    return this.deps.config.data.interaction
  }

  private area() {
    const win = this.deps.petWindow.win
    if (!win) return null
    const display = screen.getDisplayMatching(win.getBounds())
    const area = display.bounds, g = this.deps.petWindow.geometry, [width, height] = win.getSize()
    return { x: area.x - g.x, y: area.y - g.y, width: area.width + width - g.width, height: area.height + height - g.height }
  }

  private size(): Size {
    const win = this.deps.petWindow.win
    if (!win) return { width: 360, height: 420 }
    const [width, height] = win.getSize()
    return { width, height }
  }

  /* ------------------------------ 光标推送 ------------------------------ */

  private pushCursor(): void {
    const win = this.deps.petWindow.win
    if (!win || this.disposed) return
    if (!this.cfg.look || (this.fullscreen && this.cfg.fullscreenQuiet)) return
    const cursor = screen.getCursorScreenPoint()
    const bounds = win.getBounds()
    const g = this.deps.petWindow.geometry
    const center = centerOf({ x: bounds.x + g.x, y: bounds.y + g.y }, g)
    this.deps.host.send(IPC.cursor, {
      dx: cursor.x - center.x,
      dy: cursor.y - center.y,
      dist: Math.hypot(cursor.x - center.x, cursor.y - center.y),
    })
  }

  /* ------------------------------ 主循环 ------------------------------ */

  private tick(): void {
    try { this.tickLogic() } finally { this.deps.petWindow.enforceGround(); this.publishMotion() }
  }

  private tickLogic(): void {
    const win = this.deps.petWindow.win
    if (!win || this.disposed || !win.isVisible()) return
    const now = Date.now()
    const dt = Math.min(120, now - this.lastTick)
    this.lastTick = now
    if (this.deps.host.sleeping) { this.target = null; this.movingUntil = 0; return }
    if (this.fullscreen && this.cfg.fullscreenQuiet) { this.target = null; this.movingUntil = 0; return }

    const area = this.area()
    if (!area) return
    const size = this.size()
    const pos = this.deps.petWindow.getPosition()
    if (!pos) return

    // 拖拽优先于边缘待机，防止待机循环把正在拖动的窗口拉回屏幕边缘。
    if (this.deps.petWindow.isDragging()) return
    if (this.poseUntil && now >= this.poseUntil) {
      const previous = this.docked; this.wake(false)
      this.poseCooldownUntil = now + ACTION_TIMING.poseCooldownMinMs + Math.random() * (ACTION_TIMING.poseCooldownMaxMs - ACTION_TIMING.poseCooldownMinMs)
      this.target = clampToWorkArea({ x: pos.x, y: pos.y + (previous === 'top' ? 80 : -80) }, size, area)
      this.restUntil = now + 500
      return
    }
    if (this.docked === 'none' && this.cfg.wander && now > this.poseCooldownUntil && now > this.suspendUntil) {
      const g = this.deps.petWindow.geometry, screenBounds = screen.getDisplayMatching(win.getBounds()).bounds
      if (Math.abs(pos.y + g.y - screenBounds.y) <= 6) { this.dock('top'); return }
      if (Math.abs(pos.y + g.y + g.height - screenBounds.y - screenBounds.height) <= 6) { this.dock('bottom'); return }
    }
    if (this.cfg.idleMode) {
      if (!this.idleApplied) { const g = this.deps.petWindow.geometry; this.dock(nearestDockEdge({ x: pos.x + g.x + g.width / 2, y: pos.y + g.y + g.height / 2 }, screen.getDisplayMatching(win.getBounds()).bounds)) }
      this.applyDockPosition()
      return
    }
    if (this.idleApplied) {
      this.wake()
      return
    }

    if (this.deps.petWindow.isDragging() || now < this.suspendUntil) return

    const cursor = screen.getCursorScreenPoint()
    const g = this.deps.petWindow.geometry
    const petCenter = centerOf({ x: pos.x + g.x, y: pos.y + g.y }, g)

    // 躲避：抢占漫游
    if (this.cfg.avoid) {
      const fleeing = now < this.fleeUntil
      if (fleeing || shouldFlee(cursor, petCenter, this.cfg.avoidRadius)) {
        if (!fleeing) {
          this.fleeUntil = now + AVOID_DURATION_MS
          log.debug('躲避鼠标：开始逃跑')
        }
        const speed = this.cfg.avoidSpeed > 0 ? this.cfg.avoidSpeed : AVOID_SPEED
        const goal = fleeTarget(petCenter, cursor, size, area)
        const step = stepToward(pos, goal, speed, dt)
        const velocity = { x: step.pos.x - pos.x, y: step.pos.y - pos.y }
        const damped = dampAtEdge(pos, size, area, velocity)
        const next = clampToWorkArea({ x: pos.x + damped.x, y: pos.y + damped.y }, size, area)
        this.move(next)
        if (step.arrived) this.fleeUntil = now
        return
      }
      if (now < this.fleeUntil + AVOID_REST_MS) return
    }

    // 漫游：休息与移动交替
    if (!this.cfg.wander) {
      this.target = null
      return
    }
    const level = this.cfg.activity
    const profile = ACTIVITY_LEVELS[level]
    if (now < this.restUntil) return
    if (!this.target) {
      this.target = nextWanderTarget(pos, size, area, level)
      log.debug(`漫游：新目标 ${Math.round(this.target.x)},${Math.round(this.target.y)}`)
    }
    const speed = this.cfg.wanderSpeed > 0 ? this.cfg.wanderSpeed : profile.speed
    const step = stepToward(pos, this.target, speed, dt)
    this.move(step.pos)
    if (step.arrived) {
      this.target = null
      const rest = profile.restBaseMs + Math.random() * profile.restBaseMs
      this.restUntil = now + rest
      log.debug(`漫游：到达，休息 ${Math.round(rest / 1000)}s`)
    }
  }

  /* ------------------------------ 整点播报 ------------------------------ */

  private scheduleChime(): void {
    if (this.chimeTimer) clearTimeout(this.chimeTimer)
    const delay = msUntilNextHour(Date.now())
    this.chimeTimer = setTimeout(() => {
      this.maybeChime()
      this.scheduleChime()
    }, delay)
  }

  private maybeChime(): void {
    const cfg = this.cfg
    if (!cfg.hourlyChime || (this.fullscreen && cfg.fullscreenQuiet)) return
    const hour = new Date().getHours()
    if (!shouldChime(hour, cfg.chimeQuiet)) {
      log.debug(`整点播报：${hour} 点处于免打扰时段，跳过`)
      return
    }
    const line = chimeLine(hour)
    log.info(`整点播报：${line}`)
    this.deps.host.say(line, 'builtin.interaction')
  }

  /** 自检用：立刻走一次播报判定 */
  chimeNow(): void {
    this.maybeChime()
  }

  getSnapshot(): Record<string, unknown> {
    return {
      target: this.target,
      restUntil: this.restUntil,
      fleeUntil: this.fleeUntil,
      suspendUntil: this.suspendUntil,
      idleApplied: this.idleApplied,
      petSize: this.petSize,
      docked: this.docked,
      posture: this.posture,
      poseUntil: this.poseUntil,
      poseCooldownUntil: this.poseCooldownUntil,
      fullscreenQuiet: this.fullscreen && this.cfg.fullscreenQuiet,
    }
  }
}

export type { ActivityLevel }
