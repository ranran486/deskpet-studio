/**
 * 读取由 src/shared/ipc.ts 的共享常量。
 */
export const IPC = {
  // 渲染进程 → 主进程（invoke，有返回）
  bootstrap: 'deskpet:bootstrap',
  packList: 'deskpet:packs:list',
  pluginList: 'deskpet:plugins:list',
  pluginToggle: 'deskpet:plugins:toggle',
  pluginConfigGet: 'deskpet:plugins:config:get',
  pluginConfigSet: 'deskpet:plugins:config:set',
  pluginReload: 'deskpet:plugins:reload',
  pluginInvokeHandler: 'deskpet:plugins:invoke',
  chatSend: 'deskpet:chat:send',
  chatAbort: 'deskpet:chat:abort',
  petInteract: 'deskpet:pet:interact',
  dialogueGet: 'deskpet:dialogue:get',
  dialogueSave: 'deskpet:dialogue:save',
  dialoguePreview: 'deskpet:dialogue:preview',
  petLife: 'deskpet:pet:life',
  feedPanel: 'deskpet:pet:feed-panel',
  chatProviders: 'deskpet:chat:providers',
  configGet: 'deskpet:config:get',
  configSet: 'deskpet:config:set',
  setSkin: 'deskpet:skin:set',
  skinImport: 'deskpet:skin:import',
  exportActionProfile: 'deskpet:skin:export-actions',
  skinDelete: 'deskpet:skin:delete',
  secretSet: 'deskpet:secret:set',
  secretClear: 'deskpet:secret:clear',
  openPath: 'deskpet:app:open-path',
  contextMenu: 'deskpet:window:context-menu',

  // 渲染进程 → 主进程（send，无返回）
  setInteractive: 'deskpet:window:interactive',
  dragStart: 'deskpet:window:drag-start',
  dragEnd: 'deskpet:window:drag-end',
  hitTestReport: 'deskpet:window:hit-test',
  rendererEvent: 'deskpet:event:from-renderer',
  log: 'deskpet:log',

  // 主进程 → 渲染进程
  event: 'deskpet:event',
  chatDelta: 'deskpet:chat:delta',
  chatDone: 'deskpet:chat:done',
  themeApply: 'deskpet:theme:apply',
  skinApply: 'deskpet:skin:apply',
  bubbleShow: 'deskpet:bubble:show',
  stateRequest: 'deskpet:state:request',
  expressionApply: 'deskpet:expression:apply',
  configChanged: 'deskpet:config:changed',
  settingsTab: 'deskpet:settings:tab',
  /** 主进程推送光标相对窗口中心的偏移（视线跟随用） */
  cursor: 'deskpet:cursor',
  /** 主进程通知互动状态变化（如进入/退出待机模式） */
  interaction: 'deskpet:interaction',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
