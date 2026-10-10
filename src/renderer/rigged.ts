import type { ResolvedRigSkin, ResolvedSkin, States } from '../shared/types.js'
import type { SkinView } from './skinview.js'
import { PET_EXPRESSIONS, type PetExpression } from '../shared/pet-life.js'
import { DEFAULT_BEHAVIOR, bodyForSignal, sampleActionPose, retargetSkeleton, restSkeleton, ACTION_MODEL_VERSION, type BehaviorSignal, type PetGeometry, type CharacterActionAdapter, type Joint } from '../shared/action-model.js'

/**
 * 2.5D 装配外形的渲染层（Canvas2D）。
 *
 * 说明清楚它和 Petra 的差别：Petra 用 WebGL 对每个图层的三角网格做**逐顶点**解析式变形
 * （皱纹级别的形变）；这里是 Canvas2D，对**整层**做仿射变换（位移 + 绕锚点旋转 + 眼睑压缩）。
 * 但驱动公式与参数是照搬的：
 *   呼吸 3.4s 周期、头相位差 -0.6；
 *   眨眼 1600+rand×3800ms、18% 概率双眨、闭合 80ms / 保持 340ms / 张开 160ms；
 *   视线：头 angleX=look.x·0.25、angleY=-look.y·0.15，眼 look·1.8 / ·1.2，
 *   虹膜像素位移 (eyeX·11·FS, eyeY·6·FS)，平滑 k = 1-exp(-8·dt)；
 *   视差：depth 越大越靠前，头部位移 FS·(angleX·(18+40·(depth-1)) + …)。
 * 逐顶点形变留作后话（要上 WebGL），当前观感已经能到"会呼吸、会眨眼、会看你"。
 */

interface LayerImage {
  meta: ResolvedRigSkin['rig']['layers'][number]
  image: HTMLImageElement
}

const BLINK_CLOSE_MS = 80
const BLINK_HOLD_MS = 340
const BLINK_OPEN_MS = 160

export class RiggedView implements SkinView {
  private skin: ResolvedRigSkin | null = null
  private layers: LayerImage[] = []
  private ctx: CanvasRenderingContext2D | null = null
  private scale = 1
  private raf = 0
  private lastTs = 0
  private elapsed = 0
  private readyFlag = false
  private stateName = 'idle'
  private mask: Uint8Array | null = null
  private maskStep = 4
  private maskW = 0
  private maskH = 0

  // 动画状态
  private blinkAt = 0
  private blinkPhase: 'none' | 'close' | 'hold' | 'open' = 'none'
  private blinkPhaseAt = 0
  private blinkQueued = false
  private eyeOpen = 1
  private talking = false
  private dragging = false
  private emote: { name: string; until: number } | null = null
  private lookTarget = { x: 0, y: 0 }
  private look = { x: 0, y: 0 }
  private behavior: BehaviorSignal = { ...DEFAULT_BEHAVIOR }
  private swing = 0
  private swingVelocity = 0
  private swingTarget = 0
  private adapter: CharacterActionAdapter | null = null

  constructor(private readonly canvas: HTMLCanvasElement) {}

  get ready(): boolean {
    return this.readyFlag
  }

  get state(): string {
    return this.stateName
  }

