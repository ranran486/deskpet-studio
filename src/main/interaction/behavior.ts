import type { ActivityLevel, Rect } from '../../shared/types.js'

/**
 * 互动行为的**纯逻辑**：不 import electron、不碰窗口、随机源可注入。
 *
 * 为什么单独一层：漫游目标怎么挑、躲避方向怎么算、整点播报该不该响、待机露出多少 ——
 * 这些一旦写进 16ms 的窗口循环里就没法验证了。抽出来之后 tools/selftest.mjs 可以用
 * 固定随机源把这些行为逐条钉住（参数取自 Petra 的 ACTIVITY_LEVELS / 躲避 / 视线实现）。
 */

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** 三档活动频率（Petra ACTIVITY_LEVELS 的 low/mid/high） */
export const ACTIVITY_LEVELS: Record<ActivityLevel, { restBaseMs: number; restChance: number; radiusDiv: number; speed: number }> = {
  low: { restBaseMs: 600_000, restChance: 0.95, radiusDiv: 8, speed: 12 },
  mid: { restBaseMs: 8_000, restChance: 0.3, radiusDiv: 3.5, speed: 55 },
  high: { restBaseMs: 1_500, restChance: 0.05, radiusDiv: 2, speed: 120 },
}

export const AVOID_RADIUS = 165
export const AVOID_SPEED = 150
export const AVOID_TARGET = 260
export const AVOID_DURATION_MS = 1200
export const AVOID_REST_MS = 400
export const ARRIVE_EPSILON = 14
export const EDGE_PAD = 4
export const WANDER_STAGE = 700

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)

export function centerOf(pos: Point, size: Size): Point {
  return { x: pos.x + size.width / 2, y: pos.y + size.height / 2 }
}

/** 夹进工作区：宠物必须完整可见，且不压任务栏（workArea 已经排除任务栏） */
export function clampToWorkArea(pos: Point, size: Size, area: Rect, pad = EDGE_PAD): Point {
  const maxX = area.x + area.width - size.width - pad
  const maxY = area.y + area.height - size.height - pad
  return {
    x: Math.min(Math.max(pos.x, area.x + pad), Math.max(area.x + pad, maxX)),
    y: Math.min(Math.max(pos.y, area.y + pad), Math.max(area.y + pad, maxY)),
  }
}

/** 朝目标走一步；到达判定用 ARRIVE_EPSILON，避免在目标点附近抖动 */
export function stepToward(from: Point, to: Point, speed: number, dtMs: number): { pos: Point; arrived: boolean } {
  const d = distance(from, to)
  const step = (Math.max(0, speed) * Math.max(0, dtMs)) / 1000
  if (d <= ARRIVE_EPSILON || step >= d) return { pos: { x: to.x, y: to.y }, arrived: true }
  const k = step / d
  return { pos: { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k }, arrived: false }
}

/** 漫游半径：Petra 的 min(工作区宽-700, 高-700)/radiusDiv + 60 */
export function wanderRadius(area: Rect, level: ActivityLevel): number {
  const base = Math.min(area.width - WANDER_STAGE, area.height - WANDER_STAGE)
  return Math.max(60, base / ACTIVITY_LEVELS[level].radiusDiv + 60)
}

/**
 * 挑一个漫游目标：以当前位置为中心、半径 r 内的随机点，夹进工作区。
 * 半径按档位缩小（low 档几乎就在原地挪），并保证至少偏离 40px，否则看着像没动。
 */
export function nextWanderTarget(pos: Point, size: Size, area: Rect, level: ActivityLevel, rng: () => number = Math.random): Point {
  const center = centerOf(pos, size)
  const r = wanderRadius(area, level)
  const angle = rng() * Math.PI * 2
  const dist = 40 + rng() * Math.max(0, r - 40)
  const goal = { x: center.x + Math.cos(angle) * dist, y: center.y + Math.sin(angle) * dist }
  return clampToWorkArea({ x: goal.x - size.width / 2, y: goal.y - size.height / 2 }, size, area)
}

export function shouldFlee(cursor: Point, petCenter: Point, radius = AVOID_RADIUS): boolean {
  return distance(cursor, petCenter) < radius
}

/** 远离鼠标的单位向量；正好重合时返回 (0,0)（调用方应保持不动，别抖动） */
export function avoidDirection(cursor: Point, petCenter: Point): Point {
  const dx = petCenter.x - cursor.x
  const dy = petCenter.y - cursor.y
  const d = Math.hypot(dx, dy)
  if (d < 0.001) return { x: 0, y: 0 }
  return { x: dx / d, y: dy / d }
}

export function fleeTarget(petCenter: Point, cursor: Point, size: Size, area: Rect, target = AVOID_TARGET): Point {
  const dir = avoidDirection(cursor, petCenter)
  const goal = { x: petCenter.x + dir.x * target, y: petCenter.y + dir.y * target }
  return clampToWorkArea({ x: goal.x - size.width / 2, y: goal.y - size.height / 2 }, size, area)
}

/** 挡在屏幕边缘时把速度按法线衰减（Petra BOUNCE_DAMP=0.55），避免贴着边抖动 */
export function dampAtEdge(pos: Point, size: Size, area: Rect, velocity: Point, damp = 0.55): Point {
  const atLeft = pos.x <= area.x + EDGE_PAD + 1
  const atRight = pos.x + size.width >= area.x + area.width - EDGE_PAD - 1
  const atTop = pos.y <= area.y + EDGE_PAD + 1
  const atBottom = pos.y + size.height >= area.y + area.height - EDGE_PAD - 1
  return {
    x: atLeft || atRight ? velocity.x * damp : velocity.x,
    y: atTop || atBottom ? velocity.y * damp : velocity.y,
  }
}

/* ------------------------------------------------------------------ *
 * 整点播报（本地文案，零 token）
 * ------------------------------------------------------------------ */

export type DayPart = 'dawn' | 'morning' | 'noon' | 'afternoon' | 'evening' | 'night'

export function dayPartOf(hour: number): DayPart {
  if (hour >= 5 && hour < 8) return 'dawn'
  if (hour >= 8 && hour < 11) return 'morning'
  if (hour >= 11 && hour < 14) return 'noon'
  if (hour >= 14 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 23) return 'evening'
  return 'night'
}

export const CHIME_LINES: Record<DayPart, string[]> = {
  dawn: ['{h} 点了，天刚亮，你起得比太阳还早', '已经 {h} 点啦，早上好～'],
  morning: ['{h} 点整，上午的效率黄金档', '{h} 点了，喝口水再继续吧'],
  noon: ['{h} 点了，该吃饭了', '中午 {h} 点，别忘了午饭'],
  afternoon: ['{h} 点，下午茶时间？', '下午 {h} 点了，伸个懒腰吧'],
  evening: ['{h} 点了，天黑了，注意眼睛', '晚上 {h} 点，今天辛苦了'],
  night: ['{h} 点了，早点休息吧', '夜里 {h} 点，我陪你一会儿'],
}

/** 免打扰：23:00–07:59 不响 */
export function shouldChime(hour: number, quiet: boolean): boolean {
  if (!quiet) return true
  return hour >= 8 && hour < 23
}

export function chimeLine(hour: number, rng: () => number = Math.random): string {
  const pool = CHIME_LINES[dayPartOf(hour)]
  const line = pool[Math.floor(rng() * pool.length)] ?? pool[0]
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return line.replace('{h}', String(h12))
}

export function msUntilNextHour(now: number): number {
  const date = new Date(now)
  const next = new Date(date)
  next.setMinutes(60, 0, 0)
  return Math.max(1000, next.getTime() - now)
}
