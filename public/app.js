import { PcmPlayer } from './pcm-player.js'
import { liveMic } from './live-mic.js'
import { recordSpeech } from './mic-recorder.js'

const byId = (id) => document.getElementById(id)
const mic = byId('mic')
const status = byId('status')
const history = byId('history')
const message = byId('message')
const form = byId('message-form')
const stop = byId('stop')
const reset = byId('reset')
const settings = byId('settings')
const prompt = byId('prompt')
const speechLanguage = 'en-US'
const speak = byId('speak')
const auto = byId('auto')
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
const synthesis = window.speechSynthesis
const { custom: customVoice, transcription, live } = await fetch('/api/voice')
  .then((response) => response.json()).catch(() => ({ custom: false }))
let serverRecognition = transcription && (!Recognition || /Firefox\//.test(navigator.userAgent))
const ready = 'Ready to talk'
let request
let recognition
let fresh = true
let currentPrompt = ''
let speechBuffer = ''
let speechQueue = []
let speaking = false
let speechGeneration = 0
let continueAfterReply = false
let speechFailed = false
const pcm = new PcmPlayer(
  () => { controls(); resumeListening() },
  () => {
    speechFailed = true
    continueAfterReply = false
    status.textContent = 'Voice playback is unavailable. You can read the reply below.'
    controls()
  }
)

try {
  const saved = JSON.parse(localStorage.getItem('voice-settings') || '{}')
  prompt.value = saved.prompt || ''
  speak.checked = saved.speak !== false
} catch { /* Defaults work when storage is unavailable. */ }
currentPrompt = prompt.value.trim()
if (customVoice ? !window.AudioContext : !synthesis) {
  speak.checked = false
  speak.disabled = true
}

function controls() {
  mic.disabled = Boolean(request && !live)
  mic.setAttribute('aria-pressed', String(Boolean(recognition)))
  mic.setAttribute('aria-label', recognition ? 'Stop recording' : 'Turn on microphone')
  byId('send').disabled = Boolean(request || recognition)
  byId('settings-button').disabled = Boolean(request || recognition)
  reset.disabled = Boolean(request || recognition)
  stop.hidden = !(request || speaking || pcm.active || recognition)
}

function clearDialog() {
  continueAfterReply = false
  history.replaceChildren()
  const empty = document.createElement('p')
  empty.id = 'empty'
  empty.textContent = 'Your messages and Amber’s replies will appear here.'
  history.append(empty)
  fresh = true
  cancelSpeech()
  window.dispatchEvent(new CustomEvent('avatar:poster', { detail: null }))
  status.textContent = ready
}

function bubble(role) {
  byId('empty')?.remove()
  const element = document.createElement('div')
  element.className = 'bubble ' + role
  element.setAttribute('aria-label', role === 'user' ? 'You' : 'Amber’s reply')
  history.append(element)
  return element
}

function cancelSpeech() {
  speechGeneration++
  speechBuffer = ''
  speechQueue = []
  speaking = false
  synthesis?.cancel()
  window.dispatchEvent(new CustomEvent('voice:browser-speech', { detail: false }))
  pcm.stop()
  controls()
}

function playNext() {
  if (speaking || !speechQueue.length) return
  const generation = speechGeneration
  const utterance = new SpeechSynthesisUtterance(speechQueue.shift())
  utterance.lang = speechLanguage
  const voices = synthesis.getVoices()
  const matches = (voice) => voice.lang.toLowerCase().startsWith(speechLanguage.slice(0, 2).toLowerCase())
  utterance.voice = voices.find((voice) => voice.localService && matches(voice)) ??
    voices.find(matches) ?? null
  speaking = true
  controls()
  const advance = (event) => {
    if (generation !== speechGeneration) return
    window.dispatchEvent(new CustomEvent('voice:browser-speech', { detail: false }))
    speaking = false
    if (event.type === 'error') {
      continueAfterReply = false
      cancelSpeech()
      if (!request) status.textContent = 'Playback failed. You can read the reply below.'
    } else {
      playNext()
      controls()
      resumeListening()
    }
  }
  utterance.onend = advance
  utterance.onerror = advance
  utterance.onstart = () => {
    if (generation === speechGeneration) window.dispatchEvent(new CustomEvent('voice:browser-speech', { detail: true }))
  }
  synthesis.speak(utterance)
}

function queueSpeech(delta, done = false) {
  if (!speak.checked || speechFailed) return
  speechBuffer += delta
  const boundary = /[.!?…]+(?:\s|$)|\n|^.{48,}?[,:;]\s|^.{100,}?\s/
  let match
  while ((match = boundary.exec(speechBuffer))) {
    const end = match.index + match[0].length
    const sentence = speechBuffer.slice(0, end).trim()
    speechBuffer = speechBuffer.slice(end)
    if (sentence) speechQueue.push(sentence)
  }
  if (done && speechBuffer.trim()) {
    speechQueue.push(speechBuffer.trim())
    speechBuffer = ''
  }
  if (customVoice) {
    for (const phrase of speechQueue.splice(0)) pcm.push(phrase)
    controls()
  } else playNext()
}

function resumeListening() {
  if (!continueAfterReply || !auto.checked || request || speaking || pcm.active || speechQueue.length) return
  continueAfterReply = false
  listen()
}

async function send(text, fromMic = false) {
  text = text.trim()
  if (!text || request || recognition && !recognition.live) return
  cancelSpeech()
  speechFailed = false
  if (customVoice && speak.checked && !fromMic) void pcm.unlock().catch(() => {})
  continueAfterReply = fromMic && auto.checked && !recognition?.live
  const controller = new AbortController()
  request = controller
  controls()
  message.value = ''
  bubble('user').textContent = text
  history.scrollTop = history.scrollHeight
  let answer
  let completed = false
  let hasError = false
  status.textContent = 'Amber is thinking…'
  window.dispatchEvent(new CustomEvent('avatar:turn', { detail: { phase: 'start', text } }))
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, prompt: currentPrompt, reset: fresh }),
      signal: controller.signal
    })
    if (!response.ok) throw new Error(await response.text() || 'Server unavailable.')
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    while (!completed && !hasError) {
      const { done, value } = await reader.read()
      if (done) break
      const lines = (buffer + value).split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line) continue
        const event = JSON.parse(line)
        if (event.type === 'delta' && event.text) {
          if (!answer) window.dispatchEvent(new CustomEvent('avatar:turn', { detail: { phase: 'reply' } }))
          answer ??= bubble('agent')
          answer.append(event.text)
          history.scrollTop = history.scrollHeight
          if (!speechFailed) status.textContent = 'Amber is replying…'
          queueSpeech(event.text)
        } else if (event.type === 'poster') {
          window.dispatchEvent(new CustomEvent('avatar:poster', { detail: event.path }))
        } else if (event.type === 'status') {
          status.textContent = event.text
        } else if (event.type === 'error') {
          status.textContent = event.text
          hasError = true
          cancelSpeech()
        } else if (event.type === 'done') {
          completed = true
          fresh = false
          queueSpeech('', true)
          if (!speechFailed) status.textContent = answer ? ready : 'Amber finished without a text reply.'
        }
      }
    }
    if (!completed && !hasError) throw new Error('Connection interrupted. Please try again.')
  } catch (error) {
    cancelSpeech()
    status.textContent = controller.signal.aborted ? 'Reply stopped.' : (error.message || 'Connection error.')
  } finally {
    window.dispatchEvent(new CustomEvent('avatar:turn', { detail: { phase: 'end' } }))
    request = undefined
    if (!completed) continueAfterReply = false
    controls()
    resumeListening()
  }
}

