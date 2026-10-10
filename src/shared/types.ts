/**
 * deskpet 插件协议 —— 全部对外契约集中在这里。
 *
 * 设计取舍（抄自三个成熟生态，见 docs/PLUGIN.md）：
 *  - VS Code 的 `engines` 版本协商：manifest 用 semver range 声明宿主版本。
 *  - Obsidian 的极简 manifest + 启停：一个文件夹一个插件，改完 reload 即生效。
 *  - VPet 的"数据包"思路：外形/动作/主题是纯资源 + JSON，零代码门槛。
 *
 * 一个插件 = 一个文件夹 + plugin.json。`runtime` 决定怎么执行，`kind` 决定它贡献什么。
 */

export const DESKPET_VERSION = '0.2.3'
export const MANIFEST_FILENAME = 'plugin.json'

/** 插件运行方式 */
export type PluginRuntime =
  /** 纯数据包：外形 / 动作 / 主题 / 聊天后端，宿主直接消费 JSON 与图片 */
  | 'data'
  /** 声明式：只有 triggers，宿主解释执行，插件作者不写代码 */
  | 'declarative'
  /** 代码插件：entry 指向一个 JS 文件，跑在受限沙箱里 */
  | 'javascript'

/** 插件贡献的主要类别（决定 UI 里分组和启停语义） */
export type PluginKind = 'skin' | 'action' | 'theme' | 'chat' | 'behavior'

/** 能力权限。代码插件必须在 manifest 里显式申请，运行期越权直接抛错。 */
export type Permission =
  /** 让宠物说话（气泡） */
  | 'pet:speak'
  /** 触发一次情绪反应（切到某个动作状态） */
  | 'pet:react'
  /** 直接设置动画状态 */
  | 'pet:state'
  /** 移动宠物窗口 */
  | 'pet:move'
  /** 换外形 */
  | 'pet:skin'
  /** 注册定时器 / 定时触发 */
  | 'timer'
  /** 读写自己的私有存储 */
  | 'storage'
  /** 控制气泡 UI（显示/隐藏/自定义样式） */
  | 'bubble'
  /** 系统通知 */
  | 'notify'
  /** 发起网络请求（受 network.hosts 白名单限制） */
  | 'network'
  /** 调用 / 注册聊天后端 */
  | 'chat'
  /** 注册命令（托盘与右键菜单里出现） */
  | 'command'
  /** 读取系统信息（屏幕、空闲时间等） */
  | 'system:info'

export const ALL_PERMISSIONS: readonly Permission[] = [
  'pet:speak',
  'pet:react',
  'pet:state',
  'pet:move',
  'pet:skin',
  'timer',
  'storage',
  'bubble',
  'notify',
  'network',
  'chat',
  'command',
  'system:info',
] as const

/** 会触发插件逻辑的事件名 */
export type TriggerEvent =
  | 'startup'
  | 'ready'
  | 'tick'
  | 'timer'
  | 'idle'
  | 'click'
  | 'double-click'
  | 'right-click'
  | 'drag:start'
  | 'drag:end'
  | 'chat:message'
  | 'chat:reply'
  | 'state:enter'
  | 'state:exit'
  | 'skin:changed'
  | 'plugin:enabled'
  | 'plugin:disabled'

/** 配置项声明：宿主据此生成设置界面，并把值喂给 triggers / 代码插件 */
export type ConfigField =
  | { type: 'text' | 'textarea' | 'number' | 'boolean'; label: string; default?: unknown; description?: string }
  | { type: 'select'; label: string; options: Array<{ label: string; value: string }>; default?: unknown; description?: string }

/** 引用配置值：`{ config: 'interval' }`，插件因此不用把参数写死 */
export interface ConfigRef {
  config: string
}
export type ValueOrConfig<T> = T | ConfigRef

export function isConfigRef(v: unknown): v is ConfigRef {
  return typeof v === 'object' && v !== null && typeof (v as ConfigRef).config === 'string'
}

