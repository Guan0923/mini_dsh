import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from './kernel.ts'

export interface PluginStatus { plugin: string; enabled: boolean; state: string; missing: string[] }
export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<unknown>

export function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

/** 管理入口归根上下文所有，关闭网页或模型插件后仍可从设置页重新开启。 */
export function createHost(ctx: Context, list: () => PluginStatus[], toggle: (name: string, enabled: boolean) => Promise<void>) {
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const host = req.headers.host
    const port = req.socket.localPort
    res.setHeader('Cache-Control', 'no-store')
    if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return json(res, 403, { error: '请使用本机地址访问' })
    if (req.headers.origin && req.headers.origin !== 'http://' + host) return json(res, 403, { error: '请求来源无效' })
    if (req.url === '/settings' && req.method === 'GET') {
      const page = await readFile(new URL('./settings.html', import.meta.url))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page)
      return
    }
    if (req.url === '/api/plugins') {
      if (req.method === 'GET') return json(res, 200, list())
      if (req.method !== 'PUT') return json(res, 405, { error: '请求方法无效' })
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: '需要 JSON 请求' })
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > 8192) return json(res, 413, { error: '请求过长' })
        chunks.push(chunk)
      }
      let data
      try { data = JSON.parse(Buffer.concat(chunks).toString()) } catch { return json(res, 400, { error: '无效 JSON' }) }
      if (typeof data?.enabled !== 'boolean' || typeof data.plugin !== 'string') return json(res, 400, { error: '插件参数无效' })
      if (!list().some(row => row.plugin === data.plugin)) return json(res, 404, { error: '插件不存在' })
      await toggle(data.plugin, data.enabled)
      return json(res, 200, list())
    }
    if (ctx.get('app')) return ctx.app.handle(req, res)
    if (req.method === 'GET' && req.url === '/') return res.writeHead(302, { Location: '/settings' }).end()
    return json(res, 503, { error: '聊天网页未就绪，请检查插件设置' })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(error => json(res, 500, { error: error instanceof Error ? error.message : String(error) }))
  })
  ctx.effect(() => () => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  return {
    async start() {
      server.listen(Number(process.env.MINI_DSH_PORT ?? 4317), '127.0.0.1')
      await once(server, 'listening')
      return 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    },
  }
}
