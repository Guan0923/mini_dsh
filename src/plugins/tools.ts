import { Service, type Context } from '../kernel.ts'
import type { Tool, ToolCall } from '../contracts.ts'

export default class ToolRegistry extends Service {
  private readonly entries = new Map<string, Tool>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(tool: Tool) {
    // 本地内核 将 this.ctx 绑定到调用 register 的插件；该插件卸载时会执行下面的删除操作。
    return this.ctx.effect(() => {
      if (this.entries.has(tool.name)) throw new Error('工具名称冲突：' + tool.name)
      this.entries.set(tool.name, tool)
      return () => { this.entries.delete(tool.name) }
    })
  }

  // 声明和执行入口都从 entries 读取，因此卸载工具后，模型看到的清单也随之更新。
  schemas() {
    return Array.from(this.entries.values(), ({ name, description, parameters }) => ({ name, description, parameters }))
  }

  async execute(call: ToolCall) {
    try {
      const tool = this.entries.get(call.function.name)
      if (!tool) throw new Error('未知工具：' + call.function.name)
      return await tool.execute(JSON.parse(call.function.arguments))
    } catch (error) {
      // 把参数或文件错误作为工具结果回传，模型下一步可以修正参数或换一个文件。
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }
  }
}
