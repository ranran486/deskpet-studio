/** 角色无关动作协议。坐标为角色局部 0..1；角度为度，时间为毫秒。 */
export const ACTION_MODEL_VERSION = 'deskpet-actions/1' as const
export const ACTION_TIMING = { portraitTransitionMs: 160, sleepAfterMs: 90000, poseMinMs: 7000, poseMaxMs: 16000, poseCooldownMinMs: 12000, poseCooldownMaxMs: 30000 } as const
export type BodyAction = 'idle' | 'walk' | 'sleep-curl' | 'peek-left' | 'peek-right' | 'drag-lift' | 'lounge-bottom' | 'hang-top'
export type Emotion = import('./pet-life.js').PetExpression
export type DockEdge = 'none' | 'left' | 'right' | 'bottom' | 'top'
export interface BehaviorSignal {
  moving: boolean
  direction: -1 | 1
  edge: DockEdge
  resting: boolean
  dragging?: boolean
  dragDelta?: number
  paused?: boolean
  posture?: BodyAction
  viewport?: { left: number; top: number; right: number; bottom: number }
  surface?: { top: number; bottom: number }
}
export interface PetGeometry {
  x: number; y: number; width: number; height: number
  collarX: number; collarY: number
  bottomLine: number; leftLine: number; rightLine: number
  hangLine?: number; loungeLine?: number
}
export const DEFAULT_BEHAVIOR: BehaviorSignal = { moving: false, direction: -1, edge: 'none', resting: false }
export function bodyForSignal(signal: BehaviorSignal): BodyAction {
  if (!signal.dragging && signal.resting && signal.posture) return signal.posture
  return chooseBodyAction({ dragging: !!signal.dragging, resting: signal.resting, edge: signal.edge, speed: signal.moving ? 10 : 0 })
}
export function semanticState(states: Record<string, unknown>, requested: string, fallback = 'idle'): string {
  if (states[requested]) return requested
  const aliases: Record<string, string[]> = { 'drag-lift': ['drag'], 'sleep-curl': ['sleep'], 'peek-left': ['side'], 'peek-right': ['side'], 'lounge-bottom': ['sleep-curl', 'sleep', 'idle'], 'hang-top': ['side', 'idle'], walk: ['idle'], neutral: ['idle'], angry: ['idle'], sad: ['idle'], happy: ['wave'], purr: ['happy'], wave: ['happy'], shy: ['happy', 'purr', 'idle'], surprised: ['wave', 'idle'], sleepy: ['sleep', 'idle'], dizzy: ['drag', 'idle'], love: ['happy', 'purr', 'idle'], unimpressed: ['angry', 'idle'] }
  return aliases[requested]?.find(name => !!states[name]) ?? fallback
}
export function nearestDockEdge(center: { x: number; y: number }, area: { x: number; y: number; width: number; height: number }): Exclude<DockEdge, 'none'> {
  const distances = { left: Math.abs(center.x - area.x), right: Math.abs(area.x + area.width - center.x), bottom: Math.abs(area.y + area.height - center.y), top: Math.abs(center.y - area.y) }
  return (Object.keys(distances) as Array<Exclude<DockEdge, 'none'>>).reduce((a, b) => distances[a] <= distances[b] ? a : b)
}
export function dockPosition(edge: Exclude<DockEdge, 'none'>, position: { x: number; y: number }, geometry: PetGeometry, area: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  if (edge === 'bottom') return { x: Math.min(area.x + area.width - geometry.width, Math.max(area.x, position.x + geometry.x)) - geometry.x, y: area.y + area.height - geometry.y - (geometry.loungeLine ?? geometry.height) }
  if (edge === 'top') return { x: Math.min(area.x + area.width - geometry.width, Math.max(area.x, position.x + geometry.x)) - geometry.x, y: area.y - geometry.y - (geometry.hangLine ?? 0) }
  return { x: edge === 'left' ? area.x - geometry.x - geometry.leftLine : area.x + area.width - geometry.x - geometry.rightLine,
    y: Math.min(area.y + area.height - geometry.height, Math.max(area.y, position.y + geometry.y)) - geometry.y }
}

