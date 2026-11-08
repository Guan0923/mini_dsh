import type { Context } from '@deepseek-ai/cordis'
import type { Message } from '../contracts.ts'

export function apply(ctx: Context) {
  const sessions: Context['sessions'] = {
    open() {
      // 每次 open 都创建独立的消息数组。read 返回浅拷贝，避免调用方增删会话里的条目。
      const messages: Message[] = []
      return {
        read: () => messages.slice(),
        append: turn => messages.push(...turn),
      }
    },
  }
  ctx.provide('sessions', sessions)
}
