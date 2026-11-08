import type { Context } from '@deepseek-ai/cordis'
import { opendir } from 'node:fs/promises'
import { pathParameter } from '../path-parameter.ts'

export const inject = ['files', 'tools']
const directoryLimit = 200

async function listDirectory(target: string) {
  const entries: string[] = []
  let truncated = false
  for await (const entry of await opendir(target)) {
    // 发现第 201 项时才标记截断，这样恰好有 200 项的目录仍算完整。
    if (entries.length === directoryLimit) {
      truncated = true
      break
    }
    entries.push(entry.name + (entry.isDirectory() ? '/' : ''))
  }
  return { entries: entries.sort(), truncated }
}

export function apply(ctx: Context) {
  ctx.tools.register({
    name: 'list_dir',
    description: '列出目录直接子项。根目录用点号，最多返回 200 项。',
    parameters: pathParameter,
    async execute(args) {
      const target = await ctx.files.resolve(args)
      return JSON.stringify(await listDirectory(target))
    },
  })
}
