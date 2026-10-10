import { ACTION_TIMING } from './action-model.js'
/** Shared gameplay protocol; artwork adapters may gracefully fall back when bindings are missing. */
export const PET_EXPRESSIONS = ['shy', 'happy', 'surprised', 'angry', 'sleepy', 'dizzy', 'love', 'unimpressed'] as const
export type PetExpression = typeof PET_EXPRESSIONS[number] | 'neutral' | 'sad'
export const FOODS = [
  { id: 'fish', name: '小鱼干', icon: '🐟' },
  { id: 'cake', name: '小蛋糕', icon: '🍰' },
  { id: 'candy', name: '棒棒糖', icon: '🍭' },
  { id: 'dango', name: '团子', icon: '🍡' },
  { id: 'diamond', name: '钻石', icon: '💎' },
] as const
export type FoodId = typeof FOODS[number]['id']
export type PetInteraction = 'touch' | 'pat' | 'rub' | 'tickle' | 'feed' | 'praise' | 'tease' | 'wake' | 'drag' | 'open-feed'
export interface PetLifeState { mood: number; lastFood: FoodId | null; sameFoodCount: number }
export interface PetLifeSnapshot extends PetLifeState { dozing: boolean; expression: PetExpression; effect: 'hearts' | 'laugh' | 'zzz' | 'stars' | null; durationMs: number }
export interface PetDecision extends PetLifeSnapshot { group: string; food?: string }
export const SLEEP_AFTER_MS = ACTION_TIMING.sleepAfterMs
export function isFoodId(value: unknown): value is FoodId { return FOODS.some(food => food.id === value) }
const mood = (value: number): number => Math.max(0, Math.min(100, Number.isFinite(value) ? Math.round(value) : 65))

export class PetLifeEngine {
  state: PetLifeState
  lastActivity: number
  dozing = false
  private expression: PetExpression = 'neutral'
  private effect: PetLifeSnapshot['effect'] = null
  private durationMs = 3000
  constructor(saved: Partial<PetLifeState> = {}, now = Date.now()) {
    const record = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
    this.state = { mood: mood(record.mood ?? 65), lastFood: isFoodId(record.lastFood) ? record.lastFood : null, sameFoodCount: Math.max(0, Math.min(99, Number.isFinite(record.sameFoodCount) ? Math.floor(record.sameFoodCount!) : 0)) }
    this.lastActivity = now
  }
  snapshot(): PetLifeSnapshot { return { ...this.state, dozing: this.dozing, expression: this.expression, effect: this.effect, durationMs: this.durationMs } }
  private decide(group: string, expression: PetExpression, delta = 0, effect: PetLifeSnapshot['effect'] = null, durationMs = 3000): PetDecision {
    this.state.mood = mood(this.state.mood + delta); this.expression = expression; this.effect = effect; this.durationMs = durationMs
    return { ...this.snapshot(), group }
  }
  interact(kind: PetInteraction, now = Date.now(), foodId?: FoodId): PetDecision | null {
    this.lastActivity = now
    if (this.dozing) { this.dozing = false; return this.decide('wake', 'surprised', 0, 'stars', 1400) }
    switch (kind) {
      case 'touch': case 'open-feed': case 'wake': return null
      case 'pat': return this.decide(this.state.mood >= 75 ? 'pat_high' : 'pat', this.state.mood < 30 ? 'unimpressed' : 'happy', 2)
      case 'rub': return this.decide('rub', 'shy', 5, 'hearts')
      case 'tickle': return this.decide('tickle', 'happy', 4, 'laugh')
      case 'praise': return this.decide('praise', this.state.mood >= 75 ? 'love' : 'shy', 7, 'hearts')
      case 'tease': return this.decide('tease', this.state.mood < 35 ? 'unimpressed' : 'angry', -8)
      case 'drag': return this.decide('drag', 'dizzy', -1, 'stars', 2400)
      case 'feed': {
        if (!isFoodId(foodId)) return null
        this.state.sameFoodCount = this.state.lastFood === foodId ? Math.min(99, this.state.sameFoodCount + 1) : 1
        this.state.lastFood = foodId
        const repeated = this.state.sameFoodCount >= 3
        const decision = this.decide(repeated ? 'feed_repeat' : `feed_${foodId}`, repeated ? 'unimpressed' : foodId === 'diamond' ? 'surprised' : 'love', repeated ? -4 : 7, repeated ? null : foodId === 'diamond' ? 'stars' : 'hearts')
        decision.food = FOODS.find(food => food.id === foodId)!.name
        return decision
      }
    }
  }
  tick(now = Date.now(), paused = false, sleepAfterMs: number = SLEEP_AFTER_MS): PetDecision | null {
    if (paused || this.dozing || now - this.lastActivity < sleepAfterMs) return null
    this.dozing = true
    return this.decide('sleep', 'sleepy', 0, 'zzz', 24 * 60 * 60 * 1000)
  }
  idle(): PetDecision { return this.decide(this.state.mood >= 75 ? 'idle_high' : this.state.mood < 35 ? 'idle_low' : 'idle', this.state.mood >= 75 ? 'love' : this.state.mood < 35 ? 'unimpressed' : 'neutral') }
  settle(): void { this.expression = 'neutral'; this.effect = null; this.durationMs = 3000 }
}
