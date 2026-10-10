import fs from 'node:fs'
import path from 'node:path'
import type { PetHost } from '../host.js'
import { IPC } from '../../shared/ipc.js'
import { PetLifeEngine, FOODS, type PetDecision, type PetInteraction, type FoodId, type PetLifeState } from '../../shared/pet-life.js'
import { DialoguePicker } from './dialogue.js'
import { DialogueStore } from './dialogue-store.js'
import { ACTION_DIALOGUE, type DialogueSettingsSnapshot } from '../../shared/dialogue-settings.js'
import type { ChatRequest, ChatResult } from '../../shared/types.js'

export class PetLifeService {
  readonly engine: PetLifeEngine
  readonly dialogue: DialoguePicker
  private timer: NodeJS.Timeout | null = null
  private settleTimer: NodeJS.Timeout | null = null
  private disposers: Array<() => void> = []
  private dragging = false
  private resting = false
  private restingKey = ''
  private busy = 0
  private chatterAt = 0
  private lastPatAt = 0
  private readonly stateFile: string
  private readonly sleepAfterMs: number
  private readonly textStore: DialogueStore
  constructor(private readonly host: PetHost, root: string, dataDir: string) {
    this.stateFile = path.join(dataDir, 'pet-life.json')
    let saved: Partial<PetLifeState> = {}
    try { saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) } catch { /* first launch */ }
    this.engine = new PetLifeEngine(saved)
    this.textStore = new DialogueStore(path.join(root, 'assets/dialogue.zh-CN.json'), path.join(dataDir, 'dialogue.zh-CN.json'))
    this.dialogue = new DialoguePicker(this.textStore.snapshot().catalog)
    this.sleepAfterMs = process.argv.includes('--test-gameplay') ? Math.max(1000, Number(process.env.DESKPET_TEST_SLEEP_MS) || 90000) : 90000
  }
  private name(): string { return this.host.config.data.skin === 'builtin.blue-maid' ? '蓝鲸' : this.host.config.data.skin.includes('hiyori') ? '日和' : this.host.config.data.skin.includes('cat') ? '小橘' : this.host.registry.get(this.host.config.data.skin)?.manifest.name.split('·')[0].trim().slice(0, 16) || '小搭子' }
  dialogueSettings(): DialogueSettingsSnapshot { return this.textStore.snapshot() }
  saveDialogue(updates: unknown): DialogueSettingsSnapshot {
    const snapshot = this.textStore.save(updates)
    this.dialogue.replaceCatalog(snapshot.catalog)
    return snapshot
  }
  previewDialogue(group: string, lines: unknown): { text: string; shown: boolean } {
    const valid = this.textStore.validateEdits({ [group]: lines })[group]
    const food = FOODS.find(item => item.id === group.replace('feed_', '')) ?? FOODS.find(item => item.id === this.engine.state.lastFood)
    const text = valid[0].replaceAll('{name}', this.name()).replaceAll('{food}', food?.name ?? '这个点心')
    const shown = !this.busy && !this.host.quietMode && !this.engine.dozing && !!this.host.win?.win?.isVisible()
    if (shown) this.host.send(IPC.bubbleShow, { text, durationMs: 6000, local: true, allowWhileResting: this.resting, allowWhileDragging: this.dragging })
    return { text, shown }
  }
  sayAction(state: string): void {
    const group = ACTION_DIALOGUE[state]
    if (!group || this.busy || this.dragging || this.resting || this.host.quietMode || this.engine.dozing) return
    this.host.send(IPC.bubbleShow, { text: this.dialogue.pick(group, { name: this.name() }), durationMs: 3500, local: true })
  }
  private save(): void { fs.writeFileSync(this.stateFile + '.tmp', JSON.stringify(this.engine.state, null, 2)); fs.renameSync(this.stateFile + '.tmp', this.stateFile) }
  private publish(decision?: PetDecision): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.host.send(IPC.petLife, this.engine.snapshot())
    if (decision) {
      this.save()
      const text = this.dialogue.pick(decision.group, { name: this.name(), food: decision.food })
      this.host.send(IPC.bubbleShow, { text, durationMs: 3500, local: true, allowWhileResting: this.resting })
    }
    if (!this.engine.dozing) this.settleTimer = setTimeout(() => { this.engine.settle(); if (!this.busy) this.host.send(IPC.petLife, this.engine.snapshot()) }, this.engine.snapshot().durationMs)
  }
  interact(kind: PetInteraction, food?: FoodId): void {
    if (kind === 'pat' || kind === 'rub') {
      if (!this.host.config.data.interaction.pet || Date.now() - this.lastPatAt < this.host.config.data.interaction.petCooldownMs) return
      this.lastPatAt = Date.now()
    }
    const decision = this.engine.interact(kind, Date.now(), food)
    if (decision) this.publish(decision)
  }
  beginChat(): void { this.busy++; this.interact('touch') }
  endChat(): void { this.busy = Math.max(0, this.busy - 1); this.engine.lastActivity = Date.now() }
  start(): void {
    this.disposers.push(this.host.on('click', event => { if (!event.data?.localHandled) this.interact('pat') }))
    this.disposers.push(this.host.on('drag:start', () => { this.dragging = true; this.interact('touch'); this.host.send(IPC.bubbleShow, { text: this.dialogue.pick('struggle'), durationMs: 5000, local: true, allowWhileDragging: true }) }))
    this.disposers.push(this.host.on('drag:end', () => { this.dragging = false; if (!this.resting) this.interact('drag') }))
    this.disposers.push(this.host.on('behavior:changed' as never, event => {
      const resting = Boolean(event.data?.idleMode)
      const restingKey = `${event.data?.edge}:${event.data?.posture}`
      if (resting && (!this.resting || restingKey !== this.restingKey)) {
        this.resting = true
        const group = event.data?.edge === 'left' ? 'peek_left' : event.data?.edge === 'right' ? 'peek_right' : event.data?.edge === 'top' ? 'hang' : event.data?.posture === 'sleep-curl' ? 'floor' : 'lounge'
        this.host.send(IPC.bubbleShow, { text: this.dialogue.pick(group, { name: this.name() }), durationMs: group === 'hang' ? 6000 : 3500, local: true, allowWhileResting: true })
      } else this.resting = resting
      this.restingKey = resting ? restingKey : ''
    }))
    this.timer = setInterval(() => {
      const paused = this.host.quietMode || this.dragging || this.resting || this.busy > 0 || !this.host.win?.win?.isVisible()
      const now = Date.now(), sleep = this.engine.tick(now, paused, this.sleepAfterMs)
      if (sleep) this.publish(sleep)
      else if (!paused && !this.engine.dozing && now - this.engine.lastActivity >= 45000 && now - this.chatterAt >= 300000) { this.chatterAt = now; this.publish(this.engine.idle()) }
    }, 1000)
    const greeting = setTimeout(() => { if (!this.host.quietMode && !this.resting && !this.busy && Date.now() - this.engine.lastActivity >= 1000) this.host.send(IPC.bubbleShow, { text: this.dialogue.pick('startup', { name: this.name() }), durationMs: 3500, local: true }) }, 1600)
    this.disposers.push(() => clearTimeout(greeting))
  }
  stop(): void { if (this.timer) clearInterval(this.timer); if (this.settleTimer) clearTimeout(this.settleTimer); this.disposers.splice(0).forEach(dispose => dispose()) }
  async reply(req: ChatRequest, emit: (text: string) => void): Promise<ChatResult> {
    const response = this.dialogue.reply(req.messages.filter(message => message.role === 'user').at(-1)?.content ?? '', this.name())
    const chars = [...response.text]
    for (let index = 0; index < chars.length; index += 3) {
      req.signal?.throwIfAborted()
      emit(chars.slice(index, index + 3).join(''))
      await new Promise<void>(resolve => setTimeout(resolve, 32))
    }
    req.signal?.throwIfAborted()
    this.host.send(IPC.expressionApply, { emotion: response.emotion })
    return { text: response.text, providerId: 'builtin.local-text', model: 'local-dialogue-v1', source: 'local' }
  }
}
