import type { AtlasFrame, Clip, PetState, ResolvedSkin, ResolvedSpriteSkin, States } from '../shared/types.js'
import { sampleMotion } from './motion.js'
import { PET_EXPRESSIONS } from '../shared/pet-life.js'
import { resolveActionState, profileBodyForState } from '../shared/action-profile.js'
import { bodyForSignal, DEFAULT_BEHAVIOR, sampleActionPose, ACTION_TIMING, type BehaviorSignal, type PetGeometry } from '../shared/action-model.js'

interface StackEntry {
  state: string
  once: boolean
  until: number | null
  key: string
}

export interface SpriteOptions {
  canvas: HTMLCanvasElement
  scale: number
  onStateChange?: (state: string, reason: string) => void
}

/**
 * 精灵图播放器 + 动画状态机。
 *
 * 设计要点：
 *  - **状态栈**：待机是底座，拖动/说话/插件反应都是压栈的临时状态，谁先结束谁出栈，
 *    出栈后自动回到下面那层。桌宠场景不需要行为树，一个栈 + 加权随机就够了。
 *  - **待机调度**：底座状态下每个 clip 播完停 0.4~2.6 秒，再按 `weight` 抽下一个 clip，
 *    这就是"待机动作"的来源。
 *  - **单调时钟**：一律用 `performance.now()`，不用墙上时间，休眠/锁屏唤醒不会跳帧。
 *  - **像素级命中**：加载时把整张精灵图读成 ImageData，之后判定只查 alpha 通道。
 */
export class SpritePlayer {
  private image: HTMLImageElement | null = null
  private sheet: ImageData | null = null
  private skin: ResolvedSpriteSkin | null = null
  private states: States = { states: {} }
  private base = 'idle'
  private talkState = 'talk'
  private dragState = 'drag'
  private stack: StackEntry[] = []
  private clip: Clip | null = null
  private frameIndex = 0
  private frameAcc = 0
  private lastTs = 0
  private pausedUntil = 0
  private raf = 0
  private scale = 1
  private currentFrame: AtlasFrame | null = null
  private stateName = 'idle'
  private reportedMissing = new Set<string>()
  private drawTransform = new DOMMatrix()
  private previousCanvas = document.createElement('canvas')
  private transitionUntil = 0
  private behavior: BehaviorSignal = { ...DEFAULT_BEHAVIOR }
  private dragging = false
  private swing = 0
  private swingVelocity = 0
  private swingTarget = 0

  constructor(private readonly opts: SpriteOptions) {
    this.scale = opts.scale
  }

  get ready(): boolean {
    return !!this.image && !!this.sheet
  }

  get state(): string {
    return this.stateName
  }

  get frameName(): string | null {
    return this.clip ? (this.clip.frames[this.frameIndex] ?? null) : null
  }

  /* ------------------------- 加载 ------------------------- */

