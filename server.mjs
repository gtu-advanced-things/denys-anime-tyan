import WebSocket, { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash, timingSafeEqual } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Codex } from './codex.mjs'

const port = Number(process.env.PORT || 22004)
const address = process.env.BIND_ADDRESS || '127.0.0.1'
const hosts = [`127.0.0.1:${port}`, `localhost:${port}`]
const origins = hosts.map((host) => `http://${host}`)
const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN) : null
const password = process.env.SITE_PASSWORD
const ttsUrl = process.env.TTS_URL
const sttUrl = process.env.STT_URL
if (publicOrigin && (publicOrigin.protocol !== 'https:' ||
    publicOrigin.href !== publicOrigin.origin + '/')) {
  throw new Error('Set PUBLIC_ORIGIN to the HTTPS origin of the site.')
}
const digest = (value) => createHash('sha256').update(value).digest()
const credentials = password && digest('Basic ' + Buffer.from('voice:' + password).toString('base64'))
const gtuPrompt = await readFile(new URL('./gtu-prompt.txt', import.meta.url), 'utf8')
const posters = JSON.parse(await readFile(new URL('./gtu-posters.json', import.meta.url), 'utf8'))
const files = new Map(Object.keys(posters).map(name => [
  '/posters/' + name, ['posters/' + name, { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif' }[name.split('.').at(-1)]]
]))
for (const [route, file] of [
  ['/', ['index.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/live-mic.js', ['live-mic.js','text/javascript']],
  ['/audio-worklet.js', ['audio-worklet.js','text/javascript']],
  ['/mic-recorder.js', ['mic-recorder.js', 'text/javascript']],
  ['/pcm-player.js', ['pcm-player.js', 'text/javascript']],
  ['/avatar/avatar.js', ['avatar/avatar.js', 'text/javascript']],
  ['/avatar/amber.glb', ['avatar/amber.glb', 'model/gltf-binary']],
  ['/avatar/office-studio.glb', ['avatar/office-studio.glb', 'model/gltf-binary']],
  ['/avatar/hands.task', ['avatar/hands.task', 'application/octet-stream']],
  ['/avatar/face.tflite', ['avatar/face.tflite', 'application/octet-stream']]
]) files.set(route, file)
for (const variant of ['vision_wasm_internal', 'vision_wasm_nosimd_internal']) {
  for (const [extension, type] of [['js', 'text/javascript'], ['wasm', 'application/wasm']]) {
    const file = `${variant}.${extension}`
    files.set(`/avatar/wasm/${file}`, [`../node_modules/@mediapipe/tasks-vision/wasm/${file}`, type])
  }
}

async function transcribe(req, res, language) {
  if (!sttUrl) return res.writeHead(503).end()
  const type = req.headers['content-type']?.split(';', 1)[0]
  if (!['audio/ogg', 'audio/webm', 'audio/mp4'].includes(type)) return res.writeHead(415).end()
  const maxBytes = 2 * 1024 * 1024
  if (Number(req.headers['content-length']) > maxBytes) return res.writeHead(413).end()
  const abort = new AbortController()
  const cancel = () => abort.abort()
  res.once('close', cancel)
  const timeout = setTimeout(() => {
    if (!res.writableEnded) res.writeHead(408).end()
    cancel()
  }, 55_000)
  try {
    const chunks = []
    let bytes = 0
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length
      if (res.writableEnded) return
      if (bytes > maxBytes) return res.writeHead(413, { Connection: 'close' }).end()
      chunks.push(chunk)
    }
    if (!bytes) return res.writeHead(400).end()
    const url = new URL(sttUrl)
    url.search = language
    const upstream = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': type }, body: Buffer.concat(chunks, bytes),
      signal: abort.signal, redirect: 'error'
    })
    if (!upstream.ok) {
      await upstream.body?.cancel()
      return res.writeHead([400, 429].includes(upstream.status) ? upstream.status : 502).end()
    }
    const { text } = await upstream.json()
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ text }))
  } catch {
    if (!res.destroyed && !res.writableEnded) res.writeHead(502).end()
  } finally {
    clearTimeout(timeout)
    res.off('close', cancel)
  }
}

