import { nativeImage } from 'electron'
import { naturalCompare, normalizeStateName, slugifyId, splitFrameName } from './naming.js'
import fs from 'node:fs'
import path from 'node:path'
import { importLive2D } from './live2d-import.js'
import { createActionProfile } from '../../shared/action-profile.js'

/**
 * 人物模型导入：把用户手里的素材装成标准的皮肤插件包。
 *
 * 设计原则：
 *  1. **零新依赖** —— 图片解码与合成全部用 Electron 自带的 `nativeImage`
 *     （createFromPath → toBitmap(BGRA) → 手工拼版 → createFromBitmap → toPNG），
 *     所以这里不需要 sharp / canvas / pngjs。
 *  2. **产物就是普通插件包** —— 导入完成后落盘的是 `plugin.json + spritesheet.png +
 *     atlas.json + states.json`，和手写的皮肤包完全一致；渲染层、插件系统一行都不用改。
 *  3. **识别优先于报错** —— PSD / Live2D 这类暂时不能装的，也要明确告诉用户"认出来了、
 *     为什么还不能用"，而不是丢一句"格式不支持"。
 */

export type ImportKind = 'auto' | 'frames' | 'sheet' | 'image'

export interface ImportedState {
  name: string
  frames: number
  fps: number
}

export interface ImportResult {
  ok: boolean
  /** 装出来的插件 id（ok 时一定有） */
  pluginId?: string
  dir?: string
  name?: string
  format?: string
  frames?: number
  states?: ImportedState[]
  /** PSD 装配的图层数 */
  layers?: number
  /** PSD 装配摘要（图层分组、是否有眨眼/口型通道） */
  rig?: Record<string, unknown>
  /** 需要用户知道的事情：重命名、补齐的状态、被忽略的文件… */
  warnings: string[]
  /** ok=false 时说清原因（含"识别到了但还不支持"） */
  error?: string
  /** 识别到的格式（即使不支持） */
  detected?: string
}

const IMAGE_EXT = new Set(['.png', '.webp', '.jpg', '.jpeg', '.bmp', '.gif', '.apng'])

// 命名规则（纯函数）拆在 ./naming.ts，Node 单测可直接验证；这里再导出保持模块对外形态不变
export { naturalCompare, normalizeStateName, slugifyId, splitFrameName } from './naming.js'

/* ------------------------------------------------------------------ *
 * 位图搬运（BGRA，Electron 原生格式）
 * ------------------------------------------------------------------ */

interface Bitmap {
  width: number
  height: number
  data: Buffer
}

function loadBitmap(file: string): Bitmap {
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) throw new Error(`无法解码图片：${path.basename(file)}`)
  const { width, height } = img.getSize()
  if (width <= 0 || height <= 0) throw new Error(`图片尺寸异常：${path.basename(file)}`)
  return { width, height, data: img.toBitmap() }
}

function blit(dst: Bitmap, src: Bitmap, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y += 1) {
    const targetY = dy + y
    if (targetY < 0 || targetY >= dst.height) continue
    const s = y * src.width * 4
    const d = (targetY * dst.width + dx) * 4
    src.data.copy(dst.data, d, s, s + src.width * 4)
  }
}

/** 把一组图拼成一张横向精灵图：统一单元格尺寸，帧在单元格内底部居中（脚底对齐） */
export function composeSheet(frames: Bitmap[]): { sheet: Bitmap; cell: { w: number; h: number }; rects: Array<{ x: number; y: number; w: number; h: number }> } {
  if (!frames.length) throw new Error('没有可用的帧')
  const cellW = Math.max(...frames.map((f) => f.width))
  const cellH = Math.max(...frames.map((f) => f.height))
  const sheet: Bitmap = { width: cellW * frames.length, height: cellH, data: Buffer.alloc(cellW * frames.length * cellH * 4) }
  const rects = frames.map((f, i) => {
    const dx = i * cellW + Math.floor((cellW - f.width) / 2)
    const dy = cellH - f.height
    blit(sheet, f, dx, dy)
    return { x: i * cellW, y: 0, w: cellW, h: cellH }
  })
  return { sheet, cell: { w: cellW, h: cellH }, rects }
}

function sheetToPng(sheet: Bitmap): Buffer {
  return nativeImage.createFromBitmap(sheet.data, { width: sheet.width, height: sheet.height }).toPNG()
}

