import type { Context } from '../kernel.ts'
import { open, stat } from 'node:fs/promises'
import { pathParameter } from '../path-parameter.ts'
import { modelEnvFile } from '../model-env.ts'

export const inject = ['files', 'tools']
const fileLimit = 32 * 1024

async function readFile(target: string) {
  if (!(await stat(target)).isFile()) throw new Error('只能读取普通文件')
  const file = await open(target, 'r')
  try {
    // 按文件标识判断，即使通过链接访问，也不会把模型密钥送入对话。
    const config = await stat(modelEnvFile, { bigint: true, throwIfNoEntry: false })
    if (config) {
      const opened = await file.stat({ bigint: true })
      if (opened.dev === config.dev && opened.ino === config.ino) throw new Error('模型配置文件不可读取')
    }
    // 多读一个字节，用来区分“刚好读完 32 KiB”和“后面还有内容”。
    const buffer = Buffer.alloc(fileLimit + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length)
      if (!bytesRead) break
      length += bytesRead
    }
    const bytes = buffer.subarray(0, Math.min(length, fileLimit))
    if (bytes.includes(0)) throw new Error('需要 UTF-8 文本文件')
    const truncated = length > fileLimit
    // 截断可能落在一个 UTF-8 字符中间。流式解码会暂存末尾残缺的字节，只返回完整字符。
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated })
    return { content, truncated }
  } finally {
    await file.close()
  }
}

export function apply(ctx: Context) {
  ctx.tools.register({
    name: 'read_file',
    description: '读取 UTF-8 文本文件开头的 32 KiB。',
    parameters: pathParameter,
    async execute(args) {
      const target = await ctx.files.resolve(args)
      return JSON.stringify(await readFile(target))
    },
  })
}