async function speech(req, res) {
  let input
  try { input = await readInput(req) } catch { return res.writeHead(400).end() }


  if (!ttsUrl) return res.writeHead(503).end()
  const controller = new AbortController()
  const abort = () => controller.abort()
  res.once('close', abort)
  try {
    // Also support clients that submit an entire passage in one request.
    let remaining = input.text.trim()
    while (remaining) {
      let end = Math.min(240, remaining.length)
      if (end < remaining.length) {
        const prefix = remaining.slice(0, end)
        const boundary = [...prefix.matchAll(/[.!?]\s+|[,;:]\s+/g)].at(-1)
        end = boundary ? boundary.index + 1 : prefix.lastIndexOf(' ') || end
        if (end < 1) end = prefix.length
      }
      const phrase = remaining.slice(0, end)
      remaining = remaining.slice(end).trimStart()
      const upstream = await fetch(ttsUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: phrase }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
        redirect: 'error'
      })
      if (!upstream.ok || !upstream.body || Number(upstream.headers.get('X-Sample-Rate')) !== 24000) {
        await upstream.body?.cancel()
        throw new Error('Voice stream unavailable')
      }
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/octet-stream',
        'X-Sample-Rate': '24000', 'X-Accel-Buffering': 'no' })
      await pipeline(upstream.body, res, { end: false, signal: controller.signal })
    }
    res.end()
  } catch {
    if (res.destroyed) return
    if (res.headersSent) res.destroy()
    else res.writeHead(502).end()
  } finally {
    res.off('close', abort)
  }
}
const model = process.env.CODEX_MODEL || 'gpt-6.2-sol'
const voiceInstructions = `Always respond in Russian, including when addressed in another language or asked to change languages. Address a knowledgeable audience with precise, conversational explanations. Everything shown in chat and spoken aloud must be natural Russian prose. Use ordinary sentence punctuation. Omit URLs, citations, Markdown, lists, emoji, code and special symbols. Express units, mathematical symbols and references in words. Name a source in prose if needed. These output rules apply to every reply, including presentations, regardless of custom preferences.

Use the gtu lookup tool for factual questions about labs and to locate slides. For slide presentations give multiple distinct slides in one response, placing a directive before each corresponding paragraph. For ordinary replies start with one visual directive: [POSTER:keep], [POSTER:hide], or [POSTER:filename].
Then a newline and your spoken answer. Use a filename exactly as listed below. Show a relevant visual for a new lab/topic when it helps,
or whenever requested and available. Keep it across follow-up questions on the same topic. Hide it on an unrelated topic.
Do not narrate directives or filenames. Treat visuals as catalogue illustrations, never as live observations or current site conditions.

Poster catalogue:
${Object.entries(posters).map(([name, caption]) => name + ' — ' + caption).join('\n')}`

let agent
let connecting
let conversation
let busy = false

function connect() {
  if (agent && !agent.closed) return Promise.resolve(agent)
  connecting ??= (async () => {
    const child = new Codex()
    try { await child.initialize() } catch (error) { child.stop(); throw error }
    agent = child
    conversation = undefined
    return child
  })().finally(() => { connecting = undefined })
  return connecting
}

async function readInput(req) {
  let body = ''
  req.setEncoding('utf8')
  for await (const chunk of req) {
    body += chunk
    if (body.length > 48_000) throw new Error('Message too long.')
  }
  const { text, prompt = '', reset = false } = JSON.parse(body)
  if (typeof text !== 'string' || !text.trim() || text.length > 8000 ||
      typeof prompt !== 'string' || prompt.length > 6000 || typeof reset !== 'boolean') {
    throw new Error('Limit messages to 8000 characters and prompts to 6000 characters.')
  }
  return { text: text.trim(), prompt: prompt.trim(), reset }
}

