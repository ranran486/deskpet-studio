import fs from 'node:fs'
import path from 'node:path'

/**
 * 极简日志：同时写文件（便于 selfcheck 与用户报障）和保留最近 N 条在内存里。
 * 不引入第三方日志库，保持框架零运行期依赖。
 */
const RING = 400
const ring: string[] = []
let logFile: string | null = null
let debugEnabled = false

export function initLogger(logDir: string, debug = false): void {
  debugEnabled = debug
  try {
    fs.mkdirSync(logDir, { recursive: true })
    logFile = path.join(logDir, 'deskpet.log')
    fs.appendFileSync(logFile, `\n===== ${new Date().toISOString()} deskpet 日志开始 =====\n`, 'utf8')
  } catch {
    logFile = null
  }
}

function write(level: string, args: unknown[]): void {
  const text = args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`
      // 跨 realm（vm 沙箱）抛出的 Error 不是本 realm 的实例，instanceof 会漏；按鸭子类型兜底
      if (a && typeof a === 'object' && typeof (a as { message?: unknown }).message === 'string') {
        const e = a as { name?: string; message: string; stack?: string }
        return `${e.name ?? 'Error'}: ${e.message}${e.stack ? '\n' + e.stack : ''}`
      }
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
  const line = `${new Date().toISOString()} [${level}] ${text}`
  ring.push(line)
  if (ring.length > RING) ring.shift()
  if (level === 'debug' && !debugEnabled) return
  // eslint-disable-next-line no-console
  console.log(line)
  // 同步写：selfcheck/doctor 会在写完后立刻 app.exit()，异步流会丢内容
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + '\n', 'utf8')
    } catch {
      /* 磁盘问题不应该拖垮桌宠 */
    }
  }
}

export const log = {
  debug: (...a: unknown[]) => write('debug', a),
  info: (...a: unknown[]) => write('info', a),
  warn: (...a: unknown[]) => write('warn', a),
  error: (...a: unknown[]) => write('error', a),
}

export function recentLogs(): string[] {
  return [...ring]
}
