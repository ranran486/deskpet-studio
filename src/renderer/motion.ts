import type { SpriteMotion } from '../shared/types.js'

export interface MotionTransform { x: number; y: number; angle: number; sx: number; sy: number }

/** 以脚底为锚的轻量动画。数值有界；高精度美术可以直接换成帧序列，无需改宿主。 */
export function sampleMotion(motion: SpriteMotion | undefined, timeMs: number): MotionTransform {
  const out = { x: 0, y: 0, angle: 0, sx: 1, sy: 1 }
  if (!motion) return out
  const strength = Number.isFinite(motion.strength) ? Math.min(2, Math.max(0, motion.strength!)) : 1
  const period = Number.isFinite(motion.periodMs) ? Math.max(400, motion.periodMs!) : 3400
  const wave = Math.sin((timeMs % period) / period * Math.PI * 2) * strength
  switch (motion.preset) {
    case 'breathe': out.sy += wave * 0.008; out.sx -= wave * 0.003; break
    case 'sway': out.angle = wave * 0.035; out.sy += wave * 0.004; break
    case 'bounce': out.y = -Math.abs(wave) * 0.018; out.sy -= Math.abs(wave) * 0.009; break
    case 'sleep': out.sy += wave * 0.005; break
  }
  return out
}
