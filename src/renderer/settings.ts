import type { ConfigField, PluginRecord, ResolvedSkin } from '../shared/types.js'
import { actionBindingReport } from '../shared/action-profile.js'
import type { BootstrapData } from './api.js'

/**
 * 设置中心的渲染逻辑。
 *
 * 它和桌宠窗口共用同一个 preload API（`window.deskpet`），所以不需要为设置界面另开一套
 * IPC；「聊天与人格」页的表单完全由插件自己的 `configSchema` 生成——以后你写新的聊天插件，
 * 这里会自动长出对应字段，不需要改这个文件。
 */
const api = window.deskpet

type ChatProbe = {
  pluginId: string
  name: string
  model: string
  type: string
  reachable: boolean
  detail: string
  models?: string[]
}

let boot: BootstrapData
let providers: ChatProbe[] = []
let plugins: PluginRecord[] = []
let selectedProvider = ''
let chatRenderSeq = 0

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

function packUrl(pluginId: string, rel: string): string {
  return `deskpet://pack/${encodeURIComponent(pluginId)}/${rel.split('/').map(encodeURIComponent).join('/')}`
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = String(value)
    else if (key in node) (node as unknown as Record<string, unknown>)[key] = value
    else node.setAttribute(key, String(value))
  }
  for (const child of children) node.append(child)
  return node
}

function fieldControl(key: string, field: ConfigField, value: unknown): HTMLElement {
  const wrap = el('div')
  const label = el('label', { class: 'field' } as never, field.label || key)
  if (field.description) label.append(el('span', { class: 'tip' } as never, field.description))
  wrap.append(label)

  let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  if (field.type === 'select') {
    const select = el('select')
    for (const opt of field.options) {
      const o = el('option', { value: opt.value } as never, opt.label)
      if (String(value ?? field.default ?? '') === opt.value) o.selected = true
      select.append(o)
    }
    control = select
  } else if (field.type === 'boolean') {
    const row = el('label', { class: 'switch' } as never)
    const box = el('input', { type: 'checkbox' } as never) as HTMLInputElement
    box.checked = Boolean(value ?? field.default)
    box.dataset.key = key
    box.dataset.kind = 'boolean'
    row.append(box, el('span', {} as never, (value ?? field.default) ? '已开启' : '已关闭'))
    box.addEventListener('change', () => {
      row.lastElementChild!.textContent = box.checked ? '已开启' : '已关闭'
    })
    wrap.append(row)
    return wrap
  } else if (field.type === 'textarea') {
    const area = el('textarea')
    area.value = String(value ?? field.default ?? '')
    control = area
  } else {
    const input = el('input', { type: field.type === 'number' ? 'number' : 'text' } as never)
    input.value = String(value ?? field.default ?? '')
    control = input
  }
  control.dataset.key = key
  control.dataset.kind = field.type
  wrap.append(el('div', { class: 'field-row' } as never, control))
  return wrap
}

function status(text: string, kind: 'ok' | 'bad' | '' = ''): void {
  const node = $('provider-status')
  node.textContent = text
  node.className = 'status' + (kind ? ' ' + kind : '')
}

/* ------------------------------------------------------------------ *
 * 页签
 * ------------------------------------------------------------------ */

function showTab(tab: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('#tabs .tab')) {
    button.classList.toggle('active', button.dataset.tab === tab)
  }
  for (const page of document.querySelectorAll<HTMLElement>('.page')) {
    page.classList.toggle('active', page.dataset.page === tab)
  }
}

/* ------------------------------------------------------------------ *
 * 聊天与人格
 * ------------------------------------------------------------------ */

/** 真探一次各后端：会打 /models 或 /api/tags，失败也只是标成不可达 */
async function refreshProviders(): Promise<void> {
  try {
    providers = (await api.chatProviders()) as ChatProbe[]
    await renderChat()
  } catch (err) {
    api.log('探测聊天后端失败', String(err))
  }
}