function listen() {
  if (live) {
    cancelSpeech()
    status.textContent = 'Connecting microphone…'
    recognition = liveMic({
      ready: () => { status.textContent = 'Listening…' },
      speech: () => {
        continueAfterReply = false
        request?.abort()
        cancelSpeech()
        window.dispatchEvent(new CustomEvent('avatar:turn', {detail:{phase:'interrupt'}}))
        status.textContent = 'Listening…'
      },
      partial: text => { status.textContent = text },
      final: text => { if (!auto.checked) recognition?.stop(); void send(text, true) },
      end: error => { recognition = undefined; status.textContent = error || ready; controls() }
    })
    controls()
    return
  }
  if (serverRecognition) {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      status.textContent = 'The microphone requires HTTPS or localhost.'
      return
    }
    cancelSpeech()
    status.textContent = 'Connecting microphone…'
    const capture = recordSpeech((text) => { status.textContent = text }, (text, error) => {
      if (recognition !== capture) return
      recognition = undefined
      controls()
      if (text.trim()) void send(text, true)
      else status.textContent = error || 'No speech detected. Try again.'
    })
    recognition = capture
    controls()
    return
  }
  if (!Recognition) {
    status.textContent = 'Speech recognition is unavailable in this browser. Try Chrome or type your message.'
    return
  }
  cancelSpeech()
  const capture = new Recognition()
  recognition = capture
  capture.lang = speechLanguage
  capture.interimResults = false
  let transcript = ''
  let failed = false
  let retryOnServer = false
  capture.onresult = (event) => { transcript = event.results[0][0].transcript }
  capture.onerror = (event) => {
    failed = true
    retryOnServer = transcription && ['service-not-allowed', 'network', 'language-not-supported'].includes(event.error)
    if (event.error === 'aborted') return
    const messages = {
      'not-allowed': 'Allow microphone access in your browser settings.',
      'service-not-allowed': 'Speech recognition is unavailable.',
      'audio-capture': 'Microphone unavailable.',
      'no-speech': 'No speech detected. Try again.',
      'network': 'Your browser could not connect to speech recognition.'
    }
    status.textContent = messages[event.error] || 'Could not recognize speech.'
  }
  capture.onend = () => {
    recognition = undefined
    controls()
    if (retryOnServer) {
      serverRecognition = true
      listen()
    } else if (transcript.trim() && !failed) void send(transcript, true)
    else if (!failed) status.textContent = 'No speech detected. Try again.'
  }
  try {
    capture.start()
    controls()
    status.textContent = 'Listening…'
  } catch {
    recognition = undefined
    controls()
    status.textContent = 'Could not turn on the microphone.'
  }
}

