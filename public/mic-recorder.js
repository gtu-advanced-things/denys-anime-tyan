export function recordSpeech(onStatus, onFinish) {
  const controller = new AbortController()
  let stream, recorder, context, meter, timeout
  let stopped = false
  let finished = false
  const chunks = []

  function release() {
    clearInterval(meter)
    clearTimeout(timeout)
    stream?.getTracks().forEach(track => track.stop())
    if (context && context.state !== 'closed') void context.close().catch(() => {})
  }

  function finish(text = '', error) {
    if (finished || controller.signal.aborted) return
    finished = true
    release()
    onFinish(text, error)
  }

  const capture = {
    stop() {
      if (stopped) return
      stopped = true
      if (recorder?.state === 'recording') recorder.stop()
      else finish()
    },
    abort() {
      controller.abort()
      stopped = true
      if (recorder?.state === 'recording') recorder.stop()
      release()
      onFinish('', 'Conversation stopped.')
    }
  }

  async function upload() {
    release()
    if (finished || controller.signal.aborted) return
    const audio = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type })
    if (!audio.size) return finish()
    onStatus('Transcribing…')
    try {
      const response = await fetch('/api/transcribe?en', {
        method: 'POST', body: audio, signal: controller.signal
      })
      if (!response.ok) {
        return finish('', response.status === 429 ? 'Speech recognition is busy. Try again.' :
          'Could not transcribe the recording. Try again.')
      }
      const { text } = await response.json()
      finish(text)
    } catch {
      finish('', 'Transcription server unavailable.')
    }
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }, video: false
      })
      if (stopped) return release()
      const mimeType = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4']
        .find(type => MediaRecorder.isTypeSupported(type))
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data) }
      recorder.onstop = () => {
        stopped = true
        void upload()
      }
      recorder.onerror = () => {
        stopped = true
        finish('', 'Could not record microphone audio.')
      }
      stream.getAudioTracks()[0].addEventListener('ended', capture.stop, { once: true })
      recorder.start()
      onStatus('Listening…')
      timeout = setTimeout(capture.stop, 30_000)
      if (!window.AudioContext) return
      context = new AudioContext()
      const analyser = context.createAnalyser()
      context.createMediaStreamSource(stream).connect(analyser)
      void context.resume().catch(() => {})
      const samples = new Float32Array(analyser.fftSize)
      const started = performance.now()
      let lastVoice = started
      let heardVoice = false
      meter = setInterval(() => {
        if (context.state !== 'running') return
        analyser.getFloatTimeDomainData(samples)
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
        const now = performance.now()
        if (rms > 0.012) {
          lastVoice = now
          heardVoice = true
        } else if (heardVoice && now - lastVoice > 850) capture.stop()
        else if (!heardVoice && now - started > 9_000) capture.stop()
      }, 65)
    } catch (error) {
      if (stopped) return
      finish('', error.name === 'NotAllowedError' ? 'Allow microphone access in your browser settings.' :
        'Could not turn on the microphone.')
    }
  }

  void start()
  return capture
}