/** 触发条件 */
export interface TriggerWhen {
  on: TriggerEvent
  /** 每 N 分钟触发一次（on: 'timer'），或 on: 'idle' 的空闲秒数 */
  everyMinutes?: ValueOrConfig<number>
  /** 每天 HH:mm 触发（on: 'timer'） */
  at?: ValueOrConfig<string>
  /** 仅当宠物处于该动画状态时（on: 'state:enter' / 'state:exit'） */
  state?: string
  /** 空闲达到 N 秒（on: 'idle'） */
  idleSeconds?: ValueOrConfig<number>
  /** 只响应匹配该正则的消息/事件（on: 'chat:message'） */
  match?: string
  /** 冷却：两次触发之间的最小间隔秒数 */
  cooldownSeconds?: ValueOrConfig<number>
  /** 只触发一次，之后自动停用 */
  once?: boolean
}

/** 声明式动作：宿主解释执行，不需要插件写代码 */
export type PetAction =
  | { type: 'pet.speak'; message: string; durationMs?: number }
  | { type: 'pet.react'; reaction: string }
  | { type: 'pet.setState'; state: string }
  | { type: 'pet.skin'; skin: string }
  | { type: 'pet.move'; dx?: number; dy?: number; to?: 'left' | 'right' | 'top' | 'bottom' | 'center' }
  | { type: 'bubble.hide' }
  | { type: 'notify'; title: string; body?: string }
  | { type: 'storage.set'; key: string; value: unknown }
  | { type: 'storage.inc'; key: string; by?: number }
  | { type: 'log'; message: string }
  /** 交给代码插件的 handler（runtime: 'javascript'） */
  | { type: 'run'; handler: string; args?: Record<string, unknown> }
  /** 向当前聊天会话注入一条助手消息（配合 chat provider 做"主动说话"） */
  | { type: 'chat.ask'; prompt: string }

export interface Trigger {
  id?: string
  when: TriggerWhen
  actions: PetAction[]
  enabled?: boolean
}

/* ------------------------------------------------------------------ *
 * 外形 / 动作数据包
 * ------------------------------------------------------------------ */

export interface AtlasFrame {
  x: number
  y: number
  w: number
  h: number
  /** 帧内归一化动作支点；用于被衣领提起时保持抓点一致。 */
  pivot?: { x: number; y: number }
  /** 下屏幕裁切线，按整个帧的高度归一化。 */
  revealY?: number
}

/** 图集：帧名 → 精灵图上的矩形。Aseprite 的 json-hash 导出格式是超集。 */
export interface Atlas {
  frames: Record<string, AtlasFrame>
  meta?: {
    image?: string
    size?: { w: number; h: number }
    frameSize?: { w: number; h: number }
    scale?: number
  }
}

/** 一个动作片段：一组帧 + 播放参数。同一个状态可以有多个片段，按 weight 随机抽。 */
export interface Clip {
  frames: string[]
  weight?: number
  fps?: number
  loop?: boolean
}

/** 一个动画状态（idle / talk / drag / 任意自定义情绪名） */
export interface PetState {
  action?: import('./action-model.js').BodyAction
  emotion?: import('./action-model.js').Emotion
  mirror?: boolean
  /** 整体变换动画；单张角色图可先使用它，后续替换为手绘帧或分层 rig。 */
  motion?: SpriteMotion
  fps?: number
  loop?: boolean
  /** 片段播完后自动进入的状态；不填则回到 idle */
  next?: string
  /** 该状态是否可用于待机随机调度 */
  idle?: boolean
  clips: Clip[]
}

export interface SpriteMotion {
  preset: 'breathe' | 'sway' | 'bounce' | 'sleep'
  periodMs?: number
  strength?: number
}

export interface States {
  /** 默认状态名，缺省 'idle' */
  default?: string
  /** 拖动时播放的状态名，缺省 'drag' */
  drag?: string
  /** 说话时播放的状态名，缺省 'talk' */
  talk?: string
  states: Record<string, PetState>
}

