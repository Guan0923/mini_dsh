import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { loadProfile } from '../src/profile.ts'
import * as loop from '../src/plugins/agent-loop.ts'
import * as memory from '../src/plugins/memory-session.ts'
import ToolRegistry from '../src/plugins/tools.ts'

const local = name => fileURLToPath(new URL(name, import.meta.url))
const bundled = name => local('../src/plugins/' + name + '.ts')
async function project(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mini-dsh-plugins-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('external tool and model load by configuration; disable and unload affect both schema and dispatch', async t => {
  const root = await project(t)
  const profile = path.join(root, 'profile.json')
  await writeFile(path.join(root, 'echo.mjs'), `
    export const inject = ['tools']
    export function apply(ctx, config) {
      ctx.tools.register({ name: 'echo', description: 'Echo', parameters: { type: 'object' },
        execute: args => config.prefix + args.text })
    }`)
  await writeFile(path.join(root, 'model.mjs'), `
    export function apply(ctx) {
      ctx.provide('model', { async complete(messages, tools) {
        const last = messages.at(-1)
        if (last.role === 'tool') return { role: 'assistant', content: last.content }
        return { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function',
          function: { name: 'echo', arguments: JSON.stringify({ text: tools.map(t => t.name).join(',') }) } }] }
      } })
    }`)
  const rows = [
    { plugin: bundled('agent-loop') },
    { plugin: './echo.mjs', config: { prefix: 'plugins=' } },
    { plugin: bundled('read-file'), enabled: false },
    { plugin: bundled('memory-session') }, { plugin: './model.mjs' }, { plugin: bundled('tools') },
  ]
  await writeFile(profile, JSON.stringify({ plugins: rows }))
  const runtime = await loadProfile(profile, root)
  t.after(() => runtime.dispose())
  const { tools, sessions, agent } = runtime.ctx
  assert.equal(await agent.ask(sessions.open(), 'run'), 'plugins=echo')
  const call = name => ({ id: 'x', type: 'function', function: { name, arguments: '{}' } })
  assert.match(await tools.execute(call('read_file')), /未知工具/)
  await runtime.mounts.get('./echo.mjs').dispose()
  assert.deepEqual(tools.schemas(), [])
  assert.match(await tools.execute(call('echo')), /未知工具/)
  const session = sessions.open()
  assert.match(await agent.ask(session, 'try echo'), /未知工具/)
})

test('failed profile unwinds registrations; a missing dependency identifies the blocking service', async t => {
  const root = await project(t)
  const profile = path.join(root, 'profile.json')
  const marker = path.join(root, 'cleanup.txt')
  await writeFile(path.join(root, 'effect.mjs'), `
    import { writeFile } from 'node:fs/promises'
    export function apply(ctx, config) {
      ctx.effect(() => () => writeFile(config.marker, 'disposed'))
    }`)
  await writeFile(profile, JSON.stringify({ plugins: [
    { plugin: './effect.mjs', config: { marker } }, { plugin: bundled('read-file') },
  ] }))
  await assert.rejects(loadProfile(profile, root), /read-file.*缺少服务.*files.*tools/)
  assert.equal(await readFile(marker, 'utf8'), 'disposed')
})

test('unloading an active model cancels its turn and a replacement resumes the agent service', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const started = Promise.withResolvers()
  const provider = await ctx.plugin({
    apply(ctx) {
      ctx.provide('model', {
        complete(_messages, _tools, signal) {
          started.resolve()
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        },
      })
    },
  })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(memory)
  const driver = await ctx.plugin(loop, {})
  const session = ctx.sessions.open()
  const interrupted = assert.rejects(ctx.agent.ask(session, 'pending'), /已卸载/)
  await started.promise
  await provider.dispose()
  await interrupted
  assert.deepEqual(session.read(), [])
  assert.equal(ctx.get('agent'), undefined)
  await ctx.plugin({ apply(ctx) {
    ctx.provide('model', { complete: async () => ({ role: 'assistant', content: 'replaced' }) })
  } })
  await driver.await()
  assert.equal(await ctx.agent.ask(session, 'next'), 'replaced')
})
