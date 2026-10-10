import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { DialogueStore } from '../dist/main/gameplay/dialogue-store.js'
import { DialoguePicker } from '../dist/main/gameplay/dialogue.js'
import { DIALOGUE_GROUP_INFO } from '../dist/shared/dialogue-settings.js'
const dir = path.resolve(`.runtime/dialogue-store-test-${Date.now()}`); fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, 'dialogue.zh-CN.json'), asset = path.resolve('assets/dialogue.zh-CN.json')
fs.writeFileSync(file, JSON.stringify({ version: 1, style: '自定义', groups: { rub: ['原有摸头文案'], custom_group: ['保留其他文案'] } }))
const store = new DialogueStore(asset, file)
let passed = 0
const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name) }
check('读取旧文案并补齐新分组，保留已有自定义', () => { const s=store.snapshot(); assert.equal(s.catalog.groups.rub[0], '原有摸头文案'); assert.ok(s.catalog.groups.emote_shy); assert.ok(Object.keys(s.defaults.groups).every(id=>DIALOGUE_GROUP_INFO[id])) })
check('返回副本，不允许设置页直接改运行文案', () => { store.snapshot().catalog.groups.rub[0]='未保存';assert.equal(store.snapshot().catalog.groups.rub[0],'原有摸头文案') })
check('空白、超长、过多台词与未知分组拒绝写入', () => { for(const groups of [{rub:[]},{rub:[' ']},{rub:['字'.repeat(181)]},{rub:Array(101).fill('一句')},{'../config':['危险']}]) assert.throws(()=>store.save(groups));assert.equal(store.snapshot().catalog.groups.rub[0],'原有摸头文案') })
check('批量保存先整体验证，错误组不会导致部分写入', () => { const before=fs.readFileSync(file,'utf8');assert.throws(()=>store.save({hang:['不应写入'],rub:[]}));assert.equal(fs.readFileSync(file,'utf8'),before) })
check('保存仅更新指定组，原有自定义和外部编辑保留', () => { const disk=JSON.parse(fs.readFileSync(file));disk.groups.chat_greeting=['外部编辑'];fs.writeFileSync(file,JSON.stringify(disk));store.save({rub:['  新的{name}台词  '],hang:['新的倒挂台词']});const s=store.snapshot();assert.equal(s.catalog.groups.rub[0],'新的{name}台词');assert.equal(s.catalog.groups.chat_greeting[0],'外部编辑');assert.equal(s.catalog.groups.custom_group[0],'保留其他文案') })
check('运行 picker 热更新与进程重开均使用已保存台词', () => {const picker=new DialoguePicker(store.snapshot().catalog);const s=store.save({rub:['即时{name}']});picker.replaceCatalog(s.catalog);assert.equal(picker.pick('rub',{name:'蓝鲸'}),'即时蓝鲸');const reopened=new DialogueStore(asset,file);assert.equal(reopened.snapshot().catalog.groups.rub[0],'即时{name}')})
check('恢复某组默认不影响其他组', () => {store.save({rub:store.snapshot().defaults.groups.rub});assert.deepEqual(store.snapshot().catalog.groups.rub,store.snapshot().defaults.groups.rub);assert.equal(store.snapshot().catalog.groups.hang[0],'新的倒挂台词')})
console.log(`${passed} dialogue settings checks passed`)
