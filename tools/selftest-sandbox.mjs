/**
 * 代码插件沙箱与权限网关的真实测试（纯 Node，不需要 Electron）。
 *
 * 这是整个框架里最需要被验证的一块：插件代码跑在 `node:vm` 起的新 realm 里，
 * 只能看到注入的 ctx。这里既验证"该拒的拒了"，也**如实验证"能逃逸"**——
 * vm 不是安全边界，把它当成安全边界才是真风险（见 docs/PLUGIN.md 的诚实说明）。
 *
 * 用法： node tools/selftest-sandbox.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 必须在 import sandbox.js 之前设置：它按这个值给 activate/deactivate 装看门狗
process.env.DESKPET_PLUGIN_HOOK_TIMEOUT_MS = '1500'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href)

const { CodePluginRuntime } = await load('dist/main/plugins/sandbox.js')
const { readManifest } = await load('dist/main/plugins/manifest.js')

let passed = 0
const failures = []
function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`)
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`)
  }
}
function info(label, detail) {
  console.log(`  INFO  ${label}${detail ? ' — ' + detail : ''}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-sandbox-'))

/* ------------------------------ 假宿主 ------------------------------ */
function makeHost(records) {
  const host = {
    said: [],
    notifications: [],
    commands: [],
    handlers: new Map(),
    actionsRun: [],
    stored: {},
    listeners: new Map(),
    registry: {
      enabled: records,
      get: (id) => records.find((r) => r.id === id),
    },
    storage: (pluginId) => ({
      get: (key, fallback) => (key in host.stored ? host.stored[key] : fallback),
      set: (key, value) => (host.stored[key] = value),
      delete: (key) => delete host.stored[key],
      all: () => ({ ...host.stored }),
    }),
    say: (text, pluginId) => host.said.push({ text, pluginId }),
    react: () => {},
    setState: () => {},
    setSkin: () => {},
    notify: (title, body) => host.notifications.push({ title, body }),
    registerCommand: (cmd) => host.commands.push(cmd),
    unregisterCommands: (pluginId) => {
      host.commands = host.commands.filter((c) => c.pluginId !== pluginId)
    },
    registerHandler: (pluginId, name, fn) => host.handlers.set(`${pluginId}:${name}`, fn),
    unregisterHandlers: (pluginId) => {
      for (const key of [...host.handlers.keys()]) if (key.startsWith(pluginId + ':')) host.handlers.delete(key)
    },
    chat: async () => ({ text: 'ok', providerId: 'mock', model: 'mock' }),
    on: (event, handler) => {
      if (!host.listeners.has(event)) host.listeners.set(event, new Set())
      host.listeners.get(event).add(handler)
      return () => host.listeners.get(event).delete(handler)
    },
    runActions: async (actions) => host.actionsRun.push(actions),
  }
  return host
}

function makeRecord(id, dir, manifest, config = {}) {
  return { id, dir, source: 'builtin', enabled: true, ok: true, errors: [], warnings: [], config, manifest }
}

function writePlugin(dir, entrySource) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.js'), entrySource, 'utf8')
}

/* ------------------------------ 1. 正常插件 ------------------------------ */
console.log('\n== 1. 正常代码插件：能力可用 ==')
const goodDir = path.join(tmp, 'good')
writePlugin(
  goodDir,
  `
  module.exports = {
    activate(ctx) {
      ctx.handle('ping', () => 'pong')
      ctx.handle('sayHi', () => { ctx.say('hi from plugin'); return 'ok' })
      ctx.handle('trySkin', () => { ctx.setSkin('whatever'); return 'should-not-reach' })
      ctx.handle('tryProcess', () => typeof process)
      ctx.handle('tryRequire', () => { try { return String(require('node:fs')) } catch (e) { return 'blocked:' + e.name } })
      ctx.handle('tryEscape', () => {
        // 注入的外域对象（TextEncoder）挂在外域 Function 上 —— 这是已知逃逸面
        try { return typeof TextEncoder.constructor('return process')().version } catch (e) { return 'blocked:' + e.name }
      })
      ctx.registerCommand({ id: 'cmd1', title: '示例命令', run: () => {} })
      ctx.storage.set('counter', 7)
      this.timer = ctx.timer.every(25, () => ctx.say('tick'))
    },
    deactivate() { if (this.timer) this.timer() },
  }
  `,
)
const goodManifest = {
  manifestVersion: 1,
  id: 'test.good',
  name: '好插件',
  version: '1.0.0',
  kind: 'behavior',
  runtime: 'javascript',
  engine: { deskpet: '>=0.1.0' },
  sdkVersion: '0.1.0',
  entry: 'index.js',
  permissions: ['pet:speak', 'timer', 'storage', 'command'],
}
const goodRecord = makeRecord('test.good', goodDir, goodManifest)
const host = makeHost([goodRecord])
const runtime = new CodePluginRuntime(host)
await runtime.activate(goodRecord)
check('插件被标记为已加载', runtime.listLoaded().includes('test.good'), runtime.listLoaded().join(','))
check('handler 注册成功并可调用', (await host.handlers.get('test.good:ping')?.()) === 'pong')
check('命令注册进宿主命令表', host.commands.some((c) => c.id === 'cmd1'))
check('storage 读写通到宿主', host.stored.counter === 7, JSON.stringify(host.stored))
check('授权后 say 能透传', (await host.handlers.get('test.good:sayHi')?.()) === 'ok' && host.said.length === 1, JSON.stringify(host.said))

