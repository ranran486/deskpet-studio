// Sources verified from Live2D/CubismWebSamples and its LICENSE.md.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
if(!process.argv.includes('--accept-live2d-license')) throw new Error('先阅读官方 Core 与样例素材协议，再显式添加 --accept-live2d-license。仅用于本机测试；发布条件另行核对。')
const dir=path.join(root,'packs/hiyori-live2d'),vendor=path.join(root,'src/renderer/vendor')
fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(vendor,{recursive:true});fs.mkdirSync(path.join(root,'LICENSES'),{recursive:true})
const provenance=[]
async function download(url,file){const response=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error(`${response.status}: ${url}`);const bytes=Buffer.from(await response.arrayBuffer());if(!bytes.length)throw new Error('Empty download');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);provenance.push({url,file:path.relative(root,file),sha256:crypto.createHash('sha256').update(bytes).digest('hex')});return bytes}
const repo='https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop/'
const modelBase=repo+'Samples/Resources/Hiyori/'
const raw=await download(modelBase+'Hiyori.model3.json',path.join(dir,'Hiyori.model3.json')),model=JSON.parse(raw)
const assets=new Set();function refs(value){if(typeof value==='string'&&/\.(moc3|png|json|wav|mp3|ogg)$/i.test(value)){if(value.includes('..')||/^[a-z]+:/i.test(value))throw new Error('Unsafe source path');assets.add(value)}else if(Array.isArray(value))value.forEach(refs);else if(value&&typeof value==='object')Object.values(value).forEach(refs)}refs(model.FileReferences)
for(const rel of assets)await download(modelBase+rel,path.join(dir,rel))
await download(repo+'LICENSE.md',path.join(dir,'LIVE2D-SAMPLE-LICENSE.md'))
await download('https://cubism.live2d.com/sdk-web/core/05/live2dcubismcore.min.js',path.join(vendor,'live2dcubismcore.min.js'))
await download('https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html',path.join(root,'LICENSES/Live2D-Core-EULA.html'))
await download('https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html',path.join(root,'LICENSES/Live2D-Free-Material-EULA.html'))
fs.writeFileSync(path.join(dir,'plugin.json'),JSON.stringify({manifestVersion:1,id:'builtin.hiyori-live2d',name:'日和 · Live2D 测试模型',version:'0.1.0',description:'Live2D 官方 Hiyori 样例，仅用于本机开发验证。包含视线、眨眼、呼吸、头发物理和原生动作。',author:'Live2D Inc. · adapter deskpet',homepage:'https://github.com/Live2D/CubismWebSamples',kind:'skin',runtime:'data',engine:{deskpet:'>=0.1.0 <1.0.0'},data:{live2d:'Hiyori.model3.json',actionProfile:'action-profile.json'},frameSize:{w:260,h:320},scale:1},null,2))
fs.writeFileSync(path.join(dir,'action-profile.json'),JSON.stringify({version:'deskpet-character-actions/1',kind:'live2d'},null,2))
fs.writeFileSync(path.join(dir,'SOURCES.json'),JSON.stringify({downloadedAt:new Date().toISOString(),licenseConsent:'Installed locally with --accept-live2d-license; review applicable terms before redistribution',files:provenance},null,2))
for(const[name,target]of [['pixi.js','PixiJS-MIT.txt'],['pixi-live2d-display','pixi-live2d-display-MIT.txt']]){const candidates=['LICENSE','LICENSE.txt','LICENSE.md'].map(file=>path.join(root,'node_modules',name,file));const found=candidates.find(file=>fs.existsSync(file));if(found)fs.copyFileSync(found,path.join(root,'LICENSES',target))}
console.log(`Hiyori ready: ${assets.size} resources. Core downloaded from official Live2D host.`)