async function renderChat(): Promise<void> {
  const renderSeq = ++chatRenderSeq
  const chatPlugins = plugins.filter((p) => p.manifest.kind === 'chat')
  const select = $<HTMLSelectElement>('provider-select')
  select.replaceChildren()
  for (const p of chatPlugins) {
    const probe = providers.find((x) => x.pluginId === p.id)
    const suffix = probe ? (probe.reachable ? ' · 可达' : ' · 不可达') : ''
    select.append(el('option', { value: p.id } as never, `${p.manifest.name}${suffix}`))
  }
  if (!chatPlugins.some((p) => p.id === selectedProvider)) {
    selectedProvider = boot.config.chatProvider || chatPlugins[0]?.id || ''
  }
  select.value = selectedProvider

  const defSelect = $<HTMLSelectElement>('default-provider')
  defSelect.replaceChildren()
  for (const p of chatPlugins) defSelect.append(el('option', { value: p.id } as never, p.manifest.name))
  defSelect.value = boot.config.chatProvider

  const record = chatPlugins.find((p) => p.id === selectedProvider)
  const form = $('provider-form')
  form.replaceChildren()
  if (!record) {
    form.append(el('p', {} as never, '没有可用的聊天后端插件（kind = chat）。'))
    return
  }

  const schema = record.manifest.configSchema ?? {}
  const values = await api.pluginConfigGet(record.id)
  if (renderSeq !== chatRenderSeq) return

  form.append(el('h2', {} as never, `${record.manifest.name} · 参数`))
  for (const [key, field] of Object.entries(schema)) {
    form.append(fieldControl(key, field, values[key]))
  }

  const chatDef = record.manifest.data?.chat as { apiKeyRef?: string; requiresApiKey?: boolean } | undefined
  if (chatDef?.apiKeyRef) {
    const ref = chatDef.apiKeyRef
    const masked = boot.secrets?.[ref]
    const wrap = el('div')
    wrap.append(
      el(
        'label',
        { class: 'field' } as never,
        `API Key${chatDef.requiresApiKey ? '（必填）' : '（可选）'}`,
        el('span', { class: 'tip' } as never, masked ? `已保存：${masked}` : '尚未设置'),
      ),
    )
    const input = el('input', { type: 'password' } as never) as HTMLInputElement
    input.placeholder = masked ? '要更换就填新的，留空不动' : 'sk-...'
    const save = el('button', { class: 'btn' } as never, '保存 Key')
    const clear = el('button', { class: 'btn ghost' } as never, '清除')
    save.addEventListener('click', async () => {
      if (!input.value.trim()) return
      await api.secretSet(ref, input.value.trim())
      input.value = ''
      status('Key 已保存（只存在本机配置文件里）', 'ok')
      boot = await api.bootstrap()
      await renderChat()
    })
    clear.addEventListener('click', async () => {
      await api.secretClear(ref)
      status('Key 已清除')
      boot = await api.bootstrap()
      await renderChat()
    })
    wrap.append(el('div', { class: 'field-row' } as never, input, save, clear))
    form.append(wrap)
  }

  const save = el('button', { class: 'btn' } as never, '保存参数')
  save.addEventListener('click', async () => {
    const patch: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(schema)) {
      const input = form.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        `[data-key="${key}"]`,
      )
      if (!input) continue
      if (field.type === 'boolean') patch[key] = (input as HTMLInputElement).checked
      else if (field.type === 'number') patch[key] = Number(input.value)
      else patch[key] = input.value
    }
    await api.pluginConfigSet(record.id, patch)
    status('参数已保存', 'ok')
    providers = await api.chatProviders()
    await renderChat()
  })
  form.append(el('div', { class: 'field-row' } as never, save))

  const probe = providers.find((p) => p.pluginId === record.id)
  status(
    probe ? `${probe.reachable ? '可达' : '不可达'}：${probe.detail ?? '无详情'}` : '未探测（点「测试连接」）',
    probe ? (probe.reachable ? 'ok' : 'bad') : '',
  )
  if (probe?.models?.length) {
    const list = el('p', { class: 'hint' } as never, '可用模型：' + probe.models.join('、'))
    form.append(list)
  }
}

