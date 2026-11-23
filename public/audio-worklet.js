// AudioContext requests 16 kHz; batch 64 ms per network frame.
class MicrophoneFrames extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frame = new Int16Array(1024)
    this.offset = 0
  }
  process(inputs) {
    const samples = inputs[0]?.[0]
    if (samples) for (const value of samples) {
      this.frame[this.offset++] = Math.round(Math.max(-1, Math.min(1, value)) * 32767)
      if (this.offset === this.frame.length) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer])
        this.frame = new Int16Array(1024)
        this.offset = 0
      }
    }
    return true
  }
}
registerProcessor('microphone-frames', MicrophoneFrames)
