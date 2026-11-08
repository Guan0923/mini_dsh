import type { Context } from '../kernel.ts'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { json } from '../host.ts'
import type { Message, Transcript } from '../contracts.ts'

export const inject = ['sessions']

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

export async function apply(ctx: Context) {
  const page = await readFile(new URL('../web.html', import.meta.url))
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(new Error('网页插件已卸载')))
  const sessions = new Map<string, { transcript: Transcript; pending?: Promise<string> }>()

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const localPort = req.socket.localPort
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(page)
    }
    const get = req.method === 'GET' && req.url === '/api/context'
    const post = req.method === 'POST' && req.url === '/api/messages'
    const clear = req.method === 'DELETE' && req.url === '/api/context'
    if (!get && !post && !clear) return json(res, 404, { error: '地址不存在' })
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
    if (clear) {
      if (session.pending) return json(res, 409, { error: '请等待本轮回复结束后清理' })
      session.transcript = ctx.sessions.open()
      return json(res, 200, [])
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
      if (lifetime.signal.aborted || !ctx.get('agent')) return json(res, 503, { error: '聊天未就绪，请检查插件设置' })
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
            chunk => { send({ type: 'delta', text: chunk }) }, AbortSignal.any([lifetime.signal, client.signal]))
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
      session.pending = ctx.agent.ask(session.transcript, text.trim(), undefined, lifetime.signal)
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

  ctx.provide('app', { handle })
}
