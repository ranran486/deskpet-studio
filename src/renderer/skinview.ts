import type { ResolvedSkin, States } from '../shared/types.js'
import type { BehaviorSignal, PetGeometry } from '../shared/action-model.js'
import type { PetExpression } from '../shared/pet-life.js'

/**
 * 皮肤视图的统一接口：精灵图、2.5D 装配与 Live2D 共用。
 *
 * 这样桌宠主逻辑（命中判定、拖动、说话、动作）不需要知道背后是哪种外形——
 * SpritePlayer 结构上已经满足它，RiggedView 照它实现即可。
 */
export interface SkinView {
  readonly ready: boolean
  readonly state: string
  load(skin: ResolvedSkin, states: States | null, scale: number): Promise<void>
  start(): void
  stop(): void
  dispose?(): void
  bounds(): DOMRect
  /** 返回该点的 alpha（0~255），用于"点得到猫身上、点不到透明区" */
  alphaAt(clientX: number, clientY: number): number
  react(state: string, durationMs?: number): void
  talk(on: boolean): void
  drag(on: boolean): void
  resetToBase(): void
  /** 视线跟随输入（已归一化到 ±1）；精灵图外形忽略了它也没关系 */
  setLook?(x: number, y: number): void
  setBehavior(signal: BehaviorSignal): void
  geometry(): PetGeometry
  expression?(emotion: PetExpression, action?: 'wave' | 'nod' | 'tilt', durationMs?: number): void
}