  async load(skin: ResolvedSkin, _states: States | null, scale: number): Promise<void> {
    if (skin.kind !== 'rig') throw new Error('RiggedView 只能加载 rig 类型的外形')
    this.readyFlag = false
    this.skin = skin
    this.scale = Math.max(0.01, scale * (skin.scale || 1))
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })

    const width = Math.round(skin.rig.canvas.w * this.scale)
    const height = Math.round(skin.rig.canvas.h * this.scale)
    this.canvas.width = width
    this.canvas.height = height
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`

    const images = await Promise.all(
      skin.rig.layers.map(
        (meta) =>
          new Promise<LayerImage>((resolve, reject) => {
            const image = new Image()
            image.crossOrigin = 'anonymous'
            image.onload = () => resolve({ meta, image })
            image.onerror = () => reject(new Error(`图层图片加载失败：${meta.png}`))
            image.src = skin.layerUrls[meta.png] ?? ''
          }),
      ),
    )
    this.layers = images.sort((a, b) => a.meta.z - b.meta.z)
    const joints = restSkeleton()
    const { anchors, canvas } = skin.rig
    joints.head.x = anchors.face.cx ?? ((anchors.face.x0 + anchors.face.x1) / 2)
    joints.head.x /= canvas.w
    joints.head.y = (anchors.face.cy ?? ((anchors.face.y0 + anchors.face.y1) / 2)) / canvas.h
    joints.neck.x = anchors.neckPivot.cx / canvas.w; joints.neck.y = anchors.neckPivot.cy / canvas.h
    joints.root.x = anchors.bodyPivot.cx / canvas.w; joints.root.y = Math.min(.80, anchors.bodyPivot.cy / canvas.h)
    joints.collar.x = joints.neck.x; joints.collar.y = joints.neck.y
    this.adapter = { version: ACTION_MODEL_VERSION, joints, parts: {}, mode: 'rig' }
    for (const [name, point] of Object.entries(skin.actionProfile?.joints ?? {})) this.adapter.joints[name as Joint] = { ...point }
    this.buildMask()
    this.readyFlag = true
  }

  /** 静态命中掩膜：把所有图层缩略画一遍，取 alpha 的或 —— 图层会小幅移动，这个近似够用 */
  private buildMask(): void {
    const skin = this.skin
    if (!skin) return
    const w = Math.max(1, Math.round(skin.rig.canvas.w / this.maskStep))
    const h = Math.max(1, Math.round(skin.rig.canvas.h / this.maskStep))
    const off = document.createElement('canvas')
    off.width = w
    off.height = h
    const octx = off.getContext('2d', { willReadFrequently: true })
    if (!octx) {
      this.mask = null
      return
    }
    for (const layer of this.layers) {
      octx.drawImage(layer.image, layer.meta.x / this.maskStep, layer.meta.y / this.maskStep, layer.meta.w / this.maskStep, layer.meta.h / this.maskStep)
    }
    try {
      const data = octx.getImageData(0, 0, w, h).data
      const mask = new Uint8Array(w * h)
      for (let i = 0; i < mask.length; i += 1) mask[i] = data[i * 4 + 3]
      this.mask = mask
      this.maskW = w
      this.maskH = h
    } catch {
      this.mask = null
    }
  }

  start(): void {
    if (this.raf) return
    this.lastTs = 0
    this.blinkAt = performance.now() + 1200
    this.raf = requestAnimationFrame(this.frame)
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  bounds(): DOMRect {
    return this.canvas.getBoundingClientRect()
  }

  alphaAt(clientX: number, clientY: number): number {
    const rect = this.bounds()
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return 0
    if (this.ctx && this.ready) {
      const x = Math.floor((clientX - rect.left) / rect.width * this.canvas.width)
      const y = Math.floor((clientY - rect.top) / rect.height * this.canvas.height)
      if (x >= 0 && y >= 0 && x < this.canvas.width && y < this.canvas.height) return this.ctx.getImageData(x, y, 1, 1).data[3]
      return 0
    }
    if (!this.mask) return 255
    const cx = ((clientX - rect.left) / Math.max(1, rect.width)) * this.maskW
    const cy = ((clientY - rect.top) / Math.max(1, rect.height)) * this.maskH
    const i = Math.floor(cy) * this.maskW + Math.floor(cx)
    return i >= 0 && i < this.mask.length ? this.mask[i] : 0
  }

  setLook(x: number, y: number): void {
    this.lookTarget = { x, y }
  }

  setBehavior(signal: BehaviorSignal): void {
    this.behavior = signal
    if (signal.dragging !== undefined && signal.dragging !== this.dragging) this.drag(signal.dragging)
    if (signal.dragDelta !== undefined) this.swingTarget = Math.max(-12, Math.min(12, -signal.dragDelta * .8))
    if (!this.emote && !this.talking && !this.dragging) this.stateName = bodyForSignal(signal)
  }

  geometry(): PetGeometry {
    const rect = this.bounds(), face = this.skin?.rig.anchors.face, anchors = this.skin?.actionProfile?.anchors
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      collarX: rect.x + rect.width * (anchors?.collar?.x ?? .5), collarY: rect.y + rect.height * (anchors?.collar?.y ?? .10),
      bottomLine: (face?.cy ?? ((face?.y0 ?? 0) + (face?.y1 ?? rect.height)) / 2) * this.scale,
      leftLine: rect.width * (anchors?.peek?.left ?? .4), rightLine: rect.width * (anchors?.peek?.right ?? .6) }
  }

  react(state: string, durationMs = 1800): void {
    this.stateName = state
    this.emote = { name: state, until: performance.now() + durationMs }
    window.setTimeout(() => {
      if (this.emote && this.emote.until <= performance.now()) {
        this.emote = null
        this.stateName = bodyForSignal(this.behavior)
      }
    }, durationMs + 30)
  }
  expression(emotion: PetExpression, _action?: 'wave' | 'nod' | 'tilt', durationMs = 3000): void {
    if (emotion === 'neutral') { this.emote = null; this.stateName = this.talking ? 'talk' : bodyForSignal(this.behavior); return }
    this.react(emotion, durationMs)
  }

  talk(on: boolean): void {
    this.talking = on
    this.stateName = on ? 'talk' : this.emote ? this.stateName : bodyForSignal(this.behavior)
  }

  drag(on: boolean): void {
    this.dragging = on
    this.stateName = on ? 'drag-lift' : this.emote ? this.stateName : bodyForSignal(this.behavior)
  }

  resetToBase(): void {
    this.emote = null
    this.talking = false
    this.dragging = false
    this.stateName = 'idle'
  }

  /* ------------------------------------------------------------------ */

  private frame = (ts: number): void => {
    this.raf = requestAnimationFrame(this.frame)
    const fps = this.dragging ? 60 : this.behavior.resting ? 20 : this.behavior.moving ? 40 : 30
    if (this.lastTs && ts - this.lastTs < 1000 / fps) return
    const dt = this.lastTs ? Math.min(120, ts - this.lastTs) : 16
    this.lastTs = ts
    this.elapsed += dt
    const step = dt / 1000
    this.swingVelocity += (((this.dragging ? this.swingTarget : 0) - this.swing) * 34 - this.swingVelocity * 8) * step
    this.swing = Math.max(-12, Math.min(12, this.swing + this.swingVelocity * step))
    this.swingTarget *= Math.exp(-step * 6)
    this.stepBlink(ts)
    const k = 1 - Math.exp((-dt / 1000) * 8)
    this.look = { x: this.look.x + (this.lookTarget.x - this.look.x) * k, y: this.look.y + (this.lookTarget.y - this.look.y) * k }
    this.draw(ts)
  }

  private stepBlink(now: number): void {
    const params = this.skin?.rig.params
    const min = params?.blinkMinMs ?? 1600
    const max = params?.blinkMaxMs ?? 3800
    const doubleChance = params?.doubleBlinkChance ?? 0.18

    if (this.blinkPhase === 'none') {
      if (now >= this.blinkAt) {
        this.blinkPhase = 'close'
        this.blinkPhaseAt = now
      }
      return
    }
    const phaseMs = now - this.blinkPhaseAt
    if (this.blinkPhase === 'close') {
      this.eyeOpen = Math.max(0, 1 - phaseMs / BLINK_CLOSE_MS)
      if (phaseMs >= BLINK_CLOSE_MS) {
        this.blinkPhase = 'hold'
        this.blinkPhaseAt = now
        this.eyeOpen = 0
      }
    } else if (this.blinkPhase === 'hold') {
      this.eyeOpen = 0
      if (phaseMs >= BLINK_HOLD_MS) {
        this.blinkPhase = 'open'
        this.blinkPhaseAt = now
      }
    } else {
      this.eyeOpen = Math.min(1, phaseMs / BLINK_OPEN_MS)
      if (phaseMs >= BLINK_OPEN_MS) {
        this.blinkPhase = 'none'
        this.eyeOpen = 1
        if (!this.blinkQueued && Math.random() < doubleChance) {
          this.blinkQueued = true
          this.blinkAt = now + 280
        } else {
          this.blinkQueued = false
          this.blinkAt = now + min + Math.random() * (max - min)
        }
      }
    }
  }

  private draw(now: number): void {
    const skin = this.skin
    const ctx = this.ctx
    if (!skin || !ctx) return
    const { anchors, params } = skin.rig
    const FS = anchors.faceScale || 1
    const scale = this.scale
    const t = this.elapsed / 1000

    const breath = 0.5 + 0.5 * Math.sin((this.elapsed / (params.breathPeriodMs || 3400)) * Math.PI * 2)
    const breathHead = -0.6 * breath

    const emote = this.emote && this.emote.until > now ? this.emote.name : null
    const requested = ['walk', 'sleep-curl', 'peek-left', 'peek-right'].includes(emote ?? '') ? emote as 'walk' | 'sleep-curl' | 'peek-left' | 'peek-right' : bodyForSignal(this.behavior)
    const action = this.dragging ? 'drag-lift' : requested
    const emotion: PetExpression = emote && [...PET_EXPRESSIONS, 'sad'].includes(emote) ? emote as PetExpression : 'neutral'
    const pose = sampleActionPose({ body: action, emotion, timeMs: this.elapsed, dragSwing: this.swing })
    const mapped = this.adapter ? retargetSkeleton(pose, this.adapter) : pose.joints
    const animatedEye = action === 'sleep-curl' ? 0 : Math.min(this.eyeOpen, pose.face.eyeOpen)
    const emoteBoost = emote ? 1 : 0
    const angleX = this.look.x * 0.25 + (emote === 'happy' ? 0.02 * Math.sin(t * 6) : 0)
    const angleY = -this.look.y * 0.15 - (this.dragging ? 0.12 : 0)
    const angleZ = 0.07 * Math.sin(t * 0.23 + 0.5) + this.look.x * 0.05 + emoteBoost * 0.06 * Math.sin(t * 3.1)
    const body = 0.1 * Math.sin(t * 0.19 + 2.1) + (this.dragging ? 0.08 * Math.sin(t * 2.4) : 0)

    const eyeX = this.look.x * 1.8
    const eyeY = this.look.y * 1.2
    const mouthOpen = this.talking ? 1 : 0

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)

    for (const { meta, image } of this.layers) {
      let dx = 0
      let dy = 0
      let rot = 0
      let sy = 1
      let alpha = 1
      let pivotX = (meta.x + meta.w / 2) * scale
      let pivotY = (meta.y + meta.h / 2) * scale
      const isEye = meta.fade === 'eyeOpen' || meta.fade === 'eyeClose'
      const isMouth = meta.fade === 'mouthOpen' || meta.fade === 'mouthClose'
      const lowerName = meta.name.toLowerCase()
      const side = meta.side === 'R' || /(?:right|_r\b)/.test(lowerName) ? 'R' : 'L'
      const joint: Joint = /hand|wrist/.test(lowerName) ? `hand${side}` : /arm/.test(lowerName) ? `elbow${side}` : /foot|shoe/.test(lowerName) ? `foot${side}` : /leg/.test(lowerName) ? `knee${side}` : meta.group === 'head' ? 'head' : 'root'
      const bind = this.adapter?.joints[joint]
      if (bind && action !== 'idle') {
        dx += (mapped[joint].x - bind.x) * skin.rig.canvas.w
        dy += (mapped[joint].y - bind.y) * skin.rig.canvas.h
        rot += pose.joints[joint].angle * Math.PI / 180
      }
      dy -= pose.motion.bounce * skin.rig.canvas.h
      if (action === 'drag-lift') {
        rot += pose.motion.rotate * Math.PI / 180
        pivotX = skin.rig.canvas.w * scale * .5; pivotY = skin.rig.canvas.h * scale * .10
      }

      if (meta.group === 'head') {
        rot += angleZ * 0.2
        if (action !== 'drag-lift') { pivotX = anchors.neckPivot.cx * scale; pivotY = anchors.neckPivot.cy * scale }
        const layerCenterY = meta.y + meta.h / 2
        dx += FS * (angleX * (18 + 40 * (meta.depth - 1)) + angleX * (anchors.neckPivot.cy - layerCenterY) * 0.075)
        dy -= FS * (angleY * (16 + 30 * (meta.depth - 1)) + breathHead * 1.6)
      } else {
        rot += body * 0.085
        if (action !== 'drag-lift') { pivotX = anchors.bodyPivot.cx * scale; pivotY = anchors.bodyPivot.cy * scale }
        dy -= FS * breath * 2.0
      }

      if (meta.phys === 'hair') {
        // 发丝：整层位移近似（逐束弹簧要 WebGL 逐顶点才能做对）
        const wind = 1.8 * Math.sin(t * 0.8) + 1.0 * Math.sin(t * 1.9 + 2.3)
        const headDX = angleX * 14 + angleZ * 0.07 * (anchors.neckPivot.cy - (meta.y + meta.h / 2)) + wind
        dx += headDX * 0.06 * (meta.depth - 1) + pose.motion.hairLag * meta.h
      }

      if (isEye) {
        const ease = params.eyeEase ?? 0.3
        alpha = meta.fade === 'eyeOpen' ? smooth((animatedEye - (0.1 + ease * 0.45)) / 0.15) : 1 - smooth((animatedEye - (0.1 + ease * 0.45)) / 0.15)
        if (meta.fade === 'eyeClose' || meta.name.toLowerCase().includes('close')) {
          pivotY = 0
          sy = 1
        } else {
          // 眼睛闭上时绕 closeY 纵向压缩（kernel 的做法）
          const anchor = meta.side === 'R' ? anchors.eyeR : anchors.eyeL
          const closeY = anchor?.closeY ?? meta.y + meta.h
          pivotY = closeY * scale
          sy = 1 - 0.85 * (1 - animatedEye)
        }
        if (meta.name.toLowerCase().includes('irides') || meta.name.toLowerCase().includes('iris') || meta.name.toLowerCase().includes('pupil')) {
          dx += eyeX * 11 * FS
          dy += eyeY * 6 * FS
        }
      } else if (isMouth) {
        const ease = params.mouthEase ?? 0.45
        const open = meta.fade === 'mouthOpen' ? mouthOpen : 1 - mouthOpen
        alpha = Math.max(0.15, open) * (1 - ease * 0.3)
        pivotY = 0
        sy = 1
      }

      if (alpha <= 0.01) continue
      ctx.save()
      ctx.globalAlpha = Math.min(1, alpha)
      ctx.translate(pivotX, pivotY)
      ctx.rotate(rot)
      if (sy !== 1) ctx.scale(1, sy)
      ctx.translate(-pivotX, -pivotY)
      const drawX = meta.x * scale + dx * scale
      const drawY = meta.y * scale + dy * scale
      ctx.drawImage(image, drawX, drawY, meta.w * scale, meta.h * scale)
      ctx.restore()
    }
    this.canvas.dataset.state = this.stateName
    this.canvas.dataset.body = action
  }
}

/** smoothstep：把 [0,1] 之外的输入夹住，中间平滑过渡（照搬 kernel 的 fadeAlpha） */
function smooth(v: number): number {
  const x = Math.min(1, Math.max(0, v))
  return x * x * (3 - 2 * x)
}
