import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EmotionFilter } from '../dist/main/chat/emotion-filter.js'
import { live2dAssets, importLive2D } from '../dist/main/skin/live2d-import.js'
import { readManifest } from '../dist/main/plugins/manifest.js'

let passed = 0
function check(name, fn) { fn(); passed++; console.log('PASS ' + name) }
const reply = '今天也辛苦啦。<pet emotion="happy" action="nod"/>'
check('所有分块位置均隐藏动作标记，保留自然回复', () => {
  for (let split = 0; split <= reply.length; split++) {
    let shown = ''; const filter = new EmotionFilter(chunk => shown += chunk)
    filter.feed(reply.slice(0, split)); filter.feed(reply.slice(split))
    assert.equal(filter.finish(), '今天也辛苦啦。'); assert.equal(shown, '今天也辛苦啦。')
    assert.deepEqual(filter.expression, { emotion: 'happy', action: 'nod' })
  }
})
check('单字符增量与普通小于号保持正确', () => {
  let shown = ''; const filter = new EmotionFilter(chunk => shown += chunk)
  for (const char of '1 < 2，想休息。<pet emotion="sad"/>') filter.feed(char)
  assert.equal(filter.finish(), '1 < 2，想休息。'); assert.equal(shown, '1 < 2，想休息。')
})
check('拒绝未知情绪与系统命令', () => {
  const filter = new EmotionFilter(() => {}); filter.feed('好。<pet emotion="angry" action="shutdown"/>')
  assert.equal(filter.finish(), '好。'); assert.deepEqual(filter.expression, { emotion: 'angry' })
  const other = new EmotionFilter(() => {}); other.feed('<pet emotion="evil" action="move"/>'); other.finish()
  assert.equal(other.expression, null)
})
check('截断与超长控制标记不会泄漏到气泡', () => {
  const filter = new EmotionFilter(() => {}); filter.feed('晚安<pet emotion="happy"'); assert.equal(filter.finish(), '晚安')
  const large = new EmotionFilter(() => {}); large.feed('好。<pet ' + 'x'.repeat(600)); assert.equal(large.finish(), '好。')
})
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-model-fixture-'))
const model = { Version: 3, FileReferences: { Moc: 'fixture.moc3', Textures: ['texture.png'], Physics: 'fixture.physics3.json', Motions: { Idle: [{ File: 'idle.motion3.json' }] } } }
fs.writeFileSync(path.join(fixture, 'fixture.model3.json'), JSON.stringify(model))
fs.writeFileSync(path.join(fixture, 'fixture.moc3'), 'import-test fixture, not a renderable Cubism model')
fs.writeFileSync(path.join(fixture, 'texture.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5p8AAAAASUVORK5CYII=', 'base64'))
for (const file of ['fixture.physics3.json', 'idle.motion3.json']) fs.writeFileSync(path.join(fixture, file), '{}')
check('合成模型引用完整，含物理与动作，无需官方素材', () => {
  const refs = live2dAssets(model); assert.ok(refs.some(file => file.endsWith('.physics3.json'))); assert.ok(refs.some(file => file.endsWith('.motion3.json')))
})
check('拒绝外链、编码穿越、目录穿越和错误纹理类型', () => {
  for (const file of ['../a.png', 'https://example.com/a.png', 'https://example.com/a.png?x=1', '%2e%2e/a.png', 'a.exe', 'E:/other/a.png']) {
    const bad = structuredClone(model); bad.FileReferences.Textures = [file]; assert.throws(() => live2dAssets(bad))
  }
})
check('不完整模型给出错误', () => { assert.throws(() => live2dAssets({ Version: 3, FileReferences: { Moc: 'model.moc3', Textures: [] } })) })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-live2d-'))
try {
  check('完整目录可导入，产物通过插件清单校验', () => {
    const result = importLive2D(fixture, tmp, 'sample')
    assert.equal(result.ok, true, result.error); assert.deepEqual(readManifest(result.dir).errors, [])
    assert.ok(fs.existsSync(path.join(result.dir, 'fixture.moc3')))
  })
  check('同名导入拒绝覆盖', () => { assert.equal(importLive2D(fixture, tmp, 'sample').ok, false) })
  check('缺少实际纹理拒绝导入', () => {
    const source = path.join(tmp, 'incomplete'); fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'sample.model3.json'), JSON.stringify(model))
    assert.equal(importLive2D(source, tmp, 'broken').ok, false)
  })
} finally {
  const resolved = fs.realpathSync(tmp)
  assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
  fs.rmSync(resolved, { recursive: true, force: true })
  const resolvedFixture = fs.realpathSync(fixture)
  assert.ok(resolvedFixture.startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
  fs.rmSync(resolvedFixture, { recursive: true, force: true })
}
console.log(`${passed} Live2D / emotion tests passed`)
