import { FaceDetector, FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision'
import { identifyGesture, presentedHand, stabilizeGesture } from './gestures.js'

const names = { middle: 'Middle finger', thumb: 'Thumbs up', open: 'Open palm', victory: 'Peace sign', fist: 'Fist' }

export function bindCamera(video, button, status, tracking) {
  let stream, detector, recognizer, frame
  let generation = 0
  let pending = false

  function stop() {
    generation++
    pending = false
    cancelAnimationFrame(frame)
    stream?.getTracks().forEach((track) => track.stop())
    stream = undefined
    video.srcObject = null
    video.hidden = true
    detector?.close()
    recognizer?.close()
    detector = recognizer = undefined
    tracking.camera = false
    tracking.face = null
    tracking.hands = {}
    button.textContent = 'Turn on camera'
    button.setAttribute('aria-pressed', 'false')
    status.textContent = 'Camera is off'
  }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      status.textContent = 'The camera requires HTTPS or localhost.'
      return
    }
    const id = ++generation
    pending = true
    button.textContent = 'Cancel'
    status.textContent = 'Connecting camera…'
    try {
      const camera = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false
      })
      if (id !== generation) {
        camera.getTracks().forEach((track) => track.stop())
        return
      }
      stream = camera
      video.srcObject = camera
      video.hidden = false
      await video.play()
      if (id !== generation) return
      tracking.camera = true
      status.textContent = 'Loading camera tracking…'
      const vision = await FilesetResolver.forVisionTasks('/avatar/wasm')
      if (id !== generation) return
      const face = await FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '/avatar/face.tflite', delegate: 'GPU' },
        runningMode: 'VIDEO', minDetectionConfidence: 0.58
      })
      if (id !== generation) { face.close(); return }
      detector = face
      const hands = await GestureRecognizer.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '/avatar/hands.task', delegate: 'GPU' },
        runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.48,
        minHandPresenceConfidence: 0.48, minTrackingConfidence: 0.5
      })
      if (id !== generation) { hands.close(); return }
      recognizer = hands
      pending = false
      button.textContent = 'Turn off camera'
      button.setAttribute('aria-pressed', 'true')
      camera.getVideoTracks()[0].addEventListener('ended', stop, { once: true })

      const stable = Object.fromEntries(['Left', 'Right'].map((side) => [side,
        { current: null, candidate: null, since: 0, lastSeen: -Infinity }]))
      let target = null
      let lastFace = -Infinity
      let lastFrame = -1
      let lastInference = -Infinity
      const tick = (now) => {
        if (video.readyState >= 2 && video.currentTime !== lastFrame && now - lastInference >= 44) {
          lastFrame = video.currentTime
          lastInference = now
          try {
            if (now - lastFace >= 160) {
              lastFace = now
              const faces = detector.detectForVideo(video, now).detections
              target = faces.reduce((best, detection) =>
                !best || detection.boundingBox.width > best.boundingBox.width ? detection : best, null)
              const nose = target?.keypoints?.[2]
              tracking.face = nose ? { x: 1 - nose.x, y: nose.y } : null
            }
            const result = recognizer.recognizeForVideo(video, now)
            const seen = {}
            result.worldLandmarks.forEach((hand, index) => {
              const side = result.handedness[index]?.[0]?.categoryName
              if (!stable[side]) return
              const kind = identifyGesture(hand, result.gestures[index]?.[0])
              if (presentedHand(result.landmarks[index], target?.boundingBox, video.videoWidth, video.videoHeight, kind)) {
                seen[side] = kind
              }
            })
            for (const side of ['Left', 'Right']) {
              tracking.hands[side] = stabilizeGesture(stable[side], seen[side] ?? null, now)
            }
            const observed = Object.values(tracking.hands).filter(Boolean).map((kind) => names[kind])
            const label = observed.length ? observed.join(' · ') : target ? 'Person detected' : 'Looking for a face…'
            if (status.textContent !== label) status.textContent = label
          } catch (error) {
            console.error(error)
            stop()
            status.textContent = 'Camera tracking could not process this frame.'
            return
          }
        }
        frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    } catch (error) {
      if (id !== generation) return
      console.error(error)
      stop()
      status.textContent = error.name === 'NotAllowedError'
        ? 'Allow camera access.'
        : 'Could not start the camera or tracking.'
    }
  }

  button.addEventListener('click', () => { if (stream || pending) stop(); else void start() })
  window.addEventListener('pagehide', stop)
}
