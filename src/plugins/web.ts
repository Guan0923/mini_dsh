import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Message, Transcript } from '../contracts.ts'

export const inject = ['sessions', 'agent']

/** 将会话中的提问、回答、工具调用和结果转换为网页可直接展示的条目。 */
function displayMessages(messages: readonly Message[]) {
  const entries: { label: string; text: string }[] = []
  for (const message of messages) {
    if (message.role === 'user') entries.push({ label: '你', text: message.content })
    if (message.role === 'assistant') {
      if (message.content) entries.push({ label: '助手', text: message.content })
      for (const call of message.tool_calls ?? []) {
        entries.push({ label: '工具调用', text: call.function.name + ' ' + call.function.arguments })
      }
    }
    if (message.role === 'tool') entries.push({ label: '工具结果', text: message.content })
  }
  return entries
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

export async function apply(ctx: Context, config: { port?: number }) {
  const port = Number(process.env.MINI_DSH_PORT ?? config.port ?? 4317)
  const page = await readFile(new URL('../web.html', import.meta.url))
  const sessions = new Map<string, { transcript: Transcript; pending?: Promise<string> }>()

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const localPort = req.socket.localPort
    const host = req.headers.host
    res.setHeader('Cache-Control', 'no-store')
    if (host !== '127.0.0.1:' + localPort && host !== 'localhost:' + localPort) {
      return json(res, 403, { error: '请使用本机地址访问' })
    }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(page)
    }
    const get = req.method === 'GET' && req.url === '/api/context'
    const post = req.method === 'POST' && req.url === '/api/messages'
    if (!get && !post) return json(res, 404, { error: '地址不存在' })
    if (req.headers.origin && req.headers.origin !== 'http://' + host) {
      return json(res, 403, { error: '请求来源无效' })
    }
    // Cookie 只保存会话 ID，消息保存在服务端。名称带端口，避免本机多个实例共用一个 ID。
    const cookie = 'mini_dsh_' + localPort + '='
    const id = req.headers.cookie?.split(/;\s*/).find(part => part.startsWith(cookie))?.slice(cookie.length)
    let session = id ? sessions.get(id) : undefined
    if (!session) {
      const newId = randomUUID()
      session = { transcript: ctx.sessions.open() }
      sessions.set(newId, session)
      res.setHeader('Set-Cookie', cookie + newId + '; Path=/api; HttpOnly; SameSite=Strict')
    }
    if (post) {
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
        return json(res, 415, { error: '需要 JSON 请求' })
      }
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > 64 * 1024) return json(res, 413, { error: '消息过长' })
        chunks.push(chunk)
      }
      // 页面只会发送 JSON.stringify({ text }) 的结果，参数形状由 web.html 保证。
      const { text } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { text: string }
      // 同一浏览器可能同时打开多个标签页；用这份会话共享的 pending 拦住重复提交。
      if (session.pending) return json(res, 409, { error: '上一条消息正在处理' })
      // 网页显式请求逐行 JSON；普通接口调用继续返回整份对话。
      if (req.headers.accept === 'application/x-ndjson') {
        const client = new AbortController()
        res.once('close', () => client.abort())
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' })
        res.flushHeaders()
        const send = (event: object) => res.write(JSON.stringify(event) + '\n')
        try {
          session.pending = ctx.agent.ask(session.transcript, text.trim(),
            chunk => { send({ type: 'delta', text: chunk }) }, client.signal)
          await session.pending
          send({ type: 'done', history: displayMessages(session.transcript.read()) })
        } catch (error) {
          if (!res.destroyed) send({ type: 'error', error: error instanceof Error ? error.message : String(error) })
        } finally {
          delete session.pending
          res.end()
        }
        return
      }
      session.pending = ctx.agent.ask(session.transcript, text.trim())
      try {
        await session.pending
      } finally {
        delete session.pending
      }
    } else if (session.pending) {
      // 用户在回复途中刷新时，等当前问答结束，再读取包含这一轮的会话记录。
      await session.pending
    }
    json(res, 200, displayMessages(session.transcript.read()))
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(error => json(res, 500, { error: error instanceof Error ? error.message : String(error) }))
  })
  // 卸载网页插件时关闭监听和现有连接，让端口可以被下一个实例使用。
  ctx.effect(() => () => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  ctx.provide('app', {
    async start() {
      server.listen(port, '127.0.0.1')
      await once(server, 'listening')
      // 监听的是 TCP 端口，address() 在这里必定返回端口信息。
      const address = server.address() as AddressInfo
      return 'http://127.0.0.1:' + address.port
    },
  })
}
