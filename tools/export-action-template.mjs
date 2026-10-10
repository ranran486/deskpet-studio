/** Export recipes from the current 37-frame blue-maid actions; no new moves or borrowed character art. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTION_MODEL_VERSION, ACTION_TIMING, restSkeleton } from '../dist/shared/action-model.js'
import { ACTION_PROFILE_VERSION, BODY_ACTIONS, ACTION_SEMANTICS, createActionProfile } from '../dist/shared/action-profile.js'
import { PET_EXPRESSIONS } from '../dist/shared/pet-life.js'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), output = path.join(root, 'templates/actions-v1')
const states = JSON.parse(fs.readFileSync(path.join(root, 'packs/blue-maid/states.json'), 'utf8')).states
const contactAnchors = JSON.parse(fs.readFileSync(path.join(root, 'packs/blue-maid/action-profile.json'), 'utf8')).anchors
fs.mkdirSync(output, { recursive: true })
const template = { version: ACTION_MODEL_VERSION, basedOn: 'builtin.blue-maid@0.3.0', priorities: ['drag-lift', 'edge-posture', 'talk', 'expression', 'walk', 'idle'], coordinates: 'character-local 0..1; preserve current model proportions and its own artwork', timing: ACTION_TIMING, body: Object.fromEntries(BODY_ACTIONS.map(name => [name, states[name]])), expressions: Object.fromEntries(PET_EXPRESSIONS.map(name => [name, states[name]])), joints: restSkeleton(), effects: { rub: 'hearts', tickle: 'laugh', feed: 'hearts', wake: 'stars', drag: 'stars', sleep: 'zzz' } }
template.contactAnchors = contactAnchors
fs.writeFileSync(path.join(output, 'template.json'), JSON.stringify(template, null, 2))
for (const kind of ['sprite', 'rig', 'live2d']) fs.writeFileSync(path.join(output, `action-profile.${kind}.json`), JSON.stringify(createActionProfile(kind), null, 2))
const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'DeskPet existing character action bindings', type: 'object', required: ['version', 'kind'], properties: { version: { const: ACTION_PROFILE_VERSION }, kind: { enum: ['sprite', 'rig', 'live2d'] }, states: { type: 'object', propertyNames: { enum: ACTION_SEMANTICS }, additionalProperties: { type: 'string', minLength: 1, maxLength: 128 } }, expressions: { type: 'object', additionalProperties: { type: 'string', minLength: 1, maxLength: 128 } }, parameters: { type: 'object', additionalProperties: { type: 'string', minLength: 1, maxLength: 128 } }, anchors: { type: 'object' }, joints: { type: 'object' }, motions: { type: 'object' } } }
fs.writeFileSync(path.join(output, 'action-profile.schema.json'), JSON.stringify(schema, null, 2))
fs.copyFileSync(path.join(root, 'docs/ACTION-TEMPLATES.md'), path.join(output, 'ACTION-TEMPLATES.md'))
fs.writeFileSync(path.join(output, 'README.md'), '# 现有动作模板\n\n模板直接提取当前蓝鲸动作，不包含新人物的美术。\n\n1. 导入自己的帧序列、PSD 或 Live2D 模型，导入器自动生成 action-profile.json。\n2. 把 states、expressions、parameters 中的右侧名称改为新模型已有的名称。\n3. 需要时校正衣领抓点、左右裁切比例或 PSD 的 normalized joints。\n4. 在模型设置中查看已绑定与回退项，逐项预览，并验证拖拽、上下屏幕边缘与聊天组合。\n\ntemplate.json 的帧名称是蓝鲸现有动作槽位示例；新人物必须提供自己的图像或原生动作。未制作蜷缩、趴、倒挂素材时使用安全回退。运行时动作绑定版本保持 v1，兼容旧皮肤。\n\n详细操作见项目 docs/ACTION-TEMPLATES.md。\n')
console.log(`Existing action template exported: ${output}`)
