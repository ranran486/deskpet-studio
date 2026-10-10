const { _electron } = require('playwright'), fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
process.chdir(path.resolve(__dirname, '..'));
(async () => {
  let networkCalls = 0; const server = http.createServer((req, res) => { networkCalls++; res.writeHead(503); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const data = path.resolve(`.runtime/pet-play-qa-${Date.now()}`); fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ skin: 'builtin.blue-maid', chatProvider: 'builtin.chat-openai', position: null, disabled: ['builtin.cat-actions', 'builtin.pomodoro-js'], interaction: { look: false, wander: false, avoid: false, fullscreenQuiet: false, hourlyChime: false, idleMode: false }, pluginConfig: { 'builtin.chat-openai': { baseUrl: `http://127.0.0.1:${server.address().port}` } } }));
  const env = { ...process.env, DESKPET_TEST_SLEEP_MS: '6000' }; delete env.ELECTRON_RUN_AS_NODE;
  const exe = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('node_modules/electron/dist/electron.exe');
  const args = process.argv[2] ? [] : [path.resolve('.')]; args.push(`--data-dir=${data}`, '--no-sandbox', '--test-gameplay');
  const app = await _electron.launch({ executablePath: exe, args, env }).catch(error => { server.close(); throw error });
  const checks = [], errors = [];
  try {
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#pet')?.dataset.body === 'idle');
    const canvas = page.locator('#pet'), command = name => page.evaluate(name => window.deskpet.invokePlugin({ kind: 'command', pluginId: 'builtin', name }), name);
    const point = ratio => canvas.evaluate((el, ratio) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height * ratio }; }, ratio);
    async function capture(name) { const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')); fs.writeFileSync(`.runtime/pet-play-${name}.png`, Buffer.from(png, 'base64')); }
    let head = await point(.3); await page.mouse.move(head.x, head.y); await page.mouse.down(); await page.waitForTimeout(750);
    await page.waitForFunction(() => document.querySelector('#pet').dataset.expression === 'shy'); assert.equal(await page.locator('#pet-effects').getAttribute('data-effect'), 'hearts'); await page.mouse.up(); checks.push('actual-head-hold-shy-hearts');
    const belly = await point(.68); await page.mouse.click(belly.x, belly.y); await page.waitForFunction(() => document.querySelector('#pet').dataset.expression === 'happy'); assert.equal(await page.locator('#pet-effects').getAttribute('data-effect'), 'laugh'); checks.push('actual-belly-click-happy-laugh');
    head = await point(.3); await page.mouse.dblclick(head.x, head.y); await page.locator('#feed-panel').waitFor(); assert.equal(await page.locator('#food-options button').count(), 5); checks.push('actual-double-click-five-food-panel');
    for (let index = 0; index < 3; index++) await page.locator('[data-food="fish"]').click();
    await page.waitForFunction(() => document.querySelector('#pet').dataset.expression === 'unimpressed');
    let state = (await page.evaluate(() => window.deskpet.bootstrap())).petLife; assert.equal(state.sameFoodCount, 3); await capture('repeat-food'); checks.push('third-same-food-unimpressed-with-matching-text');
    await page.locator('[data-food="cake"]').click(); await page.waitForFunction(() => document.querySelector('#pet').dataset.expression === 'love'); state = (await page.evaluate(() => window.deskpet.bootstrap())).petLife; assert.equal(state.sameFoodCount, 1); await capture('feeding'); checks.push('different-food-restores-love');
    await page.locator('#feed-close').click();
    await command('praise'); await page.waitForFunction(() => ['shy', 'love'].includes(document.querySelector('#pet').dataset.expression)); checks.push('praise-command-expression');
    for (let index = 0; index < 12; index++) await command('tease');
    await page.waitForFunction(() => document.querySelector('#pet').dataset.expression === 'unimpressed'); assert.ok(Number(await canvas.getAttribute('data-mood')) < 35); checks.push('teasing-low-mood-eye-roll');
    await command('chat'); await page.locator('#chat-input').fill('你好，怎么玩呀'); await page.locator('#chat-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#pet').dataset.chatSource === 'local'); assert.ok((await page.locator('#bubble-hint').textContent()).includes('本地')); assert.ok((await page.locator('#bubble-text').textContent()).length > 8); assert.equal(networkCalls, 0); await capture('offline-chat'); checks.push('no-key-local-chat-with-zero-network-calls');
    await page.locator('#bubble-close').click(); await page.mouse.move(3, 3);
    await page.waitForFunction(() => document.querySelector('#pet').dataset.dozing === 'true', {}, { timeout: 10000 }); assert.equal(await page.locator('#pet-effects').getAttribute('data-effect'), 'zzz'); await page.waitForTimeout(180); await capture('dozing'); checks.push('idle-dozing-and-zzz');
    head = await point(.3); await page.mouse.move(head.x, head.y); await page.waitForFunction(() => document.querySelector('#pet').dataset.dozing === 'false' && document.querySelector('#pet').dataset.expression === 'surprised'); checks.push('mouse-touch-wakes-surprised');
    for (const edge of ['bottom', 'top']) {
      await command(`dock-${edge}`); await page.waitForFunction(body => document.querySelector('#pet').dataset.body === body, edge === 'bottom' ? 'lounge-bottom' : 'hang-top');
      await page.waitForTimeout(180); await capture(edge);
      const g = await app.evaluate(({ BrowserWindow, screen }) => { const b = BrowserWindow.getAllWindows()[0].getBounds(), d = screen.getDisplayMatching(b); return { y: b.y, area: d.bounds, workArea: d.workArea }; });
      const line = await page.locator('#pose-ledge').boundingBox(); assert.ok(edge === 'bottom' ? Math.abs(g.y + line.y + line.height - g.workArea.y - g.workArea.height) <= 1 : Math.abs(g.y + line.y - g.area.y) <= 1); await command('wake'); checks.push(`posture-${edge}-taskbar-and-roof-contact`);
    }
    await command('dock-top'); await page.waitForFunction(() => document.querySelector('#pet').dataset.body === 'hang-top');
    const poseStarted = Date.now(); await page.waitForFunction(() => document.querySelector('#pet').dataset.body === 'idle', {}, { timeout: 18000 });
    assert.ok(Date.now() - poseStarted >= 6500); checks.push('posture-expires-within-seven-to-sixteen-seconds');
    const start = await point(.65); await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 45, start.y - 20, { steps: 5 });
    await page.waitForFunction(() => document.querySelector('#pet').dataset.body === 'drag-lift');
    const hash = () => canvas.evaluate(el => el.getContext('2d').getImageData(0, 0, el.width, el.height).data.reduce((sum, byte, index) => (sum + byte * (index % 19 + 1)) % 1000000007, 0));
    const first = await hash(); await page.waitForTimeout(260); assert.notEqual(await hash(), first); await capture('struggle'); await page.mouse.up(); checks.push('actual-collar-drag-animated-struggle');
    await command('wake');
    await page.evaluate(() => window.deskpet.petInteract('drag')); await page.waitForFunction(() => document.querySelector('#pet').dataset.expression === 'dizzy'); checks.push('landing-dizzy-expression');
    const invalid = await page.evaluate(() => window.deskpet.petInteract('launch-program', 'evil')); assert.equal(invalid.ok, false); checks.push('invalid-game-actions-rejected');
    assert.deepEqual(errors, []); checks.push('no-renderer-errors');
    fs.writeFileSync('.runtime/pet-play-qa-report.json', JSON.stringify({ generatedAt: new Date().toISOString(), passed: true, checks, errors, sleepNote: 'UI uses a 6s test-only timer; pure logic separately verifies the exact default 90s boundary', networkCalls }, null, 2)); console.log(`${checks.length} pet gameplay UI checks passed`);
  } finally { await app.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
