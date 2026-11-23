import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'

export function codexEnv() {
  const env = { ...process.env }
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_THREAD_ID',
    'CODEX_SESSION_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE']) delete env[key]
  return env
}

export class Codex extends EventEmitter {
  pending = new Map()
  nextId = 0
  closed = false

  constructor() {
    super()
    this.process = spawn('codex', ['-c', 'forced_login_method="chatgpt"', '-c',
      'model_provider="openai"', '-c', 'mcp_servers.gtu.command="node"',
      '-c', 'mcp_servers.gtu.args=["/app/guide-mcp.mjs"]', '--disable', 'shell_tool', 'app-server', '--listen', 'stdio://'], {
      env: codexEnv(), stdio: ['pipe', 'pipe', 'ignore']
    })
    const fail = (error) => {
      if (this.closed) return
      this.closed = true
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
      this.emit('closed', error)
    }
    this.process.on('error', (error) => fail(new Error(
      error.code === 'ENOENT' ? 'Install Codex CLI and run codex login.' : error.message)))
    this.process.on('exit', () => fail(new Error('Codex disconnected. Try again.')))
    this.process.stdin.on('error', fail)
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.method && message.id != null) {
        // Decline interactive requests. This client has no approval or input dialog.
        this.write({ id: message.id, error: { code: -32601, message: 'Interactive requests are unavailable' } })
      } else if (message.method) {
        this.emit('notification', message.method, message.params)
      } else if (this.pending.has(message.id)) {
        const request = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) request.reject(new Error(message.error.message))
        else request.resolve(message.result)
      }
    })
  }

  write(message) {
    if (!this.closed) this.process.stdin.write(JSON.stringify(message) + '\n')
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('Codex connection closed.'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex timed out on ${method}.`))
        this.stop()
      }, 30_000)
      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      this.write({ id, method, params })
    })
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'denys_voice', title: 'Voice Agent', version: '1.0.0' }
    })
    this.write({ method: 'initialized' })
    const { account } = await this.request('account/read', { refreshToken: false })
    if (account?.type !== 'chatgpt') throw new Error('Sign in to ChatGPT with codex login.')
  }

  stop() { this.process.kill() }
}