console.log('\n== 2. 沙箱隔离：该拿不到的拿不到 ==')
check('沙箱里没有 process', (await host.handlers.get('test.good:tryProcess')?.()) === 'undefined')
check('沙箱里没有 require', String(await host.handlers.get('test.good:tryRequire')?.()).startsWith('blocked:'), String(await host.handlers.get('test.good:tryRequire')?.()))

let skinError = ''
try {
  await host.handlers.get('test.good:trySkin')?.()
} catch (err) {
  skinError = err.message
}
check('未申请 pet:skin 时调用被拒', /未申请权限/.test(skinError), skinError || '(没有抛错)')

console.log('\n== 3. 已知限制（如实报告，不算通过项）==')
const escapeResult = await host.handlers.get('test.good:tryEscape')?.()
info('原型链逃逸探针', String(escapeResult))
info(
  '结论',
  String(escapeResult).startsWith('blocked')
    ? 'vm 边界挡住了这次逃逸；但 vm 仍不是安全边界，不可信插件要用 utilityProcess 隔离'
    : '注入的外域对象确实能逃逸到宿主 realm —— 所以 vm 只能防"误伤"，不能防"敌意"；不可信插件必须换 utilityProcess/worker 隔离',
)

console.log('\n== 4. 卸载时清理定时器与注册 ==')
const saidBefore = host.said.length
await runtime.deactivate('test.good')
await new Promise((r) => setTimeout(r, 120))
check('卸载后定时器不再触发', host.said.length === saidBefore, `卸载后又说了 ${host.said.length - saidBefore} 次`)
check('卸载后 handler 被清理', !host.handlers.has('test.good:ping'))
check('卸载后命令被清理', !host.commands.some((c) => c.pluginId === 'test.good'))

/* ------------------------------ 5. 网络白名单 ------------------------------ */
console.log('\n== 5. network 权限 + 主机白名单 ==')
const netDir = path.join(tmp, 'net')
writePlugin(
  netDir,
  `
  module.exports = {
    activate(ctx) {
      ctx.handle('fetchEvil', async () => { try { await ctx.fetch('https://evil.example.com/x'); return 'reached' } catch (e) { return 'blocked:' + e.message } })
      ctx.handle('fetchGood', async () => { try { await ctx.fetch('https://api.example.com/x'); return 'reached' } catch (e) { return 'blocked:' + e.message } })
    },
  }
  `,
)
const netManifest = {
  ...goodManifest,
  id: 'test.net',
  entry: 'index.js',
  permissions: ['network'],
  network: { hosts: ['api.example.com'] },
}
const netRecord = makeRecord('test.net', netDir, netManifest)
const netHost = makeHost([netRecord])
const netRuntime = new CodePluginRuntime(netHost)
await netRuntime.activate(netRecord)
const evilResult = String(await netHost.handlers.get('test.net:fetchEvil')?.())
check('非白名单主机被拒', evilResult.startsWith('blocked:') && /白名单/.test(evilResult), evilResult)
const noNetDir = path.join(tmp, 'nonet')
writePlugin(noNetDir, `module.exports = { activate(ctx) { ctx.handle('go', async () => { try { await ctx.fetch('https://api.example.com'); return 'reached' } catch (e) { return 'blocked:' + e.message } }) } }`)
const noNetRecord = makeRecord('test.nonet', noNetDir, { ...goodManifest, id: 'test.nonet', entry: 'index.js', permissions: [] })
const noNetHost = makeHost([noNetRecord])
await new CodePluginRuntime(noNetHost).activate(noNetRecord)
const noPermResult = String(await noNetHost.handlers.get('test.nonet:go')?.())
check('没有 network 权限时 fetch 直接拒绝', /未申请权限/.test(noPermResult), noPermResult)

