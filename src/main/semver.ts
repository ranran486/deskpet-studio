/**
 * 极小 semver 区间判断，够用即可（不引依赖）。
 * 支持：`*` / `x` / `1.2.3` / `>=1.2.0` / `<2.0.0` / `^1.2.3` / `~1.2.3` / `1.2.x`
 * 组合：空格 = AND，`||` = OR。
 */
interface Parsed {
  major: number
  minor: number
  patch: number
  pre?: string
}

function parse(version: string): Parsed | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(version.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    pre: m[4],
  }
}

function cmp(a: Parsed, b: Parsed): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  // 有预发布号的小于没有的
  if (a.pre && !b.pre) return -1
  if (!a.pre && b.pre) return 1
  if (a.pre && b.pre) return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0
  return 0
}

function compareSingle(version: Parsed, expr: string): boolean {
  const raw = expr.trim()
  if (!raw || raw === '*' || raw === 'x' || raw === 'X') return true
  if (raw.includes('*') || /(^|\.)x($|\.)/i.test(raw)) {
    const nums = raw.split('.').map((p) => (/^[xX*]$/.test(p) ? null : Number(p)))
    if (nums[0] !== null && version.major !== nums[0]) return false
    if (nums[1] !== null && nums[1] !== undefined && version.minor !== nums[1]) return false
    if (nums[2] !== null && nums[2] !== undefined && version.patch !== nums[2]) return false
    return true
  }
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(raw)
  if (!m) return false
  const op = m[1] ?? '='
  const target = parse(m[2])
  if (!target) return false
  switch (op) {
    case '=':
      return cmp(version, target) === 0
    case '>':
      return cmp(version, target) > 0
    case '>=':
      return cmp(version, target) >= 0
    case '<':
      return cmp(version, target) < 0
    case '<=':
      return cmp(version, target) <= 0
    case '^': {
      if (cmp(version, target) < 0) return false
      const upper: Parsed = target.major > 0
        ? { major: target.major + 1, minor: 0, patch: 0 }
        : target.minor > 0
          ? { major: 0, minor: target.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: target.patch + 1 }
      return cmp(version, upper) < 0
    }
    case '~': {
      if (cmp(version, target) < 0) return false
      const upper: Parsed = { major: target.major, minor: target.minor + 1, patch: 0 }
      return cmp(version, upper) < 0
    }
    default:
      return false
  }
}

export function satisfies(version: string, range: string | undefined): boolean {
  if (!range || !range.trim()) return true
  const v = parse(version)
  if (!v) return false
  return range
    .split('||')
    .some((orPart) => orPart.trim().split(/\s+/).filter(Boolean).every((expr) => compareSingle(v, expr)))
}
