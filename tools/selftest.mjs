/**
 * 纯 Node 自测（不依赖 Electron）。
 *
 * 为什么需要它：桌面端 GUI 在受限沙箱/CI 里往往起不来，但框架里真正容易写错的逻辑
 * ——版本协商、清单校验、插件扫描与状态合并、权限表、触发器调度、流式协议解析——
 * 全都不依赖 Electron。这些逻辑一旦错，表现是"插件莫名不生效""聊天不回话"，
 * 靠肉眼看窗口很难定位。`scripts/selfcheck.cmd` 负责 GUI 那一半，这里负责另一半。
 *
 * 用法： node tools/selftest.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const { satisfies } = await import(pathToFileURL(path.join(root, 'dist/main/semver.js')).href)
const { readManifest } = await import(pathToFileURL(path.join(root, 'dist/main/plugins/manifest.js')).href)
const { PluginRegistry } = await import(pathToFileURL(path.join(root, 'dist/main/plugins/registry.js')).href)
const { ConfigStore } = await import(pathToFileURL(path.join(root, 'dist/main/config.js')).href)
const { ACTION_PERMISSION, checkActions, unusedPermissions } = await import(pathToFileURL(path.join(root, 'dist/main/permissions.js')).href)
const { TriggerEngine } = await import(pathToFileURL(path.join(root, 'dist/main/plugins/declarative.js')).href)
const { streamChat, probeProvider, resolveProvider, ChatError } = await import(pathToFileURL(path.join(root, 'dist/main/chat/providers.js')).href)

/* ------------------------------ 迷你测试框架 ------------------------------ */
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
function section(title) {
  console.log(`\n== ${title} ==`)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-selftest-'))

/* ------------------------------ 1. semver ------------------------------ */
section('1. 版本协商（VS Code engines 那一套）')
const semverCases = [
  ['0.1.0', '>=0.1.0 <1.0.0', true],
  ['0.1.0', '^0.1.0', true],
  ['0.2.0', '^0.1.0', false],
  ['1.0.0', '>=0.1.0 <1.0.0', false],
  ['0.1.5', '~0.1.2', true],
  ['0.2.0', '~0.1.2', false],
  ['1.2.3', '1.2.x', true],
  ['1.3.0', '1.2.x', false],
  ['0.1.0', '*', true],
  ['0.1.0', undefined, true],
  ['0.1.0', '', true],
  ['2.0.0', '>=0.1.0 <1.0.0 || >=2.0.0', true],
  ['0.1.0-beta.1', '>=0.1.0', false],
]
let semverOk = true
for (const [version, range, expected] of semverCases) {
  if (satisfies(version, range) !== expected) {
    semverOk = false
    check(`satisfies(${version}, ${range}) === ${expected}`, false)
  }
}
check(`semver ${semverCases.length} 组用例全部符合预期`, semverOk)

/* ------------------------------ 2. 清单校验 ------------------------------ */
section('2. 插件清单校验（含攻击面）')
const goodDir = path.join(tmp, 'good')
fs.mkdirSync(goodDir, { recursive: true })
fs.writeFileSync(path.join(goodDir, 'entry.js'), 'export function activate(){}')
fs.writeFileSync(
  path.join(goodDir, 'plugin.json'),
  JSON.stringify({
    manifestVersion: 1,
    id: 'test.good',
    name: '好插件',
    version: '1.0.0',
    kind: 'behavior',
    runtime: 'javascript',
    engine: { deskpet: '>=0.1.0 <1.0.0' },
    sdkVersion: '0.1.0',
    entry: 'entry.js',
    permissions: ['pet:speak', 'timer'],
    triggers: [{ when: { on: 'timer', everyMinutes: 5 }, actions: [{ type: 'pet.speak', message: 'hi' }] }],
  }),
)
const good = readManifest(goodDir)
check('合法清单零错误', good.errors.length === 0, good.errors.join('; '))

const badCases = [
  ['版本不兼容', { engine: { deskpet: '^9.0.0' } }, /版本不兼容/],
  ['未知权限', { permissions: ['pet:teleport'] }, /未知权限/],
  ['缺 entry', { entry: undefined }, /必须提供 entry/],
  ['目录穿越', { entry: '../../evil.js' }, /路径非法/],
  ['缺 network 白名单', { permissions: ['network'] }, /network\.hosts/],
  ['非法正则', { triggers: [{ when: { on: 'chat:message', match: '(' }, actions: [{ type: 'log', message: 'x' }] }] }, /不是合法正则/],
  ['非法版本号', { version: 'v1' }, /version 必须是/],
  ['空 actions', { triggers: [{ when: { on: 'click' }, actions: [] }] }, /actions 为空/],
]
let badOk = true
for (const [label, override, pattern] of badCases) {
  const dir = path.join(tmp, 'bad-' + Buffer.from(label).toString('hex').slice(0, 8))
  fs.mkdirSync(dir, { recursive: true })
  const manifest = {
    manifestVersion: 1,
    id: 'test.bad',
    name: '坏插件',
    version: '1.0.0',
    kind: 'behavior',
    runtime: 'javascript',
    engine: { deskpet: '>=0.1.0' },
    sdkVersion: '0.1.0',
    entry: 'entry.js',
    permissions: ['pet:speak'],
    ...override,
  }
  fs.writeFileSync(path.join(dir, 'entry.js'), 'export function activate(){}')
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest))
  const result = readManifest(dir)
  const hit = result.errors.some((e) => pattern.test(e))
  if (!hit) {
    badOk = false
    check(`拒绝「${label}」`, false, `错误信息：${result.errors.join('; ') || '(无)'}`)
  }
}
check(`8 种坏清单全部被拒`, badOk)

