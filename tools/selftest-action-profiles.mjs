import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createActionProfile, validateActionProfile, resolveActionState, actionBindingReport, profileBodyForState } from '../dist/shared/action-profile.js'
import { ACTION_TIMING } from '../dist/shared/action-model.js'
let count = 0
function check(name, test) { test(); count++; console.log('PASS ' + name) }
check('新人物用自己的状态名承接现有动作', () => {
  const profile = validateActionProfile({ version: 'deskpet-character-actions/1', kind: 'sprite', states: { idle: 'Rest', walk: 'Run', shy: 'Blush' } }), states = { Rest: {}, Run: {}, Blush: {} }
  assert.equal(resolveActionState(states, 'walk', profile, 'Rest'), 'Run'); assert.equal(resolveActionState(states, 'shy', profile, 'Rest'), 'Blush'); assert.equal(profileBodyForState('Run', profile), 'walk')
})
check('缺少绑定只回退到本人物可用状态', () => { const p = createActionProfile('sprite', { idle: {}, happy: {} }); assert.equal(resolveActionState({ idle: {}, happy: {} }, 'shy', p), 'happy'); assert.equal(resolveActionState({ idle: {} }, 'hang-top', p), 'idle') })
check('错写或过期的绑定会显示回退而非假装已有动作', () => { const p = validateActionProfile({ version: 'deskpet-character-actions/1', kind: 'sprite', states: { walk: 'missing' } }); const r = actionBindingReport({ idle: {} }, p).find(item => item.action === 'walk'); assert.equal(r.mode, 'fallback'); assert.equal(r.state, 'idle') })
check('模板保留现有九十秒、七至十六秒与淡入时序', () => { assert.equal(ACTION_TIMING.sleepAfterMs, 90000); assert.equal(ACTION_TIMING.poseMinMs, 7000); assert.equal(ACTION_TIMING.poseMaxMs, 16000); assert.equal(ACTION_TIMING.portraitTransitionMs, 160) })
check('无动作状态时明确缺失', () => { assert.ok(actionBindingReport({}, createActionProfile('sprite')).every(item => item.mode === 'missing')) })
check('非法抓点、骨架和动作索引拒绝载入', () => {
  for (const extra of [{ anchors: { collar: { x: 1.2, y: .4 } } }, { anchors: { peek: { left: .8, right: .2 } } }, { joints: { head: { x: 0, y: -2 } } }, { motions: { wave: { group: 'TapBody', index: -1 } } }, { states: { walk: 'constructor' } }, { parameters: { RunArbitraryCode: 'x' } }]) assert.throws(() => validateActionProfile({ version: 'deskpet-character-actions/1', kind: 'sprite', ...extra }))
})
check('非标准 Live2D 参数与原生表情名可映射', () => { const p = validateActionProfile({ version: 'deskpet-character-actions/1', kind: 'live2d', parameters: { ParamAngleX: 'MY_HEAD_X' }, expressions: { shy: 'blushing01' }, motions: { wave: { group: 'Greeting', index: 2 } } }); assert.equal(p.parameters.ParamAngleX, 'MY_HEAD_X'); assert.equal(p.expressions.shy, 'blushing01') })
check('内置人物的绑定文件有效，可选日和无需强制安装', () => { for (const folder of ['blue-maid', 'cat-default', 'hiyori-live2d']) { const file = `packs/${folder}/action-profile.json`; if (folder === 'hiyori-live2d' && !fs.existsSync(file)) continue; const p = validateActionProfile(JSON.parse(fs.readFileSync(file, 'utf8'))); assert.equal(p.kind, folder === 'hiyori-live2d' ? 'live2d' : 'sprite') } })
check('导出模板直接来自现有动作且不携带人物图片', () => { const t = JSON.parse(fs.readFileSync('templates/actions-v1/template.json', 'utf8')), states = JSON.parse(fs.readFileSync('packs/blue-maid/states.json', 'utf8')).states; for (const [name, action] of Object.entries(t.body)) assert.deepEqual(action, states[name]); assert.ok(!fs.readdirSync('templates/actions-v1').some(file => /\.(png|moc3|jpg)$/.test(file))) })
console.log(`${count} action profile checks passed`)
