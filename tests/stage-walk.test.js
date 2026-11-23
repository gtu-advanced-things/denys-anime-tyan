import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Group, Object3D, Vector3 } from 'three'
import { stageWalk } from '../web/stage-walk.js'

test('Amber plants a boot during each step and stands still in both modes', () => {
  const glb = readFileSync(new URL('../public/avatar/amber.glb', import.meta.url))
  const { nodes, scenes } = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)))
  const model = new Group(), root = new Group()
  root.add(model)
  const bones = new Map()
  const objects = nodes.map(n => {
    const obj = new Object3D()
    if (n.translation) obj.position.fromArray(n.translation)
    if (n.rotation) obj.quaternion.fromArray(n.rotation)
    if (n.scale) obj.scale.fromArray(n.scale)
    bones.set(n.name, obj)
    return obj
  })
  nodes.forEach((n, i) => n.children?.forEach(child => objects[i].add(objects[child])))
  scenes[0].nodes.forEach(i => model.add(objects[i]))
  const walk = stageWalk(root, model, bones)
  const ankles = () => ['R','L'].map(side => bones.get(`CC_Base_${side}_Foot`).getWorldPosition(new Vector3()))
  const home = ankles()
  for (const presenting of [false, true, false]) {
    let prev = ankles(), lift = 0
    for (let frame = 0; frame < 240; frame++) {
      walk(presenting, 1 / 60)
      const feet = ankles()
      // Around toe-off a single rendered frame can straddle two successive steps.
      assert.ok(Math.min(...feet.map((p, i) => p.distanceTo(prev[i]))) < 0.001)
      lift = Math.max(lift, ...feet.map((p, i) => p.y - home[i].y))
      prev = feet
    }
    assert.ok(Math.abs(root.position.x - (presenting ? -0.63 : 0)) < 0.00001)
    if (presenting) assert.ok(lift > 0.05)
    for (let frame = 0; frame < 120; frame++) walk(presenting, 1 / 60)
    ankles().forEach((p, i) => assert.ok(p.distanceTo(prev[i]) < 0.000001))
  }
  ankles().forEach((p, i) => assert.ok(p.distanceTo(home[i]) < 0.00001))
})