/** 主题令牌：气泡与整体视觉，用 CSS 变量注入 */
export interface ThemeTokens {
  bubbleBackground?: string
  bubbleColor?: string
  bubbleBorder?: string
  bubbleRadius?: string
  bubbleFontFamily?: string
  bubbleFontSize?: string
  bubbleMaxWidth?: string
  bubbleShadow?: string
  accent?: string
  /** 额外原始 CSS 变量 */
  extra?: Record<string, string>
}

/** 聊天后端声明（kind: 'chat' + runtime: 'data'） */
export interface ChatProviderDef {
  /** 内置协议族。openai-compatible 覆盖 DeepSeek / 通义 / 本地 vLLM 等 */
  type: 'ollama' | 'openai-compatible'
  baseUrl: string | ConfigRef
  model: string | ConfigRef
  systemPrompt?: string | ConfigRef
  temperature?: number | ConfigRef
  maxTokens?: number | ConfigRef
  /** 从宿主密钥库取 key 的名字（key 存在用户目录，不写进插件包） */
  apiKeyRef?: string
  /** 是否需要 key（openai-compatible 通常需要，本地部署可不要） */
  requiresApiKey?: boolean
  /** 额外请求头 */
  headers?: Record<string, string>
}

export interface DataContribution {
  /** 当前人物的现有动作／参数／抓点绑定 */
  actionProfile?: string
  live2d?: string
  /** 2.5D 装配外形的定义文件（skin.json）；与 spritesheet/atlas/states 二选一 */
  rig?: string
  spritesheet?: string
  atlas?: string
  states?: string
  tokens?: string
  chat?: ChatProviderDef
}

/* ------------------------------------------------------------------ *
 * manifest
 * ------------------------------------------------------------------ */

export interface PluginManifest {
  manifestVersion: 1
  /** 反向域名或短横线 id，全局唯一 */
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  /** 内置图标名（见 docs/PLUGIN.md）或包内相对路径图片 */
  icon?: string
  kind: PluginKind
  runtime: PluginRuntime
  /** 抄 VS Code：声明兼容的宿主版本范围，如 ">=0.1.0 <1.0.0" */
  engine: { deskpet: string }
  permissions?: Permission[]
  configSchema?: Record<string, ConfigField>
  triggers?: Trigger[]
  /** runtime: 'javascript' 时的入口，必须是包内相对路径 */
  entry?: string
  sdkVersion?: string
  network?: { hosts: string[] }
  data?: DataContribution
  /** 数据包可以声明它"改装"哪些状态，方便 UI 展示 */
  provides?: { states?: string[]; skins?: string[] }
}

/** 扫描后交给渲染进程/UI 的插件描述 */
export interface PluginRecord {
  id: string
  dir: string
  /** 内置包（随应用分发）还是用户包 */
  source: 'builtin' | 'user'
  manifest: PluginManifest
  enabled: boolean
  ok: boolean
  /** 校验失败原因；ok=false 时展示 */
  errors: string[]
  warnings: string[]
  config: Record<string, unknown>
}

/* ---- 2.5D 装配外形（分层 PSD 导入产物；与 src/main/skin/rig.ts 的 RigDefinition 同形）---- */

export interface RigLayer {
  name: string
  x: number
  y: number
  w: number
  h: number
  z: number
  depth: number
  group: 'head' | 'body'
  phys: string | null
  fade: string | null
  side: 'L' | 'R' | null
  /** 包内相对路径，如 layers/03-face.png */
  png: string
  strands?: unknown[] | null
  synthetic?: boolean
  unknown?: boolean
}

export interface RigParams {
  physAmp: number
  soft: number
  fhAmp: number
  fhSoft: number
  eyeEase: number
  mouthEase: number
  irisScale: number
  breathPeriodMs: number
  blinkMinMs: number
  blinkMaxMs: number
  doubleBlinkChance: number
}

export interface RigAnchor {
  x0: number
  x1: number
  y0: number
  y1: number
  cx?: number
  cy?: number
  icx?: number
  icy?: number
  closeY?: number
}

export interface RigAnchors {
  face: RigAnchor
  eyeL?: RigAnchor
  eyeR?: RigAnchor
  mouth?: RigAnchor
  neckPivot: { cx: number; cy: number }
  neckTop: number
  neckBottom: number
  bodyPivot: { cx: number; cy: number }
  faceScale: number
  hairRootY: number
}

