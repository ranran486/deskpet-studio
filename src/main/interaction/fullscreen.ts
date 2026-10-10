import { spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { appRoot } from '../window.js'
import { log } from '../logger.js'

/** A single read-only Windows helper, with no native npm addon or repeated compiler processes. */
export class FullscreenWatcher {
  private child: ChildProcess | null = null
  constructor(private readonly changed: (quiet: boolean) => void) {}
  start(): void {
    if (process.platform !== 'win32' || this.child) return
    const root = app.isPackaged ? process.resourcesPath : appRoot
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools/windows-fullscreen.ps1'), '-OwnerProcessId', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    const lines = createInterface({ input: child.stdout! })
    let previous = ''
    lines.on('line', line => {
      if ((line === 'true' || line === 'false') && previous !== line) {
        previous = line; log.info(`全屏检测：${line === 'true' ? '进入全屏安静模式' : '正常桌面'}`); this.changed(line === 'true')
      }
    })
    child.on('error', error => log.warn('全屏检测不可用', error.message))
    child.stderr?.on('data', bytes => log.warn('全屏检测诊断', String(bytes).slice(0, 200)))
    child.on('exit', () => { lines.close(); if (this.child === child) { this.child = null; this.changed(false) } })
  }
  stop(): void { const child = this.child; this.child = null; child?.kill() }
}
