import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { identifyGesture, presentedHand, stabilizeGesture } from '../web/gestures.js'

// GPU landmarks sampled from MediaPipe's test photos and the HaGRID gesture chart.
// The crossed-arm photo yields two hands, including a false Thumb_Up classifier vote.
const samples = JSON.parse(await readFile(new URL('./hand-samples.json', import.meta.url)))
for (const [i, sample] of samples.entries()) {
  test(`photo ${i + 1}: ${sample.photo}`, () => {
    const hand = sample.hand.map(([x, y, z]) => ({ x, y, z }))
    assert.equal(identifyGesture(hand, sample.category), sample.expected)
  })
}

test('a sideways hand at chest height can show a distinct finger sign', () => {
  const points = Array.from({ length: 21 }, () => ({ x: 0.4, y: 0.65 }))
  points[9] = { x: 0.48, y: 0.67 }
  const face = { originX: 240, originY: 70, width: 145, height: 150 }
  assert.equal(presentedHand(points, face, 640, 480, 'thumb'), true)
  assert.equal(presentedHand(points, face, 640, 480, 'fist'), false)
})

test('confirmation works on slow video and tolerates one missing frame on fast video', () => {
  for (const times of [[0, 450], [0, 60, 130]]) {
    const state = { current: null, candidate: null, lastSeen: -Infinity }
    assert.equal(stabilizeGesture(state, 'middle', times[0]), null)
    if (times.length === 3) stabilizeGesture(state, null, times[1])
    const confirmed = times.at(-1)
    assert.equal(stabilizeGesture(state, 'middle', confirmed), 'middle')
    assert.equal(stabilizeGesture(state, null, confirmed + 80), 'middle')
    assert.equal(stabilizeGesture(state, null, confirmed + 500), null)
  }
})