// 首次构造即落盘：用户要能直接找到并手改 config.json
const freshDir = path.join(tmp, 'fresh-data')
const freshConfig = new ConfigStore(freshDir)
check('首次启动就生成 config.json（含完整默认值）', fs.existsSync(path.join(freshDir, 'config.json')))
check('默认蓝鲸皮肤与 DeepSeek 后端已写入', freshConfig.data.skin === 'builtin.blue-maid' && freshConfig.data.chatProvider === 'builtin.chat-openai',
  JSON.stringify({ skin: freshConfig.data.skin, theme: freshConfig.data.theme, chatProvider: freshConfig.data.chatProvider }))
check('默认开启点击穿透与置顶', freshConfig.data.clickThrough === true && freshConfig.data.alwaysOnTop === true)
const reloaded = new ConfigStore(freshDir)
check('第二次构造读回同一份配置（不会把用户改动冲掉）', reloaded.data.skin === freshConfig.data.skin)

/* ------------------------------ 3. 插件仓库 ------------------------------ */
section('3. 插件扫描 / 皮肤解析 / 状态合并（跑真实 packs/）')
const dataDir = path.join(tmp, 'userdata')
fs.mkdirSync(path.join(dataDir, 'plugins'), { recursive: true })
const config = new ConfigStore(dataDir)
const registry = new PluginRegistry(path.join(root, 'packs'), path.join(dataDir, 'plugins'), config)
const plugins = registry.scan()
const hasHiyori = fs.existsSync(path.join(root, 'packs/hiyori-live2d/plugin.json'))
check('公开内置插件齐全，可选日和按安装状态加载', plugins.length === (hasHiyori ? 8 : 7), `实际 ${plugins.length}：${plugins.map((p) => p.id).join(', ')}`)
check('所有内置插件校验通过', plugins.every((p) => p.ok), plugins.filter((p) => !p.ok).map((p) => `${p.id}: ${p.errors}`).join(' | '))
check(
  '四类 kind 都在（skin/action/theme/chat）',
  ['skin', 'action', 'theme', 'chat'].every((k) => plugins.some((p) => p.manifest.kind === k)),
)

if (hasHiyori) {
  const live2d = registry.resolveSkin('builtin.hiyori-live2d')
  check('可选日和模型的原生动作与资源可解析', live2d?.kind === 'live2d' && live2d.motions.includes('Idle') && live2d.modelUrl.startsWith('deskpet://pack/'))
}
config.patch({ skin: 'builtin.blue-maid' })
const maid = registry.resolveSkin(config.data.skin)
check('蓝鲸的 37 帧动作与表情保持可解析', maid?.kind === 'sprite' && Object.keys(maid.atlas.frames).length === 37)
const maidStates = registry.mergedStates(config.data.skin)
check('猫猫动作包不能覆盖蓝鲸的 talk 状态', maidStates.states.talk.clips[0].frames[0] === 'front')
check('蓝鲸全部状态只引用自身图集', Object.values(maidStates.states).every((st) => st.clips.every((clip) => clip.frames.every((frame) => !!maid.atlas.frames[frame]))))
// 保留旧猫咪包的完整兼容性测试，独立于新的默认外形。
config.patch({ skin: 'builtin.cat-default' })
const skin = registry.resolveSkin(config.data.skin)
check('默认皮肤可解析', !!skin, config.data.skin)
const frames = Object.keys(skin.atlas.frames)
check('图集有 25 帧', frames.length === 25, `实际 ${frames.length}`)
check('frameSize 为 128x128', skin.frameSize.w === 128 && skin.frameSize.h === 128, JSON.stringify(skin.frameSize))
check('贴图 URL 走 deskpet://pack', skin.imageUrl.startsWith('deskpet://pack/builtin.cat-default/'), skin.imageUrl)

const states = registry.mergedStates(config.data.skin)
const stateNames = Object.keys(states.states)
check('状态数量 >= 7（含动作包新增的 purr）', stateNames.length >= 7, stateNames.join(', '))
check('动作包新增状态 purr 已合并', stateNames.includes('purr'))
check('动作包覆盖了 talk', states.states.talk && JSON.stringify(states.states.talk).includes('talk_'), JSON.stringify(states.states.talk)?.slice(0, 80))

const referenced = new Set()
const unknownRefs = []
for (const [name, st] of Object.entries(states.states)) {
  for (const clip of st.clips ?? []) {
    for (const f of clip.frames ?? []) {
      referenced.add(f)
      if (!frames.includes(f)) unknownRefs.push(`${name}:${f}`)
    }
  }
}
check('状态引用的帧全部存在于图集', unknownRefs.length === 0, unknownRefs.join(', '))
const orphan = frames.filter((f) => !referenced.has(f))
check('图集里没有孤儿帧', orphan.length === 0, orphan.join(', '))

const idleState = states.states[states.default ?? 'idle']
check('待机状态有多个 clip（待机动作随机调度需要）', (idleState?.clips?.length ?? 0) >= 2, `${idleState?.clips?.length} 个 clip`)
const weights = idleState.clips.map((c) => c.weight ?? 1)
check('待机 clip 带不同权重', new Set(weights).size > 1, weights.join('/'))