  async load(skin: ResolvedSkin, states: States | null, scale: number): Promise<void> {
    if (skin.kind !== 'sprite') throw new Error('SpritePlayer 只能加载精灵图外形')
    this.skin = skin
    this.states = states ?? skin.states
    this.base = resolveActionState(this.states.states, 'idle', skin.actionProfile, this.states.default ?? 'idle')
    this.dragState = resolveActionState(this.states.states, 'drag-lift', skin.actionProfile, this.states.drag ?? this.base)
    this.talkState = resolveActionState(this.states.states, 'talk', skin.actionProfile, this.states.talk ?? this.base)
    this.scale = Math.max(0.01, scale * (skin.scale || 1))

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = skin.imageUrl
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error(`皮肤图片加载失败：${skin.imageUrl}`))
    })
    this.image = img

    const off = document.createElement('canvas')
    off.width = img.naturalWidth
    off.height = img.naturalHeight
    const octx = off.getContext('2d', { willReadFrequently: true })
    if (octx) {
      octx.drawImage(img, 0, 0)
      try {
        this.sheet = octx.getImageData(0, 0, off.width, off.height)
      } catch (err) {
        // 跨源污染了 canvas —— 命中判定会退化成整块矩形，其余功能不受影响
        this.sheet = null
        this.opts.onStateChange?.(`error:alpha-unavailable:${(err as Error).message}`, 'error')
      }
    }
    this.stack = []
    this.enter(this.base, 'load')
    this.render()
  }

  start(): void {
    if (this.raf) return
    this.lastTs = 0
    this.raf = requestAnimationFrame(this.loop)
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  /* ------------------------- 状态栈 ------------------------- */

  /** 压入一个临时状态；`once` 表示 clip 播完自动出栈，`durationMs` 表示到点自动出栈 */
  push(state: string, options: { once?: boolean; durationMs?: number; key?: string } = {}): void {
    const key = options.key ?? state
    this.stack = this.stack.filter((e) => e.key !== key)
    this.stack.push({
      state,
      once: !!options.once,
      until: options.durationMs ? performance.now() + options.durationMs : null,
      key,
    })
    this.enter(state, `push:${key}`)
  }

  pop(key?: string): void {
    if (!this.stack.length) return
    this.stack = key ? this.stack.filter((e) => e.key !== key) : this.stack.slice(0, -1)
    this.enter(this.effectiveState(), `pop:${key ?? 'top'}`)
  }

  /** 设置待机底座（一般就是 states.default） */
  setBase(state: string): void {
    this.base = state
    if (!this.stack.length) this.enter(state, 'setBase')
  }

  /** 播放一次就回退的短动作（插件 react 走这里） */
  react(state: string, durationMs?: number): void {
    if (this.dragging || this.behavior.resting) return
    this.push(resolveActionState(this.states.states, state, this.skin?.actionProfile, this.base), { once: !durationMs, durationMs, key: `react:${state}` })
  }
  expression(emotion: import('../shared/pet-life.js').PetExpression, _action?: 'wave' | 'nod' | 'tilt', durationMs = 3000): void {
    if (this.dragging || this.behavior.resting) return
    if (emotion === 'neutral') { this.pop('expression'); return }
    this.push(resolveActionState(this.states.states, emotion, this.skin?.actionProfile, this.base), { durationMs, key: 'expression' })
  }

  talk(on: boolean): void {
    if (on) this.push(this.talkState, { key: 'talk' })
    else this.pop('talk')
  }

  drag(on: boolean): void {
    this.dragging = on
    if (on) this.push(this.dragState, { key: 'drag' })
    else this.pop('drag')
  }

  setBehavior(signal: BehaviorSignal): void {
    this.behavior = signal
    if (signal.dragging !== undefined && signal.dragging !== this.dragging) this.drag(signal.dragging)
    if (signal.dragDelta !== undefined) this.swingTarget = Math.max(-12, Math.min(12, -signal.dragDelta * .8))
    const body = bodyForSignal({ ...signal, dragging: false })
    const next = resolveActionState(this.states.states, body, this.skin?.actionProfile, this.states.default ?? 'idle')
    if (next !== this.base) {
      this.base = next
      if (signal.resting) this.stack = this.stack.filter(entry => entry.key === 'drag')
      this.enter(this.effectiveState(), 'behavior')
    }
  }

  geometry(): PetGeometry {
    const rect = this.bounds()
    const frameFor = (name: string) => this.skin?.atlas.frames[this.states.states[name]?.clips[0]?.frames[0]]
    const pivot = this.skin?.actionProfile?.anchors?.collar ?? frameFor(this.dragState)?.pivot ?? { x: .5, y: .3 }
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      collarX: rect.x + rect.width * pivot.x, collarY: rect.y + rect.height * pivot.y,
      ...(this.skin?.actionProfile?.anchors?.hangY !== undefined ? { hangLine: rect.height * this.skin.actionProfile.anchors.hangY } : {}),
      ...(this.skin?.actionProfile?.anchors?.loungeY !== undefined ? { loungeLine: rect.height * this.skin.actionProfile.anchors.loungeY } : {}),
      bottomLine: rect.height * (frameFor('sleep-curl')?.revealY ?? .30), leftLine: rect.width * (this.skin?.actionProfile?.anchors?.peek?.left ?? .40), rightLine: rect.width * (this.skin?.actionProfile?.anchors?.peek?.right ?? .60) }
  }

  /** 清空临时状态栈，回到待机底座（自检与设置界面用，保证可预期） */
  resetToBase(): void {
    this.stack = []
    this.enter(this.base, 'reset')
  }

  private effectiveState(): string {
    if (this.dragging) return this.dragState
    if (this.behavior.resting) return this.base
    return this.stack.length ? this.stack[this.stack.length - 1].state : this.base
  }

  private stateDef(name: string): PetState | null {
    const def = this.states.states[name]
    if (!def) {
      if (!this.reportedMissing.has(name)) {
        this.reportedMissing.add(name)
        this.opts.onStateChange?.(`missing:${name}`, 'missing')
      }
      return null
    }
    return def
  }

  private enter(name: string, reason: string): void {
    if (name !== this.stateName && !this.dragging && !this.behavior.resting && (PET_EXPRESSIONS.includes(name as typeof PET_EXPRESSIONS[number]) || PET_EXPRESSIONS.includes(this.stateName as typeof PET_EXPRESSIONS[number]))) {
      const canvas = this.opts.canvas
      this.previousCanvas.width = canvas.width; this.previousCanvas.height = canvas.height
      this.previousCanvas.getContext('2d')?.drawImage(canvas, 0, 0)
      this.transitionUntil = performance.now() + ACTION_TIMING.portraitTransitionMs
    } else if (name !== this.stateName) this.transitionUntil = 0
    const def = this.stateDef(name)
    if (!def) {
      this.stateName = this.base
      this.clip = this.pickClip(this.base)
    } else {
      this.stateName = name
      this.clip = this.pickClip(name)
    }
    this.frameIndex = 0
    this.frameAcc = 0
    this.pausedUntil = 0
    this.opts.onStateChange?.(this.stateName, reason)
    this.render()
  }

  /** 按 weight 加权随机抽一个 clip */
  private pickClip(name: string): Clip | null {
    const def = this.states.states[name]
    if (!def?.clips?.length) return null
    const clips = def.clips.filter((c) => c.frames?.length)
    if (!clips.length) return null
    const total = clips.reduce((sum, c) => sum + (c.weight ?? 1), 0)
    let roll = Math.random() * total
    for (const c of clips) {
      roll -= c.weight ?? 1
      if (roll <= 0) return c
    }
    return clips[clips.length - 1]
  }

  /* ------------------------- 时钟 ------------------------- */

  private loop = (ts: number): void => {
    this.raf = requestAnimationFrame(this.loop)
    const fps = this.dragging ? 60 : this.behavior.resting ? 20 : this.behavior.moving ? 40 : 30
    if (this.lastTs && ts - this.lastTs < 1000 / fps) return
    const dt = this.lastTs ? Math.min(120, ts - this.lastTs) : 16
    this.lastTs = ts
    this.tick(ts, dt)
  }

  private tick(now: number, dt: number): void {
    if (!this.image) return
    const seconds = dt / 1000
    const target = this.dragging ? this.swingTarget : 0
    this.swingVelocity += ((target - this.swing) * 34 - this.swingVelocity * 8) * seconds
    this.swing = Math.max(-12, Math.min(12, this.swing + this.swingVelocity * seconds))
    this.swingTarget *= Math.exp(-seconds * 6)

    // 到点出栈
    if (this.stack.some((e) => e.until !== null && e.until <= now)) {
      this.stack = this.stack.filter((e) => e.until === null || e.until > now)
      this.enter(this.effectiveState(), 'expire')
    }
    if (now < this.pausedUntil) { this.render(); return }

    const def = this.stateDef(this.stateName)
    if (!def || !this.clip?.frames.length) return

    const fps = this.clip.fps ?? def.fps ?? 8
    const frameMs = 1000 / Math.max(1, fps)
    this.frameAcc += dt
    if (this.frameAcc < frameMs) {
      this.render()
      return
    }
    this.frameAcc -= frameMs
    this.frameIndex += 1

    if (this.frameIndex >= this.clip.frames.length) {
      const top = this.stack[this.stack.length - 1]
      const loop = this.clip.loop ?? def.loop ?? false
      if (top?.once) {
        this.pop(top.key)
        return
      }
      if (this.stateName === this.base && !def.action) {
        // 待机：播完一个 clip，歇一下，再抽下一个 clip（这就是"待机动作"）
        this.frameIndex = 0
        this.clip = this.pickClip(this.base)
        this.pausedUntil = now + 400 + Math.random() * 2200
        this.render()
        return
      }
      if (loop) {
        this.frameIndex = 0
      } else if (def.next) {
        this.enter(def.next, `next:${def.next}`)
        return
      } else if (this.stack.length) {
        this.pop()
        return
      } else {
        this.enter(this.base, 'fallback')
        return
      }
    }
    this.render()
  }

  /* ------------------------- 绘制 ------------------------- */

  private render(): void {
    const canvas = this.opts.canvas
    const ctx = canvas.getContext('2d')
    const skin = this.skin
    if (!ctx || !skin || !this.image || !this.clip?.frames.length) return

    let frameName = this.clip.frames[this.frameIndex % this.clip.frames.length]
    if (this.dragging && this.states.states[this.stateName]?.action === 'drag-lift' && this.clip.frames.length >= 4) frameName = this.clip.frames[this.swing < -3 ? 1 : this.swing > 3 ? 3 : 0]
    const rect = skin.atlas.frames[frameName]
    if (!rect) {
      if (!this.reportedMissing.has(frameName)) {
        this.reportedMissing.add(frameName)
        this.opts.onStateChange?.(`missing-frame:${frameName}`, 'missing')
      }
      return
    }
    this.currentFrame = rect

    const cssW = Math.round(rect.w * this.scale)
    const cssH = Math.round(rect.h * this.scale)
    if (canvas.width !== cssW || canvas.height !== cssH) {
      canvas.width = cssW
      canvas.height = cssH
    }
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const transition = Math.max(0, Math.min(1, 1 - (this.transitionUntil - performance.now()) / ACTION_TIMING.portraitTransitionMs))
    if (transition < 1) ctx.drawImage(this.previousCanvas, 0, 0, canvas.width, canvas.height)
    const definition = this.states.states[this.stateName]
    const action = this.dragging ? 'drag-lift' : definition?.action ?? profileBodyForState(this.stateName, this.skin?.actionProfile) ?? bodyForSignal(this.behavior)
    const pose = sampleActionPose({ body: action, emotion: definition?.emotion, timeMs: performance.now(), dragSwing: this.swing })
    const motion = sampleMotion(definition?.motion, performance.now())
    const pivotX = canvas.width * (action === 'drag-lift' || action === 'hang-top' ? rect.pivot?.x ?? .5 : .5)
    const pivotY = canvas.height * (action === 'hang-top' ? skin.actionProfile?.anchors?.hangY ?? rect.pivot?.y ?? .06 : action === 'drag-lift' ? rect.pivot?.y ?? .06 : .95)
    const mirror = definition?.mirror || (action === 'walk' && this.behavior.direction === 1)
    this.drawTransform = new DOMMatrix().translate(pivotX + (action === 'hang-top' ? 0 : motion.x * canvas.width), pivotY + (action === 'hang-top' ? 0 : (motion.y - pose.motion.bounce) * canvas.height))
      .rotate(motion.angle * 180 / Math.PI + pose.motion.rotate + (!this.dragging && !this.behavior.resting ? this.swing * .35 : 0)).scale(motion.sx * (mirror ? -1 : 1), motion.sy + pose.motion.breathe).translate(-pivotX, -pivotY)
    ctx.save()
    ctx.globalAlpha = transition
    ctx.setTransform(this.drawTransform)
    ctx.drawImage(this.image, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height)
    ctx.restore()
    canvas.dataset.state = this.stateName
    canvas.dataset.body = action
  }

  /* ------------------------- 命中判定 ------------------------- */

  bounds(): DOMRect {
    return this.opts.canvas.getBoundingClientRect()
  }

  /** 客户端坐标处的不透明度（0~255）。没有 alpha 表时退化成"在框内即命中"（返回 255）。 */
  alphaAt(clientX: number, clientY: number): number {
    const rect = this.bounds()
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return 0
    const frame = this.currentFrame
    if (!this.sheet || !frame) return 255
    const local = this.drawTransform.inverse().transformPoint({
      x: (clientX - rect.left) / Math.max(1, rect.width) * this.opts.canvas.width,
      y: (clientY - rect.top) / Math.max(1, rect.height) * this.opts.canvas.height,
    })
    if (local.x < 0 || local.y < 0 || local.x >= this.opts.canvas.width || local.y >= this.opts.canvas.height) return 0
    const sx = frame.x + local.x / this.opts.canvas.width * frame.w
    const sy = frame.y + local.y / this.opts.canvas.height * frame.h
    const px = Math.floor(sx)
    const py = Math.floor(sy)
    if (px < 0 || py < 0 || px >= this.sheet.width || py >= this.sheet.height) return 0
    return this.sheet.data[(py * this.sheet.width + px) * 4 + 3]
  }
}
