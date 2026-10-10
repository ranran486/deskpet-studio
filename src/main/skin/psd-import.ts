import { nativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { slugifyId } from './naming.js'
import { rigToDefinition, summarizeRig, type RiggerOutput } from './rig.js'
import type { ImportResult } from './import.js'
import { createActionProfile } from '../../shared/action-profile.js'

/**
 * 分层 PSD → 2.5D 角色（装配部分）。
 *
 * 两个外部件：
 *  - **ag-psd**（MIT）：解析 PSD。用 `useRawData` + `getLayerImageData`，**不碰 canvas / node-canvas**，
 *    所以在主进程里零原生依赖可用。它是**懒加载**的：没装 ag-psd 时框架其余部分照常工作，
 *    只有点「识别 PSD」/导入 PSD 时会给出"请先 npm install ag-psd"。
 *  - **Anime2.5DRig**（MIT，vendored 在 ./vendor/）：纯 typed-array 的装配内核
 *    （`cleanPsdLayers` 去噪+裁切、`buildRig` 出锚点与图层语义）。它是 CJS，用 createRequire 载入。
 *
 * 产物是标准皮肤包：`plugin.json`（`data.rig: skin.json`）+ `skin.json` + `layers/*.png`。
 */

/** 我们自己实现一遍文件头检查，避免与 import.ts 形成循环依赖 */
export function isPsdFile(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(4)
    fs.readSync(fd, head, 0, 4, 0)
    fs.closeSync(fd)
    return head.toString('ascii') === '8BPS'
  } catch {
    return false
  }
}