function streamTurn(child, threadId, text, res, send) {
  return new Promise((resolve, reject) => {
    let turnId
    let finished = false
    const messages = new Map()
    let pending = ''
    const emitText = (text, flush = false) => {
      pending += text
      while (pending) {
        const opening = pending.indexOf('[')
        if (opening !== 0) {
          const end = opening < 0 ? pending.length : opening
          send({ type: 'delta', text: pending.slice(0, end) })
          pending = pending.slice(end)
          continue
        }
        const closing = pending.indexOf(']')
        if (closing < 0 && !flush && pending.length < 180 &&
            ('[POSTER:'.startsWith(pending.toUpperCase()) || pending.toUpperCase().startsWith('[POSTER:'))) break
        const match = /^\[POSTER:\s*([a-z0-9.-]+)\s*\]/i.exec(pending)
        if (match) {
          const file = match[1].toLowerCase()
          if (file === 'hide') send({ type: 'poster', path: null })
          else if (Object.hasOwn(posters, file)) send({ type: 'poster', path: '/posters/' + file })
          pending = pending.slice(match[0].length)
        } else {
          send({ type: 'delta', text: '[' })
          pending = pending.slice(1)
        }
      }
    }
    const finish = (error) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      child.off('notification', onEvent)
      child.off('closed', finish)
      res.off('close', interrupt)
      if (error) reject(error)
      else resolve()
    }
    const interrupt = () => {
      if (turnId) child.request('turn/interrupt', { threadId, turnId }).catch(finish)
    }
    const timeout = setTimeout(() => {
      finish(new Error('The reply timed out.'))
      child.stop()
    }, 180_000)
    const onEvent = (method, params) => {
      if (params?.threadId !== threadId) return
      const eventTurn = params.turnId ?? params.turn?.id
      if (turnId && eventTurn !== turnId) return
      if (eventTurn) turnId = eventTurn

      if (method === 'item/started' && params.item.type === 'agentMessage') {
        messages.set(params.item.id, { phase: params.item.phase, streamed: false })
      }
      if (method === 'item/started' && params.item.type === 'mcpToolCall') {
        send({ type: 'status', text: `MCP · ${params.item.server} / ${params.item.tool}` })
      }
      if (method === 'item/agentMessage/delta') {
        const message = messages.get(params.itemId)
        if (message?.phase === 'final_answer') {
          message.streamed = true
          emitText(params.delta)
        }
      }
      if (method === 'item/completed' && params.item.type === 'agentMessage' &&
          params.item.phase !== 'commentary' && !messages.get(params.item.id)?.streamed) {
        emitText(params.item.text)
      }
      if (method === 'turn/completed') {
        const { status, error } = params.turn
        if (status === 'completed') { emitText('', true); finish() }
        else finish(new Error(error?.message || 'Reply interrupted.'))
      }
    }
    child.on('notification', onEvent)
    child.once('closed', finish)
    res.once('close', interrupt)
    child.request('turn/start', {
      threadId, input: [{ type: 'text', text, text_elements: [] }],
      effort: 'medium', serviceTierForTurn: 'default'
    }).then(({ turn }) => {
      if (finished) return
      turnId = turn.id
      if (res.destroyed) interrupt()
    }, finish)
  })
}

async function chat(req, res) {
  if (busy) {
    res.writeHead(409).end('Wait for the current reply to finish.')
    return
  }
  busy = true
  try {
    const { text, prompt, reset } = await readInput(req)
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' })
    res.flushHeaders()
    const send = (event) => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n') }
    try {
      const child = await connect()
      if (reset || conversation?.prompt !== prompt) {
        if (conversation) await child.request('thread/unsubscribe', { threadId: conversation.id })
        const { thread } = await child.request('thread/start', {
          model, modelProvider: 'openai', cwd: process.cwd(), approvalPolicy: 'never',
          sandbox: 'read-only', ephemeral: true,
          developerInstructions: [
            gtuPrompt,
            prompt,
            voiceInstructions
          ].filter(Boolean).join('\n\n')
        })
        conversation = { id: thread.id, prompt }
      }
      if (!res.destroyed) await streamTurn(child, conversation.id, text, res, send)
      send({ type: 'done' })
    } catch (error) {
      send({ type: 'error', text: error.message })
    }
  } catch (error) {
    if (!res.headersSent) res.writeHead(400).write(error.message)
  } finally {
    res.end()
    busy = false
  }
}