/* ------------------------------------------------------------------ *
 * 外形与模型
 * ------------------------------------------------------------------ */

function renderSkins(): void {
  const skins = plugins.filter((p) => p.manifest.kind === 'skin' && p.ok)
  const current = plugins.find((p) => p.id === boot.config.skin)
  const currentBox = $('skin-current')
  currentBox.replaceChildren()
  if (current) {
    const skin: ResolvedSkin | null = boot.skin
    currentBox.append(
      el('div', { class: 'row' } as never, el('strong', {} as never, `当前外形：${current.manifest.name}`)),
      el(
        'p',
        { class: 'hint' } as never,
        `${skin?.kind === 'rig' ? skin.rig.layers.length + ' 图层 · 2.5D' : skin?.kind === 'live2d' ? 'Live2D · ' + skin.motions.length + ' 个动作组' : Object.keys(skin?.atlas.frames ?? {}).length + ' 帧'} · 来源 ${current.source === 'builtin' ? '内置' : '用户插件'}`,
      ),
    )
    const previews = el('div', { class: 'row' })
    for (const [state, label] of Object.entries({ front: '正面', side: '侧面', back: '背面', wave: '打招呼', walk: '移动', shy: '害羞', happy: '开心', surprised: '惊讶', angry: '生气', sleepy: '瞌睡', dizzy: '晕鱼', love: '喜欢', unimpressed: '无语', sad: '悲伤', neutral: '平静', 'sleep-curl': '蜷缩睡眠' })) {
      if (skin?.kind === 'sprite' && !boot.states?.states[state] && !actionBindingReport(boot.states?.states ?? {}, skin.actionProfile).some(item => item.action === state && item.mode === 'bound')) continue
      if (skin?.kind === 'live2d' && ['front', 'side', 'back'].includes(state)) continue
      const button = el('button', { class: 'btn ghost' }, skin?.kind === 'live2d' && state === 'sleep-curl' ? '闭眼休息' : label)
      button.addEventListener('click', () => void api.invokePlugin({ kind: 'command', pluginId: 'builtin', name: `pose-${state}` }))
      previews.append(button)
    }
    currentBox.append(previews)
    const sizeRow = el('div', { class: 'row' })
    const size = el('input', { type: 'number', min: '0.5', max: '2', step: '0.1', value: String(boot.config.scale), ariaLabel: '角色大小' })
    const saveSize = el('button', { class: 'btn ghost' }, '应用大小')
    saveSize.addEventListener('click', async () => {
      const scale = Number(size.value)
      if (!Number.isFinite(scale) || scale < 0.5 || scale > 2 || !skin) return
      const dimensions = skin.kind === 'rig' ? skin.rig.canvas : skin.frameSize
      const width = ('w' in dimensions ? dimensions.w : 128) * skin.scale * scale
      const height = ('h' in dimensions ? dimensions.h : 128) * skin.scale * scale
      await api.setConfig({ scale, stage: { width: Math.max(360, Math.ceil(width + 64)), height: Math.max(420, Math.ceil(height + 180)) } })
      boot = await api.bootstrap()
      renderSkins()
    })
    sizeRow.append(el('label', {}, '角色大小（0.5–2 倍）'), size, saveSize)
    currentBox.append(sizeRow)
    const bindingStatus = skin?.kind === 'sprite' ? actionBindingReport(boot.states?.states ?? {}, skin.actionProfile) : []
    currentBox.append(el('p', { class: 'hint' }, bindingStatus.length ? `现有动作：${bindingStatus.filter(item => item.mode === 'bound').length} 项已绑定，${bindingStatus.filter(item => item.mode === 'fallback').length} 项使用替代动作。新人物导入时自动生成 action-profile.json。` : '动作逻辑可复用；表情、视线和口型按人物已有参数绑定，全身姿势取决于模型素材。'))
    const exportActions = el('button', { class: 'btn ghost' }, '导出当前人物动作模板')
    exportActions.addEventListener('click', async () => {
      exportActions.disabled = true
      try {
        const result = await api.exportActionProfile()
        exportActions.textContent = result.ok ? '已导出，可按新人物修改绑定' : result.error ?? '导出未完成'
        if (result.dir) exportActions.title = result.dir
      } catch { exportActions.textContent = '导出失败，请检查目录权限' }
      finally { exportActions.disabled = false }
    })
    currentBox.append(exportActions)
  } else {
    currentBox.append(el('p', {} as never, '当前外形不可用，检查插件校验结果。'))
  }

  const list = $('skin-list')
  list.replaceChildren()
  for (const p of skins) {
    const icon = p.manifest.icon ?? p.manifest.data?.spritesheet ?? ''
    const card = el('button', { type: 'button', class: 'skin' + (p.id === boot.config.skin ? ' active' : '') })
    card.disabled = !p.enabled
    card.title = p.enabled ? `使用 ${p.manifest.name}` : '先在插件页启用这个外形'
    if (icon) card.append(el('img', { src: packUrl(p.id, icon), alt: '' } as never))
    card.append(
      el('div', { class: 'name' } as never, p.manifest.name),
      el('div', { class: 'meta' } as never, `${p.source === 'builtin' ? '内置' : '用户'} · ${p.manifest.data?.live2d ? 'Live2D' : p.manifest.data?.rig ? '分层 2.5D' : '精灵图'}`),
    )
    card.addEventListener('click', async () => {
      if (p.id === boot.config.skin) return
      const res = await api.setSkin(p.id)
      if (res.ok) {
        boot = await api.bootstrap()
        renderSkins()
      }
    })
    list.append(card)
  }
}

