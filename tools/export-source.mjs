import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const args = process.argv.slice(2), outIndex = args.indexOf('--out')
if (outIndex >= 0 && !args[outIndex + 1]) throw new Error('--out requires a directory')
const out = path.resolve(root, outIndex >= 0 ? args[outIndex + 1] : `release/source/deskpet-${version}`)
if (out === root || root.startsWith(out + path.sep) || fs.existsSync(out)) throw new Error('Use a new output directory; existing folders are never overwritten')
const relativeOut = path.relative(root, out)
if (!relativeOut.startsWith('..' + path.sep) && !path.isAbsolute(relativeOut) && !['release', '.runtime'].includes(relativeOut.split(path.sep)[0])) throw new Error('Output inside the project must be under release or .runtime; do not export into source folders')
const rootFiles = ['package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', '.gitattributes', 'LICENSE', 'ASSET-LICENSE.md', 'README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'THIRD_PARTY.md']
const docs = ['RUN.md', 'ARCHITECTURE.md', 'PLUGIN.md', 'ROADMAP.md', 'ACTION-TEMPLATES.md', 'GAMEPLAY.md', 'DIALOGUE-SETTINGS.md', 'BETA-DISTRIBUTION.md', 'LIVE2D-SETUP.md', 'OPEN-SOURCE.md', 'action-preview-v1/DESIGN.md', 'action-preview-v1/generation-prompts.json']
const excluded = relative => relative === 'src/renderer/vendor/live2dcubismcore.min.js' || /^LICENSES\/Live2D-.*-EULA\.html$/.test(relative) || /(^|\/)__pycache__(\/|$)|\.py[co]$/.test(relative)
const copied = []
const copy = relative => {
  relative = relative.replaceAll('\\', '/')
  if (excluded(relative)) return
  const source = path.join(root, relative), stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error(`Source symlink is not exported: ${relative}`)
  const target = path.join(out, relative)
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(source)) copy(`${relative}/${entry}`)
  } else if (stat.isFile()) {
    if (stat.size >= 100 * 1024 * 1024) throw new Error(`File exceeds GitHub's regular file limit: ${relative}`)
    if (/\.(?:ts|js|mjs|cjs|json|md|html|css|cmd|ps1|py|yml|vbs)$/.test(relative) && !relative.endsWith('.min.js')) {
      const text = fs.readFileSync(source, 'utf8')
      if (/\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/.test(text)) throw new Error(`Possible credential in ${relative}; review before exporting`)
    }
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target)
    copied.push({ file: relative, bytes: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex') })
  }
}
fs.mkdirSync(out, { recursive: true })
for (const file of rootFiles) copy(file)
for (const folder of ['.github', 'src', 'scripts', 'tools', 'assets']) copy(folder)
for (const folder of ['blue-maid', 'cat-default', 'cat-actions', 'bubble-default', 'chat-openai', 'chat-ollama', 'pomodoro-js']) copy(`packs/${folder}`)
for (const file of docs) copy(`docs/${file}`)
copy('LICENSES'); copy('plugins/README.md')
const report = { generatedAt: new Date().toISOString(), version, outputDirectory: out, files: copied.length, bytes: copied.reduce((n, file) => n + file.bytes, 0), blueMaidIncluded: true, excluded: ['local configuration and credentials', 'user plugins and chats', 'runtime data', 'dependencies and builds', 'Live2D Core and Hiyori', 'local agent context', 'historical reports and prototypes'], credentialPatternScanPassed: true, manifest: copied }
const reportFile = out + '.audit.json'
if (fs.existsSync(reportFile)) throw new Error('Audit file already exists')
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
if (!args.includes('--no-zip')) {
  if (process.platform !== 'win32') throw new Error('Source folder exported; ZIP creation currently requires Windows. Use --no-zip for folder-only export.')
  const zip = out + '-source.zip'
  if (fs.existsSync(zip)) throw new Error('ZIP already exists; choose a new output directory')
  const quote = value => "'" + value.replaceAll("'", "''") + "'"
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quote(out)}, ${quote(zip)}, [IO.Compression.CompressionLevel]::Optimal, $true)`], { windowsHide: true, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('ZIP creation failed; the source folder and audit remain available')
  const inspect = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; $sourceArchive = [IO.Compression.ZipFile]::OpenRead(${quote(zip)}); try { @($sourceArchive.Entries | ForEach-Object { $_.FullName }) | ConvertTo-Json -Compress } finally { $sourceArchive.Dispose() }`], { windowsHide: true, encoding: 'utf8' })
  if (inspect.status !== 0) throw new Error('ZIP verification failed')
  const entries = JSON.parse(inspect.stdout).map(file => file.replaceAll('\\', '/'))
  for (const { file } of copied) if (!entries.includes(`${path.basename(out)}/${file}`)) throw new Error(`ZIP omitted a file: ${file}`)
  report.zip = { file: zip, bytes: fs.statSync(zip).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex') }
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
}
console.log(JSON.stringify({ source: out, archive: report.zip?.file, audit: reportFile, files: report.files, sizeMiB: Math.round(report.bytes / 1024 / 1024 * 10) / 10 }))