/* ------------------------------------------------------------------ *
 * 插件包写出
 * ------------------------------------------------------------------ */

interface AtlasOut {
  frames: Record<string, { x: number; y: number; w: number; h: number }>
  meta: { size: { w: number; h: number }; frameSize: { w: number; h: number }; generatedBy: string }
}

interface ClipOut {
  frames: string[]
  weight?: number
}

interface StateOut {
  fps?: number
  loop?: boolean
  next?: string
  clips: ClipOut[]
}

interface StatesOut {
  default: string
  drag?: string
  talk?: string
  states: Record<string, StateOut>
}

interface WriteOptions {
  destRoot: string
  id: string
  displayName: string
  description: string
  sheet: Bitmap
  atlas: AtlasOut
  states: StatesOut
  /** 额外来源信息（写进 plugin.json 便于排查） */
  source?: Record<string, unknown>
}

function writePackage(opts: WriteOptions): { dir: string } {
  const dir = path.join(opts.destRoot, opts.id)
  if (fs.existsSync(dir)) throw new Error(`目标已存在：${opts.id}（换个名字或先删除旧包）`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'spritesheet.png'), sheetToPng(opts.sheet))
  fs.writeFileSync(path.join(dir, 'atlas.json'), JSON.stringify(opts.atlas, null, 2), 'utf8')
  fs.writeFileSync(path.join(dir, 'states.json'), JSON.stringify(opts.states, null, 2), 'utf8')
  fs.writeFileSync(path.join(dir, 'action-profile.json'), JSON.stringify(createActionProfile('sprite', opts.states.states), null, 2))
  const first = Object.values(opts.atlas.frames)[0]
  if (first) {
    const preview = nativeImage.createFromBuffer(sheetToPng(opts.sheet)).crop({ x: first.x, y: first.y, width: first.w, height: first.h })
    fs.writeFileSync(path.join(dir, 'preview.png'), preview.toPNG())
  }
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify(
      {
        manifestVersion: 1,
        id: opts.id,
        name: opts.displayName,
        version: '1.0.0',
        description: opts.description,
        author: 'imported',
        kind: 'skin',
        runtime: 'data',
        engine: { deskpet: '>=0.1.0 <1.0.0' },
        icon: first ? 'preview.png' : undefined,
        scale: first ? Math.min(1, 240 / first.w, 300 / first.h) : 1,
        data: { spritesheet: 'spritesheet.png', atlas: 'atlas.json', states: 'states.json', actionProfile: 'action-profile.json' },
        provides: { states: Object.keys(opts.states.states) },
        imported: { at: new Date().toISOString(), ...(opts.source ?? {}) },
      },
      null,
      2,
    ),
    'utf8',
  )
  return { dir }
}

