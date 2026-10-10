const { app } = require('electron'), path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '..');
  const { InteractionLoop } = await import(pathToFileURL(path.join(root, 'dist/main/interaction/loop.js')).href);
  const { DEFAULT_CONFIG } = await import(pathToFileURL(path.join(root, 'dist/shared/types.js')).href);
  let active = 0;
  const host = { on: () => { active++; return () => { active-- } }, send: () => {}, quietMode: false, sleeping: false };
  const loop = new InteractionLoop({ host, config: { data: structuredClone(DEFAULT_CONFIG) }, petWindow: { win: null, getPosition: () => null, isDragging: () => false, enforceGround: () => {} } });
  loop.start(); const first = active; loop.stop(); assert.equal(active, 0);
  loop.start(); assert.equal(active, first); loop.stop(); assert.equal(active, 0);
  fs.mkdirSync(path.join(root, '.runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, '.runtime/lifecycle-qa-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), passed: true, checks: ['stop-removes-all-subscriptions', 'restart-keeps-single-subscription-set', 'second-stop-removes-all'] }, null, 2));
  console.log('3 interaction lifecycle checks passed'); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
