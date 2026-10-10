const { _electron }=require('playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
process.chdir(path.resolve(__dirname,'..'));
(async()=>{
 const server=http.createServer((req,res)=>{
  if(req.url==='/api/tags'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({models:[{name:'test-model'}]}));return;}
  if(req.url==='/api/chat'){let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{res.writeHead(200,{'content-type':'application/x-ndjson'});res.write(JSON.stringify({message:{content:'你好，这是本地测试回复。'}})+'\n');setTimeout(()=>{res.end(JSON.stringify({done:true})+'\n')},100);});return;}
  res.writeHead(404);res.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const data=path.resolve('.runtime/live-action-qa-data');fs.mkdirSync(data,{recursive:true});
 fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({skin:'builtin.blue-maid',chatProvider:'builtin.chat-ollama',position:null,scale:1,disabled:['builtin.cat-actions','builtin.pomodoro-js'],interaction:{look:false,avoid:false,wander:false,hourlyChime:false,idleMode:false},pluginConfig:{'builtin.chat-ollama':{baseUrl:`http://127.0.0.1:${server.address().port}`,model:'test-model'}}}));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const app=await _electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[path.resolve('.'),`--data-dir=${data}`,'--no-sandbox'],env});
 const checks=[],errors=[];
 try{
  const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>document.querySelector('#pet')?.dataset.body==='idle');
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isAlwaysOnTop()),true);checks.push('foreground-above-taskbar-level');
  await page.evaluate(()=>window.deskpet.setConfig({alwaysOnTop:false}));
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isAlwaysOnTop()),true);checks.push('top-layer-cannot-be-disabled');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setAlwaysOnTop(false));await page.waitForTimeout(1200);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isAlwaysOnTop()),true);checks.push('top-layer-restored-after-demotion');
  const command=async name=>page.evaluate(name=>window.deskpet.invokePlugin({kind:'command',pluginId:'builtin',name}),name);
  async function capture(file){const b=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));fs.writeFileSync(file,Buffer.from(b,'base64'));}
  for(const state of ['happy','angry','sad','walk','sleep-curl']){await command(`pose-${state}`);await page.waitForFunction(state=>document.querySelector('#pet').dataset.state===state,state);checks.push(`state-${state}`);}
  for(const edge of ['left','right','bottom']){await command(`dock-${edge}`);await page.waitForFunction(expected=>document.querySelector('#pet').dataset.body===expected,edge==='bottom'?'lounge-bottom':`peek-${edge}`);await command('wake');await page.waitForFunction(()=>document.querySelector('#pet').dataset.body==='idle');checks.push(`dock-wake-${edge}`);}
  await command('dock-bottom');await page.waitForFunction(()=>document.querySelector('#pet').dataset.body==='lounge-bottom');
  await page.waitForTimeout(250);
  const floor=await app.evaluate(({BrowserWindow,screen})=>{const w=BrowserWindow.getAllWindows()[0],b=w.getBounds();return {y:b.y,bounds:b,content:w.getContentBounds(),bottom:screen.getDisplayMatching(b).bounds.y+screen.getDisplayMatching(b).bounds.height};});
  const bottom=await page.locator('#pose-ledge').evaluate(el=>el.getBoundingClientRect().bottom);assert.ok(floor.y+bottom<=floor.bottom+1,JSON.stringify({floor,visibleBottom:bottom}));checks.push('bottom-lounge-visible-head-above-ground');
  await command('wake');await command('settings');await page.waitForTimeout(300);
  const settings=await app.evaluate(({BrowserWindow})=>{const pet=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='DeskPet'),s=BrowserWindow.getAllWindows().find(w=>w!==pet);const result={petTop:pet.isAlwaysOnTop(),parent:s?.getParentWindow()===pet};s?.close();return result;});assert.equal(settings.petTop,true);assert.equal(settings.parent,true);checks.push('settings-focus-preserves-pet-top-layer');
  await app.evaluate(({Menu})=>{globalThis.__qaPopupOriginal=Menu.prototype.popup;Menu.prototype.popup=function(){globalThis.__qaMenu=this.items.map(i=>({label:i.label,children:i.submenu?.items.map(c=>c.label)}));};});
  await page.evaluate(()=>window.deskpet.showContextMenu());
  const menu=await app.evaluate(()=>globalThis.__qaMenu);assert.ok(menu.some(i=>i.label==='动作与表情'&&i.children.includes('生气')));assert.ok(menu.some(i=>i.label==='边缘姿势'));
  await app.evaluate(({Menu})=>Menu.prototype.popup=globalThis.__qaPopupOriginal);checks.push('native-context-menu');
  await command('chat');await page.locator('#chat-input').waitFor({state:'visible'});
  await page.locator('#chat-input').fill('还没有发出的内容');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('deskpet:bubble:show',{text:'自动后台消息'}));
  await page.waitForTimeout(200);assert.equal(await page.locator('#chat-input').inputValue(),'还没有发出的内容');checks.push('input-not-overwritten');
  await page.locator('#chat-input').fill('测试聊天');await page.locator('#chat-input').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#bubble-text').textContent.includes('本地测试回复'));checks.push('real-streaming-chat-with-local-mock');
  await capture('.runtime/live-bubble-chat.png');await page.locator('#bubble-close').click();assert.ok(await page.locator('#bubble').evaluate(el=>el.classList.contains('hidden')));checks.push('bubble-close');
  await page.mouse.move(4,4);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('deskpet:bubble:show',{text:'短反馈',durationMs:600}));
  await page.waitForTimeout(150);assert.ok(!(await page.locator('#bubble').evaluate(el=>el.classList.contains('hidden'))));
  await page.waitForTimeout(750);assert.ok(await page.locator('#bubble').evaluate(el=>el.classList.contains('hidden')));checks.push('bubble-typewriter-auto-hide');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());await page.waitForFunction(()=>document.querySelector('#pet').dataset.paused==='true');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());await page.waitForFunction(()=>document.querySelector('#pet').dataset.paused==='false');checks.push('hidden-animation-pauses-and-resumes');
  const stored=JSON.parse(fs.readFileSync(path.join(data,'config.json')));assert.equal(stored.interaction.idleMode,false);assert.ok(stored.position===null||Number.isFinite(stored.position.x));checks.push('dock-config-restored');
  assert.deepEqual(errors,[]);checks.push('no-renderer-errors');
  fs.writeFileSync('.runtime/live-action-qa-report.json',JSON.stringify({generatedAt:new Date().toISOString(),passed:true,checks,errors,chatBackend:'isolated local mock; no user keys or remote service'},null,2));console.log(`${checks.length} live application checks passed`);
 }finally{await app.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1});
