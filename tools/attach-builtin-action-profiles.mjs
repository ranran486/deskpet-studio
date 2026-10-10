import fs from 'node:fs'
import path from 'node:path'
import { createActionProfile } from '../dist/shared/action-profile.js'
for (const folder of ['blue-maid', 'cat-default', 'hiyori-live2d']) {
  if (!fs.existsSync(path.resolve('packs', folder, 'plugin.json'))) continue
  const dir = path.resolve('packs', folder), file = path.join(dir, 'plugin.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  const kind = manifest.data.live2d ? 'live2d' : 'sprite', states = kind === 'sprite' ? JSON.parse(fs.readFileSync(path.join(dir, manifest.data.states), 'utf8')).states : undefined
  const profile = createActionProfile(kind, states)
  if (folder === 'blue-maid') profile.anchors = { collar: { x: .5, y: 40 / 640 }, peek: { left: .4, right: .6 }, hangY: .06, loungeY: .78 }
  const profileFile = path.join(dir, 'action-profile.json')
  if (!fs.existsSync(profileFile)) fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2))
  manifest.data.actionProfile = 'action-profile.json'; fs.writeFileSync(file, JSON.stringify(manifest, null, 2))
}
