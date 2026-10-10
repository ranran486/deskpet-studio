export interface DialogueCatalog { version: number; style: string; groups: Record<string, string[]> }
export interface DialogueSettingsSnapshot { catalog: DialogueCatalog; defaults: DialogueCatalog }
export const DIALOGUE_CATEGORIES: Record<string, string> = { action: '动作与姿势', interaction: '互动与心情', food: '投喂反应', emotion: '情绪表情', chat: '离线聊天', custom: '其他自定义文案' }
export interface DialogueGroupInfo { label: string; category: string; action?: string; description?: string }
export const DIALOGUE_GROUP_INFO: Record<string, DialogueGroupInfo> = {}
const add = (category: string, labels: Record<string, string>) => { for (const [id, label] of Object.entries(labels)) DIALOGUE_GROUP_INFO[id] = { category, label } }
add('action', { startup: '启动问候', idle: '平常发呆', idle_high: '心情好时发呆', idle_low: '心情差时发呆', walk: '移动', wave: '打招呼', look_front: '正面展示', look_side: '侧面展示', look_back: '背面展示', struggle: '被提衣领／悬空挣扎', drag: '拖拽后落地', floor: '蜷缩睡眠', lounge: '趴在任务栏上沿', hang: '顶部倒挂', peek_left: '左侧窥探', peek_right: '右侧窥探' })
add('interaction', { pat: '轻触／摸摸', pat_high: '心情好时摸摸', rub: '摸头（按住轻抚）', tickle: '戳肚子', praise: '夸夸它', tease: '逗逗它', sleep: '空闲打瞌睡', wake: '被碰醒' })
add('food', { feed_fish: '小鱼干', feed_cake: '小蛋糕', feed_candy: '棒棒糖', feed_dango: '团子', feed_diamond: '钻石礼物', feed_repeat: '连续三次同款／嫌弃' })
add('chat', { chat_greeting: '打招呼', chat_goodnight: '晚安', chat_thanks: '感谢', chat_tired: '疲惫与压力', chat_sad: '伤心与安慰', chat_hungry: '饿了／想吃点心', chat_affection: '喜欢与贴贴', chat_bored: '无聊／想玩', chat_identity: '角色介绍', chat_help: '玩法帮助', chat_unknown: '其他话题' })
const emotions: Record<string, string> = { shy: '害羞', happy: '开心', surprised: '惊讶', angry: '生气', sleepy: '瞌睡', dizzy: '晕鱼', love: '喜欢', unimpressed: '无语', sad: '悲伤', neutral: '平静' }
export const ACTION_DIALOGUE: Record<string, string> = { walk: 'walk', wave: 'wave', front: 'look_front', side: 'look_side', back: 'look_back', 'sleep-curl': 'floor' }
for (const [state, label] of Object.entries(emotions)) { const id = `emote_${state}`; ACTION_DIALOGUE[state] = id; DIALOGUE_GROUP_INFO[id] = { category: 'emotion', label, action: `pose-${state}`, description: '手动触发表情时使用；摸头、投喂等仍使用对应互动台词，AI 回复保持原文。' } }
for (const [state, group] of Object.entries(ACTION_DIALOGUE)) DIALOGUE_GROUP_INFO[group].action = `pose-${state}`
for (const [group, edge] of Object.entries({ lounge: 'bottom', hang: 'top', peek_left: 'left', peek_right: 'right' })) DIALOGUE_GROUP_INFO[group].action = `dock-${edge}`
DIALOGUE_GROUP_INFO.walk.description = '手动触发移动时使用；自动漫游保持安静。'
