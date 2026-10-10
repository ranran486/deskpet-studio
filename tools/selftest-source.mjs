import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { ConfigStore } from '../dist/main/config.js'
import { PluginRegistry } from '../dist/main/plugins/registry.js'
const dir = path.resolve(`.runtime/source-tests-${Date.now()}`), packs = path.join(dir, 'packs')
fs.mkdirSync(packs, { recursive: true })
fs.cpSync('packs/bubble-default', path.join(packs, 'theme'), { recursive: true })
const manifest = JSON.parse(fs.readFileSync(path.join(packs, 'theme/plugin.json'), 'utf8'))
const file = path.join(packs, 'theme', manifest.data.tokens), tokens = JSON.parse(fs.readFileSync(file, 'utf8'))
tokens.cacheSentinel = 'initial'; fs.writeFileSync(file, JSON.stringify(tokens))
const registry = new PluginRegistry(packs, path.join(dir, 'plugins'), new ConfigStore(dir))
registry.scan()
const copy = registry.resolveTheme(manifest.id); copy.cacheSentinel = 'mutated'
assert.equal(registry.resolveTheme(manifest.id).cacheSentinel, 'initial')
tokens.cacheSentinel = 'reloaded'; fs.writeFileSync(file, JSON.stringify(tokens))
assert.equal(registry.resolveTheme(manifest.id).cacheSentinel, 'initial')
registry.reload(); assert.equal(registry.resolveTheme(manifest.id).cacheSentinel, 'reloaded')
assert.equal(fs.existsSync('dist/preload/index.mjs'), true)
assert.equal(fs.existsSync('dist/preload/index.js'), false)
assert.equal(fs.existsSync('templates/actions-v1/template.json'), true)
console.log('6 source workflow and registry cache checks passed')