/** 由"状态 → 帧文件列表"生成 atlas/states */
function buildPackage(
  groups: Array<{ state: string; files: string[] }>,
  destRoot: string,
  id: string,
  displayName: string,
  description: string,
  source: Record<string, unknown>,
  warnings: string[],
): ImportResult {
  const loaded: Array<{ state: string; bitmap: Bitmap }> = []
  for (const group of groups) {
    for (const file of group.files) loaded.push({ state: group.state, bitmap: loadBitmap(file) })
  }
  if (!loaded.length) return { ok: false, warnings, error: '没有可用的图片帧' }

  const { sheet, cell, rects } = composeSheet(loaded.map((l) => l.bitmap))
  const atlas: AtlasOut = { frames: {}, meta: { size: { w: sheet.width, h: sheet.height }, frameSize: { w: cell.w, h: cell.h }, generatedBy: 'deskpet/import' } }
  const states: StatesOut = { default: 'idle', states: {} }

  let cursor = 0
  for (const group of groups) {
    const names: string[] = []
    for (let i = 0; i < group.files.length; i += 1) {
      const frameName = `${group.state}_${i}`
      const rect = rects[cursor]
      cursor += 1
      atlas.frames[frameName] = { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
      names.push(frameName)
    }
    if (!names.length) continue
    states.states[group.state] = {
      fps: 8,
      loop: group.state === 'idle' || group.state === 'talk',
      next: group.state === 'idle' || group.state === 'talk' ? undefined : 'idle',
      clips: [{ frames: names }],
    }
  }

  const stateNames = Object.keys(states.states)
  if (!stateNames.includes('idle')) {
    // 没有 idle 就当不了待机底座：拿帧数最多的那个状态复制一份
    const biggest = stateNames.sort((a, b) => (states.states[b].clips[0].frames.length - states.states[a].clips[0].frames.length))[0]
    if (biggest) {
      states.states.idle = { fps: 6, loop: true, clips: [{ frames: [...states.states[biggest].clips[0].frames] }] }
      warnings.push(`没有 idle 状态，已用「${biggest}」复制出一份待机`)
    }
  }
  if (stateNames.includes('talk')) states.talk = 'talk'
  if (stateNames.includes('drag')) states.drag = 'drag'
  states.default = 'idle'

  const { dir } = writePackage({ destRoot, id, displayName, description, sheet, atlas, states, source })
  return {
    ok: true,
    pluginId: id,
    dir,
    name: displayName,
    format: 'frames',
    frames: loaded.length,
    states: groups.map((g) => ({ name: g.state, frames: g.files.length, fps: 8 })),
    warnings,
    detected: 'frames',
  }
}

/* ------------------------------------------------------------------ *
 * 各类导入入口
 * ------------------------------------------------------------------ */

/** 帧序列文件夹：按文件名前缀分组，每个前缀是一个状态 */
export function importFrameSequence(srcDir: string, destRoot: string, displayName?: string): ImportResult {
  const warnings: string[] = []
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    return { ok: false, warnings, error: `不是一个文件夹：${srcDir}` }
  }
  const entries = fs
    .readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort(naturalCompare)

  if (!entries.length) return { ok: false, warnings, error: '文件夹里没有图片（支持 png / webp / jpg / bmp / gif）' }

  const psd = fs.readdirSync(srcDir).filter((n) => n.toLowerCase().endsWith('.psd'))
  if (psd.length) warnings.push(`同目录还有 ${psd.length} 个 PSD，本次按帧序列导入（PSD 装配在下一版）`)
  const live2d = fs.readdirSync(srcDir).filter((n) => n.toLowerCase().endsWith('.model3.json'))
  if (live2d.length) warnings.push(`检测到 Live2D 模型 ${live2d[0]}，本次按帧序列导入；也可以选择「导入 Live2D」`)

  const map = new Map<string, string[]>()
  for (const name of entries) {
    const { state } = splitFrameName(name)
    const list = map.get(state) ?? []
    list.push(path.join(srcDir, name))
    map.set(state, list)
  }
  const groups = [...map.entries()].map(([state, files]) => ({ state, files }))
  if (groups.length === 1 && groups[0].state !== 'idle') {
    warnings.push(`所有帧都归到了「${groups[0].state}」；若想分状态，用 idle_0.png / wave_0.png 这样的前缀命名`)
  }
  const base = displayName ?? path.basename(srcDir)
  return buildPackage(groups, destRoot, `user.${slugifyId(base)}`, base, `导入的帧序列（${entries.length} 帧 / ${groups.length} 组）`, { kind: 'frames', source: srcDir }, warnings)
}

/** 单张图片（GIF / APNG / PNG）：装成只有一个状态的皮肤 */
export function importStaticImage(file: string, destRoot: string, displayName?: string): ImportResult {
  const warnings: string[] = []
  const ext = path.extname(file).toLowerCase()
  if (ext === '.gif' || ext === '.apng') {
    warnings.push('动图本版本只取第一帧（逐帧播放需要自己拆成帧序列再导入）')
  }
  const base = displayName ?? path.basename(file).replace(/\.[^.]+$/, '')
  return buildPackage([{ state: 'idle', files: [file] }], destRoot, `user.${slugifyId(base)}`, base, `导入的单帧外形（${path.basename(file)}）`, { kind: 'image', source: file }, warnings)
}

interface AsepriteFrame {
  filename?: string
  frame: { x: number; y: number; w: number; h: number }
}

