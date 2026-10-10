import { DEFAULT_INTERACTION, type ActivityLevel, type AppConfig, type InteractionConfig } from '../shared/types.js'
import type { DeskPetApi } from './api.js'

/**
 * 设置中心的「互动」页。
 *
 * 单独一个文件的原因：设置页已经有聊天/插件/关于三块，互动这块字段最多（7 个开关 +
 * 9 个数值 + 1 个档位），塞进 settings.ts 会让那个文件失控。动态 import 进来即可，
 * 不需要在 settings.ts 顶部加静态 import（也就少改一处）。
 */

export interface InteractionPageDeps {
  api: DeskPetApi
  getConfig: () => AppConfig
  saveConfig: (patch: Partial<AppConfig>) => Promise<void>
  log: (...args: unknown[]) => void
}

type FieldType = 'switch' | 'number' | 'select'

interface FieldSpec {
  key: keyof InteractionConfig
  label: string
  tip?: string
  type: FieldType
  min?: number
  max?: number
  step?: number
  options?: Array<{ label: string; value: string }>
}

/** 字段顺序 = 界面上从"最常动"到"很少动" */
const FIELDS: FieldSpec[] = [
  { key: 'look', label: '视线跟随', type: 'switch', tip: '宠物会朝鼠标方向侧倾（分层模型可做眼/头两级）' },
  { key: 'pet', label: '摸头反应', type: 'switch', tip: '轻点（位移 < 6px）算摸头，会切动作并回应一句' },
  { key: 'avoid', label: '躲避鼠标', type: 'switch', tip: '鼠标靠近到一定半径内就挪开' },
  { key: 'wander', label: '闲逛漫游', type: 'switch', tip: '自己挑目标点走动，撞不到屏幕边缘' },
  { key: 'activity', label: '活动频率', type: 'select', tip: '档位决定漫游速度、目标半径与休息时长',
    options: [
      { label: '低（默认，轻度活动）', value: 'low' },
      { label: '中', value: 'mid' },
      { label: '高（活泼）', value: 'high' },
    ] },
  { key: 'idleMode', label: '边缘待机', type: 'switch', tip: '靠近下边缘蜷缩睡眠，左右边缘窥探；拖动可以唤醒' },
  { key: 'hourlyChime', label: '整点播报', type: 'switch', tip: '整点用本地文案报时，不消耗任何 token' },
  { key: 'chimeQuiet', label: '免打扰', type: 'switch', tip: '23:00–08:00 不播报' },
  { key: 'fullscreenQuiet', label: '全屏时安静', type: 'switch', tip: 'Windows 全屏游戏或演示时暂停动画、漫游和主动消息，退出后自动恢复' },

  { key: 'lookDeadzone', label: '视线死区 (px)', type: 'number', min: 0, max: 200, step: 5, tip: '这个距离内不做反应，避免抖动' },
  { key: 'lookRange', label: '视线量程 (px)', type: 'number', min: 40, max: 1200, step: 20, tip: '到这个距离达到最大偏转' },
  { key: 'lookAmplitude', label: '偏移幅度 (px)', type: 'number', min: 0, max: 40, step: 1 },
  { key: 'lookTilt', label: '侧倾角度 (°)', type: 'number', min: 0, max: 20, step: 0.5 },
  { key: 'petCooldownMs', label: '摸头冷却 (ms)', type: 'number', min: 0, max: 10_000, step: 100 },
  { key: 'avoidRadius', label: '躲避半径 (px)', type: 'number', min: 40, max: 800, step: 5 },
  { key: 'avoidSpeed', label: '躲避速度 (px/s)', type: 'number', min: 20, max: 800, step: 10 },
  { key: 'wanderSpeed', label: '漫游速度覆盖', type: 'number', min: 0, max: 600, step: 5, tip: '0 = 用活动档位自带的速度' },
]

function control(type: FieldType, value: unknown, spec: FieldSpec): HTMLElement {
  if (type === 'switch') {
    const row = document.createElement('label')
    row.className = 'switch'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = Boolean(value)
    box.dataset.key = spec.key
    const text = document.createElement('span')
    text.textContent = box.checked ? '已开启' : '已关闭'
    box.addEventListener('change', () => {
      text.textContent = box.checked ? '已开启' : '已关闭'
    })
    row.append(box, text)
    return row
  }
  if (type === 'select') {
    const select = document.createElement('select')
    select.dataset.key = spec.key
    for (const opt of spec.options ?? []) {
      const o = document.createElement('option')
      o.value = opt.value
      o.textContent = opt.label
      if (String(value) === opt.value) o.selected = true
      select.append(o)
    }
    return select
  }
  const input = document.createElement('input')
  input.type = 'number'
  if (spec.min !== undefined) input.min = String(spec.min)
  if (spec.max !== undefined) input.max = String(spec.max)
  if (spec.step !== undefined) input.step = String(spec.step)
  input.value = String(value ?? 0)
  input.dataset.key = spec.key
  return input
}

