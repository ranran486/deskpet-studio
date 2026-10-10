/**
 * 示例代码插件：番茄钟。
 *
 * 演示 JS 代码插件能用到的全部关键能力：
 *   handle()          被声明式触发器 { "type": "run", "handler": "..." } 调用
 *   registerCommand() 出现在宠物右键菜单里
 *   timer.every()     宿主托管，插件卸载时自动清理
 *   storage           私有持久化（存在 userData/plugin-data/<id>.json）
 *   say / react       说话与切动作，全部过权限表
 */
let ctx = null
let timer = null
let endsAt = 0

function minutesLeft() {
  return Math.max(0, Math.round((endsAt - Date.now()) / 60000))
}

function stop(reason) {
  if (timer) {
    timer()
    timer = null
  }
  endsAt = 0
  if (ctx && reason) ctx.say(reason)
}

function start(minutes) {
  stop(null)
  const total = Number(minutes) || Number(ctx.config.focusMinutes) || 25
  endsAt = Date.now() + total * 60000
  const done = Number(ctx.storage.get('completed', 0)) + 0
  ctx.storage.set('lastMinutes', total)
  ctx.react('happy')
  ctx.say(`${total} 分钟番茄钟开始，我盯着你哦 🍅`)
  ctx.log(`番茄钟启动 ${total} 分钟（历史完成 ${done} 次）`)

  timer = ctx.timer.every(60000, () => {
    const left = minutesLeft()
    if (left <= 0) {
      ctx.storage.set('completed', Number(ctx.storage.get('completed', 0)) + 1)
      ctx.say('时间到！起来走两步吧 🎉')
      ctx.react('happy')
      stop(null)
      return
    }
    if (left === 5) ctx.say('还剩 5 分钟～')
  })
}

module.exports = {
  activate(context) {
    ctx = context
    ctx.log('激活，已授权：' + context.permissions.join(', '))

    // 供声明式触发器调用：{ "type": "run", "handler": "startFocus", "args": { "minutes": 25 } }
    ctx.handle('startFocus', (args) => {
      start(args.minutes)
      return { endsAt, minutes: minutesLeft() }
    })
    ctx.handle('stopFocus', () => {
      stop('番茄钟已停止')
      return { completed: ctx.storage.get('completed', 0) }
    })
    ctx.handle('stats', () => ({ completed: ctx.storage.get('completed', 0) }))

    ctx.registerCommand({ id: 'focus25', title: '番茄钟 25 分钟', run: () => start(25) })
    ctx.registerCommand({ id: 'focusStop', title: '停止番茄钟', run: () => stop('番茄钟已停止') })

    if (ctx.config.greet !== false) {
      ctx.on('startup', () => ctx.say(`番茄钟插件就绪，右键我看看命令（今日已完成 ${ctx.storage.get('completed', 0)} 次）`))
    }
  },

  deactivate() {
    stop(null)
    if (ctx) ctx.log('已卸载')
    ctx = null
  },
}
