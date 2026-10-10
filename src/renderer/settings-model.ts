import type { DeskPetApi } from './api.js'

/**
 * 设置中心「外形与模型」页里的**导入向导**。
 *
 * 单独一个模块（动态 import 进来），因为它要处理的"导入结果"形态很多：
 * 成功（装成了插件）、识别到但暂不支持（PSD / Live2D）、失败（图集越界、没有图片…）。
 * 三态都要给用户明确的下一步，而不是一句"导入失败"。
 */

export interface ModelPageDeps {
  api: DeskPetApi
  /** 重新拉取插件列表并重画皮肤网格（settings.ts 提供） */
  refresh: () => Promise<void>
  log: (...args: unknown[]) => void
  live2dAvailable?: boolean
}

type ImportKind = 'auto' | 'frames' | 'sheet' | 'image' | 'psd' | 'live2d'

interface ImportResult {
  ok: boolean
  pluginId?: string
  name?: string
  format?: string
  frames?: number
  layers?: number
  states?: Array<{ name: string; frames: number }>
  warnings: string[]
  error?: string
  detected?: string
}

const BUTTONS: Array<{ kind: ImportKind; label: string; tip: string }> = [
  { kind: 'auto', label: '导入文件夹（自动识别）', tip: '最省事：把素材文件夹整个丢进来，自动判断是帧序列 / PSD / Live2D' },
  { kind: 'frames', label: '导入帧序列', tip: '一堆 PNG。命名建议 idle_0.png / wave_0.png，前缀决定"状态"' },
  { kind: 'sheet', label: '导入精灵图 + JSON', tip: 'Aseprite 导出的图集：选 PNG 与 JSON（frameTags 会变成状态）' },
  { kind: 'image', label: '导入单张图片', tip: 'PNG / GIF / APNG 当作单帧外形（动图目前只取第一帧）' },
  { kind: 'psd', label: '导入 PSD（自动装配 2.5D）', tip: '分层 PSD → 自动识别脸/眼/嘴/发/身体，装成会呼吸、会眨眼、会看你的角色（需要 ag-psd）' },
  { kind: 'live2d', label: '导入 Live2D', tip: '选择含 model3.json、moc3 和纹理的完整文件夹，导入后使用模型自带绑定与动作' },
]

function resultCard(result: ImportResult, deps: ModelPageDeps, onUse: (id: string) => void): HTMLElement {
  const card = document.createElement('div')
  card.className = 'card'
  const head = document.createElement('div')
  head.className = 'row'
  const title = document.createElement('strong')
  title.textContent = result.ok ? '✅ 导入成功' : result.detected && result.detected !== 'unknown' ? '🔍 识别到了，但还不能直接用' : '⚠️ 导入失败'
  head.append(title)
  card.append(head)

  const detail = document.createElement('p')
  if (result.ok) {
    const stateText = (result.states ?? []).map((s) => `${s.name}(${s.frames})`).join(' / ')
    const rigText = result.layers ? `${result.layers} 个图层（2.5D 装配）` : `${result.frames} 帧`
    detail.textContent = `${result.name} · ${rigText} · 状态：${stateText || '无'} · 插件 id：${result.pluginId}`
  } else {
    detail.textContent = result.error ?? '未知原因'
  }
  card.append(detail)

  if (result.warnings.length) {
    const warn = document.createElement('p')
    warn.className = 'hint'
    warn.textContent = '注意：' + result.warnings.join('；')
    card.append(warn)
  }

  const actions = document.createElement('div')
  actions.className = 'row'
  if (result.ok && result.pluginId) {
    const use = document.createElement('button')
    use.className = 'btn'
    use.textContent = '立即使用'
    use.addEventListener('click', () => onUse(result.pluginId!))
    actions.append(use)
  }
  const openDir = document.createElement('button')
  openDir.className = 'btn ghost'
  openDir.textContent = '打开导入目录'
  openDir.addEventListener('click', () => void deps.api.openPath('imported'))
  actions.append(openDir)
  card.append(actions)
  return card
}

export function renderModelPage(deps: ModelPageDeps): void {
  const mount = document.getElementById('model-import-tools')
  if (!mount) return
  mount.className = 'card'
  mount.replaceChildren()

  const h = document.createElement('h2')
  h.textContent = '导入模型'
  mount.append(h)

  const status = document.createElement('p')
  status.className = 'hint'
  status.textContent = '支持的格式与对应做法见每个按钮的说明。导入后立刻出现在上面的模型库里，点一下即可切换。'
  mount.append(status)

  const row = document.createElement('div')
  row.className = 'row'
  const results = document.createElement('div')
  results.className = 'list'

  const run = async (kind: ImportKind): Promise<void> => {
    status.textContent = '正在导入…'
    results.replaceChildren()
    let result: ImportResult
    try {
      result = (await deps.api.skinImport(kind)) as ImportResult
    } catch (err) {
      result = { ok: false, warnings: [], error: String(err) }
    }
    status.textContent = result.ok ? '导入完成' : '导入未完成'
    deps.log('模型导入结果', kind, JSON.stringify({ ok: result.ok, id: result.pluginId, detected: result.detected }))
    results.append(
      resultCard(result, deps, (id) => {
        void deps.api.setSkin(id).then(async (res) => {
          if (res.ok) {
            await deps.refresh()
            status.textContent = '已切换到这个外形'
          }
        })
      }),
    )
    if (result.ok) await deps.refresh()
  }

  for (const spec of BUTTONS) {
    if (spec.kind === 'live2d' && deps.live2dAvailable === false) continue
    const button = document.createElement('button')
    button.className = spec.kind === 'auto' ? 'btn' : 'btn ghost'
    button.textContent = spec.label
    button.title = spec.tip
    button.addEventListener('click', () => void run(spec.kind))
    row.append(button)
  }
  mount.append(row)

  const tips = document.createElement('p')
  tips.className = 'hint'
  for (const spec of BUTTONS) {
    if (spec.kind === 'live2d' && deps.live2dAvailable === false) continue
    const line = document.createElement('div')
    line.textContent = `· ${spec.label}：${spec.tip}`
    tips.append(line)
  }
  mount.append(tips)
  mount.append(results)
}
