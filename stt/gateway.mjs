import {createServer} from 'node:net'
import {spawn} from 'node:child_process'
const [bind, host, control] = process.argv.slice(2)
createServer(socket => {
  const relay = spawn('ssh', ['-T', '-S', control, '-o', 'BatchMode=yes', host,
    'python3 ~/workspace/denys-stt/relay.py'], {stdio:['pipe','pipe','inherit']})
  relay.stdin.on('error', () => socket.destroy())
  socket.on('error', () => relay.kill())
  socket.on('close', () => relay.kill())
  relay.on('close', () => socket.destroy())
  relay.on('error', () => socket.destroy())
  socket.pipe(relay.stdin)
  relay.stdout.pipe(socket)
}).listen(22105,bind)
