export interface BubbleCallbacks {
  onSend(text: string): void
  onInputOpen?(open: boolean): void
  getPetBounds?(): DOMRect
  onCancel?(): void
}

/**
 * 气泡 UI：插件说话（整段 + 打字机）与用户对话（流式追加）共用同一个组件。
 * 纯净 DOM，无框架依赖——这也是选 Web 技术栈的主要理由：换皮就是换 CSS 变量。
 */
export class Bubble {
  private readonly el = document.getElementById('bubble') as HTMLDivElement
  private readonly textEl = document.getElementById('bubble-text') as HTMLDivElement
  private readonly chipsEl = document.getElementById('bubble-chips') as HTMLDivElement
  private readonly inputRow = document.getElementById('bubble-input-row') as HTMLDivElement
  private readonly input = document.getElementById('chat-input') as HTMLInputElement
  private readonly hintEl = document.getElementById('bubble-hint') as HTMLDivElement
  private typeTimer: number | null = null
  private hideTimer: number | null = null
  private streaming = false
  private hovering = false
  private viewport: { left: number; top: number; right: number; bottom: number } | null = null
  private posture = 'none'
  private surface: { top: number; bottom: number } | null = null

  constructor(private readonly cb: BubbleCallbacks) {
    document.getElementById('bubble-close')?.addEventListener('click', () => this.hide())
    this.el.addEventListener('mouseenter', () => { this.hovering = true; if (this.hideTimer !== null) clearTimeout(this.hideTimer) })
    this.el.addEventListener('mouseleave', () => { this.hovering = false; if (!this.streaming && !this.inputVisible()) this.scheduleHide(4500) })
    let resizeFrame = 0
    new ResizeObserver(() => {
      if (resizeFrame) return
      resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; this.reposition() })
    }).observe(this.el)
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        const text = this.input.value.trim()
        if (!text) return
        this.input.value = ''
        this.setInputVisible(false)
        this.cb.onSend(text)
      } else if (e.key === 'Escape') {
        this.hide()
      }
      e.stopPropagation()
    })
    this.input.addEventListener('pointerdown', (e) => e.stopPropagation())
    // 气泡里的交互（选中文字、点 chip）不应该触发拖动
    this.el.addEventListener('pointerdown', (e) => {
      const target = e.target as HTMLElement
      if (target.tagName !== 'INPUT') e.stopPropagation()
    })
  }

  setViewport(viewport: { left: number; top: number; right: number; bottom: number }): void { this.viewport = viewport; this.reposition() }
  setPosture(posture: string, surface?: { top: number; bottom: number }): void { this.posture = posture; this.surface = surface ?? null; this.reposition() }

  private reposition(): void {
    if (!this.isVisible()) return
    const visible = { ...(this.viewport ?? { left: 0, top: 0, right: innerWidth, bottom: innerHeight }) }
    if (this.posture === 'lounge-bottom' && this.surface) visible.bottom = Math.min(visible.bottom, this.surface.bottom)
    const pet = this.cb.getPetBounds?.()
    if (!pet) return
    this.el.style.maxWidth = `${Math.max(100, Math.min(270, visible.right - visible.left - 16))}px`
    const size = this.el.getBoundingClientRect()
    let top = pet.top - size.height - 10
    if (this.posture === 'hang-top') top = pet.bottom + 10
    if (top < visible.top + 6 && pet.bottom + 10 + size.height < visible.bottom) top = pet.bottom + 10
    this.el.style.bottom = 'auto'
    this.el.style.top = `${Math.round(Math.max(visible.top + 6, Math.min(top, visible.bottom - size.height - 6)))}px`
    this.el.style.left = `${Math.round(Math.max(visible.left + 6, Math.min(pet.left + pet.width / 2 - size.width / 2, visible.right - size.width - 6)))}px`
    this.el.style.transform = 'none'
  }

  private scheduleHide(durationMs: number): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer)
    this.hideTimer = window.setTimeout(() => { if (!this.streaming && !this.inputVisible() && !this.hovering) this.hide() }, durationMs)
  }

  isVisible(): boolean {
    return !this.el.classList.contains('hidden')
  }

  rect(): DOMRect | null {
    return this.isVisible() ? this.el.getBoundingClientRect() : null
  }

  setHint(text: string): void {
    this.hintEl.textContent = text
  }

  /** 插件说话：整段文字 + 打字机效果 */
  show(text: string, options: { typewriter?: boolean; hint?: string; durationMs?: number } = {}): void {
    if (this.streaming || this.inputVisible()) return
    this.clearTimer()
    this.setChips([])
    this.el.classList.remove('hidden')
    this.setText('')
    this.streaming = false
    this.textEl.classList.remove('streaming')
    this.setHint(options.hint ?? '')
    const chars = [...text]
    if (options.typewriter === false || chars.length === 0) {
      this.setText(text)
    } else {
      let i = 0
      const step = Math.max(12, Math.min(45, 1200 / Math.max(1, chars.length)))
      this.typeTimer = window.setInterval(() => {
        i += 1
        this.setText(chars.slice(0, i).join(''))
        if (i >= chars.length && this.typeTimer !== null) { clearInterval(this.typeTimer); this.typeTimer = null }
      }, step)
    }
    this.scheduleHide(options.durationMs ?? Math.min(8000, Math.max(3200, 2000 + chars.length * 65)))
    this.reposition()
  }

  /** 用户发问：开一个流式气泡 */
  startStreaming(hint = '思考中…'): void {
    this.clearTimer()
    this.setChips([])
    this.el.classList.remove('hidden')
    this.setText('')
    this.streaming = true
    this.textEl.classList.add('streaming')
    this.setHint(hint)
  }

  appendDelta(chunk: string): void {
    if (!this.isVisible()) this.startStreaming('')
    if (this.hintEl.textContent === '思考中…') this.setHint('')
    this.setText((this.textEl.textContent ?? '') + chunk)
  }

  finishStreaming(options: { text?: string; error?: string; hint?: string } = {}): void {
    this.streaming = false
    this.textEl.classList.remove('streaming')
    if (options.error) {
      this.setText(options.error)
      this.setHint('聊天失败')
      this.scheduleHide(10000)
      return
    }
    if (options.text !== undefined) this.setText(options.text)
    this.setHint(options.hint ?? '')
    this.scheduleHide(10000)
  }

  hide(): void {
    if (this.streaming) this.cb.onCancel?.()
    this.clearTimer()
    this.streaming = false
    this.textEl.classList.remove('streaming')
    this.el.classList.add('hidden')
    this.setInputVisible(false)
    this.setChips([])
  }

  setChips(items: Array<{ label: string; onClick: () => void }>): void {
    this.chipsEl.innerHTML = ''
    if (!items.length) {
      this.chipsEl.classList.add('hidden')
      return
    }
    this.chipsEl.classList.remove('hidden')
    for (const item of items) {
      const btn = document.createElement('button')
      btn.className = 'chip'
      btn.type = 'button'
      btn.textContent = item.label
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        item.onClick()
      })
      this.chipsEl.appendChild(btn)
    }
  }

  toggleInput(force?: boolean): void {
    const next = force ?? this.inputRow.classList.contains('hidden')
    this.setInputVisible(next)
  }

  inputVisible(): boolean {
    return !this.inputRow.classList.contains('hidden')
  }

  private setInputVisible(visible: boolean): void {
    this.inputRow.classList.toggle('hidden', !visible)
    this.el.classList.toggle('editing', visible)
    if (visible) {
      this.clearTimer()
      this.el.classList.remove('hidden')
      this.input.focus()
      this.setHint('Enter 发送 · Esc 关闭')
    } else {
      this.input.blur()
    }
    this.cb.onInputOpen?.(visible)
    this.reposition()
  }

  private setText(text: string): void {
    const followBottom = this.textEl.scrollHeight - this.textEl.scrollTop - this.textEl.clientHeight < 24
    this.textEl.textContent = text
    if (followBottom) this.textEl.scrollTop = this.textEl.scrollHeight
    this.reposition()
  }

  private clearTimer(): void {
    if (this.typeTimer !== null) {
      clearInterval(this.typeTimer)
      this.typeTimer = null
    }
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
  }
}
