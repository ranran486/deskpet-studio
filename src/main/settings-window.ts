import { BrowserWindow } from 'electron'
import path from 'node:path'
import { appRoot, distRoot } from './window.js'
import { IPC } from '../shared/ipc.js'
import { log } from './logger.js'

/**
 * 「设置中心」窗口。
 *
 * 为什么是独立窗口而不是气泡里的菜单：配置项（后端地址、Key、人格、互动参数、模型库）
 * 数量上来了以后，气泡那种"一次只显示一行"的形态完全不够用；而且它是一个正常窗口——
 * 有边框、可缩放、进任务栏、能复制粘贴 Key。
 *
 * 设置窗口作为宠物的子窗口，两者维持任务栏前层级；不通过取消宠物置顶来显示设置。
 */
let win: BrowserWindow | null = null
let focusHook: ((focused: boolean) => void) | null = null

export type SettingsTab = 'model' | 'chat' | 'interaction' | 'plugins' | 'about'

export function setSettingsFocusHook(hook: (focused: boolean) => void): void {
  focusHook = hook
}

export function settingsWindowOpen(): boolean {
  return !!win && !win.isDestroyed()
}

export function openSettingsWindow(tab?: SettingsTab): BrowserWindow {
  if (settingsWindowOpen()) {
    const existing = win!
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    if (tab) existing.webContents.send(IPC.settingsTab, { tab })
    return existing
  }

  const created = new BrowserWindow({
    parent: BrowserWindow.getAllWindows().find(window => window.getTitle() === 'DeskPet'),
    width: 980,
    height: 680,
    minWidth: 760,
    minHeight: 540,
    title: '桌面宠物 · 设置中心',
    show: false,
    backgroundColor: '#12141a',
    autoHideMenuBar: true,
    icon: path.join(appRoot, 'assets', 'deskpet.ico'),
    webPreferences: {
      preload: path.join(distRoot, 'preload', 'index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  created.setAlwaysOnTop(true, 'screen-saver')

  created.on('focus', () => focusHook?.(true))
  created.on('blur', () => focusHook?.(false))
  created.on('closed', () => {
    win = null
    focusHook?.(false)
  })
  created.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log.error(`设置窗口加载失败 ${code} ${desc} ${url}`)
  })

  const query = tab ? `?tab=${encodeURIComponent(tab)}` : ''
  void created.loadURL(`deskpet://renderer/settings.html${query}`)
  created.once('ready-to-show', () => {
    created.show()
    created.focus()
  })

  win = created
  log.info(`设置中心已打开${tab ? `（${tab} 页）` : ''}`)
  return created
}

export function closeSettingsWindow(): void {
  if (win && !win.isDestroyed()) win.close()
  win = null
}
