import { readFile } from 'node:fs/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const guide = await readFile(new URL('./gtu-prompt.txt', import.meta.url), 'utf8')
const posters = JSON.parse(await readFile(new URL('./gtu-posters.json', import.meta.url), 'utf8'))
const server = new McpServer({ name: 'gtu-guide', version: '1.0.0' })
server.tool('lookup', 'Find GTU guide passages and exact slide filenames by English topic words.', {
  query: z.string().min(1).max(180)
}, async ({ query }) => {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const rank = lines => lines.map(text => ({text, score: words.filter(word => text.toLowerCase().includes(word)).length}))
    .filter(hit => hit.score).sort((a,b) => b.score-a.score).slice(0,8).map(hit => hit.text)
  const passages = rank(guide.split(/\r?\n\s*\r?\n/))
  const slides = rank(Object.entries(posters).map(([file,caption]) => file + ' ' + caption))
  return { content: [{type:'text', text:JSON.stringify({passages,slides})}] }
})
await server.connect(new StdioServerTransport())
