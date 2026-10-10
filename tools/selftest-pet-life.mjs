import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PNG } from 'pngjs'
import { PetLifeEngine, PET_EXPRESSIONS, FOODS, SLEEP_AFTER_MS } from '../dist/shared/pet-life.js'
import { DialoguePicker, validateCatalog } from '../dist/main/gameplay/dialogue.js'
import { dockPosition, sampleActionPose } from '../dist/shared/action-model.js'
let passed = 0
function check(name, fn) { fn(); passed++; console.log('PASS ' + name) }
check('头顶轻抚匹配害羞、爱心与心情奖励', () => { const e = new PetLifeEngine({}, 0), result = e.interact('rub', 1); assert.equal(result.expression, 'shy'); assert.equal(result.effect, 'hearts'); assert.ok(result.mood > 65) })
check('戳肚子匹配开心与笑声特效', () => { const r = new PetLifeEngine({}, 0).interact('tickle', 1); assert.equal(r.expression, 'happy'); assert.equal(r.effect, 'laugh') })
check('第三次同款嫌弃，换口味恢复喜欢', () => { const e = new PetLifeEngine({}, 0); e.interact('feed', 1, 'fish'); e.interact('feed', 2, 'fish'); const before = e.state.mood, third = e.interact('feed', 3, 'fish'); assert.equal(third.expression, 'unimpressed'); assert.equal(third.sameFoodCount, 3); assert.ok(third.mood < before); assert.equal(e.interact('feed', 4, 'cake').expression, 'love'); assert.equal(e.state.sameFoodCount, 1) })
check('五种食物都匹配自己的文案组', () => { for (const food of FOODS) assert.equal(new PetLifeEngine({}, 0).interact('feed', 1, food.id).group, `feed_${food.id}`); assert.equal(FOODS.length, 5) })
check('无效食物不改变心情与连喂记录', () => { const e = new PetLifeEngine({}, 0), saved = structuredClone(e.state); assert.equal(e.interact('feed', 1, 'not-a-food'), null); assert.deepEqual(e.state, saved) })
check('异常存档安全回退，不产生 NaN 心情或次数', () => { for (const saved of [null, [], { mood: 'oops', sameFoodCount: 'bad', lastFood: 'fake' }]) { const e = new PetLifeEngine(saved, 0); assert.equal(e.state.mood, 65); assert.equal(e.state.sameFoodCount, 0); assert.equal(e.state.lastFood, null) } })
check('连续逗弄使低心情翻白眼，连续夸奖能哄好', () => { const e = new PetLifeEngine({}, 0); for (let i = 0; i < 12; i++) e.interact('tease', i); assert.equal(e.idle().expression, 'unimpressed'); for (let i = 0; i < 20; i++) e.interact('praise', i); assert.equal(e.idle().expression, 'love') })
check('心情始终限制在 0 到 100', () => { const e = new PetLifeEngine({}, 0); for (let i = 0; i < 100; i++) e.interact('tease', i); assert.equal(e.state.mood, 0); for (let i = 0; i < 100; i++) e.interact('rub', i); assert.equal(e.state.mood, 100) })
check('默认九十秒临界与一次性入睡', () => { const e = new PetLifeEngine({}, 0); assert.equal(SLEEP_AFTER_MS, 90000); assert.equal(e.tick(89999), null); assert.equal(e.tick(90000).expression, 'sleepy'); assert.equal(e.snapshot().effect, 'zzz'); assert.equal(e.tick(91000), null) })
check('一碰惊醒，重置九十秒计时', () => { const e = new PetLifeEngine({}, 0); e.tick(90000); const r = e.interact('touch', 92000); assert.equal(r.expression, 'surprised'); assert.equal(r.group, 'wake'); assert.equal(e.dozing, false); assert.equal(e.tick(181999), null) })
check('全屏、拖拽或聊天暂停时不自动进入瞌睡', () => { const e = new PetLifeEngine({}, 0); assert.equal(e.tick(90000, true), null); assert.equal(e.dozing, false) })
const catalog = validateCatalog(JSON.parse(fs.readFileSync('assets/dialogue.zh-CN.json', 'utf8')))
check('每种玩法和姿势都有专属文案', () => { for (const group of ['rub', 'tickle', 'feed_repeat', 'praise', 'tease', 'sleep', 'wake', 'struggle', 'lounge', 'hang', ...FOODS.map(f => `feed_${f.id}`)]) assert.ok(catalog.groups[group]?.length >= 3) })
check('连续取同组不会重复，替换昵称和食物占位符', () => { const p = new DialoguePicker(catalog, () => 0), a = p.pick('startup', { name: '蓝鲸' }), b = p.pick('startup', { name: '蓝鲸' }); assert.notEqual(a, b); assert.ok(!a.includes('{name}')); assert.ok(!p.pick('feed_repeat', { food: '团子' }).includes('{food}')) })
check('离线回应识别心情与玩法，不假装回答复杂事实', () => { const p = new DialoguePicker(catalog, () => 0); assert.equal(p.reply('你好', '蓝鲸').emotion, 'happy'); assert.equal(p.reply('我很难过', '蓝鲸').emotion, 'sad'); assert.equal(p.reply('你真可爱', '蓝鲸').emotion, 'love'); assert.ok(p.reply('太阳离地球多远', '蓝鲸').text.includes('本地')) })
check('错误和超长自定义文案拒绝加载', () => { assert.throws(() => validateCatalog({ version: 2 })); assert.throws(() => validateCatalog({ version: 1, groups: { bad: ['x'.repeat(181)] } })) })
check('新增表情在所有身体动作下参数有界', () => { for (const emotion of PET_EXPRESSIONS) for (const body of ['idle', 'walk', 'drag-lift', 'sleep-curl', 'lounge-bottom', 'hang-top']) { const p = sampleActionPose({ emotion, body, timeMs: 123456 }); assert.ok(Object.values(p.face).every(Number.isFinite)); assert.ok(Object.values(p.joints).every(joint => Object.values(joint).every(Number.isFinite))) } })
check('倒挂贴顶与趴桌沿均保留完整角色在屏内', () => { const area = { x: -1600, y: -200, width: 1600, height: 1000 }, g = { x: 30, y: 164, width: 256, height: 256, leftLine: 100, rightLine: 160 }; const top = dockPosition('top', { x: -700, y: 0 }, g, area), bottom = dockPosition('bottom', { x: -700, y: 0 }, g, area); assert.equal(top.y + g.y, area.y); assert.equal(bottom.y + g.y + g.height, area.y + area.height) })
check('八张表情是真正不同的图集帧，均有透明边界', () => { const atlas = JSON.parse(fs.readFileSync('packs/blue-maid/atlas.json', 'utf8')), sheet = PNG.sync.read(fs.readFileSync('packs/blue-maid/spritesheet.png')), hashes = new Set(); for (const name of PET_EXPRESSIONS) { const f = atlas.frames[`face-${name}`]; assert.ok(f); const tile = new PNG({ width: f.w, height: f.h }); PNG.bitblt(sheet, tile, f.x, f.y, f.w, f.h, 0, 0); assert.equal(tile.data[3], 0); hashes.add(createHash('sha256').update(tile.data).digest('hex')) } assert.equal(hashes.size, 8) })
console.log(`${passed} pet gameplay checks passed`)
