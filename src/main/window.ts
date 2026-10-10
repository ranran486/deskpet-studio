import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppConfig } from '../shared/types.js'
import { log } from './logger.js'
import { bus } from './events.js'
import { constrainToGround, dragRootWithinScreen, type PetGeometry } from '../shared/action-model.js'

const here = path.dirname(fileURLToPath(import.meta.url))
/** dist/ */
export const distRoot = path.resolve(here, '..')
/** 项目根（electron . 的 cwd 也是这里，但不要依赖 cwd） */
export const appRoot = path.resolve(distRoot, '..')

export interface WindowDeps {
  onPositionChange(pos: { x: number; y: number }, displayId: number | null): void
}

/**
 * 宠物窗口。
 *
 * 三个关键行为：
 *  1. 透明 + 无边框 + 置顶 + 不进任务栏。
 *  2. **默认点击穿透**：`setIgnoreMouseEvents(true, { forward: true })`，鼠标事件仍会转发给
 *     渲染进程，渲染进程做像素级命中判定（宠物本体 / 气泡），命中时再通过 IPC 让主进程临时
 *     关掉穿透。这是 Electron 上"透明区域不挡桌面、宠物本体可点击"的标准做法。
 *  3. 拖动不用 `-webkit-app-region: drag`（它与穿透互斥），而是主进程用
 *     `screen.getCursorScreenPoint()` 轮询跟随光标，帧率稳定且没有 IPC 洪泛。
 */
export class PetWindow {
  win: BrowserWindow | null = null
  private interactive = false
  private dragging = false
  private dragOffset = { dx: 0, dy: 0 }
  private dragTimer: NodeJS.Timeout | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private petGeometry: PetGeometry | null = null
  private resting = false
  private foregroundTimer: NodeJS.Timeout | null = null
  private settingsFocused = false
  private foregroundConfigured = false
  private restingPosture?: string

  constructor(
    private config: AppConfig,
    private readonly deps: WindowDeps,
  ) {}

  create(): BrowserWindow {
    const stage = this.config.stage
    const start = this.initialPosition(stage)

    const win = new BrowserWindow({
      width: stage.width,
      height: stage.height,
      x: start.x,
      y: start.y,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      acceptFirstMouse: true,
      title: 'DeskPet',
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(distRoot, 'preload', 'index.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        // ESM preload 需要 sandbox: false；渲染层本身仍然拿不到 Node。
        sandbox: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    })

    this.win = win
    this.ensureForeground()
    this.foregroundTimer = setInterval(() => this.ensureForeground(), 1000)
    win.on('show', () => this.ensureForeground())
    win.on('blur', () => this.ensureForeground())
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.applyClickThrough()

    win.on('closed', () => {
      if (this.foregroundTimer) clearInterval(this.foregroundTimer)
      this.foregroundTimer = null
      this.stopDrag()
      this.win = null
    })
    win.on('moved', () => { this.enforceGround(); this.scheduleSavePosition() })

    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      log.error(`渲染进程加载失败 ${code} ${desc} ${url}`)
    })

