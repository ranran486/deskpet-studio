// Deterministic atlas packing only: source artwork is generated with imagegen.
// Run with Node; pngjs is a build-time dependency, never loaded by the desktop app.
import { PNG } from 'pngjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'packs/blue-maid')
try {
  const source = PNG.sync.read(fs.readFileSync(path.join(dir, 'reference-sheet.png')))
  const { width, height } = source
  if (!width || !height) throw new Error('Missing reference-sheet.png')
  const sourcePixels = source.data
  const tileW = 640, tileH = 800
  const atlas = { meta: { image: 'spritesheet.png', frameSize: { w: tileW, h: tileH } }, frames: {} }
  const pixels = Buffer.alloc(tileW * 3 * tileH * 4)
  const names = ['front', 'side', 'back']
  // Column cuts are at the empty space between views (the front hair crosses the exact first third).
  const cuts = [0, Math.round(width * 0.355), Math.round(width * 0.64), width]
  for (let view = 0; view < 3; view++) {
    let x0 = width, y0 = height, x1 = 0, y1 = 0
    for (let y = 0; y < height; y++) for (let x = cuts[view]; x < cuts[view + 1]; x++) {
      if (sourcePixels[(y * width + x) * 4 + 3] > 24) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
      }
    }
    if (x1 <= x0 || y1 <= y0) throw new Error(`Empty ${names[view]} view`)
    const size = { width: x1 - x0 + 1, height: y1 - y0 + 1 }
    if (size.width > tileW - 36 || size.height > tileH - 40) throw new Error('Reference too large for atlas; adjust tile size before packing')
    const left = Math.floor((tileW - size.width) / 2), top = tileH - 28 - size.height
    const preview = Buffer.alloc(tileW * tileH * 4)
    for (let y = 0; y < size.height; y++) {
      const begin = ((y0 + y) * width + x0) * 4
      const row = sourcePixels.subarray(begin, begin + size.width * 4)
      row.copy(pixels, ((top + y) * tileW * 3 + view * tileW + left) * 4)
      row.copy(preview, ((top + y) * tileW + left) * 4)
    }
    fs.writeFileSync(path.join(dir, `preview-${names[view]}.png`), PNG.sync.write({ width: tileW, height: tileH, data: preview }))
    atlas.frames[names[view]] = { x: tileW * view, y: 0, w: tileW, h: tileH }
  }
  fs.writeFileSync(path.join(dir, 'spritesheet.png'), PNG.sync.write({ width: tileW * 3, height: tileH, data: pixels }))
  fs.writeFileSync(path.join(dir, 'atlas.json'), JSON.stringify(atlas, null, 2))
  // Package a 256px PNG in a Windows ICO container for shortcuts.
  const icon = new PNG({ width: 256, height: 256 })
  const iconScale = 256 / tileH
  const iconLeft = (256 - tileW * iconScale) / 2
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const sx = Math.floor((x - iconLeft) / iconScale), sy = Math.floor(y / iconScale)
    if (sx < 0 || sx >= tileW) continue
    pixels.copy(icon.data, (y * 256 + x) * 4, (sy * tileW * 3 + sx) * 4, (sy * tileW * 3 + sx) * 4 + 4)
  }
  const iconPng = PNG.sync.write(icon)
  const icoHeader = Buffer.alloc(22)
  icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(1, 4)
  icoHeader.writeUInt16LE(1, 10); icoHeader.writeUInt16LE(32, 12)
  icoHeader.writeUInt32LE(iconPng.length, 14); icoHeader.writeUInt32LE(22, 18)
  fs.writeFileSync(path.join(root, 'assets/deskpet-blue-maid.ico'), Buffer.concat([icoHeader, iconPng]))
  console.log(`Packed ${width}×${height} reference into three ${tileW}×${tileH} frames`)
} catch (err) { console.error(err); process.exitCode = 1 }
