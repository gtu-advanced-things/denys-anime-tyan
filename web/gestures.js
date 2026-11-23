const vector = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z]
const norm = (v) => Math.hypot(...v)
const distance = (a, b) => norm(vector(a, b))

function finger(hand, base, palm) {
  const [root, joint, end, tip] = hand.slice(base, base + 4)
  const reach = distance(root, tip)
  const length = distance(root, joint) + distance(joint, end) + distance(end, tip)
  const straight = reach / Math.max(1e-6, length)
  const wristReach = distance(hand[0], tip) / Math.max(palm, distance(hand[0], root))
  return {
    raised: straight > 0.78 && wristReach > 1.39,
    folded: straight < 0.79 || wristReach < 1.30,
    straight, wristReach
  }
}

export function identifyGesture(hand, category) {
  if (hand?.length !== 21) return null
  const palm = distance(hand[0], hand[9])
  if (palm < 1e-5) return null
  const [index, middle, ring, pinky] = [5, 9, 13, 17].map((base) => finger(hand, base, palm))
  const others = [index, ring, pinky]
  const isolatedMiddle = middle.straight > 0.86 && middle.wristReach > 1.44 &&
    others.every(digit => digit.folded && middle.wristReach - digit.wristReach > 0.31)
  if (isolatedMiddle) return 'middle'

  const thumb = vector(hand[4], hand[2])
  const thumbSpread = distance(hand[4], hand[5]) / palm
  const closed = [index, middle, ring, pinky].every(digit => digit.folded)
  const curled = [index, middle, ring, pinky].filter(digit => digit.straight < 0.74).length
  if (closed && curled >= 2 && thumbSpread > 0.46 &&
      (category?.categoryName === 'Thumb_Up' && category.score >= 0.48 ||
       norm(thumb) > palm * 0.46 && -thumb[1] > norm(thumb) * 0.52)) return 'thumb'

  if (index.raised && middle.raised && ring.folded && pinky.folded) return 'victory'
  if ([index, middle, ring, pinky].every(digit => digit.raised) &&
      category?.categoryName === 'Open_Palm' && category.score > 0.44) return 'open'
  if (closed && category?.categoryName === 'Closed_Fist' && category.score > 0.54) return 'fist'
  return null
}

export function presentedHand(points, box, width, height, kind) {
  if (!kind || points?.length !== 21) return false
  const wrist = points[0], middle = points[9]
  const dx = (middle.x - wrist.x) * width
  const dy = (middle.y - wrist.y) * height
  const palm = Math.hypot(dx, dy)
  if (palm < Math.min(width, height) * 0.019) return false
  if (!box) return true
  const nearChest = middle.y * height > box.originY + box.height * 1.03 &&
    Math.abs(middle.x * width - box.originX - box.width / 2) < box.width * 1.25
  // Suppress a relaxed palm or fist resting across the torso. Distinct finger
  // configurations remain usable at chest height and with a sideways wrist.
  return !(nearChest && (kind === 'open' || kind === 'fist') && Math.abs(dx) > 1.35 * Math.abs(dy))
}

export function stabilizeGesture(state, kind, now) {
  if (kind === state.current && kind) state.lastSeen = now
  if (kind) {
    if (kind !== state.candidate) {
      state.candidate = kind
      state.since = now
      state.samples = 0
    }
    state.sampleTime = now
    state.samples++
    const dwell = kind === 'middle' ? 110 : 65
    if (state.samples >= 2 && now - state.since >= dwell) {
      state.current = kind
      state.lastSeen = now
    }
  } else if (now - state.sampleTime > 140) {
    state.candidate = null
  }
  if (now - state.lastSeen > 420) state.current = null
  return state.current
}

export function messageReaction(text) {
  if (/^\s*(?:hi|hello|hey|good (?:morning|afternoon|evening))\b/i.test(text)) return 'wave'
  if (/\b(?:not funny|that wasn['’]t funny|bad joke|you failed|you got it wrong|you (?:can['’]t|couldn['’]t) (?:do it|handle it)|not good enough|you missed the point)\b/i.test(text)) return 'shrug'
  return null
}