function readAsepriteSheet(jsonFile: string): { atlas: AtlasOut; groups: Array<{ state: string; names: string[] }>; tags: string[] } {
  const raw = JSON.parse(fs.readFileSync(jsonFile, 'utf8')) as Record<string, unknown>
  const framesRaw = raw.frames as Record<string, AsepriteFrame | { x: number; y: number; w: number; h: number }> | Array<AsepriteFrame & { filename: string }>
  const atlas: AtlasOut = { frames: {}, meta: { size: { w: 0, h: 0 }, frameSize: { w: 0, h: 0 }, generatedBy: 'import/aseprite' } }
  const order: string[] = []

  const pushFrame = (name: string, rect: { x: number; y: number; w: number; h: number }): void => {
    const key = name.replace(/\.[^.]+$/, '')
    atlas.frames[key] = { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
    order.push(key)
    atlas.meta.frameSize = { w: rect.w, h: rect.h }
  }

  if (Array.isArray(framesRaw)) {
    for (const f of framesRaw) pushFrame(f.filename, f.frame)
  } else {
    for (const [name, value] of Object.entries(framesRaw)) {
      const rect = 'frame' in value ? (value as AsepriteFrame).frame : (value as { x: number; y: number; w: number; h: number })
      pushFrame(name, rect)
    }
  }

  const meta = (raw.meta ?? {}) as { size?: { w: number; h: number }; frameTags?: Array<{ name: string; from: number; to: number }> }
  if (meta.size) atlas.meta.size = { w: meta.size.w, h: meta.size.h }

  const tags = meta.frameTags ?? []
  const groups: Array<{ state: string; names: string[] }> = []
  if (tags.length) {
    for (const tag of tags) {
      const names = order.slice(tag.from, tag.to + 1)
      if (names.length) groups.push({ state: normalizeStateName(tag.name), names })
    }
    // 没有被任何 tag 覆盖的帧，单独成组，避免丢帧
    const covered = new Set(groups.flatMap((g) => g.names))
    const rest = order.filter((n) => !covered.has(n))
    if (rest.length) groups.push({ state: 'extra', names: rest })
  } else {
    groups.push({ state: 'idle', names: order })
  }
  return { atlas, groups, tags: tags.map((t) => t.name) }
}

/** 精灵图 + Aseprite JSON（json-hash / json-array 都吃） */
export function importSpriteSheet(sheetFile: string, jsonFile: string, destRoot: string, displayName?: string): ImportResult {
  const warnings: string[] = []
  const sheet = loadBitmap(sheetFile)
  const { atlas, groups, tags } = readAsepriteSheet(jsonFile)
  if (!atlas.meta.size.w) atlas.meta.size = { w: sheet.width, h: sheet.height }

  for (const [name, r] of Object.entries(atlas.frames)) {
    if (r.x < 0 || r.y < 0 || r.x + r.w > sheet.width || r.y + r.h > sheet.height) {
      return { ok: false, warnings, error: `图集里「${name}」的矩形超出图片范围（图片 ${sheet.width}×${sheet.height}，帧 ${r.x},${r.y},${r.w},${r.h}）` }
    }
  }

  const states: StatesOut = { default: 'idle', states: {} }
  for (const group of groups) {
    states.states[group.state] = {
      fps: 8,
      loop: group.state === 'idle' || group.state === 'talk',
      next: group.state === 'idle' || group.state === 'talk' ? undefined : 'idle',
      clips: [{ frames: group.names }],
    }
  }
  const names = Object.keys(states.states)
  if (!names.includes('idle')) {
    const biggest = names.sort((a, b) => states.states[b].clips[0].frames.length - states.states[a].clips[0].frames.length)[0]
    if (biggest) {
      states.states.idle = { fps: 6, loop: true, clips: [{ frames: [...states.states[biggest].clips[0].frames] }] }
      warnings.push(`没有 idle 标签，已用「${biggest}」复制出一份待机`)
    }
  }
  if (names.includes('talk')) states.talk = 'talk'
  if (names.includes('drag')) states.drag = 'drag'

  const base = displayName ?? path.basename(sheetFile).replace(/\.[^.]+$/, '')
  const id = `user.${slugifyId(base)}`
  const { dir } = writePackage({
    destRoot,
    id,
    displayName: base,
    description: `导入的精灵图（${Object.keys(atlas.frames).length} 帧 / ${names.length} 个状态${tags.length ? ` / 标签：${tags.join('、')}` : ''}）`,
    sheet,
    atlas,
    states,
    source: { kind: 'sheet', sheet: sheetFile, atlas: jsonFile, tags },
  })
  return {
    ok: true,
    pluginId: id,
    dir,
    name: base,
    format: 'sheet',
    frames: Object.keys(atlas.frames).length,
    states: groups.map((g) => ({ name: g.state, frames: g.names.length, fps: 8 })),
    warnings,
    detected: 'sheet',
  }
}

/* ------------------------------------------------------------------ *
 * 识别（暂不支持的格式也要说清楚）
 * ------------------------------------------------------------------ */

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

export function inspectPsd(file: string): ImportResult {
  if (!isPsdFile(file)) return { ok: false, warnings: [], error: '不是有效的 PSD（文件头不是 8BPS）', detected: 'unknown' }
  return {
    ok: false,
    detected: 'psd',
    warnings: [],
    error:
      '识别到分层 PSD。用「导入 PSD」按钮可以自动装配成 2.5D 角色（呼吸/眨眼/视线跟随）；' +
      '装配需要 ag-psd（未安装时会提示），它会解析图层并交给 Anime2.5DRig 做槽位装配（两者都是 MIT）。',
  }
}

export function inspectLive2D(dir: string): ImportResult {
  const models = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.model3.json')) : []
  if (!models.length) return { ok: false, warnings: [], error: '这个目录里没有 model3.json', detected: 'unknown' }
  return {
    ok: false,
    detected: 'live2d',
    warnings: [],
    error:
      `识别到 Live2D 模型 ${models[0]}。用「导入 Live2D」导入包含 moc3 和纹理的完整目录。` +
      'Cubism Core 与模型素材许可分别保留；本机测试已获同意，公开分发授权另行核对。',
  }
}

/** 自动识别：目录里有什么就选哪条路 */
export function detectFolderFormat(dir: string): { kind: ImportKind | 'psd' | 'live2d' | 'empty'; note: string } {
  if (!fs.existsSync(dir)) return { kind: 'empty', note: '目录不存在' }
  const names = fs.readdirSync(dir)
  if (names.some((n) => n.toLowerCase().endsWith('.model3.json'))) return { kind: 'live2d', note: '发现 model3.json' }
  const psd = names.find((n) => n.toLowerCase().endsWith('.psd'))
  if (psd) return { kind: 'psd', note: `发现 ${psd}` }
  const images = names.filter((n) => IMAGE_EXT.has(path.extname(n).toLowerCase()))
  if (images.length >= 2) return { kind: 'frames', note: `${images.length} 张图片，按帧序列导入` }
  if (images.length === 1) return { kind: 'image', note: `单张图片 ${images[0]}` }
  return { kind: 'empty', note: '没找到可用的图片或模型' }
}

/** 导入向导：给一个目录，自动选路 */
export async function importFromFolder(dir: string, destRoot: string, displayName?: string): Promise<ImportResult> {
  const detected = detectFolderFormat(dir)
  if (detected.kind === 'live2d') return importLive2D(dir, destRoot, displayName)
  if (detected.kind === 'psd') {
    const psd = fs.readdirSync(dir).find((n) => n.toLowerCase().endsWith('.psd'))!
    return importPsdFile(path.join(dir, psd), destRoot, displayName)
  }
  if (detected.kind === 'image') {
    const one = fs.readdirSync(dir).find((n) => IMAGE_EXT.has(path.extname(n).toLowerCase()))!
    return importStaticImage(path.join(dir, one), destRoot, displayName)
  }
  if (detected.kind === 'frames') return importFrameSequence(dir, destRoot, displayName)
  return { ok: false, warnings: [], error: detected.note }
}

/** PSD 真装配（动态 import：没装 ag-psd 时也不影响其它格式） */
async function importPsdFile(file: string, destRoot: string, displayName?: string): Promise<ImportResult> {
  try {
    const mod = await import('./psd-import.js')
    return await mod.importPsd(file, destRoot, displayName)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, warnings: [], detected: 'psd', error: `PSD 装配模块加载失败：${detail}` }
  }
}

/** 任意路径入口：目录 / PSD / 图片 / JSON */
export async function importAnyPath(target: string, destRoot: string, displayName?: string): Promise<ImportResult> {
  if (fs.statSync(target).isDirectory()) return importFromFolder(target, destRoot, displayName)
  const ext = path.extname(target).toLowerCase()
  if (ext === '.psd') return importPsdFile(target, destRoot, displayName)
  if (ext === '.json') return { ok: false, warnings: [], error: 'JSON 要跟精灵图 PNG 一起导入（在设置里选「精灵图 + JSON」）' }
  if (IMAGE_EXT.has(ext)) return importStaticImage(target, destRoot, displayName)
  return { ok: false, warnings: [], error: `不认识的格式：${ext || '(无扩展名)'}` }
}
