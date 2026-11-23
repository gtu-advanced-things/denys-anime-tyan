import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { bindStageSettings, gazeAngles } from './stage-settings.js'
import { stageWalk, aimBone } from './stage-walk.js'
import { bindCamera } from './camera.js'
import { messageReaction } from './gestures.js'

const view = document.querySelector('#avatar-view')
const status = document.querySelector('#camera-status')
const cameraButton = document.querySelector('#camera-toggle')
const state = { face: null, hands: {}, camera: false }
const worldY = new THREE.Vector3(0, 1, 0)
const worldX = new THREE.Vector3(1, 0, 0)
const clamp = THREE.MathUtils.clamp
let analyser, samples, browserSpeaking = false
let posterRequest
const slides = []
window.addEventListener('avatar:poster', ({ detail }) => {
  if (slides.at(-1) !== detail) slides.push(detail)
})
window.addEventListener('avatar:turn', ({detail}) => {
  if (detail.phase === 'start' || detail.phase === 'interrupt') slides.length = 0
})

window.addEventListener('voice:analyser', ({ detail }) => {
  analyser = detail
  samples = new Float32Array(analyser.fftSize)
})
window.addEventListener('voice:browser-speech', ({ detail }) => { browserSpeaking = detail })

let scratching = false
let thinkStarted = 0
let reaction = null
let reactionStarted = 0
window.addEventListener('avatar:turn', ({ detail }) => {
  if (detail.phase === 'start') {
    scratching = Math.random() < 0.33
    thinkStarted = performance.now() / 1000
    reaction = messageReaction(detail.text)
    reactionStarted = thinkStarted
  } else scratching = false
})

const fullscreen = document.querySelector('#fullscreen-toggle')
const isFullscreen = () => document.fullscreenElement === view || view.classList.contains('avatar-fullscreen')

function updateFullscreen() {
  const active = isFullscreen()
  fullscreen.setAttribute('aria-pressed', String(active))
  if (!active) fullscreen.focus({ preventScroll: true })
}

async function leaveFullscreen() {
  if (document.fullscreenElement === view) await document.exitFullscreen()
  else if (view.classList.contains('avatar-fullscreen')) {
    view.classList.remove('avatar-fullscreen')
    updateFullscreen()
  }
}

fullscreen.addEventListener('click', async () => {
  if (isFullscreen()) return leaveFullscreen()
  try {
    if (!view.requestFullscreen) throw new Error('Fullscreen API unavailable')
    await view.requestFullscreen()
  } catch {
    view.classList.add('avatar-fullscreen')
    updateFullscreen()
  }
})
view.addEventListener('dblclick', () => { void leaveFullscreen() })
document.addEventListener('fullscreenchange', updateFullscreen)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isFullscreen()) void leaveFullscreen()
})

function voiceLevel(time) {
  if (analyser) {
    analyser.getFloatTimeDomainData(samples)
    let energy = 0
    for (const value of samples) energy += value * value
    return clamp((Math.sqrt(energy / samples.length) - 0.009) * 6, 0, 0.85)
  }
  return browserSpeaking ? 0.12 + 0.34 * Math.abs(Math.sin(time * 15)) : 0
}

function basis(up, across) {
  const y = up.clone().normalize()
  const z = across.clone().cross(y).normalize()
  const x = y.clone().cross(z)
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z))
}