export interface RigSkinData {
  format: string
  canvas: { w: number; h: number }
  anchors: RigAnchors
  params: RigParams
  layers: RigLayer[]
  warnings?: string[]
  source?: Record<string, unknown>
}

/** 精灵图外形：一张图集 + 状态机 */
export interface ResolvedSpriteSkin {
  actionProfile?: import('./action-profile.js').ActionProfile
  kind: 'sprite'
  pluginId: string
  id: string
  name: string
  /** 形如 deskpet://pack/<pluginId>/spritesheet.png 的自定义协议 URL */
  imageUrl: string
  atlas: Atlas
  states: States
  frameSize: { w: number; h: number }
  anchor: { x: number; y: number }
  scale: number
}

/** 2.5D 装配外形：逐层 PNG + 锚点 + 参数 */
export interface ResolvedRigSkin {
  actionProfile?: import('./action-profile.js').ActionProfile
  kind: 'rig'
  pluginId: string
  id: string
  name: string
  rig: RigSkinData
  /** 图层 png 相对路径 → deskpet:// URL */
  layerUrls: Record<string, string>
  scale: number
}

export interface ResolvedLive2DSkin {
  actionProfile?: import('./action-profile.js').ActionProfile
  kind: 'live2d'
  pluginId: string
  id: string
  name: string
  modelUrl: string
  motions: string[]
  motionCounts?: Record<string, number>
  expressions: string[]
  frameSize: { w: number; h: number }
  scale: number
}
export type ResolvedSkin = ResolvedSpriteSkin | ResolvedRigSkin | ResolvedLive2DSkin

/* ------------------------------------------------------------------ *
 * 代码插件 API（注入沙箱的 ctx）
 * ------------------------------------------------------------------ */

export interface PluginStorage {
  get<T = unknown>(key: string, fallback?: T): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
  all(): Record<string, unknown>
}

/** 代码插件拿到的宿主 API。所有方法都会检查 manifest 里声明的权限。 */
export interface PluginContext {
  readonly id: string
  readonly version: string
  /** 已解析的插件配置（configSchema 的默认值 + 用户覆盖） */
  readonly config: Record<string, unknown>
  readonly permissions: readonly Permission[]
  has(permission: Permission): boolean
  log(...args: unknown[]): void
  /** 订阅宿主事件；返回取消订阅函数 */
  on(event: TriggerEvent, handler: (payload: unknown) => void): () => void
  /** 注册一个可被 trigger 的 `run` 动作或命令调用的处理器 */
  handle(name: string, fn: (args: Record<string, unknown>) => unknown | Promise<unknown>): void
  say(text: string, options?: { durationMs?: number }): void
  react(state: string, options?: { returnTo?: string; durationMs?: number }): void
  setState(state: string): void
  setSkin(pluginId: string): void
  move(delta: { dx?: number; dy?: number; to?: string }): void
  registerCommand(command: { id: string; title: string; run: () => void }): void
  storage: PluginStorage
  notify(title: string, body?: string): void
  /** 受 network.hosts 白名单约束的 fetch */
  fetch(url: string, init?: RequestInit): Promise<Response>
  /** 调用当前聊天后端（走 provider 插件） */
  chat(messages: ChatMessage[], options?: { provider?: string; onDelta?: (t: string) => void }): Promise<string>
  timer: {
    every(ms: number, fn: () => void): () => void
    after(ms: number, fn: () => void): () => void
  }
}

export interface PluginModule {
  activate?(ctx: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}

/* ------------------------------------------------------------------ *
 * 聊天
 * ------------------------------------------------------------------ */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  /** 使用哪个 provider 插件 id；缺省用配置里的默认值 */
  providerId?: string
  messages: ChatMessage[]
  /** 流式增量回调 */
  onDelta?: (chunk: string) => void
  signal?: AbortSignal
}

export interface ChatResult {
  text: string
  providerId: string
  model: string
  source?: 'local' | 'api'
  usage?: { promptTokens?: number; completionTokens?: number }
}

