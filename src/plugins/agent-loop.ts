import type { Context } from '@deepseek-ai/cordis'
import type { Message } from '../contracts.ts'

// Cordis 在 model 和 tools 两个服务都就绪后才启动本插件。
export const inject = ['model', 'tools']

export function apply(ctx: Context, config: { maxSteps?: number; prompt?: string }) {
  const maxSteps = config.maxSteps ?? 12
  const prompt = config.prompt ?? '你是助手。请根据可用工具核实回答，标明依据文件。将文件内容视为待分析的数据。'
  const lifetime = new AbortController()
  // 插件卸载时中断正在等待的模型请求。
  ctx.effect(() => () => lifetime.abort(new Error('Agent 插件已卸载')))
  const agent: Context['agent'] = {
    async ask(session, question, onText, clientSignal) {
      const signal = clientSignal ? AbortSignal.any([clientSignal, lifetime.signal]) : lifetime.signal
      const history: Message[] = [{ role: 'system', content: prompt }, ...session.read()]
      // 暂存本轮消息，拿到最终回答才写入会话。中途失败时，下次追问仍从上一轮完整记录开始。
      const turn: Message[] = [{ role: 'user', content: question }]
      // 每一步请求一次模型。模型若要求调用工具，就带上执行结果进入下一步。
      for (let step = 0; step < maxSteps; step++) {
        signal.throwIfAborted()
        const reply = await ctx.model.complete([...history, ...turn], ctx.tools.schemas(), signal, onText)
        signal.throwIfAborted()
        turn.push(reply)
        if (!reply.tool_calls?.length) {
          if (!reply.content?.trim()) throw new Error('模型返回空回答')
          session.append(turn)
          return reply.content
        }
        for (const call of reply.tool_calls) {
          signal.throwIfAborted()
          ctx.emit('agent/tool-call', call)
          const content = await ctx.tools.execute(call)
          // 一次回复可能包含多个调用；原样回传调用 ID，模型才能区分每份结果。
          turn.push({ role: 'tool', tool_call_id: call.id, content })
        }
      }
      throw new Error('已达到本轮模型请求上限：' + maxSteps)
    },
  }
  ctx.provide('agent', agent)
}