function armFor(bones, side) {
  const get = part => bones.get(`CC_Base_${side[0]}_${part}`)
  const shoulder = get('Upperarm')
  const elbow = get('Forearm')
  const wrist = get('Hand')
  const digits = ['Thumb', 'Index', 'Mid', 'Ring', 'Pinky'].map((name) =>
    [get(`${name}1`), get(`${name}2`), get(`${name}3`)]
  )
  if (!shoulder || !elbow || !wrist || digits.flat().some((bone) => !bone)) return null
  const sign = side === 'Right' ? -1 : 1
  aimBone(shoulder, elbow, new THREE.Vector3(sign * 0.20, -1, -0.03))
  aimBone(elbow, wrist, new THREE.Vector3(sign * 0.07, -1, 0.22))
  const palm = basis(digits[2][0].position, digits[1][0].position.clone().sub(digits[4][0].position))
  const point = bone => bone.getWorldPosition(new THREE.Vector3())
  const lengthwise = point(digits[2][0]).sub(point(wrist)).normalize()
  const widthwise = point(digits[1][0]).sub(point(digits[4][0])).normalize()
  const inward = lengthwise.clone().cross(widthwise).multiplyScalar(sign).normalize()
  const hinges = digits.map((chain, digit) => chain.map((joint, segment) => {
    const along = segment < 2 ? point(chain[segment + 1]).sub(point(joint)) : point(joint).sub(point(chain[1]))
    const toward = digit === 0 ? point(digits[4][0]).sub(point(chain[0])) : inward
    const inverse = joint.getWorldQuaternion(new THREE.Quaternion()).invert()
    return { curl: along.cross(toward).normalize().applyQuaternion(inverse),
      spread: inward.clone().applyQuaternion(inverse) }
  }))
  // Relax the resting hand progressively from index to little finger.
  const neutralDigits = digits.flat().map(joint => joint.quaternion.clone())
  digits.forEach((chain, digit) => chain.forEach((joint, segment) => {
    const curl = digit === 0 ? 0.10 : (0.14 + digit * 0.055) * [1, 0.85, 0.55][segment]
    joint.rotateOnAxis(hinges[digit][segment].curl, curl)
  }))
  const joints = [shoulder, elbow, wrist, ...digits.flat()]
  return {
    head: bones.get('CC_Base_Head'),
    shoulder, elbow, wrist, digits, palm, hinges, joints, sign: side === 'Right' ? -1 : 1,
    rest: [shoulder.quaternion.clone(), elbow.quaternion.clone(), wrist.quaternion.clone(), ...neutralDigits],
    base: joints.map(joint => joint.quaternion.clone()),
    displayed: joints.map(joint => joint.quaternion.clone())
  }
}

