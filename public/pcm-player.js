export class PcmPlayer {
  constructor(onIdle, onError) {
    this.onIdle = onIdle
    this.onError = onError
    this.sources = new Set()
    this.queue = []
  }

  get active() { return Boolean(this.controller || this.sources.size) }

  unlock() {
    if (!this.context) {
      this.context = new AudioContext()
      this.analyser = this.context.createAnalyser()
      this.analyser.fftSize = 1024
      this.analyser.connect(this.context.destination)
      window.dispatchEvent(new CustomEvent('voice:analyser', { detail: this.analyser }))
    }
    return this.context.resume()
  }

  push(text) {
    this.queue.push(text)
    if (!this.controller) void this.drain()
  }

  stop() {
    this.controller?.abort()
    this.controller = undefined
    this.queue.length = 0
    for (const source of this.sources) {
      source.onended = null
      source.stop()
      source.disconnect()
    }
    this.sources.clear()
    this.nextTime = undefined
  }

  schedule(bytes, rate) {
    const samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const audio = this.context.createBuffer(1, samples.byteLength / 2, rate)
    const channel = audio.getChannelData(0)
    for (let i = 0; i < channel.length; i++) {
      channel[i] = samples.getInt16(i * 2, true) / 32768
    }
    const source = this.context.createBufferSource()
    source.buffer = audio
    source.connect(this.analyser)
    const now = this.context.currentTime
    const start = this.nextTime >= now ? this.nextTime : now + 0.06
    source.onended = () => {
      source.disconnect()
      this.sources.delete(source)
      if (!this.active) this.onIdle()
    }
    this.sources.add(source)
    source.start(start)
    this.nextTime = start + audio.duration
  }

  async drain() {
    const controller = new AbortController()
    this.controller = controller
    try {
      await this.unlock()
      while (!controller.signal.aborted && this.queue.length) {
        const response = await fetch('/api/voice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: this.queue.shift() }),
          signal: controller.signal
        })
        if (!response.ok) throw new Error('Voice server unavailable.')
        const rate = Number(response.headers.get('X-Sample-Rate'))
        let trailing
        let received = false
        const reader = response.body.getReader()
        while (true) {
          const { value: bytes, done } = await reader.read()
          if (done) break
          if (controller.signal.aborted) return
          const chunk = new Uint8Array(bytes.length + (trailing === undefined ? 0 : 1))
          if (trailing !== undefined) chunk[0] = trailing
          chunk.set(bytes, chunk.length - bytes.length)
          const length = chunk.length - chunk.length % 2
          trailing = chunk[length]
          if (!length) continue
          this.schedule(chunk.subarray(0, length), rate)
          received = true
        }
        if (!received || trailing !== undefined) throw new Error('Voice playback was interrupted.')
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.stop()
        this.onError(error)
      }
    } finally {
      if (this.controller === controller) this.controller = undefined
      if (!this.active && !controller.signal.aborted) this.onIdle()
    }
  }
}
