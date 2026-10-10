const { _electron } = require('playwright'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
process.chdir(path.resolve(__dirname, '..'));
(async () => {
  const data = path.resolve(`.runtime/package-smoke-${Date.now()}`), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const exe = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('release/framework-beta/win-unpacked/DeskPet Beta.exe');
  const app = await _electron.launch({ executablePath: exe, args: [`--data-dir=${data}`, '--no-sandbox'], env });
  const checks = [], errors = [];
  try {
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#pet')?.dataset.body === 'idle');
    const boot = await page.evaluate(() => window.deskpet.bootstrap());
    assert.equal(boot.skin.id, 'builtin.blue-maid'); assert.equal(boot.config.chatProvider, 'builtin.chat-openai'); checks.push('packaged-blue-maid-default-and-deepseek');
    assert.deepEqual(boot.config.secrets, {}); checks.push('no-developer-keys');
    assert.equal(boot.capabilities.live2d, false); assert.ok(!boot.plugins.some(p => /hiyori/.test(p.id))); assert.ok(boot.plugins.some(p => p.id === 'builtin.cat-default')); checks.push('blue-maid-and-cat-without-live2d-core');
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true); checks.push('actual-packaged-runtime');
    const packageVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version + '-beta.1';
    assert.equal(boot.version, packageVersion); checks.push('packaged-release-version');
    assert.equal(boot.skin.actionProfile.kind, 'sprite'); checks.push('packaged-character-action-profile');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), true); checks.push('packaged-top-layer');
    const command = name => page.evaluate(name => window.deskpet.invokePlugin({ kind: 'command', pluginId: 'builtin', name }), name);
    for (const state of ['happy', 'angry', 'sad', 'walk']) { await command(`pose-${state}`); await page.waitForFunction(state => document.querySelector('#pet').dataset.state === state, state); }
    checks.push('packaged-blue-maid-emotions-and-walk');
    await command('dock-bottom'); await page.waitForFunction(() => document.querySelector('#pet').dataset.body === 'lounge-bottom');
    const ground = await app.evaluate(({ BrowserWindow, screen }) => { const b = BrowserWindow.getAllWindows()[0].getBounds(); const d = screen.getDisplayMatching(b).workArea; return { y: b.y, floor: d.y + d.height }; });
    assert.ok(ground.y + await page.locator('#pose-ledge').evaluate(el => el.getBoundingClientRect().top) <= ground.floor + 1); checks.push('packaged-visible-lounge-boundary');
    await command('wake');
    const settingsPromise = app.waitForEvent('window'); await command('settings'); const settings = await settingsPromise;
    await settings.locator('button[data-tab="model"]').click(); await settings.locator('#skin-list .skin').first().waitFor();
    assert.equal(await settings.getByRole('button', { name: '导入 Live2D', exact: true }).count(), 0); checks.push('framework-capabilities-match-settings');
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, data);
    const exported = await settings.evaluate(() => window.deskpet.exportActionProfile());
    assert.equal(exported.ok, true); assert.equal(JSON.parse(fs.readFileSync(path.join(exported.dir, 'action-profile.json'), 'utf8')).kind, 'sprite');
    assert.ok(fs.existsSync(path.join(exported.dir, 'template.json'))); checks.push('packaged-action-template-export');
    await settings.evaluate(() => window.deskpet.setSkin('builtin.cat-default')); await page.waitForFunction(() => document.querySelector('#pet').dataset.body === 'idle');
    assert.equal((await page.evaluate(() => window.deskpet.bootstrap())).skin.id, 'builtin.cat-default');
    await settings.evaluate(() => window.deskpet.setSkin('builtin.blue-maid')); assert.equal((await page.evaluate(() => window.deskpet.bootstrap())).skin.id, 'builtin.blue-maid'); checks.push('packaged-two-character-switch');
    await settings.locator('button[data-tab="chat"]').click(); await settings.locator('[data-key="persona"]').waitFor();
    assert.ok(await settings.locator('input[type="password"]').count()); checks.push('testers-can-configure-key-and-persona');
    const rejected = await settings.evaluate(() => window.deskpet.skinImport('live2d')); assert.equal(rejected.ok, false); checks.push('unavailable-runtime-import-rejected');
    await settings.close(); await page.waitForTimeout(2200);
    const log = fs.readFileSync(path.join(data, 'logs/deskpet.log'), 'utf8'); assert.ok(log.includes('全屏检测：')); assert.ok(!log.includes('全屏检测不可用') && !log.includes('全屏检测诊断')); checks.push('helper-extracted-outside-asar');
    assert.deepEqual(errors, []); checks.push('no-packaged-renderer-errors');
    fs.writeFileSync('.runtime/package-smoke-report.json', JSON.stringify({ generatedAt: new Date().toISOString(), exe, passed: true, checks, errors }, null, 2));
    console.log(`${checks.length} packaged application checks passed`);
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