function animateArm(arm, kind, delta, strength = 1, phase = 0) {
  if (!arm) return
  const { shoulder, elbow, wrist, digits, palm, sign, joints, rest, displayed } = arm
  const idle = joints.map(joint => joint.quaternion.clone())
  if (kind) {
    for (let i = 0; i < joints.length; i++) joints[i].quaternion.copy(rest[i])
    shoulder.updateWorldMatrix(true, true)
    poseArm()
  }
  // Blend actual local rotations, including when two active gestures replace each other.
  const blend = 1 - Math.exp(-delta * (kind ? 9 : 7))
  joints.forEach((joint, i) => {
    const target = idle[i].slerp(joint.quaternion, strength)
    const angle = displayed[i].angleTo(target)
    displayed[i].rotateTowards(target, Math.min(angle * blend, delta * 7))
    joint.quaternion.copy(displayed[i])
  })

  function poseArm() {
    const upper = new THREE.Vector3(sign * 0.56, -0.66, 0.38)
    const lower = new THREE.Vector3(sign * 0.22, 0.78, 0.62)
    const across = worldX.clone().multiplyScalar(kind === 'middle' ? sign : -sign)
    const upright = new THREE.Vector3(sign * 0.08, 1, 0.08)
    const pulse = Math.sin(phase * 3.1)
    if (kind === 'thumb') {
      lower.set(-sign * 0.10, 0.85, 0.55)
      upright.set(-sign * 0.68, 0.36, 0.57)
      across.set(sign * 0.12, 1, 0.1)
    } else if (kind === 'wave') {
      upper.set(sign * 0.70, -0.36, 0.39)
      lower.set(sign * (0.07 + 0.15 * Math.sin(phase * 7)), 0.99, 0.23)
      upright.set(sign * (0.09 + 0.34 * Math.sin(phase * 7)), 1, 0.04)
    } else if (kind === 'scratch') {
      upper.set(sign * 0.73, 0.30, -0.17)
      lower.set(-sign * 0.85, 0.45, 0.04 + 0.065 * Math.sin(phase * 8))
      upright.set(-sign * 0.83, 0.18, -0.29)
      across.set(sign * 0.1, -0.25, 1)
    } else if (kind === 'chin') {
      upper.set(sign * 0.08, -0.66, 0.65)
      lower.set(-sign * (0.57 + 0.055 * Math.sin(phase * 4)), 0.91, -0.28)
      upright.set(-sign * 0.40, 0.83, -0.25 + 0.10 * Math.sin(phase * 5))
      across.set(sign * 0.80, 0.12, -0.45)
    } else if (kind === 'beat' || kind === 'sweep' || kind === 'self') {
      const beat = Math.sin(phase * 4)
      upper.set(sign * (kind === 'sweep' ? 0.72 : 0.28), -0.62, 0.52)
      lower.set(sign * (kind === 'self' ? -0.76 : 0.24 + 0.23 * beat), 0.69, kind === 'self' ? -0.10 : 0.42)
      upright.set(sign * (kind === 'self' ? -0.68 : 0.23), kind === 'beat' ? 0.49 : 0.62, 0.49 + 0.13 * beat)
      across.set(sign * (kind === 'self' ? 0.86 : -0.20), 0.57, -0.48)
    } else if (kind === 'shrug') {
      upper.set(sign * 0.48, -0.67, 0.30)
      lower.set(sign * 0.60, 0.43 + 0.06 * pulse, 0.63)
      upright.set(sign * 0.61, 0.18, 0.67)
      across.set(sign * 0.64, 0.37, -0.61)
    } else if (kind === 'explain' || kind === 'offer') {
      upper.set(sign * (kind === 'offer' ? 0.68 : 0.32), -0.57, 0.40)
      lower.set(sign * (kind === 'offer' ? 0.33 : -0.16), 0.58 + 0.2 * Math.sin(phase * 3), 0.77)
      upright.set(sign * (kind === 'offer' ? 0.72 : 0.15), kind === 'offer' ? 0.34 : 0.86, 0.45)
      across.set(sign * 0.64, kind === 'offer' ? 0.36 : 0.71, -0.53)
    }

    const turn = arm.frame.getWorldQuaternion(new THREE.Quaternion())
    for (const vector of [upper, lower, upright, across]) vector.applyQuaternion(turn)
    if (arm.head && (kind === 'scratch' || kind === 'chin')) {
      const origin = shoulder.getWorldPosition(new THREE.Vector3())
      const target = arm.head.getWorldPosition(new THREE.Vector3())
      const stroke = Math.sin(phase * (kind === 'chin' ? 3 : 6))
      const offset = kind === 'scratch'
        ? new THREE.Vector3(sign * 0.123, 0.039 + 0.006 * stroke, -0.068)
        : new THREE.Vector3(sign * 0.058, -0.115, 0.105 + 0.006 * stroke)
      target.add(offset.applyQuaternion(turn))
      const axis = target.clone().sub(origin).normalize()
      const elbowWorld = elbow.getWorldPosition(new THREE.Vector3())
      const a = origin.distanceTo(elbowWorld), b = elbowWorld.distanceTo(wrist.getWorldPosition(new THREE.Vector3()))
      const reach = clamp(origin.distanceTo(target), Math.abs(a - b) + 0.001, a + b - 0.001)
      const along = (reach * reach + a * a - b * b) / (2 * reach)
      const pole = upper.clone().addScaledVector(axis, -upper.dot(axis)).normalize()
      upper.copy(axis).multiplyScalar(along).addScaledVector(pole, Math.sqrt(Math.max(0, a * a - along * along)))
      lower.copy(axis).multiplyScalar(reach).sub(upper)
    }

    aimBone(shoulder, elbow, upper)
    aimBone(elbow, wrist, lower)
    const target = basis(upright, across).multiply(palm.clone().invert())
    // Share palm rotation with the forearm, keeping wrist flexion small.
    const axis = wrist.getWorldPosition(new THREE.Vector3()).sub(elbow.getWorldPosition(new THREE.Vector3())).normalize()
    const relative = target.clone().multiply(wrist.getWorldQuaternion(new THREE.Quaternion()).invert())
    if (relative.w < 0) relative.set(-relative.x, -relative.y, -relative.z, -relative.w)
    const twist = clamp(2 * Math.atan2(axis.dot(new THREE.Vector3(relative.x, relative.y, relative.z)), relative.w), -1.35, 1.35)
    const localAxis = axis.applyQuaternion(elbow.getWorldQuaternion(new THREE.Quaternion()).invert())
    elbow.rotateOnAxis(localAxis, twist)
    const wristTarget = wrist.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(target)
    wrist.quaternion.copy(rest[2]).rotateTowards(wristTarget, 0.60)

    const extended = { thumb: [0], middle: [2], victory: [1, 2], fist: [] }[kind]
    digits.forEach((chain, digit) => {
      chain.forEach((joint, segment) => {
        const open = extended?.includes(digit)
        let angle = extended ? open ? 0 : [0.96, 1.24, 0.70][segment] : 0.08
        if (kind === 'wave' || kind === 'open') angle = 0.02
        if (kind === 'scratch' || kind === 'chin') {
          angle = (kind === 'scratch' ? 0.35 : 0.26) + 0.15 * Math.sin(phase * 7 + digit * 0.35)
        }
        if (!extended && !['wave','open','scratch','chin'].includes(kind)) {
          angle = 0.10 + digit * 0.035 + 0.06 * pulse
        }
        if (kind === 'chin' && digit > 1) angle += 0.29
        if (digit === 0) angle *= 0.55
        if (segment === 0 && digit > 0) {
          const spread = kind === 'victory' ? [0, 0.30, -0.22, 0, 0][digit] :
            (kind === 'open' || kind === 'wave' ? (2.5 - digit) * 0.095 : 0)
          joint.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(arm.hinges[digit][segment].spread, -sign * spread))
        }
        joint.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(arm.hinges[digit][segment].curl, angle))
      })
    })
    if (kind === 'thumb') {
      // The thumb has an oblique bind axis, independent of palm flexion.
      const chain = digits[0]
      for (let i = 0; i < 2; i++) {
        const joint = chain[i]
        const localUp = worldY.clone().applyQuaternion(joint.parent.getWorldQuaternion(new THREE.Quaternion()).invert())
        const axis = chain[i + 1].position.clone().normalize().applyQuaternion(joint.quaternion)
        const target = new THREE.Quaternion().setFromUnitVectors(axis, localUp).multiply(joint.quaternion)
        joint.quaternion.rotateTowards(target, i ? 0.65 : 0.92)
      }
    }
  }
}