function readValue(node: HTMLElement, spec: FieldSpec): unknown {
  const input = node.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-key="${spec.key}"]`)
  if (!input) return undefined
  if (spec.type === 'switch') return (input as HTMLInputElement).checked
  if (spec.type === 'select') return input.value
  return Number(input.value)
}

export function renderInteractionPage(deps: InteractionPageDeps): void {
  const mount = document.getElementById('interaction-form')
  if (!mount) return
  mount.className = 'card'
  mount.replaceChildren()

  const current = deps.getConfig().interaction

  const groups: Array<{ title: string; keys: Array<keyof InteractionConfig> }> = [
    { title: '行为开关', keys: ['look', 'pet', 'avoid', 'wander', 'activity', 'idleMode', 'hourlyChime', 'chimeQuiet', 'fullscreenQuiet'] },
    { title: '参数', keys: ['lookDeadzone', 'lookRange', 'lookAmplitude', 'lookTilt', 'petCooldownMs', 'avoidRadius', 'avoidSpeed', 'wanderSpeed'] },
  ]

  const readAll = (): Partial<InteractionConfig> => {
    const patch: Record<string, unknown> = {}
    for (const spec of FIELDS) {
      const holder = mount.querySelector<HTMLElement>(`[data-holder="${spec.key}"]`)
      if (!holder) continue
      const value = readValue(holder, spec)
      if (value === undefined) continue
      patch[spec.key] = spec.type === 'number' ? Number(value) : value
    }
    return patch as Partial<InteractionConfig>
  }

  for (const group of groups) {
    const h = document.createElement('h2')
    h.textContent = group.title
    mount.append(h)
    for (const key of group.keys) {
      const spec = FIELDS.find((f) => f.key === key)
      if (!spec) continue
      const row = document.createElement('div')
      row.className = 'row'
      row.dataset.holder = spec.key
      const label = document.createElement('label')
      label.textContent = spec.label
      label.style.minWidth = '150px'
      row.append(label, control(spec.type, current[key], spec))
      mount.append(row)
      if (spec.tip) {
        const tip = document.createElement('p')
        tip.className = 'hint'
        tip.style.margin = '0 0 6px 150px'
        tip.textContent = spec.tip
        mount.append(tip)
      }
    }
  }

  const stats = document.createElement('p')
  stats.className = 'hint'
  stats.textContent = `已摸头 ${current.patCount} 次`
  mount.append(stats)

  const actions = document.createElement('div')
  actions.className = 'row'
  const save = document.createElement('button')
  save.className = 'btn'
  save.textContent = '保存互动设置'
  const reset = document.createElement('button')
  reset.className = 'btn ghost'
  reset.textContent = '恢复默认'
  const clearCount = document.createElement('button')
  clearCount.className = 'btn ghost'
  clearCount.textContent = '清零摸头计数'
  const status = document.createElement('span')
  status.className = 'status'

  const refresh = (message: string, ok = true): void => {
    status.textContent = message
    status.className = 'status' + (ok ? ' ok' : ' bad')
  }

  save.addEventListener('click', async () => {
    const patch = readAll()
    await deps.saveConfig({ interaction: { ...current, ...patch } })
    refresh('已保存')
    deps.log('互动设置已保存', JSON.stringify(patch))
  })
  reset.addEventListener('click', async () => {
    await deps.saveConfig({ interaction: { ...DEFAULT_INTERACTION, patCount: current.patCount } })
    refresh('已恢复默认')
    renderInteractionPage(deps)
  })
  clearCount.addEventListener('click', async () => {
    await deps.saveConfig({ interaction: { ...current, ...readAll(), patCount: 0 } })
    refresh('计数已清零')
    renderInteractionPage(deps)
  })

  actions.append(save, reset, clearCount, status)
  mount.append(actions)

  // 待机模式是个"立刻看出来"的开关，勾上就先应用一次，省得用户以为没生效
  const idleBox = mount.querySelector<HTMLInputElement>('input[data-key="idleMode"]')
  idleBox?.addEventListener('change', async () => {
    await deps.saveConfig({ interaction: { ...current, ...readAll(), idleMode: idleBox.checked } })
    refresh(idleBox.checked ? '已进入待机模式（沉到屏幕底边）' : '已退出待机模式')
  })
}

export type { ActivityLevel }