function validRequest(req, requireOrigin = false) {
  const { host, origin } = req.headers
  const localRequest = hosts.includes(host)
  const publicRequest = publicOrigin ? host === publicOrigin.host :
    Boolean(address === '0.0.0.0' && host && /^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(host))
  const allowedOrigin = (localRequest && origins.includes(origin)) ||
    (publicRequest && (publicOrigin ? origin === publicOrigin.origin :
      origin === `https://${host}` || origin === `http://${host}`))
  return (localRequest || publicRequest) && (origin ? allowedOrigin : !requireOrigin)
}

const server = createServer(async (req, res) => {
  const { origin } = req.headers
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' blob:; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'")
  if (!validRequest(req)) {
    res.writeHead(403).end()
    return
  }
  if (credentials && !timingSafeEqual(digest(req.headers.authorization || ''), credentials)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Voice Agent", charset="UTF-8"')
    res.writeHead(401).end('Sign in to continue.')
    return
  }
  try {
    if (req.method === 'POST' && ['/api/chat', '/api/voice'].includes(req.url)) {
      if (!origin || req.headers['content-type'] !== 'application/json') {
        res.writeHead(403).end()
        return
      }
      if (req.url === '/api/chat') await chat(req, res)
      else await speech(req, res)
    } else if (req.method === 'POST' && /^\/api\/transcribe\?en$/.test(req.url)) {
      if (!origin) return res.writeHead(403).end()
      await transcribe(req, res, req.url.split('?')[1])
    } else if (req.method === 'GET' && req.url === '/api/voice') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ custom: Boolean(ttsUrl), transcription: Boolean(sttUrl), live: Boolean(process.env.LIVE_STT_URL) }))
    } else if (req.method === 'GET' && req.url === '/api/mcp') {
      const child = await connect()
      const {data} = await child.request('mcpServerStatus/list', {})
      const names = data.filter(entry => Object.keys(entry.tools || {}).length).map(entry => entry.name)
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(names))
    } else if (req.method === 'GET' && files.has(req.url)) {
      const [name, type] = files.get(req.url)
      const contents = await readFile(new URL(`./public/${name}`, import.meta.url))
      const contentType = type.startsWith('text/') ? `${type}; charset=utf-8` : type
      res.writeHead(200, { 'Content-Type': contentType }).end(contents)
    } else {
      res.writeHead(404).end()
    }
  } catch {
    res.writeHead(500).end('Request failed. Check the Codex CLI installation.')
  }
})

const liveSockets = new WebSocketServer({noServer:true, maxPayload:8192})
server.on('upgrade', (req, socket, head) => {
  if (!process.env.LIVE_STT_URL || !validRequest(req, true) ||
      !/^\/api\/listen\?en$/.test(req.url) ||
      credentials && !timingSafeEqual(digest(req.headers.authorization || ''), credentials)) return socket.destroy()
  liveSockets.handleUpgrade(req, socket, head, client => {
    const gpu = new WebSocket(process.env.LIVE_STT_URL + '?lang=' + req.url.split('?')[1], {handshakeTimeout:8000})
    client.on('message', (data, binary) => {
      if (gpu.readyState === WebSocket.OPEN && gpu.bufferedAmount < 100000) gpu.send(data, {binary})
      else client.close(1013)
    })
    gpu.on('message', data => { if (client.readyState === WebSocket.OPEN) client.send(data.toString()) })
    client.on('error', () => gpu.terminate())
    gpu.on('error', () => client.close(1011))
    client.on('close', () => gpu.terminate())
    gpu.on('close', () => client.close())
  })
})

server.listen(port, address, () => {
  console.log(`Voice Agent · port ${port}`)
  void connect().catch((error) => console.error(error.message))
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { agent?.stop(); process.exit() })
}
