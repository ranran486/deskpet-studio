// Isolated native fullscreen window for the Windows quiet-mode integration test.
const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const win = new BrowserWindow({ fullscreen: true, frame: false, title: 'DeskPet fullscreen QA', backgroundColor: '#172033', webPreferences: { contextIsolation: true, nodeIntegration: false } })
  win.loadURL('data:text/html,<body style="color:white;font-family:sans-serif;padding:40px">DeskPet 全屏检测测试，窗口会自动关闭。</body>')
  win.once('ready-to-show', () => win.focus())
  setTimeout(() => app.quit(), 45000)
})
app.on('window-all-closed', () => app.quit())
