import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('Web app follows project references, preserves tool history and recovers after a failed request', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mini-dsh-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'docs'))
  await writeFile(path.join(root, 'README.md'), '启动步骤见 docs/start.md')
  await writeFile(path.join(root, 'docs', 'start.md'), '运行 npm run orchard')

  const requests = []
  const release = Promise.withResolvers()
  t.after(release.resolve)
  function tool(id, name, file) {
    return { id, type: 'function', function: { name, arguments: JSON.stringify({ path: file }) } }
  }
  const replies = [
    [tool('a', 'list_dir', '.')],
    [tool('b', 'read_file', 'README.md'), tool('c', 'read_file', 'missing.md')],
    [tool('d', 'read_file', 'docs/start.md')],
    '运行 npm run orchard，依据 docs/start.md。',
    null, // 在两次成功问答之间模拟一次网关故障，验证下一轮仍能接着对话。
    '依据是 docs/start.md。',
  ]
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ path: req.url, auth: req.headers.authorization, ...JSON.parse(body) })
    const reply = replies[requests.length - 1]
    if (!reply) {
      res.writeHead(503).end()
      return
    }
    const calls = Array.isArray(reply)
    const message = { role: 'assistant', reasoning_content: 'fixture', content: calls ? null : reply }
    if (calls) message.tool_calls = reply
    if (requests.at(-1).stream) {
      res.setHeader('content-type', 'text/event-stream')
      const frame = (delta, finish_reason = null) => {
        res.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason }] }) + '\r\n\r\n')
      }
      frame({ reasoning_content: 'fixture' })
      if (calls) {
        // 同一步的工具参数拆成两片传输，覆盖并行调用的索引配对。
        frame({ tool_calls: reply.map((call, index) => ({ ...call, index, function: { ...call.function, arguments: '{' } })) })
        frame({ tool_calls: reply.map((call, index) => ({ index, function: { arguments: call.function.arguments.slice(1) } })) }, 'tool_calls')
      } else {
        frame({ content: '运行' })
        await release.promise
        frame({ content: reply.slice(2) }, 'stop')
      }
      res.end('data: [DONE]\n\n')
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ finish_reason: calls ? 'tool_calls' : 'stop', message }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const entry = fileURLToPath(new URL('../src/server.ts', import.meta.url))
  const child = spawn(process.execPath, [entry], { env: {
    ...process.env, MINI_DSH_CWD: root, MINI_DSH_PORT: '0', DEEPSEEK_API_KEY: 'test-only',
    MINI_DSH_PROFILE: '', DEEPSEEK_MODEL: 'fixture', DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + server.address().port,
  } })
  t.after(() => child.kill())
  const stdout = createInterface({ input: child.stdout })
  const [url] = await once(stdout, 'line', { signal: AbortSignal.timeout(5000) })
  const page = await fetch(url)
  assert.match(await page.text(), /aria-label="对话上下文"/)
  const first = await fetch(url + '/api/context')
  const cookie = first.headers.get('set-cookie').split(';')[0]
  assert.deepEqual(await first.json(), [])
  async function send(text, accept = 'application/json') {
    return fetch(url + '/api/messages', {
      method: 'POST', headers: { cookie, accept, 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    })
  }
  const streamed = await send('怎么启动？', 'application/x-ndjson')
  const lines = createInterface({ input: Readable.fromWeb(streamed.body) })
  const events = lines[Symbol.asyncIterator]()
  // 模型尚未获准结束，网页接口必须已经收到第一片正文。
  try {
    assert.deepEqual(JSON.parse((await events.next()).value), { type: 'delta', text: '运行' })
  } finally {
    release.resolve()
  }
  assert.match(JSON.parse((await events.next()).value).text, /npm run orchard/)
  const done = JSON.parse((await events.next()).value)
  assert.equal(done.type, 'done')
  const answer = done.history
  assert.match(answer.at(-1).text, /运行 npm run orchard/)
  assert.equal(answer.filter(row => row.label === '工具调用').length, 4)
  assert.equal(answer.filter(row => row.label === '工具结果').length, 4)
  const failed = await send('这个请求会失败')
  assert.equal(failed.status, 500)
  assert.match((await failed.json()).error, /HTTP 503/)
  const latest = await (await send('依据是哪个文件？')).json()
  assert.match(latest.at(-1).text, /依据是 docs\/start.md/)
  const refreshed = await fetch(url + '/api/context', { headers: { cookie } })
  assert.deepEqual(await refreshed.json(), latest)
  assert.deepEqual(await (await fetch(url + '/api/context')).json(), [])
  assert.equal(requests.length, 6)
  assert.equal(requests[0].auth, 'Bearer test-only')
  assert.equal(requests[0].path, '/chat/completions')
  assert.equal(requests[0].model, 'fixture')
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ['list_dir', 'read_file'])
  const history = requests.at(-1).messages
  assert.deepEqual(history.filter(m => m.role === 'user').map(m => m.content), ['怎么启动？', '依据是哪个文件？'])
  assert.ok(history.filter(m => m.role === 'assistant').every(m => m.reasoning_content === 'fixture'))
  const results = history.filter(m => m.role === 'tool')
  assert.deepEqual(results.map(r => r.tool_call_id), ['a', 'b', 'c', 'd'])
  assert.deepEqual(JSON.parse(results[0].content).entries, ['README.md', 'docs/'])
  assert.match(JSON.parse(results[1].content).content, /docs\/start.md/)
  assert.match(JSON.parse(results[2].content).error, /ENOENT/)
  assert.equal(JSON.parse(results[3].content).content, '运行 npm run orchard')
})
