const { _electron } = require('playwright'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
process.chdir(path.resolve(__dirname, '..'));
(async () => {
  const data = path.resolve(`.runtime/window-dpi-qa-${Date.now()}`); fs.mkdirSync(data, {recursive:true});
  fs.writeFileSync(path.join(data,'config.json'), JSON.stringify({skin:'builtin.blue-maid',interaction:{wander:false,look:false,avoid:false,hourlyChime:false,fullscreenQuiet:false}}));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const exe = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('node_modules/electron/dist/electron.exe');
  const args = process.argv[2] ? [] : [path.resolve('.')]; args.push(`--data-dir=${data}`, '--no-sandbox');
  const app = await _electron.launch({executablePath:exe,args,env}), samples=[];
  try {
    const page=await app.firstWindow(); await page.waitForFunction(()=>document.querySelector('#pet')?.dataset.body==='idle');
    const command=name=>page.evaluate(name=>window.deskpet.invokePlugin({kind:'command',pluginId:'builtin',name}),name);
    let baseline;
    for(let iteration=0;iteration<20;iteration++) {
      await command('dock-bottom'); await page.waitForFunction(()=>document.querySelector('#pet').dataset.body==='lounge-bottom');
      await page.waitForTimeout(60);
      const main=await app.evaluate(({BrowserWindow,screen})=>{const b=BrowserWindow.getAllWindows()[0].getBounds();const d=screen.getDisplayMatching(b);return {bounds:b,floor:d.workArea.y+d.workArea.height,scale:d.scaleFactor};});
      const bottom=await page.locator('#pose-ledge').evaluate(el=>el.getBoundingClientRect().top);
      baseline ??= main.bounds;
      assert.ok(Math.abs(main.bounds.width-baseline.width)<=1 && Math.abs(main.bounds.height-baseline.height)<=1,'window size grew during repeated moves');
      assert.ok(main.bounds.y+bottom<=main.floor+1,'character moved below ground');
      samples.push({...main,bottom}); await command('wake'); await command('pose-walk');
    }
    fs.writeFileSync('.runtime/window-dpi-qa-report.json',JSON.stringify({generatedAt:new Date().toISOString(),passed:true,exe,iterations:samples.length,samples},null,2));
    console.log('20 repeated dock/wake checks: stable DPI window size and floor boundary');
  } finally {await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