    void win.loadURL('deskpet://renderer/index.html')
    win.once('ready-to-show', () => {
      win.showInactive()
      log.info(`宠物窗口已显示 ${stage.width}x${stage.height} @ ${start.x},${start.y}`)
    })
    return win
  }

  /* ---------------- 穿透 ---------------- */

  /** 渲染进程命中判定结果：true = 指针下有宠物本体或气泡 */
  setInteractive(next: boolean): void {
    if (this.interactive === next) return
    this.interactive = next
    this.applyClickThrough()
  }

  isInteractive(): boolean {
    return this.interactive
  }

  private applyClickThrough(): void {
    if (!this.win) return
    const ignore = this.config.clickThrough && !this.interactive
    this.win.setIgnoreMouseEvents(ignore, { forward: true })
    log.debug(`点击穿透 = ${ignore}`)
  }

  setClickThrough(enabled: boolean): void {
    this.config.clickThrough = enabled
    this.applyClickThrough()
  }

  /* ---------------- 拖动 ---------------- */

  startDrag(anchor?: { x: number; y: number }): void {
    if (!this.win || this.dragging) return
    const cursor = screen.getCursorScreenPoint()
    const [wx, wy] = this.win.getPosition()
    this.setResting(false)
    const valid = anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y) && anchor.x >= 0 && anchor.y >= 0 && anchor.x <= this.config.stage.width && anchor.y <= this.config.stage.height
    this.dragOffset = valid ? { dx: -anchor!.x, dy: -anchor!.y } : { dx: wx - cursor.x, dy: wy - cursor.y }
    this.dragging = true
    if (valid) this.moveDragTo(cursor)
    bus.emit('drag:start')
    this.dragTimer = setInterval(() => {
      if (!this.win) return
      const c = screen.getCursorScreenPoint()
      this.moveDragTo(c)
    }, 15)
  }

  /** 全屏拖动按抓点限制，而不是含气泡留白的舞台窗口。 */
  moveDragTo(cursor: { x: number; y: number }): void {
    if (!this.win) return
    const display = screen.getDisplayNearestPoint(cursor)
    const desired = dragRootWithinScreen(cursor, display.bounds, { x: -this.dragOffset.dx, y: -this.dragOffset.dy })
    const target = constrainToGround(desired, this.geometry, display.bounds)
    this.moveTo(target.x, Math.floor(target.y))
  }

  setPetGeometry(geometry: PetGeometry): void {
    if (!geometry || !Object.values(geometry).every(Number.isFinite) || geometry.width <= 0 || geometry.height <= 0 || geometry.width > 4096 || geometry.height > 4096) return
    const first = !this.petGeometry
    this.petGeometry = geometry
    this.enforceGround()
    if (first && !this.resting && !this.dragging) this.ensureVisible()
  }

  enforceGround(): void {
    const position = this.getPosition(), win = this.win
    if (!win || !position || win.isDestroyed()) return
    const g = this.geometry
    const center = { x: Math.round(position.x + g.x + g.width / 2), y: Math.round(position.y + g.y + g.height / 2) }
    const area = screen.getDisplayNearestPoint(center).bounds
    const clippedLounge = this.resting && this.restingPosture === 'lounge-bottom' && g.loungeLine !== undefined
    const target = constrainToGround(position, clippedLounge ? { ...g, height: g.loungeLine! } : g, area)
    if (target.y < position.y) this.moveTo(target.x, Math.floor(target.y))
  }

  /** Windows DPI rounding can grow a nonresizable window on setPosition; preserve configured stage size. */
  moveTo(x: number, y: number): void {
    if (!this.win || this.win.isDestroyed() || !Number.isFinite(x) || !Number.isFinite(y)) return
    this.win.setBounds({ x: Math.round(x) || 0, y: Math.round(y) || 0, width: this.config.stage.width, height: this.config.stage.height })
  }

  /** screen-saver 层高于 Windows 任务栏；只提升层级，不抢键盘焦点。 */
  ensureForeground(): void {
    const win = this.win
    if (!win || win.isDestroyed() || !win.isVisible()) return
    if (!this.foregroundConfigured || !win.isAlwaysOnTop()) {
      const before = win.getBounds()
      win.setAlwaysOnTop(true, 'screen-saver')
      const after = win.getBounds()
      if (before.x !== after.x || before.y !== after.y || before.width !== after.width || before.height !== after.height) this.moveTo(before.x, before.y)
      this.foregroundConfigured = true
    }
    if (!this.settingsFocused) win.moveTop()
  }

  setSettingsFocused(focused: boolean): void {
    this.settingsFocused = focused
    this.ensureForeground()
  }

  get geometry(): PetGeometry {
    return this.petGeometry ?? { x: this.config.stage.width / 2 - 64, y: this.config.stage.height - 128, width: 128, height: 128, collarX: this.config.stage.width / 2, collarY: this.config.stage.height - 100, bottomLine: 45, leftLine: 52, rightLine: 76 }
  }

  setResting(on: boolean, posture?: string): void {
    this.resting = on
    this.restingPosture = on ? posture : undefined
    if (on && this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
  }

  ensureVisible(): void {
    const pos = this.getPosition()
    if (!this.win || !pos) return
    const g = this.geometry
    const display = screen.getDisplayNearestPoint({ x: Math.round(pos.x + g.x + g.width / 2), y: Math.round(pos.y + g.y + g.height / 2) })
    const area = display.bounds
    this.moveTo(Math.max(area.x, Math.min(area.x + area.width - g.width, pos.x + g.x)) - g.x, Math.max(area.y, Math.min(area.y + area.height - g.height, pos.y + g.y)) - g.y)
  }

  ensureStageVisible(): void {
    if (!this.win) return
    const bounds = this.win.getBounds(), area = screen.getDisplayMatching(bounds).workArea
    this.moveTo(Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)), Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height)))
    this.win.focus()
  }

  stopDrag(): void {
    if (this.dragTimer) {
      clearInterval(this.dragTimer)
      this.dragTimer = null
    }
    if (!this.dragging) return
    this.dragging = false
    this.scheduleSavePosition(0)
    bus.emit('drag:end')
  }

  isDragging(): boolean {
    return this.dragging
  }

  getPosition(): { x: number; y: number } | null {
    if (!this.win) return null
    const [x, y] = this.win.getPosition()
    return { x, y }
  }

  /* ---------------- 位置与显示器 ---------------- */

  private initialPosition(stage: { width: number; height: number }): { x: number; y: number } {
    const saved = this.config.position
    if (saved) return this.clampToDisplay(saved.x, saved.y, stage.width, stage.height)
    const display = screen.getPrimaryDisplay()
    const area = display.workArea
    return {
      x: area.x + area.width - stage.width - 24,
      y: area.y + area.height - stage.height - 24,
    }
  }

  /** 把窗口夹在"离它最近的那块屏"的工作区内，避免拖出屏幕后找不回来。 */
  private clampToDisplay(x: number, y: number, w: number, h: number): { x: number; y: number } {
    const display = screen.getDisplayNearestPoint({ x: x + Math.round(w / 2), y: y + Math.round(h / 2) })
    const area = display.bounds
    const g = this.geometry
    return {
      x: Math.min(Math.max(x, area.x - g.x), area.x + area.width - g.width - g.x),
      y: Math.min(Math.max(y, area.y - g.y), area.y + area.height - g.height - g.y),
    }
  }

  private scheduleSavePosition(delay = 400): void {
    if (this.resting || this.dragging) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      const pos = this.getPosition()
      if (!pos || !this.win || this.resting || this.dragging) return
      const display = screen.getDisplayMatching(this.win.getBounds())
      this.config.position = pos
      this.config.displayId = display.id
      this.deps.onPositionChange(pos, display.id)
    }, delay)
  }

  setStageSize(width: number, height: number): void {
    this.config.stage = { width, height }
    this.win?.setSize(width, height)
  }

  setAlwaysOnTop(_on: boolean): void {
    this.config.alwaysOnTop = true
    this.ensureForeground()
  }

  close(): void {
    this.stopDrag()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    const pos = this.getPosition()
    if (pos && !this.resting) this.config.position = pos
    this.win?.destroy()
    this.win = null
  }
}