mic.addEventListener('click', () => {
  if (customVoice && speak.checked) void pcm.unlock().catch(() => {})
  if (recognition) recognition.stop()
  else listen()
})
window.addEventListener('pagehide', () => recognition?.abort())
auto.addEventListener('change', () => { if (!auto.checked && recognition?.live) recognition.stop(); controls() })

form.addEventListener('submit', (event) => {
  event.preventDefault()
  void send(message.value)
})
message.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    form.requestSubmit()
  }
})
stop.addEventListener('click', () => {
  continueAfterReply = false
  recognition?.abort()
  request?.abort()
  cancelSpeech()
  status.textContent = 'Conversation stopped.'
})
reset.addEventListener('click', () => {
  message.value = ''
  clearDialog()
})
byId('settings-button').addEventListener('click', async () => {
  settings.showModal()
  const mcp = byId('mcp-status')
  mcp.textContent = 'Checking Codex settings…'
  try {
    const response = await fetch('/api/mcp')
    if (!response.ok) throw new Error()
    const servers = await response.json()
    mcp.textContent = servers.length ? 'Configured servers: ' + servers.join(', ') : 'No MCP servers configured.'
  } catch {
    mcp.textContent = 'Could not load MCP settings.'
  }
})
settings.addEventListener('close', () => {
  const nextPrompt = prompt.value.trim()
  if (currentPrompt !== nextPrompt) {
    currentPrompt = nextPrompt
    clearDialog()
  }
  if (!speak.checked) cancelSpeech()
  try {
    localStorage.setItem('voice-settings', JSON.stringify({
      prompt: currentPrompt, speak: speak.checked
    }))
  } catch { /* Settings still apply for this page. */ }
})
