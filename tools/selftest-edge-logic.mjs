import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dockPosition } from '../dist/shared/action-model.js'
import { validateActionProfile } from '../dist/shared/action-profile.js'
import { upgradePoseDialogue } from '../dist/main/gameplay/dialogue.js'
const geometry = { x: 50, y: 170, width: 256, height: 256, leftLine: 100, rightLine: 150, hangLine: 15.36, loungeLine: 199.68 }
const area = { x: -1920, y: -200, width: 1920, height: 1000 }
const top = dockPosition('top', { x: -600, y: 0 }, geometry, area)
assert.ok(Math.abs(top.y + geometry.y + geometry.hangLine - area.y) < .001)
const bottom = dockPosition('bottom', { x: -600, y: 0 }, geometry, area)
assert.ok(Math.abs(bottom.y + geometry.y + geometry.loungeLine - area.y - area.height) < .001)
assert.ok(bottom.y + geometry.y + geometry.height > area.y + area.height)
const builtIn = JSON.parse(fs.readFileSync('assets/dialogue.zh-CN.json', 'utf8'))
const legacy = { version: 1, groups: { hang: ['倒挂金钩！咦，世界怎么反过来了？', '我的发尾在替我试探重力呢。', '头朝下也要保持可爱，哼哼！', '快看，我的视角和你不一样啦。', '血都要流到脑子里了，待会儿就下来！', '这次是主动倒挂，不是被你拎着哦。'] } }
assert.deepEqual(upgradePoseDialogue(legacy, builtIn).groups.hang, builtIn.groups.hang)
const custom = { version: 1, groups: { hang: ['这是用户自定义的台词'] } }
assert.equal(upgradePoseDialogue(custom, builtIn), custom)
assert.throws(() => validateActionProfile({ version: 'deskpet-character-actions/1', kind: 'sprite', anchors: { hangY: -1 } }))
console.log('5 edge contact and dialogue migration checks passed')