/** 屏幕最底边为实地。左右可窥探、上方可拖动，但整个角色矩形不得穿过地面。 */
export function constrainToGround(position: { x: number; y: number }, geometry: Pick<PetGeometry, 'y' | 'height'>, area: { y: number; height: number }): { x: number; y: number } {
  return { x: position.x, y: Math.min(position.y, area.y + area.height - geometry.y - geometry.height) }
}
export type Joint = 'root' | 'collar' | 'neck' | 'head' | 'shoulderL' | 'shoulderR' | 'elbowL' | 'elbowR' | 'handL' | 'handR' | 'hipL' | 'hipR' | 'kneeL' | 'kneeR' | 'footL' | 'footR'
export interface JointPose { x: number; y: number; angle: number }
export type SkeletonPose = Record<Joint, JointPose>
export interface ActionPose {
  body: BodyAction
  emotion: Emotion
  joints: SkeletonPose
  face: { eyeOpen: number; smile: number; brow: number; tear: number }
  motion: { rotate: number; bounce: number; breathe: number; hairLag: number }
  anchor: 'feet' | 'collar' | 'edge'
}
export interface ActionContext {
  timeMs: number
  body: BodyAction
  emotion?: Emotion
  intensity?: number
  dragSwing?: number
  direction?: -1 | 1
}
export interface CharacterActionAdapter {
  version: typeof ACTION_MODEL_VERSION
  /** 新人物绑定相同语义，不绑定前一个人物的帧名。 */
  joints: Partial<Record<Joint, { x: number; y: number }>>
  parts: Partial<Record<'head' | 'body' | 'armL' | 'armR' | 'legL' | 'legR' | 'hairFront' | 'hairBack' | 'eyes' | 'mouth', string[]>>
  mode: 'rig' | 'sprite' | 'flat'
  clips?: Partial<Record<BodyAction | Emotion, string>>
}
const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, Number.isFinite(x) ? x : a))
export function restSkeleton(): SkeletonPose {
  const joint = (x: number, y: number): JointPose => ({ x, y, angle: 0 })
  return {
    root: joint(.5, .63), collar: joint(.5, .41), neck: joint(.5, .42), head: joint(.5, .25),
    shoulderL: joint(.37, .45), shoulderR: joint(.63, .45), elbowL: joint(.30, .56), elbowR: joint(.70, .56),
    handL: joint(.32, .68), handR: joint(.68, .68), hipL: joint(.44, .65), hipR: joint(.56, .65),
    kneeL: joint(.43, .78), kneeR: joint(.57, .78), footL: joint(.43, .92), footR: joint(.57, .92),
  }
}
/** 同一组动作参数可以驱动不同角色的绑定。图集预览另用语义 clip 映射。 */
export function sampleActionPose(input: ActionContext): ActionPose {
  const intensity = clamp(input.intensity ?? 1, 0, 1)
  const seconds = Math.max(0, Number.isFinite(input.timeMs) ? input.timeMs : 0) / 1000
  const joints = restSkeleton()
  const emotion = input.emotion ?? 'neutral'
  const result: ActionPose = { body: input.body, emotion, joints,
    face: { eyeOpen: 1, smile: .1, brow: 0, tear: 0 },
    motion: { rotate: 0, bounce: 0, breathe: Math.sin(seconds * Math.PI * 2 / 3.6) * .007, hairLag: 0 }, anchor: 'feet' }
  const wave = Math.sin(seconds * Math.PI * 2 / .92)
  if (input.body === 'walk') {
    result.motion.bounce = Math.abs(wave) * .015
    joints.kneeL.x += wave * .075; joints.kneeR.x -= wave * .075
    joints.footL.x += wave * .12; joints.footR.x -= wave * .12
    joints.handL.x -= wave * .05; joints.handR.x += wave * .05
    result.motion.hairLag = Math.sin(seconds * Math.PI * 2 / .92 - .7) * .03
  } else if (input.body === 'drag-lift') {
    result.anchor = 'collar'
    result.motion.rotate = clamp(input.dragSwing ?? Math.sin(seconds * 2) * 5, -16, 16)
    result.motion.hairLag = -result.motion.rotate * .007
    joints.collar = { x: .5, y: .03, angle: 0 }
    joints.head = { x: .46, y: .32, angle: 18 }
    joints.neck.y = .47
    joints.shoulderL.y = joints.shoulderR.y = .50
    joints.elbowL = { x: .39, y: .63, angle: 3 }; joints.elbowR = { x: .61, y: .63, angle: -3 }
    joints.handL = { x: .39, y: .75, angle: 10 }; joints.handR = { x: .61, y: .75, angle: -10 }
    joints.footL.x = .47; joints.footR.x = .53
    result.face.eyeOpen = .4
  } else if (input.body === 'sleep-curl') {
    result.anchor = 'edge'
    joints.head = { x: .30, y: .45, angle: -18 }; joints.neck = { x: .46, y: .54, angle: -50 }
    joints.root = { x: .64, y: .65, angle: -70 }; joints.collar = { x: .46, y: .50, angle: 0 }
    joints.shoulderL = { x: .45, y: .58, angle: 0 }; joints.shoulderR = { x: .49, y: .57, angle: 0 }
    joints.elbowL = { x: .38, y: .70, angle: 0 }; joints.elbowR = { x: .42, y: .69, angle: 0 }
    joints.handL = { x: .26, y: .62, angle: 0 }; joints.handR = { x: .30, y: .62, angle: 0 }
    joints.hipL = { x: .71, y: .63, angle: 0 }; joints.hipR = { x: .76, y: .67, angle: 0 }
    joints.kneeL = { x: .62, y: .74, angle: 0 }; joints.kneeR = { x: .67, y: .77, angle: 0 }
    joints.footL = { x: .77, y: .80, angle: 0 }; joints.footR = { x: .80, y: .78, angle: 0 }
    result.face.eyeOpen = 0; result.face.smile = .6
  } else if (input.body.startsWith('peek-')) {
    result.anchor = 'edge'
    const sign = input.body === 'peek-left' ? 1 : -1
    joints.head.x += sign * .13; joints.head.angle = sign * 12
    joints.handL = { x: .32, y: .41, angle: 0 }
    result.motion.rotate = sign * (2 + Math.sin(seconds * 1.3))
    const blink = seconds % 4.6
    result.face.eyeOpen = blink > 3.8 && blink < 4 ? 0 : 1
  }
  if (emotion === 'happy') {
    result.face.smile = .9 * intensity; result.face.eyeOpen = .25
    result.motion.bounce += Math.abs(Math.sin(seconds * 5)) * .02 * intensity
    joints.handL.y -= .13 * intensity; joints.handR.y -= .13 * intensity
  } else if (emotion === 'angry') {
    result.face.brow = -.9 * intensity; result.face.smile = -.25
    result.motion.rotate += Math.sin(seconds * 9) * .6 * intensity
  } else if (emotion === 'sad') {
    result.face.brow = .6 * intensity; result.face.smile = -.65 * intensity; result.face.tear = .55 * intensity
    joints.head.y += .025 * intensity; joints.head.angle += 10 * intensity
    result.motion.breathe *= .5
  } else if (emotion === 'shy' || emotion === 'love') {
    result.face.smile = .85; result.face.eyeOpen = .85; joints.head.angle += 5
  } else if (emotion === 'surprised') {
    result.face.eyeOpen = 1; result.face.brow = .6; result.face.smile = .15
  } else if (emotion === 'sleepy') {
    result.face.eyeOpen = .08; result.motion.breathe *= .5
  } else if (emotion === 'dizzy') {
    result.motion.rotate += Math.sin(seconds * 5) * 2; result.face.eyeOpen = .7
  } else if (emotion === 'unimpressed') {
    result.face.eyeOpen = .55; result.face.smile = -.2; result.face.brow = -.3
  }
  return result
}

