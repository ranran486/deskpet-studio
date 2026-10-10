const { _electron } = require('playwright'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
process.chdir(path.resolve(__dirname, '..'));
(async () => {
  const data = path.resolve(`.runtime/action-profile-qa-${Date.now()}`), dir = path.join(data, 'plugins/user.renamed-avatar'); fs.mkdirSync(dir, { recursive: true });
  fs.cpSync('packs/cat-default', dir, { recursive: true });
  const file = path.join(dir, 'plugin.json'), manifest = JSON.parse(fs.readFileSync(file)); manifest.id = 'user.renamed-avatar'; manifest.name = '映射测试角色'; fs.writeFileSync(file, JSON.stringify(manifest));
  const states = JSON.parse(fs.readFileSync(path.join(dir, 'states.json'))); states.states.Resting = states.states.idle; delete states.states.idle; states.default = 'Resting'; states.states.Flustered = states.states.happy;
  states.states.Locomotion = states.states.wave; states.states.Grabbed = states.states.drag; states.states.Chattering = states.states.talk; fs.writeFileSync(path.join(dir, 'states.json'), JSON.stringify(states));
  fs.writeFileSync(path.join(dir, 'action-profile.json'), JSON.stringify({ version: 'deskpet-character-actions/1', kind: 'sprite', states: { idle: 'Resting', walk: 'Locomotion', shy: 'Flustered', 'drag-lift': 'Grabbed', talk: 'Chattering' }, anchors: { collar: { x: .5, y: .24 }, peek: { left: .3, right: .7 } } }));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ skin: 'user.renamed-avatar', disabled: ['builtin.cat-actions', 'builtin.pomodoro-js'], interaction: { look: false, avoid: false, wander: false, hourlyChime: false, fullscreenQuiet: false } }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: [path.resolve('.'), `--data-dir=${data}`, '--no-sandbox'], env }); const checks = [], errors = [];
  try {
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#pet')?.dataset.state === 'Resting'); checks.push('new-character-idle-name-mapping');
    await page.evaluate(() => window.deskpet.petInteract('rub')); await page.waitForFunction(() => document.querySelector('#pet').dataset.state === 'Flustered'); checks.push('existing-rub-gameplay-uses-new-character-expression');
    await page.evaluate(() => window.deskpet.invokePlugin({ kind: 'command', pluginId: 'builtin', name: 'pose-walk' })); await page.waitForFunction(() => document.querySelector('#pet').dataset.state === 'Locomotion'); checks.push('existing-walk-template-uses-new-state');
    const output = path.join(data, 'export'); fs.mkdirSync(output);
    await app.evaluate(({ dialog }, output) => { globalThis.oldOpenDialog = dialog.showOpenDialog; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [output] }); }, output);
    const exported = await page.evaluate(() => window.deskpet.exportActionProfile()); assert.equal(exported.ok, true); assert.ok(fs.existsSync(path.join(exported.dir, 'action-profile.json'))); assert.ok(fs.existsSync(path.join(exported.dir, 'template.json'))); checks.push('current-character-action-template-export');
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.oldOpenDialog; });
    await page.evaluate(() => window.deskpet.setSkin('builtin.blue-maid')); await page.waitForFunction(() => document.querySelector('#pet').dataset.body === 'idle');
    await page.evaluate(() => window.deskpet.setSkin('user.renamed-avatar')); await page.waitForFunction(() => document.querySelector('#pet').dataset.state === 'Resting'); checks.push('switch-back-retains-own-bindings');
    assert.deepEqual(errors, []); checks.push('no-renderer-errors'); fs.writeFileSync('.runtime/action-profile-qa-report.json', JSON.stringify({ generatedAt: new Date().toISOString(), passed: true, checks, errors }, null, 2)); console.log(`${checks.length} action profile application checks passed`);
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