function speechMotion() {
  const repertoire = ['explain', 'offer', 'scratch', 'chin', 'beat', 'sweep', 'self', 'shrug']
  let bag = [], previous, side, elapsed = 0, duration = 0
  return (delta) => {
    elapsed += delta
    if (elapsed >= duration) {
      if (!bag.length) bag = [...repertoire]
      const choices = bag.filter(kind => kind !== previous)
      previous = choices[Math.floor(Math.random() * choices.length)]
      bag.splice(bag.indexOf(previous), 1)
      side = side === 'Left' ? 'Right' : 'Left'
      elapsed = 0
      duration = 2.0 + Math.random() * 1.3
    }
    return { kind: previous, side, phase: elapsed }
  }
}

function posterDisplay(scene) {
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff, toneMapped: false, transparent: true, opacity: 0, side: THREE.DoubleSide
  })
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
  sheet.visible = false
  scene.add(sheet)
  const loader = new THREE.TextureLoader()
  let active, observed, loaded
  let visibleFor = 0

  return delta => {
    if (slides.length && (observed === active || !active && !observed) && (!active || visibleFor >= 5)) {
      posterRequest = slides.shift()
    }
    if (posterRequest !== observed) {
      observed = posterRequest
      const request = observed
      loaded?.dispose()
      loaded = undefined
      if (request && request !== active) {
        loader.loadAsync(request).then((texture) => {
          if (posterRequest !== request) return texture.dispose()
          texture.colorSpace = THREE.SRGBColorSpace
          texture.anisotropy = 4
          loaded?.dispose()
          loaded = texture
        }).catch(error => { if (posterRequest === request) posterRequest = active; console.error(error) })
      }
    }
    if (active && material.opacity > 0.85) visibleFor += delta
    if (active !== observed && visibleFor >= 5 && (!observed || loaded)) {
      material.opacity = THREE.MathUtils.damp(material.opacity, 0, 13, delta)
      if (material.opacity < 0.035) {
        material.map?.dispose()
        material.map = null
        active = undefined
        material.needsUpdate = true
      }
    }
    if (!active && loaded && observed) {
      material.needsUpdate = true
      sheet.scale.set(1.00, 0.72, 1)
      // Preserve the original aspect ratio inside the paper rather than stretching the image.
      const paperRatio = sheet.scale.x / sheet.scale.y
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(1024 * paperRatio)
      canvas.height = 1024
      const context = canvas.getContext('2d')
      context.fillStyle = '#faf7ef'
      context.fillRect(0, 0, canvas.width, canvas.height)
      const fit = Math.min((canvas.width - 48) / loaded.image.width, 976 / loaded.image.height)
      const width = loaded.image.width * fit, height = loaded.image.height * fit
      context.drawImage(loaded.image, (canvas.width - width) / 2, (1024 - height) / 2, width, height)
      material.map = new THREE.CanvasTexture(canvas)
      material.map.colorSpace = THREE.SRGBColorSpace
      material.map.anisotropy = 4
      loaded.dispose()
      loaded = undefined
      active = observed
      visibleFor = 0
    }
    if (active && (active === observed || visibleFor < 5 || observed && !loaded)) {
      material.opacity = THREE.MathUtils.damp(material.opacity, 1, 7, delta)
    }
    sheet.position.set(0.56, 1.18, -0.38)
    sheet.scale.set(1.27, 0.91, 1)
    sheet.visible = Boolean(active)
    return Boolean(active)
  }
}