function renderLive2dNote(): void {
  $('live2d-note').textContent =
    boot.capabilities?.live2d === false ? '此框架内测版未包含 Live2D；支持图片、精灵图和 PSD 模型导入。' : 'Live2D 已支持 model3.json、moc3、纹理与模型自带动作。没有绑定的全身动作会温和回退；模型素材与 Core 许可分别保留。'
}

/* ------------------------------------------------------------------ *
 * 插件
 * ------------------------------------------------------------------ */

async function renderPlugins(): Promise<void> {
  plugins = await api.listPlugins()
  const list = $('plugin-list')
  list.replaceChildren()
  for (const p of plugins) {
    const item = el('div', { class: 'item' + (p.ok ? '' : ' bad') })
    const left = el('div')
    const title = el('div', { class: 'title' } as never)
    title.append(
      el('strong', {} as never, p.manifest.name),
      el('span', { class: 'badge' } as never, p.manifest.kind),
      el('span', { class: 'badge' } as never, p.manifest.runtime),
      el('span', { class: 'badge' } as never, p.source === 'builtin' ? '内置' : '用户'),
      el('span', { class: 'badge' } as never, `v${p.manifest.version}`),
    )
    left.append(title)
    if (p.manifest.description) left.append(el('div', { class: 'desc' } as never, p.manifest.description))
    if (!p.ok && p.errors.length) left.append(el('div', { class: 'err' } as never, p.errors.join('\n')))
    else if (p.warnings.length) left.append(el('div', { class: 'desc' } as never, '⚠ ' + p.warnings.join('；')))

    const toggle = el('label', { class: 'switch' } as never)
    const box = el('input', { type: 'checkbox' } as never) as HTMLInputElement
    box.checked = p.enabled
    box.addEventListener('change', async () => {
      box.disabled = true
      await api.togglePlugin(p.id, box.checked)
      $('plugin-status').textContent = box.checked ? `已启用 ${p.manifest.name}` : `已禁用 ${p.manifest.name}`
      await renderPlugins()
      boot = await api.bootstrap()
      renderSkins()
    })
    toggle.append(box, el('span', {} as never, '启用'))
    item.append(left, toggle)
    list.append(item)
  }
}

/* ------------------------------------------------------------------ *
 * 关于
 * ------------------------------------------------------------------ */