export interface BehaviorContext {
  dragging: boolean
  resting: boolean
  edge: DockEdge
  speed: number
  emotion?: Emotion
}
/** 首先确定身体状态，再叠加情绪；拖拽时优先保证支点、重量与输入响应。 */
export function chooseBodyAction(ctx: BehaviorContext): BodyAction {
  if (ctx.dragging) return 'drag-lift'
  if (ctx.resting && ctx.edge === 'bottom') return 'sleep-curl'
  if (ctx.resting && ctx.edge === 'top') return 'hang-top'
  if (ctx.resting && ctx.edge === 'left') return 'peek-left'
  if (ctx.resting && ctx.edge === 'right') return 'peek-right'
  return ctx.speed > 2 ? 'walk' : 'idle'
}
/** 全屏拖动以本体的可见接触点限制范围，不使用舞台/气泡尺寸。 */
export function dragRootWithinScreen(cursor: { x: number; y: number }, screen: { x: number; y: number; width: number; height: number }, grab: { x: number; y: number }): { x: number; y: number } {
  return { x: clamp(cursor.x, screen.x, screen.x + screen.width) - grab.x,
    y: clamp(cursor.y, screen.y, screen.y + screen.height) - grab.y }
}

export const JOINT_PARENT: Record<Joint, Joint | null> = {
  // collar 是衣物抓点，可伸展的衣领不作为固定长度的人体骨骼。
  root: null, neck: 'root', collar: null, head: 'neck', shoulderL: 'neck', shoulderR: 'neck',
  elbowL: 'shoulderL', elbowR: 'shoulderR', handL: 'elbowL', handR: 'elbowR',
  hipL: 'root', hipR: 'root', kneeL: 'hipL', kneeR: 'hipR', footL: 'kneeL', footR: 'kneeR',
}
/** 按新人物的骨长重定向姿势，保留动作方向，避免把人物拉成原角色的比例。 */
export function retargetSkeleton(pose: ActionPose, adapter: CharacterActionAdapter): SkeletonPose {
  const rest = restSkeleton()
  const mapped = {} as SkeletonPose
  const visit = (name: Joint): JointPose => {
    if (mapped[name]) return mapped[name]
    const parent = JOINT_PARENT[name]
    const bind = adapter.joints[name] ?? rest[name]
    if (!parent) return mapped[name] = { x: bind.x + pose.joints[name].x - rest[name].x, y: bind.y + pose.joints[name].y - rest[name].y, angle: pose.joints[name].angle }
    const parentPose = visit(parent)
    const parentBind = adapter.joints[parent] ?? rest[parent]
    const length = Math.hypot(bind.x - parentBind.x, bind.y - parentBind.y)
    const dx = pose.joints[name].x - pose.joints[parent].x
    const dy = pose.joints[name].y - pose.joints[parent].y
    const span = Math.hypot(dx, dy) || 1
    return mapped[name] = { x: parentPose.x + dx / span * length, y: parentPose.y + dy / span * length, angle: pose.joints[name].angle }
  }
  for (const name of Object.keys(rest) as Joint[]) visit(name)
  if (pose.anchor === 'collar') {
    const dx = pose.joints.collar.x - mapped.collar.x, dy = pose.joints.collar.y - mapped.collar.y
    for (const joint of Object.values(mapped)) { joint.x += dx; joint.y += dy }
  }
  return mapped
}
