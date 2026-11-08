import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Context } from '../src/kernel.ts'
import tools from '../src/plugins/tools.ts'
import * as files from '../src/plugins/workspace-files.ts'
import * as readFile from '../src/plugins/read-file.ts'
import * as listDir from '../src/plugins/list-dir.ts'

test('workspace tools check resolved targets and truncate UTF-8 without splitting a character', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'mini-dsh-tools-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = path.join(await realpath(base), 'project')
  const outside = path.join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  await writeFile(path.join(outside, 'private.txt'), 'outside content')
  await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(path.join(root, 'long.txt'), 'a'.repeat(32767) + '文')
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.provide('workspace', root)
  for (const plugin of [tools, files, listDir, readFile]) await ctx.plugin(plugin)
  async function run(name, file) {
    const call = { id: 'test', type: 'function', function: { name, arguments: JSON.stringify({ path: file }) } }
    return JSON.parse(await ctx.tools.execute(call))
  }
  assert.match((await run('read_file', '../outside/private.txt')).error, /超出工作目录/)
  assert.match((await run('read_file', 'link/private.txt')).error, /超出工作目录/)
  assert.match((await run('list_dir', 'link')).error, /超出工作目录/)
  assert.deepEqual(await run('read_file', 'long.txt'), { content: 'a'.repeat(32767), truncated: true })
})