async function renderAbout(): Promise<void> {
  if (boot.capabilities?.live2d === false) {
    $('live2d-about').textContent = '此框架内测版未包含日和素材与 Live2D Core。可在模型库切换角色，支持图片、精灵图与 PSD 导入。'
    $('live2d-about-binding').hidden = true
  }
  const diag = await api.diag()
  const box = $('about-diag')
  box.replaceChildren()
  const dl = el('dl', { class: 'kv' } as never)
  const rows: Array<[string, string]> = [
    ['应用版本', diag.versions.app ?? '—'],
    ['Electron', diag.versions.electron],
    ['Chromium', diag.versions.chrome],
    ['Node', diag.versions.node],
    ['数据目录', diag.paths.userData],
    ['显示器', diag.displays.map((d) => `${d.bounds.width}×${d.bounds.height}@${d.scaleFactor}x${d.primary ? '（主）' : ''}`).join('，')],
  ]
  for (const [k, v] of rows) dl.append(el('dt', {} as never, k), el('dd', {} as never, v))
  box.append(dl)
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  boot = await api.bootstrap()
  plugins = boot.plugins
  // boot.providers 只有 id/name，没有 reachable/detail —— 那是"声明"不是"探测结果"。
  // 先把状态留空，再在后台真探一次（不阻塞页面渲染）。
  providers = []
  void refreshProviders()

  $('version').textContent = `v${boot.version}`
  showTab(new URLSearchParams(location.search).get('tab') ?? 'chat')
  api.onSettingsTab(({ tab }) => showTab(tab))

  for (const button of document.querySelectorAll<HTMLButtonElement>('#tabs .tab')) {
    button.addEventListener('click', () => showTab(button.dataset.tab ?? 'chat'))
  }
  $('open-data').addEventListener('click', () => void api.openPath('data'))
  $('open-plugins').addEventListener('click', () => void api.openPath('plugins'))

  $('provider-select').addEventListener('change', async (e) => {
    selectedProvider = (e.target as HTMLSelectElement).value
    await renderChat()
  })
  $('provider-test').addEventListener('click', async () => {
    status('探测中…')
    providers = await api.chatProviders()
    await renderChat()
  })
  $('provider-default-save').addEventListener('click', async () => {
    const value = $<HTMLSelectElement>('default-provider').value
    await api.setConfig({ chatProvider: value })
    boot = await api.bootstrap()
    status('已设为默认后端', 'ok')
  })
  $('plugin-reload').addEventListener('click', async () => {
    $('plugin-status').textContent = '重新加载中…'
    plugins = await api.reloadPlugins()
    boot = await api.bootstrap()
    await renderPlugins()
    renderSkins()
    $('plugin-status').textContent = `已重新加载 ${plugins.length} 个插件`
  })

  renderLive2dNote()
  const { renderDialoguePage } = await import('./settings-dialogue.js')
  await renderDialoguePage(api)
  renderSkins()
  await renderPlugins()
  await renderChat()
  // 动态 import：模型导入与互动两页各自成模块，避免 settings.ts 继续膨胀
  const { renderModelPage } = await import('./settings-model.js')
  renderModelPage({
    api,
    live2dAvailable: boot.capabilities?.live2d,
    refresh: async () => {
      plugins = await api.listPlugins()
      boot = await api.bootstrap()
      renderSkins()
    },
    log: (...args: unknown[]) => api.log('设置中心', ...args),
  })
  const { renderInteractionPage } = await import('./settings-interaction.js')
  renderInteractionPage({
    api,
    getConfig: () => boot.config,
    saveConfig: async (patch) => {
      await api.setConfig(patch)
      boot = await api.bootstrap()
    },
    log: (...args: unknown[]) => api.log('设置中心', ...args),
  })
  await renderAbout()
  api.report('settings:ready', { tab: document.querySelector('.tab.active')?.getAttribute('data-tab') ?? '' })
  api.log('设置中心渲染层就绪')
}

void main().catch((err) => {
  api.report('renderer:error', { message: `settings main() 失败: ${String(err)}` })
})
