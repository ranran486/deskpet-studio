// Reuse the existing 256px blue-maid ICO; no redraw or recompression.
import fs from 'node:fs'
const source = 'assets/deskpet-blue-maid.ico', bytes = fs.readFileSync(source)
if (bytes.readUInt16LE(2) !== 1 || bytes[6] !== 0 || bytes[7] !== 0) throw new Error('安装图标需要有效的 256px ICO')
fs.mkdirSync('.runtime/beta-build-resources', { recursive: true })
fs.copyFileSync(source, '.runtime/beta-build-resources/deskpet-beta.ico')
