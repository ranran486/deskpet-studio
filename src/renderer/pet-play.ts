import { FOODS, PetLifeEngine, type PetLifeSnapshot, type PetInteraction } from '../shared/pet-life.js'
export class PetPlayUI {
  state = new PetLifeEngine().snapshot()
  private panel = document.getElementById('feed-panel')!
  private effects = document.getElementById('pet-effects')!
  private posture = 'none'
  private viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
  private surface: { top: number; bottom: number } | null = null
  constructor(private readonly bounds: () => DOMRect) {
    const foods = document.getElementById('food-options')!
    for (const food of FOODS) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.food = food.id; button.title = food.name
      const icon = document.createElement('span'); icon.className = 'food-icon'; icon.textContent = food.icon
      const label = document.createElement('span'); label.textContent = food.name; button.append(icon, label)
      button.addEventListener('click', () => {
        foods.querySelectorAll('button').forEach(node => { node.disabled = true })
        void window.deskpet.petInteract('feed', food.id).finally(() => setTimeout(() => foods.querySelectorAll('button').forEach(node => { node.disabled = false }), 420))
      })
      foods.append(button)
    }
    document.getElementById('feed-close')!.addEventListener('click', () => this.hide())
    this.panel.addEventListener('pointerdown', event => event.stopPropagation())
  }
  show(): void { this.panel.classList.remove('hidden'); this.position(); void window.deskpet.petInteract('open-feed') }
  hide(): void { this.panel.classList.add('hidden') }
  rect(): DOMRect | null { return this.panel.classList.contains('hidden') ? null : this.panel.getBoundingClientRect() }
  setViewport(viewport: typeof this.viewport): void { this.viewport = viewport; this.position() }
  setSurface(surface?: { top: number; bottom: number }): void { this.surface = surface ?? null; this.position() }
  setPosture(posture: string): void { this.posture = posture; this.position() }
  position(): void {
    const pet = this.bounds(), v = this.viewport, panel = this.panel.getBoundingClientRect()
    this.panel.style.left = `${Math.round(Math.max(v.left + 6, Math.min(pet.x + pet.width / 2 - panel.width / 2, v.right - panel.width - 6)))}px`
    this.panel.style.top = `${Math.round(Math.max(v.top + 6, Math.min(pet.y - panel.height - 8, v.bottom - panel.height - 6)))}px`
    this.effects.style.left = `${Math.round(pet.x + pet.width / 2)}px`
    this.effects.style.top = `${Math.round(pet.y + pet.height * .17)}px`
    const ledge = document.getElementById('pose-ledge')!
    ledge.classList.toggle('hidden', this.posture !== 'lounge-bottom' && this.posture !== 'hang-top')
    ledge.style.left = `${Math.round(v.left)}px`; ledge.style.width = `${Math.round(v.right - v.left)}px`
    ledge.style.height = this.posture === 'hang-top' ? '2px' : '1px'
    ledge.style.boxShadow = 'none'
    ledge.style.top = `${Math.round(this.posture === 'hang-top' ? this.surface?.top ?? v.top : (this.surface?.bottom ?? v.bottom) - 1)}px`
  }
  update(state: PetLifeSnapshot): void {
    this.state = state
    const score = document.getElementById('mood-score')!, meter = document.getElementById('mood-fill')!
    score.textContent = `心情 ${state.mood}/100 · ${state.mood >= 75 ? '想撒娇' : state.mood < 35 ? '有点小脾气' : '心情不错'}`
    meter.style.width = `${state.mood}%`
    document.getElementById('feed-note')!.textContent = state.sameFoodCount >= 3 ? '同款已经吃三次啦，换个口味哄哄它吧。' : '选一份点心，看看它的小表情。'
    this.effects.replaceChildren(); this.effects.dataset.effect = state.effect ?? 'none'
    if (state.effect) {
      const symbol = state.effect === 'hearts' ? '♥' : state.effect === 'stars' ? '✦' : state.effect === 'zzz' ? 'z' : '♪'
      for (let index = 0; index < 3; index++) {
        const particle = document.createElement('span'); particle.textContent = symbol; particle.className = `particle ${state.effect}`
        particle.style.setProperty('--delay', `${index * .23}s`); particle.style.setProperty('--offset', `${(index - 1) * 18}px`)
        this.effects.append(particle)
      }
    }
    this.position()
  }
}

interface GestureOptions {
  canvas: HTMLCanvasElement; hit: (x: number, y: number) => boolean; bounds: () => DOMRect; dozing: () => boolean
  interact: (kind: PetInteraction) => void; pressed: (on: boolean) => void; dragStart: () => void; dragEnd: () => void; feed: () => void
}
/** Slow head strokes remain petting; deliberate large movement becomes collar dragging. */
export function wirePetGestures(options: GestureOptions): void {
  const { canvas } = options
  let down: { x: number; y: number; head: boolean; belly: boolean; woke: boolean } | null = null
  let dragging = false, rubbed = false, holdTimer = 0, clickTimer = 0
  const clearHold = (): void => { clearTimeout(holdTimer); holdTimer = 0 }
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !options.hit(event.clientX, event.clientY)) return
    const bounds = options.bounds(), ratio = (event.clientY - bounds.y) / bounds.height
    down = { x: event.clientX, y: event.clientY, head: ratio < .48, belly: ratio >= .55 && ratio < .88, woke: options.dozing() }
    rubbed = false; options.pressed(true); options.interact('touch')
    try { canvas.setPointerCapture(event.pointerId) } catch { /* no active pointer in synthetic clients */ }
    if (down.head && !down.woke) holdTimer = window.setTimeout(() => { if (down && !dragging) { rubbed = true; options.interact('rub') } }, 650)
  })
  canvas.addEventListener('pointermove', event => {
    if (!down) {
      if (options.dozing() && options.hit(event.clientX, event.clientY)) options.interact('touch')
      return
    }
    if (dragging) return
    const distance = Math.hypot(event.clientX - down.x, event.clientY - down.y)
    if (distance <= (down.head ? 18 : 6)) return
    clearHold(); clearTimeout(clickTimer); dragging = true; options.dragStart()
  })
  window.addEventListener('pointerup', event => {
    if (!down) return
    clearHold(); const started = down; down = null; options.pressed(false)
    if (dragging) { dragging = false; options.dragEnd(); return }
    if (rubbed || started.woke || Math.hypot(event.clientX - started.x, event.clientY - started.y) > 18) return
    clearTimeout(clickTimer)
    clickTimer = window.setTimeout(() => options.interact(started.belly ? 'tickle' : 'pat'), 240)
  })
  window.addEventListener('pointercancel', () => { clearHold(); clearTimeout(clickTimer); down = null; options.pressed(false); if (dragging) { dragging = false; options.dragEnd() } })
  canvas.addEventListener('dblclick', event => { if (!options.hit(event.clientX, event.clientY)) return; clearHold(); clearTimeout(clickTimer); options.feed() })
}