async function startAvatar() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.2
  const { scene, animations } = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync('/avatar/amber.glb')
  const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 50)
  renderer.domElement.setAttribute('aria-label', 'Animated avatar of Amber')
  renderer.domElement.setAttribute('role', 'img')
  const surface = document.getElementById('stage-render')
  surface.append(renderer.domElement)
  const stage = new THREE.Scene()
  camera.removeFromParent()
  stage.add(camera, scene)
  let presenting = false
  const settings = bindStageSettings(() => resize())
  const resize = () => {
    const sideways = settings.angle % 180 === 90
    const width = sideways ? view.clientHeight : view.clientWidth
    const height = sideways ? view.clientWidth : view.clientHeight
    surface.style.width = width + 'px'
    surface.style.height = height + 'px'
    surface.style.transform = `translate(-50%, -50%) rotate(${settings.angle}deg)`
    if (!width || !height) return
    camera.aspect = width / height
    camera.fov = 34
    camera.position.set(0, 0.94, 2.98 * Math.max(1, (presenting ? 1.35 : 0.64) / camera.aspect))
    camera.lookAt(0, 0.81, 0)
    camera.updateProjectionMatrix()
    renderer.setSize(width, height, false)
  }
  new ResizeObserver(resize).observe(view)
  resize()

  stage.add(new THREE.HemisphereLight(0xfff3e5, 0x667692, 2.1))
  for (const [position, color, energy] of [
    [[-3, 3, 4], 0xffe1cf, 2.9], [[3, 2, 2], 0xd7e7ff, 1.6], [[1, 3, -3], 0xffffff, 2.3]
  ]) {
    const light = new THREE.DirectionalLight(color, energy)
    light.position.set(...position)
    stage.add(light)
  }

  const bones = new Map()
  const faces = []
  scene.traverse((node) => {
    if (node.isBone) bones.set(node.userData.name || node.name, node)
    if (node.morphTargetDictionary?.jawOpen != null) faces.push(node)
  })
  const head = bones.get('CC_Base_Head')
  const headRest = head?.quaternion.clone()
  const arms = Object.fromEntries(['Left', 'Right'].map((side) => [side, armFor(bones, side)]))
  const updatePoster = posterDisplay(stage)
  const mixer = new THREE.AnimationMixer(scene)
  if (animations.length) mixer.clipAction(animations[0]).play()
  mixer.update(0)

  const morph = (name, value) => {
    for (const mesh of faces) {
      const index = mesh.morphTargetDictionary[name]
      if (index != null) mesh.morphTargetInfluences[index] = value
    }
  }
  let last = performance.now()
  let yaw = 0, pitch = 0, jaw = 0, rise = 0, speechEnergy = 0
  const speechPose = speechMotion()
  let nextBlink = 3.7
  let blinkStart = -1
  let cleared = false
  let holdingPoster = false
  const walker = new THREE.Group()
  stage.add(walker)
  walker.add(scene)
  const walk = stageWalk(walker, scene, bones)
  for (const arm of Object.values(arms)) if (arm) arm.frame = walker

  const frame = (now) => {
    const time = now / 1000
    const delta = Math.min((now - last) / 1000, 0.25)
    last = now
    const showAvatar = state.camera || isFullscreen() || posterRequest || slides.length || holdingPoster
    if (!showAvatar) {
      if (!cleared) renderer.clear()
      cleared = true
      rise = 0
      return
    }
    cleared = false
    scene.visible = true
    rise = Math.min(1, rise + delta / 1.05)
    scene.position.y = -2.05 * (1 - THREE.MathUtils.smoothstep(rise, 0, 1))
    for (const arm of Object.values(arms)) {
      arm?.joints.forEach((joint, i) => joint.quaternion.copy(arm.base[i]))
    }
    mixer.update(delta)
    const showSlide = updatePoster(delta)
    if (presenting !== showSlide) { presenting = showSlide; resize() }
    holdingPoster = showSlide
    walk(showSlide, delta)
    for (const arm of Object.values(arms)) {
      arm?.joints.forEach((joint, i) => arm.base[i].copy(joint.quaternion))
    }
    scene.updateMatrixWorld(true)
    const [horizontal, vertical] = gazeAngles(state.face, settings)
    yaw = THREE.MathUtils.damp(yaw, clamp(horizontal, -0.75, 0.75), 8, delta)
    pitch = THREE.MathUtils.damp(pitch, clamp(vertical, -0.45, 0.45), 8, delta)
    if (head) {
      head.quaternion.copy(headRest)
      const parentInverse = head.parent.getWorldQuaternion(new THREE.Quaternion()).invert()
      const yawAxis = worldY.clone().applyQuaternion(parentInverse)
      const pitchAxis = worldX.clone().applyQuaternion(parentInverse)
      head.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(yawAxis, yaw))
      head.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(pitchAxis, pitch))
    }
    morph('eyeLookInLeft', Math.max(0, -yaw) * 0.6)
    morph('eyeLookOutLeft', Math.max(0, yaw) * 0.6)
    morph('eyeLookInRight', Math.max(0, yaw) * 0.6)
    morph('eyeLookOutRight', Math.max(0, -yaw) * 0.6)

    jaw = THREE.MathUtils.damp(jaw, voiceLevel(time), 22, delta)
    morph('jawOpen', jaw)
    morph('mouthFunnel', jaw * 0.32)
    morph('mouthUpperUpLeft', jaw * 0.13)
    morph('mouthUpperUpRight', jaw * 0.13)
    if (time >= nextBlink) {
      blinkStart = time
      nextBlink = time + 2.8 + Math.random() * 2
    }
    const blink = blinkStart >= 0 && time - blinkStart < 0.17
      ? Math.sin((time - blinkStart) / 0.17 * Math.PI) : 0
    morph('eyeBlinkLeft', blink)
    morph('eyeBlinkRight', blink)
    const phase = time - reactionStarted
    const reactionKind = phase < (reaction === 'wave' ? 1.65 : 2.0) ? reaction : null
    const thinking = scratching && time - thinkStarted >= 0.30
    speechEnergy = THREE.MathUtils.damp(speechEnergy, jaw > 0.04 ? 1 : 0, 3, delta)
    const speech = speechPose(speechEnergy > 0.09 ? delta : 0)
    for (const side of ['Right', 'Left']) {
      const mirrored = state.hands[side]
      if (mirrored) animateArm(arms[side], mirrored, delta)
      else if (reactionKind === 'shrug' || reactionKind === 'wave' && side === 'Right') {
        animateArm(arms[side], reactionKind, delta, 1, phase)
      } else if (thinking && side === 'Right') {
        animateArm(arms[side], 'scratch', delta, 1, time - thinkStarted)
      } else if (speechEnergy > 0.09 && (side === speech.side || speech.kind === 'shrug')) {
        animateArm(arms[side], speech.kind, delta, Math.min(1, speechEnergy * 1.6), speech.phase)
      } else animateArm(arms[side], null, delta)
    }
    renderer.render(stage, camera)
  }
  nextBlink += last / 1000
  renderer.setAnimationLoop(frame)
  view.querySelector('.avatar-loading').hidden = true
  cameraButton.disabled = false
  bindCamera(document.querySelector('#camera-preview'), cameraButton, status, state)
}

startAvatar().catch((error) => {
  console.error(error)
  view.querySelector('.avatar-loading').textContent = 'Amber could not be loaded.'
})
