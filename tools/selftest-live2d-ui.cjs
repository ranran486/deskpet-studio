const { _electron }=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),http=require('node:http');
process.chdir(path.resolve(__dirname,'..'));
if(!fs.existsSync('packs/hiyori-live2d/Hiyori.model3.json')||!fs.existsSync('src/renderer/vendor/live2dcubismcore.min.js'))throw new Error('Live2D GUI 检查需要可选官方模型与 Core。阅读条款后运行 npm run setup:live2d -- --accept-live2d-license。');
(async()=>{
 const requests=[],checks=[];
 const server=http.createServer((req,res)=>{
  if(req.url==='/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'deepseek-flash'}]}));return;}
  if(req.url!=='/chat/completions'){res.writeHead(404);res.end();return;}
  let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
   const body=JSON.parse(raw);requests.push(body);
   assert.equal(req.headers.authorization,'Bearer local-test-key');
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   const emit=text=>res.write('data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n');
   emit('今天也辛苦啦。');
   const delay=body.messages.at(-1).content==='取消测试'?6000:650;
   const timer=setTimeout(()=>{emit('<pe');emit('t emotion="happy" action="nod"/>');res.end('data: [DONE]\n\n');},delay);
   res.on('close',()=>clearTimeout(timer));
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const data=path.resolve('.runtime/live2d-qa-data');fs.mkdirSync(data,{recursive:true});
 fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({skin:'builtin.hiyori-live2d',chatProvider:'builtin.chat-openai',position:null,scale:1,disabled:['builtin.cat-actions','builtin.pomodoro-js'],interaction:{look:false,avoid:false,wander:false,hourlyChime:false,idleMode:false,fullscreenQuiet:false},secrets:{'builtin.chat-openai':'local-test-key'},pluginConfig:{'builtin.chat-openai':{baseUrl:`http://127.0.0.1:${server.address().port}`,model:'deepseek-flash',animateReply:true,persona:'自定义测试性格'}}}));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const app=await _electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[path.resolve('.'),`--data-dir=${data}`,'--no-sandbox'],env}).catch(error=>{server.close();throw error});
 try{
  const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>document.querySelector('#pet')?.dataset.renderer==='live2d',{},{timeout:25000});
  const canvas=page.locator('#pet');
  const command=async name=>page.evaluate(name=>window.deskpet.invokePlugin({kind:'command',pluginId:'builtin',name}),name);
  const pixels=await canvas.evaluate(el=>{const d=el.getContext('2d').getImageData(0,0,el.width,el.height).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i]>32)n++;return n});assert.ok(pixels>3000,'No visible Live2D pixels');
  assert.ok(Number(await canvas.getAttribute('data-parameters'))>10,'Missing model bindings');checks.push('real-webgl-pixels-and-parameter-bindings');
  for(const state of ['happy','angry','sad','wave']){await page.evaluate(name=>window.deskpet.invokePlugin({kind:'command',pluginId:'builtin',name:`pose-${name}`}),state);await page.waitForFunction(state=>document.querySelector('#pet').dataset.state===state,state);}
  checks.push('happy-angry-sad-native-wave');
  await command('wake');await page.waitForTimeout(250);
  await command('chat');await page.locator('#chat-input').fill('第一轮');await page.locator('#chat-input').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#pet').dataset.mouthActive==='true');checks.push('streaming-text-mouth');
  await page.waitForFunction(()=>document.querySelector('#pet').dataset.emotion==='happy');
  assert.equal(await page.locator('#bubble-text').textContent(),'今天也辛苦啦。');checks.push('ai-expression-and-hidden-metadata');
  await command('chat');await page.locator('#chat-input').fill('第二轮');await page.locator('#chat-input').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#pet').dataset.mouthActive==='true');
  await page.waitForFunction(()=>document.querySelector('#pet').dataset.mouthActive==='false');
  assert.deepEqual(requests[1].messages.slice(1).map(m=>m.role),['user','assistant','user']);
  assert.ok(requests[0].messages[0].content.includes('自定义测试性格')&&requests[0].messages[0].content.includes('<pet'));checks.push('custom-persona-and-history-order');
  await command('chat');await page.locator('#chat-input').fill('取消测试');await page.locator('#chat-input').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#pet').dataset.mouthActive==='true');
  await page.locator('#bubble-close').click();await page.waitForFunction(()=>document.querySelector('#pet').dataset.mouthActive==='false');checks.push('cancel-current-renderer-request');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('deskpet:interaction',{dragging:true,dragDelta:1000,resting:false,paused:false}));
  await page.waitForFunction(()=>document.querySelector('#pet').dataset.motionsSuspended==='true'&&document.querySelector('#pet').dataset.body==='drag-lift');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('deskpet:state:request',{state:'wave'}));
  assert.equal(await canvas.getAttribute('data-body'),'drag-lift');checks.push('drag-overrides-native-motion');
  await command('dock-bottom');await page.waitForFunction(()=>document.querySelector('#pet').dataset.body==='lounge-bottom');
  assert.equal(await canvas.getAttribute('data-motions-suspended'),'true');
  const floor=await app.evaluate(({BrowserWindow,screen})=>{const b=BrowserWindow.getAllWindows()[0].getBounds();return {y:b.y,bottom:screen.getDisplayMatching(b).bounds.y+screen.getDisplayMatching(b).bounds.height}});
  const bottom=await canvas.evaluate(el=>el.getBoundingClientRect().bottom);assert.ok(floor.y+bottom<=floor.bottom+1);checks.push('rest-and-ground-limit');
  for(const edge of ['left','right']){await command('wake');await command(`dock-${edge}`);await page.waitForFunction(edge=>document.querySelector('#pet').dataset.body===`peek-${edge}`,edge);}
  await command('wake');await page.waitForFunction(()=>document.querySelector('#pet').dataset.motionsSuspended==='false');checks.push('edge-peek-and-idle-restored');
  const settingsPromise=app.waitForEvent('window');await command('settings');const settings=await settingsPromise;await settings.waitForLoadState();
  await settings.locator('button[data-tab="chat"]').click();
  await settings.locator('[data-key="persona"]').waitFor();assert.equal(await settings.locator('[data-key="persona"]').inputValue(),'自定义测试性格');
  assert.equal(await settings.locator('[data-key="model"]').inputValue(),'deepseek-flash');assert.ok(await settings.locator('input[type="password"]').count());checks.push('settings-api-model-key-and-editable-persona');
  await settings.locator('[data-key="persona"]').fill('可以保存的新性格');await settings.getByRole('button',{name:'保存参数',exact:true}).click();
  await settings.waitForFunction(()=>document.querySelector('[data-key="persona"]').value==='可以保存的新性格');
  const cfg=JSON.parse(fs.readFileSync(path.join(data,'config.json')));assert.equal(cfg.pluginConfig['builtin.chat-openai'].persona,'可以保存的新性格');checks.push('persona-saved');
  await settings.close();
  await page.evaluate(()=>window.deskpet.setSkin('builtin.blue-maid'));await page.waitForFunction(()=>document.querySelector('#pet').dataset.body==='idle'&&document.querySelector('#pet').width>300);
  await page.evaluate(()=>window.deskpet.setSkin('builtin.hiyori-live2d'));await page.waitForFunction(()=>document.querySelector('#pet').getBoundingClientRect().width===260&&document.querySelector('#pet').dataset.renderer==='live2d');checks.push('sprite-live2d-switch-and-resource-release');
  if(process.platform==='win32'&&!process.argv.includes('--skip-fullscreen')){
   await page.evaluate(async()=>{const c=(await window.deskpet.bootstrap()).config;await window.deskpet.setConfig({interaction:{...c.interaction,fullscreenQuiet:true}})});
   let fixture;
   try{fixture=await _electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[path.resolve('tools/fullscreen-fixture.cjs'),'--no-sandbox'],env});await fixture.firstWindow();await fixture.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setFullScreen(true);w.show();w.focus()});try{await page.waitForFunction(()=>document.querySelector('#pet').dataset.paused==='true',{},{timeout:12000});}catch(error){console.error('Fullscreen fixture diagnostics:',JSON.stringify(await fixture.evaluate(({BrowserWindow,screen})=>{const w=BrowserWindow.getAllWindows()[0];return {focused:w.isFocused(),fullscreen:w.isFullScreen(),bounds:w.getBounds(),display:screen.getDisplayMatching(w.getBounds()).bounds};})));throw error;}checks.push('external-native-fullscreen-pauses');}
   finally{if(fixture)await fixture.close();}
   await page.waitForFunction(()=>document.querySelector('#pet').dataset.paused==='false',{},{timeout:12000});checks.push('fullscreen-exit-resumes');
  }
  const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));fs.writeFileSync('.runtime/live2d-hiyori.png',Buffer.from(png,'base64'));
  assert.deepEqual(errors,[]);fs.writeFileSync('.runtime/live2d-qa-report.json',JSON.stringify({generatedAt:new Date().toISOString(),passed:true,pixels,parameters:await canvas.getAttribute('data-parameters'),checks,errors,skipped:process.argv.includes('--skip-fullscreen')?['native fullscreen pause/resume: fixture could not remain Windows foreground']:[],api:'local SSE mock; no paid call'},null,2));console.log(`${checks.length} Live2D application checks passed${process.argv.includes('--skip-fullscreen')?' (2 native foreground checks explicitly skipped)':''}`);
 }catch(error){const file=path.join(data,'logs/deskpet.log');if(fs.existsSync(file)){const log=fs.readFileSync(file,'utf8');console.error(log.slice(log.lastIndexOf('启动')).split('\n').filter(l=>l.includes('[error]')||l.includes('失败')).slice(-8).join('\n'));}throw error;}finally{await app.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
