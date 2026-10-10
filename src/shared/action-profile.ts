import { semanticState, type BodyAction, type Joint } from './action-model.js'
import { PET_EXPRESSIONS, type PetExpression } from './pet-life.js'

export const ACTION_PROFILE_VERSION = 'deskpet-character-actions/1' as const
export const BODY_ACTIONS: readonly BodyAction[] = ['idle', 'walk', 'sleep-curl', 'peek-left', 'peek-right', 'lounge-bottom', 'hang-top', 'drag-lift']
export const ACTION_SEMANTICS = [...BODY_ACTIONS, ...PET_EXPRESSIONS, 'neutral', 'sad', 'talk', 'wave'] as const
export type ActionSemantic = typeof ACTION_SEMANTICS[number]
export type CharacterKind = 'sprite' | 'rig' | 'live2d'
export interface ActionProfile {
  version: typeof ACTION_PROFILE_VERSION
  kind: CharacterKind
  states?: Partial<Record<ActionSemantic, string>>
  expressions?: Partial<Record<PetExpression, string>>
  parameters?: Record<string, string>
  motions?: Partial<Record<'wave', { group: string; index: number }>>
  anchors?: { collar?: { x: number; y: number }; peek?: { left: number; right: number }; hangY?: number; loungeY?: number }
  joints?: Partial<Record<Joint, { x: number; y: number }>>
}
const JOINTS = ['root', 'collar', 'neck', 'head', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'handL', 'handR', 'hipL', 'hipR', 'kneeL', 'kneeR', 'footL', 'footR']
export const LIVE2D_PARAMETERS = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamBrowLAngle', 'ParamBrowRAngle', 'ParamMouthOpenY', 'ParamMouthForm', 'ParamCheek', 'ParamBodyAngleX', 'ParamBodyAngleZ'] as const
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !['__proto__', 'constructor', 'prototype', 'toString'].includes(value) && !/[\x00-\x1f]/.test(value)
const fraction = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
export function validateActionProfile(raw: unknown): ActionProfile {
  if (!object(raw) || raw.version !== ACTION_PROFILE_VERSION || !['sprite', 'rig', 'live2d'].includes(String(raw.kind))) throw new Error('动作绑定模板的版本或模型类型无效')
  for (const [field, allowed] of [['states', ACTION_SEMANTICS], ['expressions', [...PET_EXPRESSIONS, 'neutral', 'sad']], ['parameters', LIVE2D_PARAMETERS]] as const) {
    const values = raw[field]
    if (values !== undefined && (!object(values) || Object.keys(values).length > allowed.length)) throw new Error(`动作绑定 ${field} 格式无效`)
    for (const [key, value] of Object.entries(values ?? {})) if (!(allowed as readonly string[]).includes(key) || !identifier(value)) throw new Error(`动作绑定 ${field}.${key} 无效`)
  }
  if (raw.motions !== undefined) {
    if (!object(raw.motions) || Object.keys(raw.motions).some(key => key !== 'wave')) throw new Error('动作组绑定格式无效')
    const wave = raw.motions.wave
    if (wave !== undefined && (!object(wave) || !identifier(wave.group) || !Number.isInteger(wave.index) || Number(wave.index) < 0 || Number(wave.index) > 128)) throw new Error('挥手动作组或索引无效')
  }
  if (raw.anchors !== undefined) {
    if (!object(raw.anchors)) throw new Error('动作抓点格式无效')
    const collar = raw.anchors.collar, peek = raw.anchors.peek
    for (const key of ['hangY', 'loungeY']) if (raw.anchors[key] !== undefined && !fraction(raw.anchors[key])) throw new Error('姿势接触线必须在人物局部 0..1 范围')
    if (collar !== undefined && (!object(collar) || !fraction(collar.x) || !fraction(collar.y))) throw new Error('衣领抓点必须在人物局部 0..1 范围')
    if (peek !== undefined && (!object(peek) || !fraction(peek.left) || !fraction(peek.right) || peek.left >= peek.right)) throw new Error('窥探裁切线必须有序且在 0..1 范围')
  }
  if (raw.joints !== undefined) {
    if (!object(raw.joints)) throw new Error('骨架抓点格式无效')
    for (const [key, point] of Object.entries(raw.joints)) if (!JOINTS.includes(key) || !object(point) || !fraction(point.x) || !fraction(point.y)) throw new Error(`骨架抓点 ${key} 无效`)
  }
  return raw as unknown as ActionProfile
}
export function createActionProfile(kind: CharacterKind, states?: Record<string, unknown>): ActionProfile {
  const profile: ActionProfile = { version: ACTION_PROFILE_VERSION, kind }
  if (kind === 'sprite') profile.states = Object.fromEntries(ACTION_SEMANTICS.filter(name => !states || Object.hasOwn(states, name)).map(name => [name, name]))
  if (kind === 'live2d') { profile.parameters = Object.fromEntries(LIVE2D_PARAMETERS.map(name => [name, name])); profile.motions = { wave: { group: 'TapBody', index: 0 } } }
  return profile
}
/** Exact bindings precede semantic fallbacks; never borrow another character's frame names. */
export function resolveActionState(states: Record<string, unknown>, requested: string, profile?: ActionProfile, fallback = 'idle'): string {
  const bound = profile?.states?.[requested as ActionSemantic]
  if (bound && Object.hasOwn(states, bound)) return bound
  return semanticState(states, requested, fallback)
}
export function profileBodyForState(state: string, profile?: ActionProfile): BodyAction | undefined {
  return BODY_ACTIONS.find(name => profile?.states?.[name] === state)
}
export function actionBindingReport(states: Record<string, unknown>, profile?: ActionProfile): Array<{ action: ActionSemantic; state: string; mode: 'bound' | 'fallback' | 'missing' }> {
  const base = Object.hasOwn(states, 'idle') ? 'idle' : Object.keys(states)[0] ?? 'idle'
  return ACTION_SEMANTICS.map(action => { const state = resolveActionState(states, action, profile, base); return { action, state, mode: Object.hasOwn(states, profile?.states?.[action] ?? action) ? 'bound' : Object.hasOwn(states, state) ? 'fallback' : 'missing' } })
}