/* ------------------------------ 6. 坏插件不拖垮运行时 ------------------------------ */
console.log('\n== 6. 坏插件被隔离，不影响宿主 ==')
const throwDir = path.join(tmp, 'throw')
writePlugin(throwDir, `module.exports = { activate() { throw new Error('我是故意炸的') } }`)
const throwRecord = makeRecord('test.throw', throwDir, { ...goodManifest, id: 'test.throw', entry: 'index.js' })
const throwHost = makeHost([throwRecord])
const throwRuntime = new CodePluginRuntime(throwHost)
let threw = false
try {
  await throwRuntime.activate(throwRecord)
} catch {
  threw = true
}
check('activate 抛错被运行时吃掉（不冒泡）', !threw)
check('炸掉的插件不会被标记为已加载', !throwRuntime.listLoaded().includes('test.throw'))

const timeoutDir = path.join(tmp, 'hang')
writePlugin(timeoutDir, `module.exports = { activate() { while (true) {} } }`)
const timeoutRecord = makeRecord('test.hang', timeoutDir, { ...goodManifest, id: 'test.hang', entry: 'index.js' })
const timeoutRuntime = new CodePluginRuntime(makeHost([timeoutRecord]))
const started = Date.now()
await timeoutRuntime.activate(timeoutRecord)
const elapsed = Date.now() - started
check('死循环插件被看门狗掐断，不会挂死主进程', elapsed < 6_000, `${elapsed}ms`)
check('被掐断的死循环插件不会被标记为已加载', !timeoutRuntime.listLoaded().includes('test.hang'))

/* ------------------------------ 7. 真实示例插件 ------------------------------ */
console.log('\n== 7. 随框架分发的示例插件真能加载 ==')
const pomoDir = path.join(root, 'packs', 'pomodoro-js')
const { manifest: pomoManifest, errors } = readManifest(pomoDir)
check('pomodoro-js 清单校验通过', errors.length === 0, errors.join('; '))
const registryLikeConfig = { focusMinutes: 25, greet: true }
const pomoRecord = makeRecord(pomoManifest.id, pomoDir, pomoManifest, registryLikeConfig)
const pomoHost = makeHost([pomoRecord])
const pomoRuntime = new CodePluginRuntime(pomoHost)
await pomoRuntime.activate(pomoRecord)
check('示例插件激活成功', pomoRuntime.listLoaded().includes(pomoManifest.id), pomoRuntime.listLoaded().join(','))
check(
  '示例插件注册了 3 个 handler',
  ['stats', 'startFocus', 'stopFocus'].every((h) => pomoHost.handlers.has(`${pomoManifest.id}:${h}`)),
  [...pomoHost.handlers.keys()].join(','),
)
check('示例插件注册了 2 个命令', pomoHost.commands.length === 2, JSON.stringify(pomoHost.commands.map((c) => c.id)))
const focusResult = await pomoHost.handlers.get(`${pomoManifest.id}:startFocus`)({ minutes: 25 })
check('startFocus 返回剩余时间', focusResult && focusResult.minutes === 25, JSON.stringify(focusResult))
check('番茄钟会说话（权限已授权）', pomoHost.said.some((s) => /25 分钟/.test(s.text)), JSON.stringify(pomoHost.said))
const stopResult = await pomoHost.handlers.get(`${pomoManifest.id}:stopFocus`)({})
await pomoRuntime.deactivate(pomoManifest.id)
check('stopFocus 返回统计', stopResult !== undefined, JSON.stringify(stopResult))
check('卸载后 handler 清理干净', !pomoHost.handlers.has(`${pomoManifest.id}:startFocus`))

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n================ sandbox selftest 结果 ================')
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`)
for (const f of failures) console.log(`  ✗ ${f}`)
process.exit(failures.length === 0 ? 0 : 1)
