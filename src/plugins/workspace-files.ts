import type { Context } from '@deepseek-ai/cordis'
import { realpath } from 'node:fs/promises'
import path from 'node:path'

export const inject = ['workspace']

function checkLocation(root: string, target: string) {
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('路径超出工作目录')
  }
}

export function apply(ctx: Context) {
  const root = ctx.workspace
  const files: Context['files'] = {
    async resolve(args) {
      if (!args || typeof args !== 'object' || !('path' in args)
        || typeof args.path !== 'string' || !args.path.trim() || Object.keys(args).length !== 1) {
        throw new Error('工具需要一个字符串参数 path')
      }
      if (path.isAbsolute(args.path) || (process.platform === 'win32' && args.path.includes(':'))) {
        throw new Error('请使用工作目录内的相对路径')
      }
      // 先拦住通过 .. 越界的路径，再检查符号链接或 Windows 目录联接最终指向的位置。
      const candidate = path.resolve(root, args.path)
      checkLocation(root, candidate)
      const target = await realpath(candidate)
      checkLocation(root, target)
      return target
    },
  }
  ctx.provide('files', files)
}
