import { Quaternion, Vector3, MathUtils } from 'three'

const up = new Vector3(0, 1, 0)
const smooth = t => t * t * (3 - 2 * t)
const position = bone => bone.getWorldPosition(new Vector3())

export function aimBone(bone, child, direction) {
  const parent = bone.parent.getWorldQuaternion(new Quaternion())
  const from = child.position.clone().normalize().applyQuaternion(bone.quaternion)
  const to = direction.clone().normalize().applyQuaternion(parent.invert())
  bone.quaternion.premultiply(new Quaternion().setFromUnitVectors(from, to))
}

// Each stride has two footfalls. The supporting ankle stays at its stage
// coordinate while the pelvis follows the feet and the other boot lifts.
export function stageWalk(root, model, bones) {
  const legs = ['R', 'L'].map(side => {
    const [hip, knee, foot] = ['Thigh', 'Calf', 'Foot'].map(part => bones.get(`CC_Base_${side}_${part}`))
    const home = position(foot)
    return { hip, knee, foot, home, anchor: home.clone(), angle: 0,
      bind: [hip, knee, foot].map(b => b.quaternion.clone()),
      level: foot.getWorldQuaternion(new Quaternion()),
      thigh: position(hip).distanceTo(position(knee)), calf: position(knee).distanceTo(home) }
  })
  let center = 0, yaw = 0, stride = null
  return (presenting, dt) => {
    const target = presenting ? -0.63 : 0
    if (!stride && Math.abs(target - center) > 0.001) {
      const end = center + MathUtils.clamp(target - center, -0.21, 0.21)
      const angle = 0.86 * (end / -0.63)
      stride = { end, angle, first: end < center ? 0 : 1, elapsed: 0,
        starts: legs.map(l => l.anchor.clone()), angles: legs.map(l => l.angle),
        ends: legs.map(l => l.home.clone().applyAxisAngle(up, angle).add(new Vector3(end, 0, 0))) }
    }
    if (stride) {
      stride.elapsed += dt
      const t = Math.min(1, stride.elapsed / 0.78)
      root.position.x = MathUtils.lerp(center, stride.end, smooth(t))
      root.rotation.y = MathUtils.lerp(yaw, stride.angle, smooth(t))
      legs.forEach((leg, i) => {
        const u = MathUtils.clamp(2 * t - (i === stride.first ? 0 : 1), 0, 1)
        leg.anchor.lerpVectors(stride.starts[i], stride.ends[i], smooth(u))
        leg.anchor.y += 0.065 * Math.sin(Math.PI * u) ** 2
        leg.angle = MathUtils.lerp(stride.angles[i], stride.angle, smooth(u))
      })
      if (t === 1) { center = stride.end; yaw = stride.angle; stride = null }
    }
    root.position.y = -0.025
    for (const leg of legs) {
      const { hip, knee, foot, thigh, calf } = leg
      ;[hip, knee, foot].forEach((bone, i) => bone.quaternion.copy(leg.bind[i]))
      const origin = position(hip)
      const ankle = leg.anchor.clone()
      ankle.y += model.position.y
      const line = ankle.sub(origin)
      const reach = MathUtils.clamp(line.length(), Math.abs(thigh - calf) + 0.0001, thigh + calf - 0.0001)
      line.normalize()
      const along = (thigh * thigh + reach * reach - calf * calf) / (2 * reach)
      const bend = new Vector3(Math.sin(leg.angle), 0, Math.cos(leg.angle))
      bend.addScaledVector(line, -bend.dot(line)).normalize()
      const upper = bend.multiplyScalar(Math.sqrt(Math.max(0, thigh * thigh - along * along))).addScaledVector(line, along)
      aimBone(hip, knee, upper)
      aimBone(knee, foot, line.multiplyScalar(reach).sub(upper))
      foot.quaternion.copy(foot.parent.getWorldQuaternion(new Quaternion()).invert())
        .multiply(new Quaternion().setFromAxisAngle(up, leg.angle)).multiply(leg.level)
    }
  }
}
