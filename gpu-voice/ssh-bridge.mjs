import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const [bind, sshHost, socket] = process.argv.slice(2)
if (!bind || !sshHost || !socket) throw new Error('Usage: ssh-bridge.mjs BIND SSH_HOST CONTROL_SOCKET')

createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/speak') return res.writeHead(404).end()

  let body = ''
  req.setEncoding('utf8')
  try {
    for await (const chunk of req) {
      body += chunk
      if (body.length > 4096) return res.writeHead(413).end()
    }
  } catch {
    return res.destroy()
  }

  const child = spawn('ssh', [
    '-T', '-S', socket, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', sshHost,
    "curl -fsS --no-buffer --max-time 26 -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:22104/speak"
  ], { stdio: ['pipe', 'pipe', 'inherit'] })
  const timeout = setTimeout(() => child.kill(), 28_000)
  res.once('close', () => child.kill())
  child.stdin.on('error', () => {})
  child.stdin.end(body)
  child.stdout.once('data', () => {
    res.writeHead(200, { 'X-Sample-Rate': '24000', 'Content-Type': 'application/octet-stream' })
  })
  child.stdout.pipe(res, { end: false })
  child.on('error', () => {})
  child.on('close', (code) => {
    clearTimeout(timeout)
    if (!res.headersSent) res.writeHead(502).end()
    else if (code === 0) res.end()
    else res.destroy()
  })
}).listen(22104, bind)
