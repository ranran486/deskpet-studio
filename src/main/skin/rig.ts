/**
 * 把 Anime2.5DRig 的装配结果转成**可序列化的皮肤包描述**。
 *
 * 这一层刻意是纯函数（不 import electron、不碰文件系统）：rigger 的输出是普通对象 +
 * typed-array，转成 skin.json + 待写出的 PNG 列表这件事可以被 Node 单测直接验证。
 * 真正落盘与 PNG 编码在 psd-import.ts 里做。
 */

/** 我们从 Anime2.5DRig 的输出里读取的字段（该内核是无类型的 vendored CJS） */
export interface RiggerLayer {
  name: string
  img?: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }
  imageData?: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }
  left: number
  top: number
  right: number
  bottom: number
  w?: number
  h?: number
  z: number
  depth: number
  group: 'head' | 'body'
  phys: string | null
  fade: string | null
  side: 'L' | 'R' | null
  strands: unknown[] | null
  synthetic?: boolean
  unknown?: boolean
}

export interface RiggerAnchors {
  face: { cx: number; cy: number; x0: number; x1: number; y0: number; y1: number }
  eyeL?: { x0: number; x1: number; y0: number; y1: number; icx: number; icy: number; closeY: number }
  eyeR?: { x0: number; x1: number; y0: number; y1: number; icx: number; icy: number; closeY: number }
  mouth?: { x0: number; x1: number; y0: number; y1: number; cx: number; cy: number }
  neckPivot: { cx: number; cy: number }
  neckTop: number
  neckBottom: number
  bodyPivot: { cx: number; cy: number }
  faceScale: number
  hairRootY: number
}

export interface RiggerOutput {
  canvas: { w: number; h: number }
  layers: RiggerLayer[]
  anchors: RiggerAnchors
  warnings?: string[]
  synth?: { eye?: boolean; mouth?: boolean }
}

export interface RigLayer {
  name: string
  /** 图层在画布里的矩形（rigger 已经裁到内容 bbox） */
  x: number
  y: number
  w: number
  h: number
  z: number
  /** 视差深度：1.0 是脸，越小越靠后、越大越靠前 */
  depth: number
  group: 'head' | 'body'
  phys: string | null
  /** 交叉淡入通道：eyeOpen/eyeClose/mouthOpen/mouthClose */
  fade: string | null
  side: 'L' | 'R' | null
  /** 包内相对路径 */
  png: string
  strands: unknown[] | null
  synthetic?: boolean
  unknown?: boolean
}

/** 渲染层用的可调参数（Petra 的 getAdjustableParams 字段子集，先给一组稳妥默认值） */
export interface RigParams {
  physAmp: number
  soft: number
  fhAmp: number
  fhSoft: number
  eyeEase: number
  mouthEase: number
  irisScale: number
  breathPeriodMs: number
  blinkMinMs: number
  blinkMaxMs: number
  doubleBlinkChance: number
}

export const DEFAULT_RIG_PARAMS: RigParams = {
  physAmp: 2,
  soft: 2,
  fhAmp: 2,
  fhSoft: 0.4,
  eyeEase: 0.3,
  mouthEase: 0.45,
  irisScale: 1,
  // 以下三个来自 Petra 实测值：呼吸 3.4s；眨眼 1600+rand*3800ms；18% 概率双眨
  breathPeriodMs: 3400,
  blinkMinMs: 1600,
  blinkMaxMs: 3800,
  doubleBlinkChance: 0.18,
}

export interface RigDefinition {
  format: 'psd-rig/1'
  canvas: { w: number; h: number }
  anchors: RiggerAnchors
  params: RigParams
  layers: RigLayer[]
  warnings: string[]
  source?: Record<string, unknown>
}

/** 文件名安全化：图层名可能含中日文与空格 */
export function safeLayerName(name: string, index: number): string {
  const base = name
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${String(index).padStart(2, '0')}-${base || 'layer'}`
}

export interface RigConversion {
  definition: RigDefinition
  /** 待写出的图层 PNG（顺序与 definition.layers 一致） */
  images: Array<{ png: string; width: number; height: number; data: Uint8ClampedArray | Uint8Array }>
}

/**
 * rigger 输出 → 皮肤包描述。
 * 图层按 z 排序（z 已经是绘制顺序），每层裁到自己的 bbox，PNG 走 layers/ 子目录。
 */
export function rigToDefinition(rig: RiggerOutput, source?: Record<string, unknown>): RigConversion {
  const warnings = [...(rig.warnings ?? [])]
  const layers: RigLayer[] = []
  const images: RigConversion['images'] = []

  const sorted = [...rig.layers].sort((a, b) => a.z - b.z)
  sorted.forEach((layer, index) => {
    const img = layer.img ?? layer.imageData
    if (!img || !img.width || !img.height) {
      warnings.push(`图层「${layer.name}」没有像素数据，已跳过`)
      return
    }
    const png = `layers/${safeLayerName(layer.name, index)}.png`
    layers.push({
      name: layer.name,
      x: Math.round(layer.left),
      y: Math.round(layer.top),
      w: Math.round(img.width),
      h: Math.round(img.height),
      z: index,
      depth: layer.depth ?? 1,
      group: layer.group === 'body' ? 'body' : 'head',
      phys: layer.phys ?? null,
      fade: layer.fade ?? null,
      side: layer.side ?? null,
      png,
      strands: layer.strands ?? null,
      ...(layer.synthetic ? { synthetic: true } : {}),
      ...(layer.unknown ? { unknown: true } : {}),
    })
    images.push({ png, width: img.width, height: img.height, data: img.data })
  })

  if (!layers.length) warnings.push('没有任何可用图层')

  return {
    definition: {
      format: 'psd-rig/1',
      canvas: { w: rig.canvas.w, h: rig.canvas.h },
      anchors: rig.anchors,
      params: { ...DEFAULT_RIG_PARAMS },
      layers,
      warnings,
      ...(source ? { source } : {}),
    },
    images,
  }
}

/** 统计一下装配结果，用于导入结果提示与自检断言 */
export function summarizeRig(def: RigDefinition): { layers: number; headLayers: number; bodyLayers: number; fades: string[]; hasEyes: boolean; hasMouth: boolean } {
  const fades = [...new Set(def.layers.map((l) => l.fade).filter((f): f is string => !!f))]
  return {
    layers: def.layers.length,
    headLayers: def.layers.filter((l) => l.group === 'head').length,
    bodyLayers: def.layers.filter((l) => l.group === 'body').length,
    fades,
    hasEyes: fades.includes('eyeOpen') || fades.includes('eyeClose'),
    hasMouth: fades.includes('mouthOpen') || fades.includes('mouthClose'),
  }
}
