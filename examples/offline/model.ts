import type { Context } from '../../src/kernel.ts'

// 离线示例用两次模型调用演示一轮问答：先请求列目录，收到工具结果后再将它作为回答。
export function apply(ctx: Context) {
  const model: Context['model'] = {
    async complete(messages, tools) {
      const last = messages.at(-1)
      if (last?.role === 'tool') return { role: 'assistant', content: last.content }
      if (!tools.some(tool => tool.name === 'list_dir')) {
        return { role: 'assistant', content: '当前配置未启用 list_dir。' }
      }
      return {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'dir-' + messages.length, type: 'function', function: {
          name: 'list_dir', arguments: JSON.stringify({ path: '.' }),
        } }],
      }
    },
  }
  ctx.provide('model', model)
}