const theme = registry.resolveTheme(config.data.theme)
check('主题可解析且有关键令牌', !!theme && !!theme.bubbleBackground && !!theme.bubbleColor)
const providers = registry.chatProviders()
check('两个内置聊天后端都在', providers.length === 2, providers.map((p) => `${p.pluginId}:${p.def.type}`).join(', '))

// 禁用后应该消失
registry.setEnabled('builtin.cat-actions', false)
const afterDisable = registry.mergedStates(config.data.skin)
check('禁用动作包后 purr 状态消失', !Object.keys(afterDisable.states).includes('purr'))
registry.setEnabled('builtin.cat-actions', true)
check(
  '重新启用后 purr 回来',
  Object.keys(registry.mergedStates(config.data.skin).states).includes('purr'),
)

// 多用户目录：项目内 plugins/ 优先，其次数据目录 plugins/（同 id 前者胜）
const dirA = path.join(tmp, 'proj-plugins')
const dirB = path.join(tmp, 'data-plugins')
for (const [dir, who] of [
  [dirA, 'A'],
  [dirB, 'B'],
]) {
  // 约定：用户目录下的**每个子文件夹**是一个插件
  const pdir = path.join(dir, 'dup')
  fs.mkdirSync(pdir, { recursive: true })
  fs.writeFileSync(
    path.join(pdir, 'plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'dup.id',
      name: who,
      version: '1.0.0',
      kind: 'theme',
      runtime: 'data',
      engine: { deskpet: '>=0.1.0' },
      data: { tokens: 'tokens.json' },
    }),
  )
  fs.writeFileSync(path.join(pdir, 'tokens.json'), '{"bubbleColor":"#fff"}')
  // 反向用例：直接把 plugin.json 丢在用户目录根部（而不是子文件夹里）不应被识别
  fs.writeFileSync(path.join(dir, 'stray.json'), '{}')
}
const multiRegistry = new PluginRegistry(
  path.join(root, 'packs'),
  [dirA, path.join(tmp, 'missing-dir'), dirB],
  new ConfigStore(path.join(tmp, 'multi-data')),
)
const multiPlugins = multiRegistry.scan()
check(
  '多个用户插件目录都被扫描（不存在的目录不报错）',
  multiPlugins.length === plugins.length + 1,
  `实际 ${multiPlugins.length}：${multiPlugins.map((p) => p.id).join(',')}`,
)
check(
  '同 id 冲突时靠前的用户目录优先',
  multiRegistry.get('dup.id')?.manifest.name === 'A',
  String(multiRegistry.get('dup.id')?.manifest.name),
)
check('插件必须放在用户目录的子文件夹里（根部的 json 不算插件）', multiPlugins.filter((p) => p.source === 'user').length === 1,
  multiPlugins.filter((p) => p.source === 'user').map((p) => p.id).join(','))

/* ------------------------------ 4. 权限表 ------------------------------ */
section('4. 权限模型')
check('动作到权限的映射覆盖全部动作类型', Object.keys(ACTION_PERMISSION).length === 12, `${Object.keys(ACTION_PERMISSION).length} 条`)
check('log 动作不需要权限', ACTION_PERMISSION.log === null)
const actions = [
  { type: 'pet.speak', message: 'hi' },
  { type: 'notify', title: 't' },
  { type: 'pet.move', dx: 1 },
]
const violations = checkActions(actions, ['pet:speak'])
check('缺权限的动作被识别出来', violations.length === 2, JSON.stringify(violations))
check('权限充足时无违规', checkActions(actions, ['pet:speak', 'notify', 'pet:move']).length === 0)
check('能报出"申请了但没用到"的权限', unusedPermissions(actions, ['pet:speak', 'storage']).join(',') === 'storage')

/* ------------------------------ 5. 触发器引擎 ------------------------------ */
section('5. 声明式触发器引擎')
const fired = []
const fakeRecord = {
  id: 'test.triggers',
  dir: tmp,
  source: 'user',
  enabled: true,
  ok: true,
  errors: [],
  warnings: [],
  config: { interval: 1 },
  manifest: {
    id: 'test.triggers',
    kind: 'behavior',
    runtime: 'declarative',
    permissions: ['pet:speak', 'pet:react', 'timer', 'notify'],
    triggers: [
      { id: 'on-click', when: { on: 'click', cooldownSeconds: 0 }, actions: [{ type: 'pet.speak', message: 'clicked' }] },
      { id: 'every', when: { on: 'timer', everyMinutes: { config: 'interval' } }, actions: [{ type: 'log', message: 'tick' }] },
      { id: 'startup', when: { on: 'startup', once: true }, actions: [{ type: 'pet.react', reaction: 'happy' }] },
      { id: 'no-perm', when: { on: 'click' }, actions: [{ type: 'pet.skin', skin: 'x' }] },
    ],
  },
}
const listeners = new Map()
const fakeHost = {
  registry: { enabled: [fakeRecord], get: (id) => (id === fakeRecord.id ? fakeRecord : undefined) },
  on: (event, handler) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(handler)
    return () => listeners.get(event).delete(handler)
  },
  emit: (event, data) => {
    for (const h of listeners.get(event) ?? []) h({ type: event, at: Date.now(), data })
    for (const h of listeners.get('*') ?? []) h({ type: event, at: Date.now(), data })
  },
  runActions: async (acts, permissions, pluginId) => {
    fired.push({ acts, permissions, pluginId })
  },
}
const engine = new TriggerEngine(fakeHost)
const quiet = console.log
console.log = () => {}
engine.start()
await new Promise((r) => setTimeout(r, 1100))
console.log = quiet
check('startup 触发器已触发', fired.some((f) => f.acts.some((a) => a.type === 'pet.react')), JSON.stringify(fired.map((f) => f.acts.map((a) => a.type))))
check('订阅了 click 事件', listeners.has('click'))
// 模拟一次点击
for (const h of listeners.get('click') ?? []) h({ type: 'click', at: Date.now() })
check('点击后触发了两个触发器（含越权那个，由宿主在执行前拦下）', fired.length >= 2, `fired=${fired.length}`)
const noPerm = fired.find((f) => f.acts.some((a) => a.type === 'pet.skin'))
check('越权触发器仍被交给宿主判定权限', !!noPerm && !noPerm.permissions.includes('pet:skin'), JSON.stringify(noPerm?.permissions))
// 冷却
const before = fired.length
for (const h of listeners.get('click') ?? []) h({ type: 'click', at: Date.now() })
check('cooldownSeconds=0 时不拦重复触发', fired.length > before)
engine.stop()
check('stop() 之后不再监听', !listeners.has('click') || listeners.get('click').size === 0)

