const defaults = { angle: 0, width: 2.4, height: 1.8, distance: 2 }
const angles = [0, 90, 180, 270]
const storageKey = 'amber-stage-settings'

function valid(key, value) {
  return key === 'angle' ? angles.includes(value) :
    Number.isFinite(value) && value >= 0.1 && value <= 100
}

export function bindStageSettings(onChange) {
  const settings = { ...defaults }
  let saved
  try { saved = JSON.parse(localStorage.getItem(storageKey)) } catch { /* Use defaults. */ }
  for (const key of Object.keys(settings)) {
    const field = document.getElementById(key === 'angle' ? 'render-angle' : 'tracking-' + key)
    if (valid(key, saved?.[key])) settings[key] = saved[key]
    field.value = settings[key]
    field.addEventListener('change', () => {
      const value = Number(field.value)
      if (valid(key, value)) settings[key] = value
      field.value = settings[key]
      try { localStorage.setItem(storageKey, JSON.stringify(settings)) } catch { /* Apply for this session. */ }
      onChange()
    })
  }
  return settings
}

// Convert a mirrored camera point to meters at the speaker plane, then undo
// display rotation so the face turns toward the same physical screen edge.
export function gazeAngles(face, { width, height, distance, angle }) {
  if (!face) return [0, 0]
  const x = (face.x - 0.5) * width
  const y = (face.y - 0.5) * height
  const radians = angle * Math.PI / 180
  const dx = x * Math.cos(radians) + y * Math.sin(radians)
  const dy = y * Math.cos(radians) - x * Math.sin(radians)
  return [Math.atan2(dx, distance), Math.atan2(dy, Math.hypot(distance, dx))]
}
