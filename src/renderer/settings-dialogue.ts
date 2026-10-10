import type { DeskPetApi } from './api.js'
import { DIALOGUE_CATEGORIES, DIALOGUE_GROUP_INFO, type DialogueSettingsSnapshot } from '../shared/dialogue-settings.js'

export async function renderDialoguePage(api: DeskPetApi): Promise<void> {
  const root = document.getElementById('dialogue-editor')!
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const element = document.createElement(tag); element.textContent = text; return element }
  const drafts = new Map<string, string>()
  let snapshot: DialogueSettingsSnapshot, selected = '', busy = false
  const toolbar = node('div'); toolbar.className = 'row'
  const category = node('select'); category.id = 'dialogue-category'; category.setAttribute('aria-label', '文案分类')
  const group = node('select'); group.id = 'dialogue-group'; group.setAttribute('aria-label', '动作或互动')
  const search = node('input'); search.id = 'dialogue-search'; search.type = 'text'; search.placeholder = '搜索动作、玩法或食物'; search.setAttribute('aria-label', '搜索文案分组')
  toolbar.append(category, group, search)
  const title = node('h2'), hint = node('p'); hint.className = 'hint'
  const editor = node('textarea'); editor.id = 'dialogue-lines'; editor.rows = 11; editor.maxLength = 19000; editor.setAttribute('aria-label', '台词（每行一句）')
  const count = node('p'); count.className = 'hint'; count.id = 'dialogue-count'
  const actions = node('div'); actions.className = 'row'
  const save = node('button', '保存本组'), saveAll = node('button', '保存全部修改'), defaults = node('button', '填入默认'), preview = node('button', '预览台词')
  for (const button of [save, saveAll, defaults, preview]) { button.className = 'btn'; button.type = 'button' }
  save.id = 'dialogue-save'; saveAll.id = 'dialogue-save-all'; defaults.id = 'dialogue-default'; preview.id = 'dialogue-preview'
  const status = node('p'); status.className = 'status'; status.id = 'dialogue-status'; status.setAttribute('role', 'status')
  const sample = node('div'); sample.id = 'dialogue-sample'; sample.className = 'dialogue-sample'; sample.setAttribute('aria-label', '台词预览')
  actions.append(save, saveAll, defaults, preview)
  root.replaceChildren(toolbar, title, hint, editor, count, actions, status, sample)
  const lines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const info = (id: string) => DIALOGUE_GROUP_INFO[id] ?? { label: `自定义文案：${id}`, category: 'custom' }
  const updateButtons = () => {
    save.disabled = busy || !drafts.has(selected); saveAll.disabled = busy || !drafts.size
    defaults.disabled = busy || !snapshot?.defaults.groups[selected]; preview.disabled = busy || !selected
    editor.disabled = busy || !selected; category.disabled = group.disabled = search.disabled = busy
    count.textContent = `${lines(editor.value).length} 句 · ${drafts.size ? `${drafts.size} 个分组未保存` : '已保存'}。每组最多 100 句，每句最多 180 字符。`
  }
  const keepDraft = () => {
    if (!selected) return
    if (editor.value === snapshot.catalog.groups[selected].join('\n')) drafts.delete(selected)
    else drafts.set(selected, editor.value)
    updateButtons()
  }
  const display = () => {
    selected = group.value; title.textContent = selected ? info(selected).label : '未找到匹配的分组'
    hint.textContent = selected ? info(selected).description ?? '每行填写一句，触发时随机选用；{name} 替换为当前人物名字，{food} 替换为点心名字。' : '可以更换分类或清空搜索。'
    editor.value = selected ? drafts.get(selected) ?? snapshot.catalog.groups[selected].join('\n') : ''
    sample.textContent = ''; updateButtons()
  }
  const filter = () => {
    const previous = selected, query = search.value.trim().toLowerCase()
    group.replaceChildren()
    for (const id of Object.keys(snapshot.catalog.groups)) {
      const meta = info(id)
      if (meta.category !== category.value || (query && !(meta.label + id).toLowerCase().includes(query))) continue
      const option = node('option', meta.label); option.value = id; group.append(option)
    }
    if ([...group.options].some(option => option.value === previous)) group.value = previous
    display()
  }
  const perform = async (fn: () => Promise<void>) => {
    busy = true; updateButtons()
    try { await fn() } catch (error) { status.textContent = (error as Error).message || '操作失败，请重试' }
    finally { busy = false; updateButtons() }
  }
  const persist = (all: boolean) => perform(async () => {
    const updates = Object.fromEntries((all ? [...drafts] : [[selected, editor.value]]).map(([id, text]) => [id, lines(text)]))
    const result = await api.saveDialogue(updates)
    if (!result.ok || !result.snapshot) throw new Error(result.error ?? '保存失败')
    snapshot = result.snapshot; for (const id of Object.keys(updates)) drafts.delete(id)
    display(); status.textContent = '已保存并立即生效，所有人物共用，无需重启。'
  })
  editor.addEventListener('input', () => { keepDraft(); status.textContent = '编辑尚未生效。切换分组会保留草稿，关闭窗口前请保存。' })
  group.addEventListener('change', display); category.addEventListener('change', filter); search.addEventListener('input', filter)
  save.addEventListener('click', () => void persist(false)); saveAll.addEventListener('click', () => void persist(true))
  defaults.addEventListener('click', () => { editor.value = snapshot.defaults.groups[selected].join('\n'); keepDraft(); status.textContent = '已填入本组默认文案，点击保存后生效。' })
  preview.addEventListener('click', () => void perform(async () => {
    const result = await api.previewDialogue(selected, lines(editor.value))
    if (!result.ok) throw new Error(result.error ?? '预览失败')
    sample.textContent = result.text ?? ''
    status.textContent = result.shown ? '预览显示在下方，空闲的宠物气泡也会同步显示；预览不会保存修改。' : '当前宠物正在聊天、休息或安静模式，文字预览显示在下方。'
  }))
  try {
    snapshot = await api.dialogueSettings()
    if (!snapshot?.catalog) throw new Error('文案尚未就绪，请稍后重开设置。')
    const categories = new Set(Object.keys(snapshot.catalog.groups).map(id => info(id).category))
    for (const [id, label] of Object.entries(DIALOGUE_CATEGORIES)) if (categories.has(id)) { const option = node('option', label); option.value = id; category.append(option) }
    filter()
  } catch (error) { editor.disabled = true; for (const button of [save, saveAll, defaults, preview]) button.disabled = true; status.textContent = (error as Error).message }
}
