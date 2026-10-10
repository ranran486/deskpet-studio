// Atlas packing only: generated bitmap content and alpha are preserved.
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
const dir = path.resolve('packs/blue-maid'), size = 640, frames = []
const atlas = JSON.parse(fs.readFileSync(path.join(dir, 'atlas.json'), 'utf8')), original = PNG.sync.read(fs.readFileSync(path.join(dir, 'spritesheet.png')))
for (const [name, frame] of Object.entries(atlas.frames)) {
  if (name.startsWith('face-') || name.startsWith('pose-')) continue
  const tile = new PNG({ width: size, height: size }); PNG.bitblt(original, tile, frame.x, frame.y, size, size, 0, 0)
  const { x, y, w, h, ...extra } = frame; frames.push({ name, tile, extra })
}
function bounds(image, ox, oy, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (image.data[((oy + y) * image.width + ox + x) * 4 + 3] > 32) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  if (x1 < 0) throw new Error('表情或姿势没有有效像素')
  return { x0, y0, x1, y1 }
}
function pack(name, image, ox = 0, oy = 0, w = image.width, h = image.height, sharedBox, pin) {
  const box = sharedBox ?? bounds(image, ox, oy, w, h), scale = Math.min(464 / (box.x1 - box.x0 + 1), 584 / (box.y1 - box.y0 + 1))
  const tile = new PNG({ width: size, height: size })
  const left = pin ? size * .5 - (pin.x - box.x0) * scale : (size - (box.x1 - box.x0 + 1) * scale) / 2
  const top = pin ? 40 - (pin.y - box.y0) * scale : size - 22 - (box.y1 - box.y0 + 1) * scale
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = box.x0 + (x - left) / scale, sy = box.y0 + (y - top) / scale
    if (sx < box.x0 || sy < box.y0 || sx > box.x1 || sy > box.y1) continue
    const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy; let alpha = 0, r = 0, g = 0, b = 0
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const px = Math.min(w - 1, ix + dx), py = Math.min(h - 1, iy + dy), i = ((oy + py) * image.width + ox + px) * 4
      const a = image.data[i + 3] * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy)
      alpha += a; r += image.data[i] * a; g += image.data[i + 1] * a; b += image.data[i + 2] * a
    }
    const i = (y * size + x) * 4; tile.data[i] = alpha ? r / alpha : 0; tile.data[i + 1] = alpha ? g / alpha : 0; tile.data[i + 2] = alpha ? b / alpha : 0; tile.data[i + 3] = alpha
  }
  frames.push({ name, tile, extra: pin ? { pivot: { x: .5, y: 40 / size } } : name === 'pose-hang-top' ? { pivot: { x: .5, y: .06 } } : {} })
}
const expressions = ['shy', 'happy', 'surprised', 'angry', 'sleepy', 'dizzy', 'love', 'unimpressed']
for (const expression of expressions) pack(`face-${expression}`, PNG.sync.read(fs.readFileSync(path.join(dir, 'source-expressions', `${expression}.png`))))
for (const posture of ['lounge-bottom', 'hang-top']) pack(`pose-${posture}`, PNG.sync.read(fs.readFileSync(path.join(dir, 'source-poses', `${posture}.png`))))
const struggle = PNG.sync.read(fs.readFileSync(path.join(dir, 'source-poses/struggle.png'))), width = Math.floor(struggle.width / 2), height = Math.floor(struggle.height / 2)
const boxes = [0, 1, 2, 3].map(index => bounds(struggle, index % 2 * width, Math.floor(index / 2) * height, width, height))
const union = { x0: Math.min(...boxes.map(box => box.x0)), y0: Math.min(...boxes.map(box => box.y0)), x1: Math.max(...boxes.map(box => box.x1)), y1: Math.max(...boxes.map(box => box.y1)) }
for (let index = 0; index < 4; index++) {
  const ox = index % 2 * width, oy = Math.floor(index / 2) * height, top = boxes[index].y0, points = []
  for (let y = top; y <= top + 3; y++) for (let x = 0; x < width; x++) if (struggle.data[((oy + y) * struggle.width + ox + x) * 4 + 3] > 160) points.push(x)
  pack(`pose-struggle-${index}`, struggle, ox, oy, width, height, union, { x: points.length ? points.reduce((a, b) => a + b, 0) / points.length : width / 2, y: top })
}
const columns = 6, sheet = new PNG({ width: columns * size, height: Math.ceil(frames.length / columns) * size }), packed = { meta: { image: 'spritesheet.png', size: { w: sheet.width, h: sheet.height }, frameSize: { w: size, h: size } }, frames: {} }
frames.forEach(({ name, tile, extra }, index) => { const x = index % columns * size, y = Math.floor(index / columns) * size; PNG.bitblt(tile, sheet, 0, 0, size, size, x, y); packed.frames[name] = { x, y, w: size, h: size, ...extra } })
const states = JSON.parse(fs.readFileSync(path.join(dir, 'states.json'), 'utf8'))
for (const expression of expressions) states.states[expression] = { action: 'idle', emotion: expression, loop: true, clips: [{ frames: [`face-${expression}`], fps: 1, loop: true }] }
states.states['lounge-bottom'] = { action: 'lounge-bottom', loop: true, clips: [{ frames: ['pose-lounge-bottom'], fps: 1, loop: true }] }
states.states['hang-top'] = { action: 'hang-top', loop: true, motion: { preset: 'sway', strength: .2, periodMs: 2200 }, clips: [{ frames: ['pose-hang-top'], fps: 1, loop: true }] }
states.states['drag-lift'] = { action: 'drag-lift', loop: true, clips: [{ frames: [0, 1, 2, 3].map(index => `pose-struggle-${index}`), fps: 6, loop: true }] }
states.states.drag = states.states['drag-lift']
fs.writeFileSync(path.join(dir, 'spritesheet.png'), PNG.sync.write(sheet)); fs.writeFileSync(path.join(dir, 'atlas.json'), JSON.stringify(packed, null, 2)); fs.writeFileSync(path.join(dir, 'states.json'), JSON.stringify(states, null, 2))
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')); manifest.version = '0.3.0'; manifest.provides.states = Object.keys(states.states)
manifest.description = '蓝鲸：八种表情、摸头喂食与心情互动、底边趴桌沿、顶边倒挂、衣领悬空挣扎及旧版动作。'
fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2))
console.log(`${frames.length} frames packed: eight expressions and three posture actions`)
