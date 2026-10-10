import type { ResolvedSkin, ResolvedLive2DSkin, States } from '../shared/types.js'
import type { SkinView } from './skinview.js'
import { PET_EXPRESSIONS } from '../shared/pet-life.js'
import { DEFAULT_BEHAVIOR, bodyForSignal, type BodyAction, type BehaviorSignal, type PetGeometry, type Emotion } from '../shared/action-model.js'

/** Reuses guansss/pixi-live2d-display (MIT) + official Cubism Core. No custom model decoder. */
type Library = Record<string, any>
let libraries: Promise<Library> | null = null
function script(file: string): Promise<void> {
  return new Promise((resolve, reject) => { const tag = document.createElement('script'); tag.src = `deskpet://renderer/vendor/${file}`; tag.onload = () => resolve(); tag.onerror = () => reject(new Error(`Live2D 运行库未准备：${file}，请运行 setup:live2d`)); document.head.append(tag) })
}
async function loadLibraries(): Promise<Library> {
  if (!libraries) libraries = (async () => {
    await script('live2dcubismcore.min.js'); await script('pixi.min.js'); await script('unsafe-eval.min.js'); await script('cubism4.min.js')
    return (window as unknown as { PIXI: Library }).PIXI
  })().catch(error => { libraries = null; throw error })
  return libraries
}
export class Live2DView implements SkinView {
  private skin: ResolvedLive2DSkin | null = null
  private app: Library | null = null
  private model: Library | null = null
  private gpu = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D | null = null
  private raf = 0
  private last = 0
  private clock = 0
  private look = { x: 0, y: 0 }
  private behavior = { ...DEFAULT_BEHAVIOR }
  private dragging = false
  private talking = false
  private emotion: Emotion = 'neutral'
  private emote: { name: string; until: number } | null = null
  private stateName = 'idle'
  private swing = 0
  private velocity = 0
  private target = 0
  private parameters = new Map<string, number>()
  private baseScale = 1
  private action: string | undefined
  private idleGroup = 'Idle'
  private motionsSuspended = false
  private smoothed = new Map<string, number>()
  private stepSeconds = .016
  constructor(private readonly canvas: HTMLCanvasElement) {}
  get ready(): boolean { return !!this.model }
  get state(): string { return this.stateName }
  async load(skin: ResolvedSkin, _states: States | null, scale: number): Promise<void> {
    if (skin.kind !== 'live2d') throw new Error('Live2DView 需要 Live2D 模型')
    this.skin = skin
    const pixi = await loadLibraries()
    const width = Math.max(1, Math.round(skin.frameSize.w * skin.scale * scale)), height = Math.max(1, Math.round(skin.frameSize.h * skin.scale * scale))
    const resolution = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    this.canvas.width = Math.round(width * resolution); this.canvas.height = Math.round(height * resolution); this.canvas.style.width = width + 'px'; this.canvas.style.height = height + 'px'
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })
    this.app = new pixi.Application({ view: this.gpu, width, height, resolution, transparent: true, autoStart: false, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' })
    this.model = await pixi.live2d.Live2DModel.from(skin.modelUrl, { autoUpdate: false, autoInteract: false, motionPreload: 'IDLE' })
    const model = this.model!
    this.baseScale = Math.min((width - 30) / model.width, (height - 24) / model.height)
    model.scale.set(this.baseScale); model.anchor.set(.5, 1); model.position.set(width / 2, height - 10)
    this.app!.stage.addChild(model)
    const core = model.internalModel.coreModel
    this.idleGroup = model.internalModel.motionManager.groups.idle
    const ids: string[] = core._model?.parameters?.ids ?? []
    for (let index = 0; index < ids.length; index++) this.parameters.set(ids[index], index)
    model.internalModel.on('beforeModelUpdate', () => this.applyParameters())
    this.draw(16)
    this.canvas.dataset.renderer = 'live2d'
  }
  private parameter(id: string, value: number, weight = 1): void {
    const actual = this.skin?.actionProfile?.parameters?.[id] ?? id
    const index = this.parameters.get(actual), core = this.model?.internalModel.coreModel
    if (index === undefined || !core) return
    const min = core.getParameterMinimumValue(index), max = core.getParameterMaximumValue(index)
    const target = Math.max(min, Math.min(max, value))
    const previous = this.smoothed.get(id) ?? core.getParameterValueByIndex(index)
    const next = previous + (target - previous) * (1 - Math.exp(-this.stepSeconds * 16))
    this.smoothed.set(id, next)
    core.setParameterValueByIndex(index, next, weight)
  }
  private applyParameters(): void {
    const body = this.body(), t = this.clock / 1000
    const sleep = body === 'sleep-curl'
    const active = this.emote && this.emote.until > performance.now()
    const mood = active ? this.emotion : 'neutral'
    const nod = active && this.action === 'nod' ? Math.sin(t * 5) * 8 : 0
    const tilt = active && this.action === 'tilt' ? 7 : 0
    // A single driver writes each controlled parameter; dragging suppresses incompatible motions.
    this.parameter('ParamAngleX', this.dragging ? this.swing * .5 : this.look.x * 22, .75)
    this.parameter('ParamAngleY', this.dragging ? -12 : sleep ? -8 : -this.look.y * 14 + nod, .75)
    this.parameter('ParamAngleZ', this.dragging ? this.swing : body.startsWith('peek') ? (body === 'peek-left' ? 8 : -8) : tilt, .6)
    this.parameter('ParamEyeBallX', this.dragging || sleep ? 0 : this.look.x, .8)
    this.parameter('ParamEyeBallY', this.dragging || sleep ? 0 : this.look.y, .8)
    if (sleep) { this.parameter('ParamEyeLOpen', 0); this.parameter('ParamEyeROpen', 0) }
    else if (this.dragging) { this.parameter('ParamEyeLOpen', .5, .8); this.parameter('ParamEyeROpen', .5, .8) }
    else if (mood === 'happy' || mood === 'love' || mood === 'shy') { this.parameter('ParamEyeLSmile', 1); this.parameter('ParamEyeRSmile', 1); this.parameter('ParamMouthForm', 1, .8); this.parameter('ParamCheek', mood === 'happy' ? .2 : .8) }
    else if (mood === 'angry') { this.parameter('ParamBrowLAngle', -1, .7); this.parameter('ParamBrowRAngle', -1, .7); this.parameter('ParamMouthForm', -.5, .7) }
    else if (mood === 'sad') { this.parameter('ParamBrowLAngle', .7, .7); this.parameter('ParamBrowRAngle', .7, .7); this.parameter('ParamMouthForm', -.5, .7) }
    else if (mood === 'surprised') { this.parameter('ParamEyeLOpen', 1.2); this.parameter('ParamEyeROpen', 1.2); this.parameter('ParamMouthForm', 0) }
    else if (mood === 'unimpressed') { this.parameter('ParamEyeLOpen', .55); this.parameter('ParamEyeROpen', .55); this.parameter('ParamMouthForm', -.2) }
    else if (mood === 'dizzy') this.parameter('ParamBodyAngleZ', Math.sin(t * 5) * 3, .5)
    this.parameter('ParamMouthOpenY', this.talking && !this.dragging && !sleep ? .2 + Math.abs(Math.sin(t * 8.3)) * .5 : 0, .9)
    if (body === 'walk') this.parameter('ParamBodyAngleX', Math.sin(t * 5) * 4, .5)
    if (this.dragging) this.parameter('ParamBodyAngleZ', this.swing * .4, .7)
  }
  start(): void { if (!this.raf && this.ready) { this.last = 0; this.raf = requestAnimationFrame(this.frame) } }
  stop(): void { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0 }
  dispose(): void { this.stop(); this.model?.destroy({ children: true }); this.model = null; this.app?.destroy(false); this.app = null }
  bounds(): DOMRect { return this.canvas.getBoundingClientRect() }
  geometry(): PetGeometry { const r = this.bounds(), anchors = this.skin?.actionProfile?.anchors; return { x: r.x, y: r.y, width: r.width, height: r.height, collarX: r.x + r.width * (anchors?.collar?.x ?? .5), collarY: r.y + r.height * (anchors?.collar?.y ?? .25), bottomLine: r.height, leftLine: r.width * (anchors?.peek?.left ?? .35), rightLine: r.width * (anchors?.peek?.right ?? .65) } }
  alphaAt(x: number, y: number): number { const r = this.bounds(); const px = Math.floor((x - r.x) * this.canvas.width / r.width), py = Math.floor((y - r.y) * this.canvas.height / r.height); return this.ctx && px >= 0 && py >= 0 && px < this.canvas.width && py < this.canvas.height ? this.ctx.getImageData(px, py, 1, 1).data[3] : 0 }
  setLook(x: number, y: number): void { this.look = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) } }
  setBehavior(signal: BehaviorSignal): void {
    this.behavior = signal
    if (signal.dragging !== undefined) this.drag(signal.dragging)
    if (signal.dragDelta !== undefined) this.target = Math.max(-8, Math.min(8, -signal.dragDelta * .6))
  }
  react(state: string, durationMs = 2600): void {
    if (this.dragging || this.behavior.resting) return
    this.emote = { name: state, until: performance.now() + durationMs }
    this.action = state
    this.emotion = [...PET_EXPRESSIONS, 'sad', 'neutral'].includes(state) ? state as Emotion : 'neutral'
    if (state === 'wave') this.wave()
    const nativeExpression = this.skin?.actionProfile?.expressions?.[state as Emotion] ?? state
    if (this.skin?.expressions.includes(nativeExpression)) void this.model?.expression(nativeExpression).catch(() => {})
  }
  expression(emotion: Emotion, action?: 'wave' | 'nod' | 'tilt', durationMs = 3500): void {
    if (this.dragging || this.behavior.resting) return
    if (emotion === 'neutral') { this.emote = null; this.emotion = 'neutral'; this.model?.internalModel.motionManager.expressionManager?.resetExpression(); return }
    this.react(emotion, durationMs); this.action = action
    if (action === 'wave') this.wave()
  }
  private wave(): void {
    const binding = this.skin?.actionProfile?.motions?.wave ?? { group: 'TapBody', index: 0 }
    if (!this.skin?.motions.includes(binding.group) || binding.index >= (this.skin.motionCounts?.[binding.group] ?? 1)) return
    void this.model?.motion(binding.group, binding.index, 2).catch(() => {})
  }
  talk(on: boolean): void { this.talking = on }
  private body(): BodyAction {
    if (this.dragging) return 'drag-lift'
    const body = bodyForSignal(this.behavior)
    if (this.behavior.resting) return body
    if (this.emote && this.emote.until > performance.now() && this.emote.name === 'sleepy') return 'sleep-curl'
    if (this.emote && this.emote.until > performance.now() && ['walk', 'sleep-curl', 'peek-left', 'peek-right'].includes(this.emote.name)) return this.emote.name as BodyAction
    return body
  }
  drag(on: boolean): void { if (on && !this.dragging) { this.emote = null; this.action = undefined }; this.dragging = on; this.syncMotions() }
  private syncMotions(): void {
    const manager = this.model?.internalModel.motionManager
    if (!manager) return
    const body = this.body()
    const suspend = this.dragging || this.behavior.resting || body === 'sleep-curl' || body.startsWith('peek')
    if (suspend === this.motionsSuspended) return
    // MotionManager otherwise restarts Idle on the next frame after stopAllMotions.
    manager.groups.idle = suspend ? '' : this.idleGroup
    manager.stopAllMotions()
    this.motionsSuspended = suspend
    this.smoothed.clear()
  }
  resetToBase(): void { this.emote = null; this.emotion = 'neutral'; this.talking = false }
  private frame = (timestamp: number): void => {
    this.raf = requestAnimationFrame(this.frame)
    const fps = this.dragging ? 60 : this.behavior.resting ? 20 : 30
    if (this.last && timestamp - this.last < 1000 / fps) return
    const dt = this.last ? Math.min(80, timestamp - this.last) : 16; this.last = timestamp; this.clock += dt
    const seconds = dt / 1000
    this.velocity += ((this.target - this.swing) * 25 - this.velocity * 8) * seconds
    this.swing = Math.max(-8, Math.min(8, this.swing + this.velocity * seconds)); this.target *= Math.exp(-seconds * 5)
    this.draw(dt)
  }
  private draw(dt: number): void {
    if (!this.model || !this.app || !this.ctx) return
    const body = this.body()
    const active = this.emote && this.emote.until > performance.now()
    this.stateName = this.dragging ? 'drag-lift' : this.behavior.resting ? body : this.talking ? 'talk' : active ? this.emote!.name : body
    this.syncMotions(); this.stepSeconds = dt / 1000
    // Sway through actual model parameters, keeping feet and the character's rig coherent.
    this.model.rotation = 0
    this.model.update(dt); this.app.renderer.render(this.app.stage)
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); this.ctx.drawImage(this.gpu, 0, 0)
    this.canvas.dataset.body = body; this.canvas.dataset.state = this.stateName
    this.canvas.dataset.emotion = active ? this.emotion : 'neutral'
    this.canvas.dataset.parameters = String(this.parameters.size)
    this.canvas.dataset.motionsSuspended = String(this.motionsSuspended)
    this.canvas.dataset.mouthActive = String(this.talking && !this.dragging && body !== 'sleep-curl')
  }
}
