/**
 * 导入器的命名规则（**纯函数、不 import electron**）。
 *
 * 单独拆出来的原因：这些规则决定了"用户的素材怎么变成状态"，是最容易出错也最该被单测钉住
 * 的部分；而 import.ts 需要在主进程里用 nativeImage 解码图片，没法在 Node 里 import。
 */

/** state 名归一化：中文与常见别名映射到框架认识的规范名 */
export const STATE_ALIASES: Record<string, string> = {
  待机: 'idle',
  闲置: 'idle',
  呼吸: 'idle',
  idle: 'idle',
  拖拽: 'drag',
  被拖: 'drag',
  drag: 'drag',
  说话: 'talk',
  聊天: 'talk',
  talk: 'talk',
  挥手: 'wave',
  wave: 'wave',
  开心: 'happy',
  happy: 'happy',
  睡觉: 'sleep',
  sleep: 'sleep',
  呼噜: 'purr',
  purr: 'purr',
}

export function normalizeStateName(raw: string): string {
  const key = raw.trim()
  const alias = STATE_ALIASES[key] ?? STATE_ALIASES[key.toLowerCase()]
  if (alias) return alias
  return (
    key
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'state'
  )
}

/** 自然序：frame_2 排在 frame_10 前面 */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g
  const ax = a.toLowerCase().match(re) ?? []
  const bx = b.toLowerCase().match(re) ?? []
  for (let i = 0; i < Math.max(ax.length, bx.length); i += 1) {
    const av = ax[i]
    const bv = bx[i]
    if (av === undefined) return -1
    if (bv === undefined) return 1
    const an = Number(av)
    const bn = Number(bv)
    if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) return an - bn
    if (av !== bv) return av < bv ? -1 : 1
  }
  return 0
}

/** 从文件名推状态名与序号：`idle_03.png` → { state: 'idle', index: 3 }；无序号 → 整名做状态 */
export function splitFrameName(baseName: string): { state: string; index: number | null } {
  const stem = baseName.replace(/\.[^.]+$/, '')
  const m = /^(.*?)[\s_-]*(\d+)$/.exec(stem)
  if (!m || !m[1].trim()) return { state: normalizeStateName(stem), index: null }
  return { state: normalizeStateName(m[1]), index: Number(m[2]) }
}

/** 目录名 → 插件 id 片段：非 ASCII 一律退化成时间戳，避免中文目录名生不出合法 id */
export function slugifyId(raw: string): string {
  const ascii = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const id = ascii.length >= 2 ? ascii : `skin-${Date.now().toString(36)}`
  return id.slice(0, 48)
}
