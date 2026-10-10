import type { InteractionConfig } from '../shared/types.js'

/**
 * 渲染层的互动：点击判定与视线跟随。
 *
 * 纯函数部分（isPat / normalizeCursor / smoothLook / lookTransform）刻意不碰 DOM，
 * 这样 tools/selftest.mjs 能在 Node 里直接验证死区、归一化、平滑与变换幅度；
 * 只有 CursorFollow 这个类会去写 style。
 *
 * 视线跟随参数取自 Petra：死区 20px 起、40px 过渡带、量程 260px、
 * 平滑 k = 1 - exp(-dt·8)（时间常数约 125ms）。区别是 Petra 驱动的是 PSD 分层
 * （眼/头分开），我这里是整只宠物做"侧倾 + 位移"——分层驱动要等 PSD 装配那一步。
 */

/** 按下与抬起的位移小于它就算"摸头"，大于它算拖动（Petra: 6px） */
export const PAT_THRESHOLD_PX = 6

export interface Point {
  x: number
  y: number
}

export function isPat(start: Point, end: Point, threshold = PAT_THRESHOLD_PX): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) < threshold
}

const clamp = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), max)

/**
 * 光标偏移 → 归一化朝向。
 * 死区以内为 0；死区到 2×死区之间线性淡入（避免边缘突兀）；量程以外截断到 ±1。
 */
export function normalizeCursor(
  dx: number,
  dy: number,
  deadzone: number,
  range: number,
): { x: number; y: number; mag: number } {
  const dist = Math.hypot(dx, dy)
  if (dist <= deadzone || dist < 0.001) return { x: 0, y: 0, mag: 0 }
  const band = Math.max(1, deadzone) * 2 // 过渡带 = 2×死区：20px 死区 → 60px 达到满幅（Petra 的做法）
  const mag = clamp((dist - deadzone) / band, 0, 1)
  const span = Math.max(band, range)
  return {
    x: clamp(dx / span, -1, 1) * mag,
    y: clamp(dy / span, -1, 1) * mag,
    mag,
  }
}

/** 指数平滑：k = 1 - exp(-dt·rate)，rate=8 时时间常数约 125ms */
export function smoothLook(prev: Point, target: Point, dtMs: number, rate = 8): Point {
  const k = 1 - Math.exp((-Math.max(0, dtMs) / 1000) * rate)
  return { x: prev.x + (target.x - prev.x) * k, y: prev.y + (target.y - prev.y) * k }
}

/** 归一化朝向 → 画布变换（位移 + 侧倾） */
export function lookTransform(look: Point, cfg: Pick<InteractionConfig, 'lookAmplitude' | 'lookTilt'>): { tx: number; ty: number; rot: number } {
  return {
    tx: look.x * cfg.lookAmplitude,
    ty: look.y * cfg.lookAmplitude * 0.5,
    rot: look.x * cfg.lookTilt,
  }
}

/* ------------------------------------------------------------------ *
 * 写样式的那一半
 * ------------------------------------------------------------------ */

export interface CursorFollowOptions {
  canvas: HTMLCanvasElement
  getConfig: () => InteractionConfig
  onError?: (message: string) => void
}

/**
 * 把光标偏移平滑地变成宠物画布的 transform。
 * 画布本身用 `translateX(-50%)` 居中，所以这里要把它一起带上，否则宠物会跳位。
 */
export class CursorFollow {
  private target: Point = { x: 0, y: 0 }
  private current: Point = { x: 0, y: 0 }
  private applied = ''
  private raf = 0
  private lastTs = 0

  constructor(private readonly opts: CursorFollowOptions) {}

  onCursor(dx: number, dy: number): void {
    const cfg = this.opts.getConfig()
    if (!cfg.look) {
      this.target = { x: 0, y: 0 }
      return
    }
    const n = normalizeCursor(dx, dy, cfg.lookDeadzone, cfg.lookRange)
    this.target = { x: n.x, y: n.y }
  }

  start(): void {
    if (this.raf) return
    this.lastTs = 0
    this.raf = requestAnimationFrame(this.frame)
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.reset()
  }

  reset(): void {
    this.target = { x: 0, y: 0 }
    this.current = { x: 0, y: 0 }
    this.apply()
  }

  /** 设置窗口在动宠物（漫游/躲避）时没必要继续平滑，可暂停 */
  private frame = (ts: number): void => {
    this.raf = requestAnimationFrame(this.frame)
    const dt = this.lastTs ? Math.min(120, ts - this.lastTs) : 16
    this.lastTs = ts
    const cfg = this.opts.getConfig()
    if (!cfg.look) {
      if (this.current.x !== 0 || this.current.y !== 0) {
        this.current = { x: 0, y: 0 }
        this.apply()
      }
      return
    }
    const next = smoothLook(this.current, this.target, dt)
    if (Math.abs(next.x - this.current.x) < 0.0015 && Math.abs(next.y - this.current.y) < 0.0015) {
      // 已经足够接近：吸附到目标值，避免永远欠一点点
      this.current = { ...this.target }
    } else {
      this.current = next
    }
    this.apply()
  }

  private apply(): void {
    const cfg = this.opts.getConfig()
    const t = lookTransform(this.current, cfg)
    // 保持 CSS 变换后的底边不低于本体基准底边，避免视线侧倾时穿过地面。
    const radians = Math.abs(t.rot) * Math.PI / 180
    const heightGrowth = (Math.sin(radians) * this.opts.canvas.offsetWidth + Math.cos(radians) * this.opts.canvas.offsetHeight - this.opts.canvas.offsetHeight) / 2
    const ty = t.ty - Math.max(0, t.ty + heightGrowth)
    const css =
      `translateX(-50%) translate(${t.tx.toFixed(2)}px, ${ty.toFixed(2)}px) rotate(${t.rot.toFixed(2)}deg)`
    if (css === this.applied) return
    this.applied = css
    this.opts.canvas.style.transform = css
  }
}
