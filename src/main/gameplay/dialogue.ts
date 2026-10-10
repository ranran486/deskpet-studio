import type { PetExpression } from '../../shared/pet-life.js'
import type { DialogueCatalog } from '../../shared/dialogue-settings.js'
export type { DialogueCatalog } from '../../shared/dialogue-settings.js'
export function validateCatalog(raw: unknown): DialogueCatalog {
  const catalog = raw as DialogueCatalog
  if (catalog?.version !== 1 || !catalog.groups || typeof catalog.groups !== 'object' || Array.isArray(catalog.groups)) throw new Error('本地文案格式无效')
  for (const [group, lines] of Object.entries(catalog.groups)) {
    if (['__proto__', 'constructor', 'prototype'].includes(group) || !Array.isArray(lines) || !lines.length || lines.length > 100 || lines.some(line => typeof line !== 'string' || !line.trim() || line.length > 180)) throw new Error(`文案组无效：${group}`)
  }
  return catalog
}
/** Upgrade only the previously seeded pose lines; retain user-written replacements. */
export function upgradePoseDialogue(custom: DialogueCatalog, builtIn: DialogueCatalog): DialogueCatalog {
  const oldHang = ['倒挂金钩！咦，世界怎么反过来了？', '我的发尾在替我试探重力呢。', '头朝下也要保持可爱，哼哼！', '快看，我的视角和你不一样啦。', '血都要流到脑子里了，待会儿就下来！', '这次是主动倒挂，不是被你拎着哦。']
  return JSON.stringify(custom.groups.hang) === JSON.stringify(oldHang) ? { ...custom, groups: { ...custom.groups, hang: builtIn.groups.hang } } : custom
}
export class DialoguePicker {
  private previous = new Map<string, number>()
  constructor(readonly catalog: DialogueCatalog, private readonly random = Math.random) {}
  replaceCatalog(catalog: DialogueCatalog): void { this.catalog.groups = structuredClone(catalog.groups); this.catalog.style = catalog.style; this.previous.clear() }
  pick(group: string, values: { name?: string; food?: string } = {}): string {
    const lines = this.catalog.groups[group] ?? this.catalog.groups.chat_unknown
    if (!lines?.length) return '我在这里陪你呀。'
    const previous = this.previous.get(group), candidates = lines.map((_, index) => index).filter(index => lines.length === 1 || index !== previous)
    const index = candidates[Math.min(candidates.length - 1, Math.max(0, Math.floor(this.random() * candidates.length)))]
    this.previous.set(group, index)
    return lines[index].replaceAll('{name}', values.name ?? '小搭子').replaceAll('{food}', values.food ?? '这个点心')
  }
  reply(text: string, name: string): { text: string; emotion: PetExpression } {
    const rules: Array<[RegExp, string, PetExpression]> = [
      [/晚安|睡觉|去睡|good\s*night/i, 'chat_goodnight', 'sleepy'],
      [/你是谁|叫什么|名字|who are you/i, 'chat_identity', 'happy'],
      [/怎么玩|帮助|玩法|怎么喂|怎么摸|help/i, 'chat_help', 'happy'],
      [/难过|伤心|不开心|委屈|失落|孤单|抱抱/, 'chat_sad', 'sad'],
      [/累了|好累|疲惫|辛苦|困了|压力/, 'chat_tired', 'shy'],
      [/喜欢你|爱你|可爱|好看|漂亮|贴贴/, 'chat_affection', 'love'],
      [/谢谢|感谢|thank/i, 'chat_thanks', 'happy'],
      [/饿|吃饭|点心|蛋糕|喂食/, 'chat_hungry', 'love'],
      [/无聊|没意思|玩一会|逗逗/, 'chat_bored', 'surprised'],
      [/你好|早安|早上好|下午好|晚上好|在吗|hello|^hi\b|^嗨/i, 'chat_greeting', 'happy'],
    ]
    const match = rules.find(([pattern]) => pattern.test(text))
    return { text: this.pick(match?.[1] ?? 'chat_unknown', { name }), emotion: match?.[2] ?? 'neutral' }
  }
}
