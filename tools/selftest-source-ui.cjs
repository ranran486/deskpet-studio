const { _electron } = require('playwright'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
process.chdir(path.resolve(__dirname, '..'));
(async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const data = path.resolve(`.runtime/source-ui-qa-${Date.now()}`);
  const app = await _electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: [path.resolve('.'), `--data-dir=${data}`, '--no-sandbox'], env });
  try {
    const page = await app.firstWindow(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#pet')?.dataset.body === 'idle');
    const boot = await page.evaluate(() => window.deskpet.bootstrap());
    assert.equal(boot.skin.id, 'builtin.blue-maid'); assert.equal(boot.capabilities.live2d, fs.existsSync('src/renderer/vendor/live2dcubismcore.min.js'));
    assert.deepEqual(errors, []);
    fs.writeFileSync('.runtime/source-ui-qa-report.json', JSON.stringify({ generatedAt: new Date().toISOString(), passed: true, live2dIncluded: boot.capabilities.live2d, checks: ['public-default-model', 'capabilities-match-resources', 'no-renderer-errors'] }, null, 2));
    console.log('3 clean-source startup checks passed');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
