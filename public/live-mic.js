export function liveMic(events) {
  let stream, context, socket, active = false, closed = false, ready = false
  let voiced = 0, quiet = 0, frames = 0
  const pre = []
  function close(error) {
    if (closed) return
    closed = true
    socket?.close()
    stream?.getTracks().forEach(track => track.stop())
    if (context) void context.close()
    events.end(error)
  }
  async function start() {
    try {
      context = new AudioContext({sampleRate:16000})
      await context.resume()
      stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}})
      if (closed) { stream.getTracks().forEach(track => track.stop()); return }
      await context.audioWorklet.addModule('/audio-worklet.js')
      if (closed) return
      const processor = new AudioWorkletNode(context,'microphone-frames')
      context.createMediaStreamSource(stream).connect(processor)
      processor.connect(context.destination)
      const url = new URL('/api/listen?en', location.href)
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(url)
      socket.onmessage = ({data}) => {
        if (closed) return
        const event = JSON.parse(data)
        if (event.type === 'ready') {ready = true; events.ready()}
        if (event.type === 'partial' && active && event.text) events.partial(event.text)
        if (event.type === 'final' && event.text) events.final(event.text)
      }
      socket.onclose = () => close('Transcription disconnected.')
      socket.onerror = () => close('Could not connect to speech recognition.')
      stream.getAudioTracks()[0].onended = () => close('Microphone disconnected.')
      processor.port.onmessage = ({data}) => {
        if (!ready || closed) return
        if (socket.bufferedAmount > 128000) return close('The network is too slow to stream audio.')
        const pcm = new Int16Array(data)
        const loud = Math.sqrt(pcm.reduce((n,x)=>n+x*x,0)/pcm.length) > 380
        voiced = loud ? voiced + 1 : 0
        if (!active) {
          pre.push(data)
          if (pre.length > 6) pre.shift()
          if (voiced < 3) return
          active = true
          events.speech()
          for (const chunk of pre) socket.send(chunk)
          frames = pre.length
          pre.length = 0
        } else {socket.send(data); frames++}
        quiet = loud ? 0 : quiet + 1
        if (quiet >= 11 || frames >= 450) {
          socket.send('end')
          active = false
          quiet = voiced = 0
        }
      }
    } catch (e) { close(e.name === 'NotAllowedError' ? 'Allow microphone access.' : 'Could not turn on the microphone. Recording requires HTTPS or localhost.') }
  }
  void start()
  return {live:true, stop:()=>close(), abort:()=>close()}
}
