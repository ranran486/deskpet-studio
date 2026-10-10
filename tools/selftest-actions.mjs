import assert from 'node:assert/strict'
import { ACTION_MODEL_VERSION, JOINT_PARENT, chooseBodyAction, dragRootWithinScreen, restSkeleton, retargetSkeleton, sampleActionPose, dockPosition, nearestDockEdge, semanticState, constrainToGround } from '../dist/shared/action-model.js'
let checks = 0
const check = (label, run) => { run(); checks++; console.log('PASS', label) }
check('拖动优先于待机与行走', () => assert.equal(chooseBodyAction({ dragging: true, resting: true, edge: 'bottom', speed: 20 }), 'drag-lift'))
for (const [edge, body] of [['bottom', 'sleep-curl'], ['left', 'peek-left'], ['right', 'peek-right']]) check(`${edge} 边缘继承对应待机动作`, () => assert.equal(chooseBodyAction({ dragging: false, resting: true, edge, speed: 0 }), body))
check('行走和情绪相互独立', () => assert.equal(chooseBodyAction({ dragging: false, resting: false, edge: 'none', speed: 50, emotion: 'sad' }), 'walk'))
check('带负坐标的副屏与屏幕四角均可到达', () => {
  const s = { x: -1920, y: -200, width: 1920, height: 1080 }, g = { x: 80, y: 25 }
  for (const point of [{ x: -1920, y: -200 }, { x: 0, y: 880 }]) {
    const root = dragRootWithinScreen(point, s, g)
    assert.equal(root.x + g.x, point.x); assert.equal(root.y + g.y, point.y)
  }
})
check('所有身体动作与四种情绪组合都输出有限值', () => {
  for (const body of ['idle', 'walk', 'sleep-curl', 'peek-left', 'peek-right', 'drag-lift']) for (const emotion of ['neutral', 'happy', 'angry', 'sad']) for (const timeMs of [0, 400, 5500, 1e10]) {
    const pose = sampleActionPose({ body, emotion, timeMs, dragSwing: 999 })
    for (const joint of Object.values(pose.joints)) assert.ok(Object.values(joint).every(Number.isFinite))
    assert.ok(Math.abs(pose.motion.rotate) < 17)
  }
})
check('睡眠与悬垂使用不同的支点和眼睑', () => {
  assert.equal(sampleActionPose({ body: 'sleep-curl', timeMs: 0 }).face.eyeOpen, 0)
  assert.equal(sampleActionPose({ body: 'drag-lift', timeMs: 0 }).anchor, 'collar')
})
check('更换身材后保留新人物骨长', () => {
  const rest = restSkeleton(), joints = Object.fromEntries(Object.entries(rest).map(([key, p]) => [key, { x: .5 + (p.x - .5) * .7, y: .5 + (p.y - .5) * 1.2 }]))
  const adapter = { version: ACTION_MODEL_VERSION, joints, parts: {}, mode: 'rig' }
  for (const body of ['walk', 'sleep-curl', 'drag-lift']) {
    const mapped = retargetSkeleton(sampleActionPose({ body, timeMs: 450 }), adapter)
    for (const [name, parent] of Object.entries(JOINT_PARENT)) if (parent) {
      const actual = Math.hypot(mapped[name].x - mapped[parent].x, mapped[name].y - mapped[parent].y)
      const expected = Math.hypot(joints[name].x - joints[parent].x, joints[name].y - joints[parent].y)
      assert.ok(Math.abs(actual - expected) < 1e-8)
    }
    if (body === 'drag-lift') assert.ok(Math.abs(mapped.collar.y - .03) < 1e-8)
  }
})
check('旧人物缺少精细动作时回退而不引用其他人物的帧', () => {
  assert.equal(semanticState({ idle: {}, drag: {}, sleep: {} }, 'drag-lift'), 'drag')
  assert.equal(semanticState({ idle: {}, drag: {}, sleep: {} }, 'sleep-curl'), 'sleep')
  assert.equal(semanticState({ idle: {} }, 'peek-right'), 'idle')
})
check('边缘裁切与气泡舞台留白无关', () => {
  const area={x:-1920,y:-200,width:1920,height:1080},g={x:52,y:164,width:256,height:256,collarX:180,collarY:180,bottomLine:210,leftLine:102.4,rightLine:153.6}
  const pos={x:-500,y:100}
  const left=dockPosition('left',pos,g,area),right=dockPosition('right',pos,g,area),bottom=dockPosition('bottom',pos,g,area)
  assert.ok(Math.abs(left.x+g.x+g.leftLine-area.x)<1e-8)
  assert.ok(Math.abs(right.x+g.x+g.rightLine-(area.x+area.width))<1e-8)
  assert.equal(bottom.y+g.y+g.height,area.y+area.height)
})
check('多屏负坐标下最近边缘选择正确', () => {
  const area={x:-1920,y:-200,width:1920,height:1080}
  assert.equal(nearestDockEdge({x:-1910,y:0},area),'left')
  assert.equal(nearestDockEdge({x:-5,y:0},area),'right')
  assert.equal(nearestDockEdge({x:-960,y:870},area),'bottom')
})
check('抓衣领拖到最底部时整个角色仍在实地上方', () => {
  const screen={x:0,y:0,width:1920,height:1080}, geometry={y:180,height:256}, grab={x:180,y:196}
  const requested=dragRootWithinScreen({x:960,y:1079},screen,grab)
  const grounded=constrainToGround(requested,geometry,screen)
  assert.equal(grounded.y+geometry.y+geometry.height,1080)
  assert.equal(grounded.x,requested.x)
  assert.equal(constrainToGround({x:20,y:-200},geometry,screen).y,-200)
})
check('负坐标显示器与更大人物均按各自屏幕地面限制', () => {
  for(const screen of [{y:-1080,height:1080},{y:120,height:900}])for(const height of [64,256,512]) {
    const g={y:140,height}, p=constrainToGround({x:-400,y:5000},g,screen)
    assert.equal(p.y+g.y+g.height,screen.y+screen.height)
  }
})
console.log(`Action model: ${checks} checks passed`)