/* ------------------------------------------------------------------ *
 * 互动（摸头 / 视线跟随 / 漫游 / 躲避 / 待机 / 整点播报）
 * ------------------------------------------------------------------ */

export type ActivityLevel = 'low' | 'mid' | 'high'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 默认值取自 Petra（MIT）的行为参数：死区 20px、量程 260px、摸头冷却 1.5s、
 * 躲避半径 165px、速度 150px/s、活动三档 low/mid/high。
 */
export interface InteractionConfig {
  /** 视线跟随：宠物朝鼠标方向侧倾 */
  look: boolean
  lookDeadzone: number
  lookRange: number
  lookAmplitude: number
  lookTilt: number
  /** 摸头：轻点（位移 < 6px）触发的动作与回应 */
  pet: boolean
  petCooldownMs: number
  /** 亲密度：累计被摸次数（持久化） */
  patCount: number
  /** 躲避鼠标 */
  avoid: boolean
  avoidRadius: number
  avoidSpeed: number
  /** 闲逛漫游 */
  wander: boolean
  activity: ActivityLevel
  /** 0 = 用活动档位自带速度 */
  wanderSpeed: number
  /** 边缘待机：底边保持完整角色在实地上方，左右边缘窥探 */
  idleMode: boolean
  /** 旧版配置兼容字段；底边位置改由角色几何与地面约束计算 */
  idlePeek: number
  /** 整点播报（本地文案，零 token） */
  hourlyChime: boolean
  chimeQuiet: boolean
  /** 全屏游戏或演示时暂停自动活动与主动消息 */
  fullscreenQuiet: boolean
}

export const DEFAULT_INTERACTION: InteractionConfig = {
  look: true,
  lookDeadzone: 20,
  lookRange: 260,
  lookAmplitude: 8,
  lookTilt: 3,
  pet: true,
  petCooldownMs: 1500,
  patCount: 0,
  avoid: false,
  avoidRadius: 165,
  avoidSpeed: 150,
  wander: true,
  activity: 'low',
  wanderSpeed: 0,
  idleMode: false,
  idlePeek: 60,
  hourlyChime: true,
  chimeQuiet: true,
  fullscreenQuiet: true,
}

/* ------------------------------------------------------------------ *
 * 应用配置
 * ------------------------------------------------------------------ */

export interface AppConfig {
  /** 当前皮肤插件 id */
  skin: string
  /** 当前主题插件 id */
  theme: string
  /** 默认聊天后端插件 id */
  chatProvider: string
  /** 宠物窗口左上角坐标（DIP） */
  position: { x: number; y: number } | null
  /** 上次所在显示器 id，用于多屏恢复 */
  displayId: number | null
  /** 整体缩放 */
  scale: number
  /** 舞台尺寸（宠物 + 气泡预留空间） */
  stage: { width: number; height: number }
  /** 默认点击穿透，鼠标命中宠物本体/气泡时才可交互 */
  clickThrough: boolean
  alwaysOnTop: boolean
  launchAtLogin: boolean
  /** 互动行为（摸头 / 视线跟随 / 漫游 / 躲避 / 待机 / 整点播报） */
  interaction: InteractionConfig
  /** 每个插件的配置覆盖 */
  pluginConfig: Record<string, Record<string, unknown>>
  /** 禁用的插件 id */
  disabled: string[]
  /** 聊天后端密钥，按 apiKeyRef 存（只落在用户目录，不进仓库） */
  secrets: Record<string, string>
  /** 是否显示对话调试日志 */
  debug: boolean
}

export const DEFAULT_CONFIG: AppConfig = {
  skin: 'builtin.blue-maid',
  theme: 'builtin.bubble-default',
  chatProvider: 'builtin.chat-openai',
  position: null,
  displayId: null,
  scale: 1,
  stage: { width: 360, height: 420 },
  clickThrough: true,
  alwaysOnTop: true,
  launchAtLogin: false,
  interaction: { ...DEFAULT_INTERACTION },
  pluginConfig: {},
  disabled: [],
  secrets: {},
  debug: false,
}