interface PixelData {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyRecord = Record<string, any>

const requireVendor = createRequire(import.meta.url)

async function loadAgPsd(): Promise<AnyRecord> {
  try {
    const agPsd = await import('ag-psd')
    // useRawData 的延迟解码依然会调用 createImageData；提供 typed-array 工厂以免落到 canvas。
    agPsd.initializeCanvas(
      () => { throw new Error('PSD 导入使用原始像素数据，不创建 DOM canvas') },
      (width, height) => ({ width, height, colorSpace: 'srgb', data: new Uint8ClampedArray(width * height * 4) }),
    )
    return agPsd as unknown as AnyRecord
  } catch {
    throw new Error(
      '缺少 ag-psd 依赖：在项目目录执行 `npm install ag-psd` 之后再导入 PSD。' +
        '它只影响 PSD 导入；框架其余部分（动画 / 聊天 / 插件 / 帧序列导入）不依赖它。',
    )
  }
}

function loadRigger(): AnyRecord {
  return requireVendor('./vendor/rigger.cjs') as AnyRecord
}

function loadGenericParts(): Record<string, unknown> | null {
  try {
    const parts = requireVendor('./vendor/genericparts.cjs') as { get?: (key: string) => unknown }
    if (!parts?.get) return null
    return { eyeL: parts.get('eyeL'), eyeR: parts.get('eyeR'), mouth: parts.get('mouth') }
  } catch {
    return null
  }
}

/** ag-psd 的原始图层数据 → 每层挂上 imageData（rigger 需要这个字段） */
function attachLayerImages(agPsd: AnyRecord, psd: AnyRecord): number {
  const getImage = agPsd.getLayerImageData as ((layer: unknown) => PixelData | undefined) | undefined
  let attached = 0
  const walk = (nodes: AnyRecord[] | undefined): void => {
    for (const node of nodes ?? []) {
      if (Array.isArray(node.children) && node.children.length) {
        walk(node.children)
        continue
      }
      if (!node.imageData && getImage) {
        try {
          const image = getImage(node)
          if (image) {
            node.imageData = image
            attached += 1
          }
        } catch {
          // 单层解码失败不该拖垮整次导入
        }
      }
      if (node.imageDataRaw) delete node.imageDataRaw
    }
  }
  walk(psd.children)
  return attached
}

/** RGBA → PNG：nativeImage 的位图是 BGRA，所以要换通道 */
function rgbaToPng(image: PixelData): Buffer {
  const { width, height, data } = image
  const bgra = Buffer.allocUnsafe(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    const s = i * 4
    bgra[s] = data[s + 2]
    bgra[s + 1] = data[s + 1]
    bgra[s + 2] = data[s]
    bgra[s + 3] = data[s + 3]
  }
  const img = nativeImage.createFromBitmap(bgra, { width, height })
  if (img.isEmpty()) throw new Error(`图层 PNG 编码失败（${width}×${height}）`)
  return img.toPNG()
}

export async function importPsd(file: string, destRoot: string, displayName?: string): Promise<ImportResult> {
  const warnings: string[] = []
  if (!fs.existsSync(file)) return { ok: false, warnings, error: `文件不存在：${file}` }
  if (!isPsdFile(file)) return { ok: false, warnings, error: '不是有效的 PSD（文件头不是 8BPS）', detected: 'unknown' }

  const sizeMb = fs.statSync(file).size / 1048576
  if (sizeMb > 60) warnings.push(`文件较大（${sizeMb.toFixed(0)}MB），解析期间界面会短暂无响应`)

  let agPsd: AnyRecord
  try {
    agPsd = await loadAgPsd()
  } catch (err) {
    return { ok: false, warnings, detected: 'psd', error: (err as Error).message }
  }

  let Rigger: AnyRecord
  try {
    Rigger = loadRigger()
  } catch (err) {
    return {
      ok: false,
      warnings,
      detected: 'psd',
      error: `装配内核缺失（应为 dist/main/skin/vendor/rigger.cjs）：${(err as Error).message}`,
    }
  }

  const generic = loadGenericParts()
  if (!generic) warnings.push('通用闭合眼/嘴素材缺失：PSD 里若没有 eye_close / mouth_close，闭合动作会缺一张图')

  let psd: AnyRecord
  try {
    psd = agPsd.readPsd(fs.readFileSync(file), { useRawData: true, skipThumbnail: true, skipCompositeImageData: true }) as AnyRecord
  } catch (err) {
    return { ok: false, warnings, detected: 'psd', error: `PSD 解析失败：${(err as Error).message}` }
  }

  const attached = attachLayerImages(agPsd, psd)
  if (!attached && !psd.children?.length) {
    return {
      ok: false,
      warnings,
      detected: 'psd',
      error: '这个 PSD 里没有可用图层（可能是拼合图）。2.5D 装配需要分层 PSD：脸 / 眼白 / 瞳孔 / 嘴 / 前发 / 后发 / 身体…',
    }
  }

  try {
    Rigger.cleanPsdLayers(psd)
  } catch (err) {
    warnings.push(`图层清理跳过：${(err as Error).message}`)
  }

  let rig: RiggerOutput
  try {
    rig = Rigger.buildRig(psd, generic ? { generic } : {}) as RiggerOutput
  } catch (err) {
    return {
      ok: false,
      warnings,
      detected: 'psd',
      error: `PSD 装配失败（图层结构可能异常）：${(err as Error).message}`,
    }
  }

  const base = displayName ?? path.basename(file).replace(/\.[^.]+$/, '')
  const id = `user.${slugifyId(base)}`
  const dir = path.join(destRoot, id)
  if (fs.existsSync(dir)) return { ok: false, warnings, detected: 'psd', error: `目标已存在：${id}（换个文件名或先删除旧包）` }

  const conversion = rigToDefinition(rig, {
    kind: 'psd',
    file: path.basename(file),
    sizeMb: Number(sizeMb.toFixed(1)),
    importedAt: new Date().toISOString(),
  })
  const summary = summarizeRig(conversion.definition)
  if (!summary.layers) {
    return { ok: false, warnings, detected: 'psd', error: '装配后没有任何图层（图层名可能完全无法识别）' }
  }

  fs.mkdirSync(path.join(dir, 'layers'), { recursive: true })
  for (const image of conversion.images) {
    fs.writeFileSync(path.join(dir, image.png), rgbaToPng(image))
  }
  fs.writeFileSync(path.join(dir, 'skin.json'), JSON.stringify(conversion.definition, null, 2), 'utf8')
  fs.writeFileSync(path.join(dir, 'action-profile.json'), JSON.stringify(createActionProfile('rig'), null, 2))
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify(
      {
        manifestVersion: 1,
        id,
        name: base,
        version: '1.0.0',
        description: `分层 PSD 自动装配的 2.5D 角色（${summary.layers} 层：头 ${summary.headLayers} / 身 ${summary.bodyLayers}${summary.hasEyes ? '，含眨眼' : ''}${summary.hasMouth ? '，含口型' : ''}）`,
        author: 'imported',
        kind: 'skin',
        runtime: 'data',
        engine: { deskpet: '>=0.1.0 <1.0.0' },
        data: { rig: 'skin.json', actionProfile: 'action-profile.json' },
        scale: Math.min(1, 240 / conversion.definition.canvas.w, 300 / conversion.definition.canvas.h),
        provides: { states: ['idle'] },
        imported: { at: new Date().toISOString(), source: path.basename(file), layers: summary.layers },
      },
      null,
      2,
    ),
    'utf8',
  )

  warnings.push(...conversion.definition.warnings)
  if (!summary.hasEyes) warnings.push('没识别到眼睛图层（建议命名为 eyewhite_L/R + irides_L/R），眨眼会不明显')
  if (!summary.hasMouth) warnings.push('没识别到嘴部图层（mouth_open / mouth_close），说话时嘴不会动')

  return {
    ok: true,
    pluginId: id,
    dir,
    name: base,
    format: 'psd-rig',
    frames: summary.layers,
    layers: summary.layers,
    rig: summary,
    states: [{ name: 'idle', frames: summary.layers, fps: 0 }],
    warnings,
    detected: 'psd',
  }
}
