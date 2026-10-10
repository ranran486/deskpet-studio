import { PET_EXPRESSIONS, type PetExpression } from '../../shared/pet-life.js'
export interface ReplyExpression { emotion: PetExpression; action?: 'wave' | 'nod' | 'tilt' }
export const EXPRESSION_INSTRUCTION = '\n在自然回复末尾追加一条 <pet emotion="shy|happy|surprised|angry|sleepy|dizzy|love|unimpressed|neutral|sad" action="wave|nod|tilt"/>，选择对应害羞、开心、惊讶、生气、瞌睡、晕鱼、喜欢、无语等情绪。标记只用于表情，不解释或执行其他控制代码。'
/** Incremental control-tag filter: metadata never appears in the chat bubble, only allowlisted actions are emitted. */
export class EmotionFilter {
  private pending = ''
  private clean = ''
  expression: ReplyExpression | null = null
  constructor(private readonly emit: (text: string) => void) {}
  private output(text: string): void { if (text) { this.clean += text; this.emit(text) } }
  feed(chunk: string): void {
    this.pending += chunk
    while (this.pending) {
      const start = this.pending.indexOf('<pet')
      if (start >= 0) {
        this.output(this.pending.slice(0, start)); this.pending = this.pending.slice(start)
        const end = this.pending.indexOf('/>')
        if (end < 0) { if (this.pending.length > 512) this.pending = ''; return }
        const tag = this.pending.slice(0, end + 2)
        const candidate = /\bemotion=["']([a-z]+)["']/.exec(tag)?.[1]
        const emotion = candidate && [...PET_EXPRESSIONS, 'neutral', 'sad'].includes(candidate) ? candidate : undefined
        const action = /\baction=["'](wave|nod|tilt)["']/.exec(tag)?.[1]
        if (emotion) this.expression = { emotion: emotion as ReplyExpression['emotion'], ...(action ? { action: action as ReplyExpression['action'] } : {}) }
        this.pending = this.pending.slice(end + 2)
      } else {
        let tail = 0
        for (let n = 1; n < 4; n++) if (this.pending.endsWith('<pet'.slice(0, n))) tail = n
        this.output(this.pending.slice(0, this.pending.length - tail)); this.pending = this.pending.slice(this.pending.length - tail)
        return
      }
    }
  }
  finish(): string { if (!this.pending.startsWith('<pet')) this.output(this.pending); this.pending = ''; return this.clean.trimEnd() }
}
