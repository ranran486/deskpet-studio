const { _electron } = require('playwright'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { PNG } = require('pngjs');
process.chdir(path.resolve(__dirname,'..'));
(async()=>{
  const data=path.resolve(`.runtime/edge-posture-qa-${Date.now()}`);fs.mkdirSync(data,{recursive:true});
  fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({skin:'builtin.blue-maid',disabled:['builtin.cat-actions','builtin.pomodoro-js'],interaction:{wander:false,look:false,avoid:false,hourlyChime:false,fullscreenQuiet:false}}));
  const exe=process.argv[2]?path.resolve(process.argv[2]):path.resolve('node_modules/electron/dist/electron.exe'), args=process.argv[2]?[]:[path.resolve('.')];args.push(`--data-dir=${data}`,'--no-sandbox');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const app=await _electron.launch({executablePath:exe,args,env}),checks=[],errors=[];
  try {
    const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>document.querySelector('#pet')?.dataset.body==='idle');
    const command=name=>page.evaluate(name=>window.deskpet.invokePlugin({kind:'command',pluginId:'builtin',name}),name);
    const geometry=()=>app.evaluate(({BrowserWindow,screen})=>{const w=BrowserWindow.getAllWindows()[0],b=w.getBounds(),d=screen.getDisplayMatching(b);return {b,screen:d.bounds,work:d.workArea};});
    const capture=async name=>{const raw=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));const image=PNG.sync.read(Buffer.from(raw,'base64'));fs.writeFileSync(`.runtime/edge-posture-${name}.png`,Buffer.from(raw,'base64'));return image;};
    await command('dock-bottom');await page.waitForFunction(()=>document.querySelector('#pet').dataset.posture==='lounge-bottom'&&document.querySelector('#pet').style.clipPath.startsWith('inset'));
    await page.waitForTimeout(250);let g=await geometry();let line=await page.locator('#pose-ledge').boundingBox();
    assert.ok(Math.abs(g.b.y+line.y+line.height-g.work.y-g.work.height)<=1);checks.push('lounge-hand-contact-aligns-taskbar-top');
    const bottomImage=await capture('bottom'), bar=(g.work.y+g.work.height-g.b.y)*bottomImage.height/g.b.height;let alpha=0;
    for(let y=Math.ceil(bar+8);y<bottomImage.height;y++)for(let x=0;x<bottomImage.width;x++)alpha+=bottomImage.data[(y*bottomImage.width+x)*4+3];assert.equal(alpha,0);checks.push('body-transparent-behind-taskbar');
    await command('dock-top');await page.waitForFunction(()=>document.querySelector('#pet').dataset.posture==='hang-top');await page.waitForTimeout(250);
    g=await geometry();line=await page.locator('#pose-ledge').boundingBox();const pet=await page.locator('#pet').boundingBox();assert.ok(Math.abs(g.b.y+line.y-g.screen.y)<=1);assert.ok(Math.abs(g.b.y+pet.y+pet.height*.06-g.screen.y)<=1);checks.push('top-line-and-feet-contact-align-screen-top');
    const hang=JSON.parse(fs.readFileSync('assets/dialogue.zh-CN.json','utf8')).groups.hang;await page.waitForFunction(lines=>lines.includes(document.querySelector('#bubble-text').textContent),hang);checks.push('direct-bottom-to-top-switch-updates-hang-dialogue');
    const bubble=await page.locator('#bubble').boundingBox();assert.ok(bubble.y>=pet.y+pet.height+6);assert.ok(g.b.y+bubble.y>=g.screen.y&&g.b.y+bubble.y+bubble.height<=g.screen.y+g.screen.height);await capture('top');checks.push('hang-bubble-below-character-and-inside-screen');
    await command('wake');await page.waitForFunction(()=>document.querySelector('#pet').style.clipPath==='none'&&document.querySelector('#pet').style.bottom==='0px');checks.push('wake-clears-pose-occlusion-and-spacing');
    assert.deepEqual(errors,[]);checks.push('no-renderer-errors');fs.writeFileSync('.runtime/edge-posture-qa-report.json',JSON.stringify({generatedAt:new Date().toISOString(),passed:true,exe,checks,errors},null,2));console.log(`${checks.length} edge posture checks passed`);
  }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