/* ------------------------------ 6. 流式聊天 ------------------------------ */
section('6. 聊天后端：真实 HTTP 流式解析（本地 mock）')
let ollamaPostSeen = null
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/api/tags') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ models: [{ name: 'mock:latest' }] }))
    return
  }
  if (req.method === 'GET' && url.pathname === '/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      ollamaPostSeen = JSON.parse(body)
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      for (const chunk of ['你', '好', '呀']) {
        res.write(JSON.stringify({ model: 'mock:latest', message: { content: chunk }, done: false }) + '\n')
      }
      res.write(JSON.stringify({ model: 'mock:latest', message: { content: '' }, done: true }) + '\n')
      res.end()
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/chat/completions') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const chunk of ['hel', 'lo ', 'world']) {
      res.write(`data: ${JSON.stringify({ model: 'mock-model', choices: [{ delta: { content: chunk } }] })}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  if (req.method === 'POST' && url.pathname === '/boom/api/chat') {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: '模型未加载' }))
    return
  }
  res.writeHead(404).end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

const refDef = {
  type: 'ollama',
  baseUrl: { config: 'baseUrl' },
  model: { config: 'model' },
  systemPrompt: { config: 'persona' },
}
const refResolved = resolveProvider(refDef, { baseUrl: base, model: 'mock:latest', persona: '你是猫' })
check(
  'data.chat 里的 {config:"x"} 被解析成具体值',
  refResolved.baseUrl === base && refResolved.model === 'mock:latest' && refResolved.systemPrompt === '你是猫',
  JSON.stringify(refResolved),
)
check('配置缺失时回落为空串而不是 undefined', resolveProvider({ type: 'ollama', baseUrl: { config: 'nope' }, model: 'm' }, {}).baseUrl === '')

const ollamaDef = { type: 'ollama', baseUrl: base, model: 'mock:latest', systemPrompt: '你是猫' }
const deltas = []
const result = await streamChat(
  ollamaDef,
  { messages: [{ role: 'user', content: '在吗' }], onDelta: (c) => deltas.push(c) },
  undefined,
  'mock.ollama',
)
check('Ollama NDJSON 拼接正确', result.text === '你好呀', JSON.stringify(result.text))
check('Ollama 增量是真流式（>=3 次回调）', deltas.length >= 3, `deltas=${JSON.stringify(deltas)}`)
check('systemPrompt 被注入请求体', ollamaPostSeen?.messages?.[0]?.role === 'system', JSON.stringify(ollamaPostSeen?.messages))
check('stream:true 已发送', ollamaPostSeen?.stream === true)
const cancelled = new AbortController()
cancelled.abort()
let cancelledError = ''
try { await streamChat(ollamaDef, { messages: [], signal: cancelled.signal }, undefined, 'mock.cancelled') }
catch (error) { cancelledError = error.name }
check('已取消的请求直接终止，保留 AbortError 而非误报网络故障', cancelledError === 'AbortError', cancelledError)

const openaiDeltas = []
const openaiResult = await streamChat(
  { type: 'openai-compatible', baseUrl: base, model: 'mock-model' },
  { messages: [{ role: 'user', content: 'hi' }], onDelta: (c) => openaiDeltas.push(c) },
  'sk-test',
  'mock.openai',
)
check('OpenAI SSE 拼接正确', openaiResult.text === 'hello world', JSON.stringify(openaiResult.text))
check('SSE [DONE] 被正确终止', openaiDeltas.length === 3, `deltas=${JSON.stringify(openaiDeltas)}`)

const probeOllama = await probeProvider(ollamaDef, undefined)
check('probeProvider 探到 Ollama 模型列表', probeOllama.reachable && probeOllama.models?.[0] === 'mock:latest', JSON.stringify(probeOllama))
const probeOpenai = await probeProvider({ type: 'openai-compatible', baseUrl: base, model: 'm' }, 'k')
check('probeProvider 探到 OpenAI 兼容模型列表', probeOpenai.reachable && probeOpenai.models?.[0] === 'mock-model', JSON.stringify(probeOpenai))

let errorMessage = ''
try {
  await streamChat({ type: 'ollama', baseUrl: base + '/boom', model: 'm' }, { messages: [] }, undefined, 'mock.err')
} catch (err) {
  errorMessage = err instanceof ChatError ? `${err.message}|${err.hint ?? ''}` : `wrong-type:${err.constructor.name}`
}
check('HTTP 500 抛 ChatError 并带响应体', errorMessage.startsWith('http://127.0.0.1') && errorMessage.includes('500'), errorMessage)

let offlineHint = ''
try {
  await streamChat({ type: 'ollama', baseUrl: 'http://127.0.0.1:9', model: 'm' }, { messages: [] }, undefined, 'mock.offline')
} catch (err) {
  offlineHint = err instanceof ChatError ? err.hint ?? '' : 'wrong-type'
}
check('后端不可达时给出可操作的提示', /ollama serve|OpenAI 兼容/.test(offlineHint), offlineHint)

let keyError = ''
try {
  await streamChat({ type: 'openai-compatible', baseUrl: base, model: 'm', requiresApiKey: true }, { messages: [] }, undefined, 'mock.key')
} catch (err) {
  keyError = err instanceof ChatError ? err.message : 'wrong-type'
}
check('缺 API key 时明确报错而不是发空请求', /需要 API key/.test(keyError), keyError)

/* ------------------------------ 7. 命令表 ------------------------------ */
section('7. 命令表（插件命令与内置命令）')
const { CommandRegistry } = await import(pathToFileURL(path.join(root, 'dist/main/plugins/commands.js')).href)
const cmds = new CommandRegistry()
const ran = []
cmds.register({ pluginId: 'builtin', id: 'quit', title: '退出桌宠', run: () => ran.push('quit') })
cmds.register({
  pluginId: 'p.one',
  id: 'focus25',
  title: '番茄钟 25 分钟',
  run: async () => {
    ran.push('focus25')
  },
})
check(
  '命令列表带 key（IPC 靠它定位）',
  cmds.list().length === 2 && cmds.list().every((c) => c.key === `${c.pluginId}:${c.id}`),
  JSON.stringify(cmds.list().map((c) => c.key)),
)
check('可按键取到命令', cmds.get('p.one', 'focus25')?.title === '番茄钟 25 分钟')
check(
  'run() 真的被执行（这正是之前静默失效的那条链路）',
  (await cmds.run('p.one', 'focus25')) === true && ran.includes('focus25'),
  JSON.stringify(ran),
)
check('不存在的命令返回 false，而不是假装成功', (await cmds.run('p.one', 'nope')) === false)
cmds.unregisterPlugin('p.one')
check(
  '插件卸载只清自己的命令，内置命令还在',
  cmds.get('p.one', 'focus25') === undefined && !!cmds.get('builtin', 'quit'),
)

/* ------------------------------ 8. 互动纯逻辑 ------------------------------ */
section('8. 互动纯逻辑（含 Petra 参数）')
const B = await import(pathToFileURL(path.join(root, 'dist/main/interaction/behavior.js')).href)
const R = await import(pathToFileURL(path.join(root, 'dist/renderer/interaction.js')).href)

const AREA = { x: 0, y: 0, width: 1920, height: 1040 }
const PET = { width: 128, height: 128 }

check(
  '活动三档参数与 Petra 一致',
  B.ACTIVITY_LEVELS.low.speed === 12 &&
    B.ACTIVITY_LEVELS.mid.speed === 55 &&
    B.ACTIVITY_LEVELS.high.speed === 120 &&
    B.ACTIVITY_LEVELS.low.restBaseMs === 600000 &&
    B.ACTIVITY_LEVELS.mid.restChance === 0.3,
  JSON.stringify(B.ACTIVITY_LEVELS),
)
const clamped = B.clampToWorkArea({ x: -500, y: 99999 }, PET, AREA)
check('越界坐标被夹回工作区', clamped.x >= AREA.x && clamped.y + PET.height <= AREA.y + AREA.height, JSON.stringify(clamped))
const tiny = B.clampToWorkArea({ x: -50, y: -50 }, { width: 4000, height: 4000 }, AREA)
check('宠物比工作区还大时不产生反直觉坐标', tiny.x >= AREA.x && tiny.y >= AREA.y, JSON.stringify(tiny))

const step = B.stepToward({ x: 0, y: 0 }, { x: 1000, y: 0 }, 100, 1000)
check('stepToward 按速度前进（1 秒走 100px）', Math.abs(step.pos.x - 100) < 0.001 && !step.arrived, JSON.stringify(step))
const near = B.stepToward({ x: 0, y: 0 }, { x: 10, y: 0 }, 100, 16)
check('到达阈值内直接吸附目标', near.arrived && near.pos.x === 10, JSON.stringify(near))

check(
  '漫游半径随活动档位增大（低档半径最小：歇得多、走得近）',
  B.wanderRadius(AREA, 'low') < B.wanderRadius(AREA, 'mid') && B.wanderRadius(AREA, 'mid') < B.wanderRadius(AREA, 'high'),
  `${B.wanderRadius(AREA, 'low')} / ${B.wanderRadius(AREA, 'mid')} / ${B.wanderRadius(AREA, 'high')}`,
)
const seeded = () => 0.5
const target = B.nextWanderTarget({ x: 300, y: 300 }, PET, AREA, 'high', seeded)
check(
  '漫游目标落在工作区内且至少偏离 40px',
  target.x >= AREA.x && target.y >= AREA.y && target.x + PET.width <= AREA.width && B.distance({ x: 300, y: 300 }, target) >= 40,
  JSON.stringify(target),
)

check('躲避半径 165px 的边界判定', B.shouldFlee({ x: 0, y: 0 }, { x: 164, y: 0 }) === true && B.shouldFlee({ x: 0, y: 0 }, { x: 166, y: 0 }) === false)
const dir = B.avoidDirection({ x: 0, y: 0 }, { x: 100, y: 0 })
check('躲避方向指向远离鼠标', dir.x > 0.99 && Math.abs(dir.y) < 0.01, JSON.stringify(dir))
check('鼠标与宠物重合时不产生方向（避免抖动）', JSON.stringify(B.avoidDirection({ x: 5, y: 5 }, { x: 5, y: 5 })) === '{"x":0,"y":0}')
const fleeAtEdge = B.fleeTarget({ x: 20, y: 500 }, { x: 0, y: 500 }, PET, AREA)
check('逃跑目标会被夹回工作区（贴左边缘）', fleeAtEdge.x >= AREA.x, JSON.stringify(fleeAtEdge))
const damped = B.dampAtEdge({ x: AREA.x, y: 500 }, PET, AREA, { x: 10, y: 10 })
check('贴边时速度按 0.55 衰减', Math.abs(damped.x - 5.5) < 0.001 && damped.y === 10, JSON.stringify(damped))

check('时段划分六段边界正确', B.dayPartOf(5) === 'dawn' && B.dayPartOf(8) === 'morning' && B.dayPartOf(11) === 'noon' && B.dayPartOf(14) === 'afternoon' && B.dayPartOf(18) === 'evening' && B.dayPartOf(23) === 'night' && B.dayPartOf(2) === 'night')
check('免打扰：23 点不响、12 点响、7 点不响、8 点响', B.shouldChime(23, true) === false && B.shouldChime(12, true) === true && B.shouldChime(7, true) === false && B.shouldChime(8, true) === true)
check('关闭免打扰时任何整点都响', B.shouldChime(3, false) === true)
const line = B.chimeLine(0, () => 0)
check('整点文案替换为 12 小时制（0 点 → 12 点）', line.includes('12') && !line.includes('{h}'), line)
const now = new Date(2026, 0, 1, 10, 30, 0).getTime()
check('距下一个整点 = 30 分钟', Math.abs(B.msUntilNextHour(now) - 30 * 60_000) < 1000, String(B.msUntilNextHour(now)))
check('距整点极近时也不会返回 0（避免忙循环）', B.msUntilNextHour(new Date(2026, 0, 1, 10, 59, 59, 900).getTime()) >= 1000)

check('点击判定阈值 6px', R.isPat({ x: 0, y: 0 }, { x: 5, y: 0 }) === true && R.isPat({ x: 0, y: 0 }, { x: 7, y: 0 }) === false && R.PAT_THRESHOLD_PX === 6)
const inDead = R.normalizeCursor(10, 0, 20, 260)
check('视线死区内不产生偏移', inDead.x === 0 && inDead.y === 0 && inDead.mag === 0, JSON.stringify(inDead))
const far = R.normalizeCursor(600, 0, 20, 260)
check('超出量程截断到 ±1', Math.abs(far.x - 1) < 1e-9 && far.mag === 1, JSON.stringify(far))
const band = R.normalizeCursor(40, 0, 20, 260)
check('死区到 2×死区之间线性淡入', band.mag > 0.4 && band.mag < 0.6 && band.x > 0 && band.x < 0.2, JSON.stringify(band))
const smoothed = R.smoothLook({ x: 0, y: 0 }, { x: 1, y: 0 }, 16, 8)
check('指数平滑：一帧内向目标靠近但不越过', smoothed.x > 0 && smoothed.x < 1, JSON.stringify(smoothed))
let lookConvergence = { x: 0, y: 0 }
for (let i = 0; i < 60; i += 1) lookConvergence = R.smoothLook(lookConvergence, { x: 1, y: 0 }, 16, 8)
check('平滑在 1 秒内收敛到目标附近', Math.abs(lookConvergence.x - 1) < 0.01, JSON.stringify(lookConvergence))
const lookRight = R.lookTransform({ x: 1, y: 0 }, { lookAmplitude: 8, lookTilt: 3 })
check('朝右看：向右位移 + 顺时针侧倾', lookRight.tx === 8 && lookRight.rot === 3 && lookRight.ty === 0, JSON.stringify(lookRight))
check('朝左看方向相反', R.lookTransform({ x: -1, y: 0 }, { lookAmplitude: 8, lookTilt: 3 }).tx === -8)
check('幅度为 0 时不动', JSON.stringify(R.lookTransform({ x: 1, y: 1 }, { lookAmplitude: 0, lookTilt: 0 })) === '{"tx":0,"ty":0,"rot":0}')

/* ------------------------------ 9. 导入器的命名与分组规则 ------------------------------ */
section('9. 导入器的命名与分组规则')
const N = await import(pathToFileURL(path.join(root, 'dist/main/skin/naming.js')).href)

check('自然序：frame_2 排在 frame_10 之前', N.naturalCompare('frame_2.png', 'frame_10.png') < 0)
check('自然序可直接用于排序数组', ['f_10.png', 'f_2.png', 'f_1.png'].sort(N.naturalCompare)[0] === 'f_1.png')
check(
  '文件名 → 状态名与序号',
  N.splitFrameName('idle_03.png').state === 'idle' &&
    N.splitFrameName('idle_03.png').index === 3 &&
    N.splitFrameName('wave-12.png').state === 'wave' &&
    N.splitFrameName('run 7.png').state === 'run',
  JSON.stringify([N.splitFrameName('idle_03.png'), N.splitFrameName('run 7.png')]),
)
check('没有序号的文件名整名做状态', N.splitFrameName('wave.png').state === 'wave' && N.splitFrameName('wave.png').index === null)
check(
  '中文与常见别名映射到规范状态名',
  N.normalizeStateName('待机') === 'idle' &&
    N.normalizeStateName('挥手') === 'wave' &&
    N.normalizeStateName('拖拽') === 'drag' &&
    N.normalizeStateName('说话') === 'talk' &&
    N.normalizeStateName('WAVE') === 'wave',
)
check('不认识的中文前缀保留原名（状态名允许中文）', N.normalizeStateName('打盹') === '打盹')
check('非法字符归一化成连字符', N.normalizeStateName('My Walk!!') === 'my-walk' && N.normalizeStateName('  --x--  ') === 'x')
check('纯 ASCII 目录名直接成 id', N.slugifyId('My Cat 2') === 'my-cat-2', N.slugifyId('My Cat 2'))
check(
  '中文目录名退化成合法 id（插件 id 只允许 ascii）',
  /^skin-[a-z0-9]+$/.test(N.slugifyId('我的猫咪')),
  N.slugifyId('我的猫咪'),
)
check('id 长度被截断到 48', N.slugifyId('a'.repeat(120)).length === 48)

/* ------------------------------ 10. 配置健壮性 ------------------------------ */
section('10. 配置健壮性（深合并，缺字段自动补默认值）')
const robustnessDir = path.join(tmp, 'robustness')
fs.mkdirSync(robustnessDir, { recursive: true })
const robustnessFile = path.join(robustnessDir, 'config.json')

// 1) 文件里 interaction 是个空对象（正是实际踩到的情形）
fs.writeFileSync(robustnessFile, JSON.stringify({ skin: 'builtin.cat-default', interaction: {} }, null, 2))
const afterEmpty = new ConfigStore(robustnessDir)
check(
  'interaction 为空对象时，加载后补齐全部 19 个字段',
  Object.keys(afterEmpty.data.interaction).length === 19 &&
    afterEmpty.data.interaction.lookDeadzone === 20 &&
    afterEmpty.data.interaction.activity === 'low' && afterEmpty.data.interaction.fullscreenQuiet === true,
  `${Object.keys(afterEmpty.data.interaction).length} 个字段`,
)
check('用户已有的顶层设置不被默认值覆盖', afterEmpty.data.skin === 'builtin.cat-default')

// 2) 文件里只有部分字段：用户改过的要保留，缺的补默认
fs.writeFileSync(
  robustnessFile,
  JSON.stringify({ interaction: { look: false, avoidRadius: 300, activity: 'high' } }, null, 2),
)
const afterPartial = new ConfigStore(robustnessDir)
check(
  '部分字段：用户的值保留、缺的补默认',
  afterPartial.data.interaction.look === false &&
    afterPartial.data.interaction.avoidRadius === 300 &&
    afterPartial.data.interaction.activity === 'high' &&
    afterPartial.data.interaction.petCooldownMs === 1500 &&
    afterPartial.data.interaction.wander === true,
  JSON.stringify({
    look: afterPartial.data.interaction.look,
    avoidRadius: afterPartial.data.interaction.avoidRadius,
    petCooldownMs: afterPartial.data.interaction.petCooldownMs,
  }),
)

// 3) patch 传部分 interaction 不能抹掉其它字段
const beforePatch = afterPartial.data.interaction
afterPartial.patch({ interaction: { look: true } })
check(
  'patch 部分 interaction 时其它字段不丢',
  afterPartial.data.interaction.look === true &&
    afterPartial.data.interaction.avoidRadius === beforePatch.avoidRadius &&
    afterPartial.data.interaction.idlePeek === beforePatch.idlePeek,
  JSON.stringify({ look: afterPartial.data.interaction.look, avoidRadius: afterPartial.data.interaction.avoidRadius }),
)
check('patch 后落盘的文件里字段是齐的', Object.keys(JSON.parse(fs.readFileSync(robustnessFile, 'utf8')).interaction).length === 19)

// 4) 配置文件损坏时整体回落到默认值，不抛异常
fs.writeFileSync(robustnessFile, '{ 这不是 JSON')
const afterBroken = new ConfigStore(robustnessDir)
check(
  '配置文件损坏时回落到默认值（不抛异常）',
  afterBroken.data.skin === 'builtin.blue-maid' && Object.keys(afterBroken.data.interaction).length === 19,
)

/* ------------------------------ 11. 2.5D 装配转换 ------------------------------ */
section('11. 2.5D 装配：rigger 输出 → 皮肤包描述')
const RIG = await import(pathToFileURL(path.join(root, 'dist/main/skin/rig.js')).href)

const px = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(200) })
const fakeRig = {
  canvas: { w: 200, h: 260 },
  anchors: {
    face: { cx: 100, cy: 90, x0: 40, x1: 160, y0: 30, y1: 150 },
    eyeL: { x0: 60, x1: 90, y0: 70, y1: 92, icx: 75, icy: 81, closeY: 84 },
    mouth: { x0: 85, x1: 115, y0: 110, y1: 126, cx: 100, cy: 118 },
    neckPivot: { cx: 100, cy: 160 },
    neckTop: 150,
    neckBottom: 175,
    bodyPivot: { cx: 100, cy: 260 },
    faceScale: 1.2,
    hairRootY: 90,
  },
  layers: [
    { name: 'body', img: px(100, 110), left: 50, top: 150, right: 150, bottom: 260, z: 5, depth: 0.9, group: 'body', phys: null, fade: null, side: null, strands: null },
    { name: 'face', img: px(120, 120), left: 40, top: 30, right: 160, bottom: 150, z: 0, depth: 1, group: 'head', phys: null, fade: null, side: null, strands: null },
    { name: 'irides_L', img: px(16, 16), left: 68, top: 73, right: 84, bottom: 89, z: 1, depth: 1.08, group: 'head', phys: null, fade: 'eyeOpen', side: 'L', strands: null },
    { name: 'front hair', img: px(130, 60), left: 45, top: 20, right: 175, bottom: 80, z: 2, depth: 1.28, group: 'head', phys: 'hair', fade: null, side: null, strands: [{ x: 60 }, { x: 120 }] },
    { name: 'no-pixels', left: 0, top: 0, right: 0, bottom: 0, z: 3, depth: 1, group: 'head', phys: null, fade: null, side: null, strands: null },
  ],
  warnings: ['原警告'],
  synth: { eye: true },
}
const conv = RIG.rigToDefinition(fakeRig, { kind: 'test' })
check('格式标记为 psd-rig/1', conv.definition.format === 'psd-rig/1')
check('图层按 z 升序（绘制顺序）', conv.definition.layers.map((l) => l.name).join(',') === 'face,irides_L,front hair,body', conv.definition.layers.map((l) => l.name).join(','))
check('没有像素的图层被跳过并给出告警', conv.definition.layers.length === 4 && conv.definition.warnings.some((w) => w.includes('no-pixels')), JSON.stringify(conv.definition.warnings))
check('图层几何取自 bbox、尺寸取自图片', conv.definition.layers[0].x === 40 && conv.definition.layers[0].y === 30 && conv.definition.layers[0].w === 120, JSON.stringify(conv.definition.layers[0]))
check('PNG 路径落在 layers/ 且带序号前缀', conv.definition.layers[0].png === 'layers/00-face.png' && conv.definition.layers[2].png.startsWith('layers/02-'), conv.definition.layers.map((l) => l.png).join(','))
check('待写出的图片数与图层数一致', conv.images.length === conv.definition.layers.length)
check('锚点原样透传（渲染层要用 closeY / neckPivot / faceScale）', conv.definition.anchors.eyeL.closeY === 84 && conv.definition.anchors.neckPivot.cy === 160 && conv.definition.anchors.faceScale === 1.2)
check(
  '参数默认值照 Petra：呼吸 3.4s / 眨眼 1600+rand·3800 / 18% 双眨',
  conv.definition.params.breathPeriodMs === 3400 && conv.definition.params.blinkMinMs === 1600 && conv.definition.params.blinkMaxMs === 3800 && conv.definition.params.doubleBlinkChance === 0.18,
  JSON.stringify(conv.definition.params),
)
check('原警告保留', conv.definition.warnings.includes('原警告'))
check('source 写进定义（可追溯来源文件）', conv.definition.source?.kind === 'test')

const sum = RIG.summarizeRig(conv.definition)
check(
  '摘要统计头/身图层、淡入通道与是否有眼/嘴',
  sum.layers === 4 && sum.headLayers === 3 && sum.bodyLayers === 1 && sum.hasEyes && sum.hasMouth === false,
  JSON.stringify(sum),
)
check('图层文件名安全化（中文/空格/符号都能落盘）', RIG.safeLayerName('前髪 Front Hair!', 3) === '03-front-hair', RIG.safeLayerName('前髪 Front Hair!', 3))

/* ------------------------------ 收尾 ------------------------------ */
section('12. 默认角色透明图集与轻量动画')
const { PNG } = await import('pngjs')
const { sampleMotion } = await import(pathToFileURL(path.join(root, 'dist/renderer/motion.js')).href)
const maidImage = PNG.sync.read(fs.readFileSync(path.join(root, 'packs/blue-maid/spritesheet.png')))
check('角色图集尺寸与完整动作帧一致', maidImage.width === 3840 && maidImage.height === 4480)
check('图集外侧透明区域确实有 alpha', maidImage.data[3] === 0 && maidImage.data[(maidImage.width * maidImage.height - 1) * 4 + 3] === 0)
check('三视图均有有效角色像素', ['front', 'side', 'back'].every((name) => {
  const f = maid.atlas.frames[name]
  let opaque = 0
  for (let y = f.y; y < f.y + f.h; y += 8) for (let x = f.x; x < f.x + f.w; x += 8) if (maidImage.data[(y * maidImage.width + x) * 4 + 3] > 32) opaque++
  return opaque > 1000
}))
check('未配置 motion 的旧皮肤保持原变换', JSON.stringify(sampleMotion(undefined, 100)) === JSON.stringify({ x: 0, y: 0, angle: 0, sx: 1, sy: 1 }))
check('轻量动作在长时间运行与异常参数下始终有界', ['breathe', 'sway', 'bounce', 'sleep'].every((preset) => {
  for (let ms = 0; ms < 100000; ms += 413) {
    const t = sampleMotion({ preset, strength: 100, periodMs: -1 }, ms)
    if (!Object.values(t).every(Number.isFinite) || t.sy < 0.95 || t.sy > 1.05 || Math.abs(t.angle) > 0.08) return false
  }
  return true
}))
check('呼吸、摇摆、开心动作会产生不同变换', sampleMotion({ preset: 'breathe' }, 850).sy > 1 && sampleMotion({ preset: 'sway' }, 850).angle > 0 && sampleMotion({ preset: 'bounce' }, 850).y < 0)

server.close()
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n================ selftest 结果 ================`)
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`)
for (const f of failures) console.log(`  ✗ ${f}`)
process.exit(failures.length === 0 ? 0 : 1)
