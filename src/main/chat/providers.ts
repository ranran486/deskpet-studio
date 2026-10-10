import { isConfigRef } from '../../shared/types.js'
import type { ChatMessage, ChatProviderDef, ChatRequest, ChatResult } from '../../shared/types.js'
import { log } from '../logger.js'

/** `data.chat` 里带 {config:"x"} 的字段解析成具体值之后的样子 */
export type ResolvedChatProvider = Omit<
  ChatProviderDef,
  'baseUrl' | 'model' | 'systemPrompt' | 'temperature' | 'maxTokens'
> & {
  baseUrl: string
  model: string
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
}

/**
 * 把后端声明按插件自己的配置解析成具体值。
 * "数据插件也能读配置"是这套插件系统的关键一环：换个模型、换个地址都不用改代码。
 */
export function resolveProvider(def: ChatProviderDef, config: Record<string, unknown> = {}): ResolvedChatProvider {
  const pick = (value: unknown, fallback: unknown): unknown => {
    if (isConfigRef(value)) return config[value.config] ?? fallback
    return value ?? fallback
  }
  return {
    ...def,
    baseUrl: String(pick(def.baseUrl, '')),
    model: String(pick(def.model, '')),
    systemPrompt:
      def.systemPrompt === undefined ? undefined : String(pick(def.systemPrompt, '')),
    temperature: def.temperature === undefined ? undefined : Number(pick(def.temperature, 0)),
    maxTokens: def.maxTokens === undefined ? undefined : Number(pick(def.maxTokens, 0)),
  }
}

export class ChatError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'ChatError'
  }
}

function buildBody(def: ChatProviderDef, messages: ChatMessage[], stream: boolean): string {
  const base: Record<string, unknown> = { model: def.model, messages, stream }
  if (def.temperature !== undefined) base.temperature = def.temperature
  if (def.maxTokens !== undefined) base.max_tokens = def.maxTokens
  return JSON.stringify(base)
}

function headers(def: ChatProviderDef, apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json', ...(def.headers ?? {}) }
  if (apiKey) h.authorization = `Bearer ${apiKey}`
  return h
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path
}

async function fail(res: Response, url: string): Promise<never> {
  let body = ''
  try {
    body = (await res.text()).slice(0, 400)
  } catch {
    /* ignore */
  }
  throw new ChatError(`${url} 返回 ${res.status} ${res.statusText}`, body)
}

/**
 * 流式对话。两个内置协议族：
 *  - ollama：`POST /api/chat`，NDJSON，每行 `{message:{content}, done}`
 *  - openai-compatible：`POST /chat/completions`，SSE，`data: {...}` / `data: [DONE]`
 *    （DeepSeek、通义、vLLM、LM Studio 等都吃这一套）
 */
export async function streamChat(
  def: ResolvedChatProvider,
  req: ChatRequest,
  apiKey: string | undefined,
  providerId: string,
): Promise<ChatResult> {
  const isOllama = def.type === 'ollama'
  const url = isOllama ? joinUrl(def.baseUrl, '/api/chat') : joinUrl(def.baseUrl, '/chat/completions')

  if (def.requiresApiKey && !apiKey) {
    throw new ChatError(`聊天后端「${providerId}」需要 API key`, '打开设置 → 聊天与人格，填写 API Key 并点击「保存 Key」')
  }

  // 角色设定在这里注入一次：无论调用方是渲染层气泡还是插件 chat.ask，行为一致
  const messages: ChatMessage[] =
    def.systemPrompt && req.messages[0]?.role !== 'system'
      ? [{ role: 'system', content: def.systemPrompt }, ...req.messages]
      : req.messages

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers(def, apiKey),
      body: buildBody(def, messages, true),
      signal: req.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new ChatError(
      `连不上聊天后端 ${url}`,
      isOllama
        ? '本机 Ollama 没在跑？先执行 `ollama serve`，或把默认后端换成 OpenAI 兼容的云端接口。'
        : `原始错误：${(err as Error).message}`,
    )
  }
  if (!res.ok) await fail(res, url)
  if (!res.body) throw new ChatError(`${url} 没有返回流式响应体`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let model = def.model

  const handleLine = (line: string): boolean => {
    const trimmed = line.trim()
    if (!trimmed) return false
    if (isOllama) {
      let obj: { message?: { content?: string }; response?: string; done?: boolean; model?: string }
      try {
        obj = JSON.parse(trimmed)
      } catch {
        return false
      }
      if (obj.model) model = obj.model
      const chunk = obj.message?.content ?? obj.response ?? ''
      if (chunk) {
        text += chunk
        req.onDelta?.(chunk)
      }
      return obj.done === true
    }
    if (!trimmed.startsWith('data:')) return false
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') return true
    let obj: { choices?: Array<{ delta?: { content?: string } }>; model?: string }
    try {
      obj = JSON.parse(payload)
    } catch {
      return false
    }
    if (obj.model) model = obj.model
    const chunk = obj.choices?.[0]?.delta?.content ?? ''
    if (chunk) {
      text += chunk
      req.onDelta?.(chunk)
    }
    return false
  }

  let done = false
  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read()
      if (streamDone) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (handleLine(line)) {
          done = true
          break
        }
      }
    }
    if (buffer.trim()) handleLine(buffer)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  if (!text) log.warn(`聊天后端 ${providerId} 返回了空内容`)
  return { text, providerId, model }
}

/**
 * 探测后端是否可达、有哪些模型（selfcheck 与设置界面用，不产生对话开销）。
 */
export async function probeProvider(
  def: ResolvedChatProvider,
  apiKey: string | undefined,
): Promise<{ reachable: boolean; detail: string; models?: string[] }> {
  const isOllama = def.type === 'ollama'
  const url = isOllama ? joinUrl(def.baseUrl, '/api/tags') : joinUrl(def.baseUrl, '/models')
  if (def.requiresApiKey && !apiKey) return { reachable: false, detail: '尚未配置 Key，可先使用本地闲聊' }
  try {
    const res = await fetch(url, { headers: headers(def, apiKey), signal: AbortSignal.timeout(4000) })
    if (!res.ok) return { reachable: false, detail: `HTTP ${res.status}` }
    const body = (await res.json()) as { models?: Array<{ name?: string; id?: string }>; data?: Array<{ id?: string }> }
    const list = (body.models ?? body.data ?? []) as Array<{ name?: string; id?: string }>
    const models = list.map((m) => m.name ?? m.id ?? '').filter(Boolean)
    return { reachable: true, detail: `${models.length} 个模型`, models: models.slice(0, 12) }
  } catch (err) {
    return { reachable: false, detail: (err as Error).message }
  }
}
