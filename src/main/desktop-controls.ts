import { app, globalShortcut, Menu, nativeImage, screen, Tray, type MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type { PetHost } from './host.js'
import type { InteractionLoop } from './interaction/loop.js'
import type { PetWindow } from './window.js'
import { appRoot } from './window.js'
import { openSettingsWindow } from './settings-window.js'
import { log } from './logger.js'

/** 托盘与角色右键共用宿主命令；长命令列表从聊天气泡中移除。 */
export function buildPetMenu(host: PetHost): Menu {
  const commands = host.listCommands()
  const item = (id: string): MenuItemConstructorOptions => ({ label: commands.find(c => c.pluginId === 'builtin' && c.id === id)?.title ?? id, click: () => { void host.runCommand('builtin', id) } })
  const plugins = commands.filter(c => c.pluginId !== 'builtin')
  return Menu.buildFromTemplate([
    item('settings'), item('chat'), item('local-chat'),
    { label: '互动与喂食', submenu: [item('feed'), item('praise'), item('tease')] },
    { label: '动作与表情', submenu: ['wave', 'walk', 'shy', 'happy', 'surprised', 'angry', 'sleepy', 'dizzy', 'love', 'unimpressed', 'sad', 'neutral', 'sleep-curl'].map(state => item(`pose-${state}`)) },
    { label: '边缘姿势', submenu: ['left', 'right', 'bottom', 'top'].map(edge => item(`dock-${edge}`)).concat([item('wake')]) },
    { label: '互动设置', submenu: ['toggle-look', 'toggle-avoid', 'toggle-wander', 'cycle-activity', 'toggle-idle'].map(item) },
    ...(plugins.length ? [{ label: '插件工具', submenu: plugins.map(c => ({ label: c.title, click: () => { void host.runCommand(c.pluginId, c.id) } })) }] : []),
    { type: 'separator' }, item('reload-plugins'), item('open-data-dir'), item('quit'),
  ])
}

/** 原生托盘作为稳定入口；皮肤、动作、设置仍通过宿主接口执行。 */
export function installDesktopControls(host: PetHost, pet: PetWindow, interaction: InteractionLoop): () => void {
  const blueIcon = path.join(appRoot, 'packs/blue-maid/preview-front.png')
  const icon = nativeImage.createFromPath(fs.existsSync(blueIcon) ? blueIcon : path.join(appRoot, 'packs/cat-default/preview-idle.png')).resize({ width: 32, height: 32 })
  const tray = new Tray(icon)
  tray.setToolTip('DeskPet · 桌面宠物')
  const toggle = (): void => {
    const win = pet.win
    if (!win) return
    if (win.isVisible()) { win.hide(); interaction.suspend(24 * 60 * 60 * 1000) }
    else { win.showInactive(); interaction.resume() }
    refresh()
  }
  const resetPosition = (): void => {
    const win = pet.win
    if (!win) return
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const [width, height] = win.getSize()
    win.setPosition(Math.round(area.x + Math.max(0, area.width - width - 24)), Math.round(area.y + Math.max(0, area.height - height - 16)))
    win.showInactive()
    interaction.wake(false)
    interaction.resume()
    interaction.suspend(1500)
    refresh()
  }
  function refresh(): void {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: pet.win?.isVisible() ? '隐藏宠物 · Alt+P' : '显示宠物 · Alt+P', click: toggle },
      { label: '设置中心', click: () => openSettingsWindow('model') },
      { label: '回到屏幕右下角', click: resetPosition },
      { type: 'separator' },
      { label: '切换角色', submenu: host.registry.enabledOfKind('skin').map((record) => ({
        label: record.manifest.name, type: 'radio' as const, checked: record.id === host.config.data.skin,
        click: () => { host.setSkin(record.id, 'builtin'); refresh() },
      })) },
      { label: '动作与表情', submenu: buildPetMenu(host).items[2].submenu },
      { label: '边缘待机', submenu: buildPetMenu(host).items[3].submenu },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]))
  }
  refresh()
  tray.on('double-click', toggle)
  const off = host.on('skin:changed', refresh)
  if (!globalShortcut.register('Alt+P', toggle)) log.warn('Alt+P 已被占用，仍可通过托盘显示或隐藏宠物')
  const dispose = (): void => { off(); globalShortcut.unregister('Alt+P'); tray.destroy() }
  app.once('before-quit', dispose)
  return refresh
}
