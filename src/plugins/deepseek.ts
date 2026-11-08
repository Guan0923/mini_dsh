import type { Context } from '../kernel.ts'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import type { AssistantMessage, ToolCall } from '../contracts.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// 网关返回的 arguments 是 JSON 字符串，留到执行工具时再解析。
function isToolCall(value: unknown): value is ToolCall {
  return isRecord(value) && value.type === 'function'
    && typeof value.id === 'string' && value.id.length > 0
    && isRecord(value.function) && typeof value.function.name === 'string'
    && typeof value.function.arguments === 'string'
}

// 网关用 SSE 传输增量。按行解码后再按空行分帧，避免网络分包截断中文或 JSON。
async function readStream(response: Response, onText: (text: string) => void) {
  const source = Readable.from(response.body!)
  source.setEncoding('utf8')
  const lines = createInterface({ input: source, crlfDelay: Infinity })
  const message: AssistantMessage = { role: 'assistant', content: null }
  const calls = new Map<number, ToolCall>()
  let finish_reason: string | null = null
  let data: string[] = []
  try {
    for await (const line of lines) {
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      if (line || !data.length) continue
      const frame = data.join('\n')
      data = []
      if (frame === '[DONE]') break
      const packet = JSON.parse(frame)
      if (packet.error) throw new Error('模型流返回错误')
      const choice = packet.choices?.[0]
      if (!choice) continue
      finish_reason = choice.finish_reason ?? finish_reason
      const delta = choice.delta
      if (typeof delta?.content === 'string' && delta.content) {
        message.content = (message.content ?? '') + delta.content
        onText(delta.content)
      }
      if (typeof delta?.reasoning_content === 'string') {
        message.reasoning_content = (message.reasoning_content ?? '') + delta.reasoning_content
      }
      // 同一步可能交错返回多个工具，按 index 分别拼接名称和 JSON 参数。
      for (const part of delta?.tool_calls ?? []) {
        if (!Number.isSafeInteger(part.index) || part.index < 0) throw new Error('工具调用序号无效')
        const call = calls.get(part.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
        call.id += part.id ?? ''
        call.function.name += part.function?.name ?? ''
        call.function.arguments += part.function?.arguments ?? ''
        calls.set(part.index, call)
      }
    }
  } finally {
    lines.close()
    source.destroy()
  }
  if (calls.size) message.tool_calls = [...calls.keys()].sort((a, b) => a - b).map(i => calls.get(i)!)
  return { finish_reason, message }
}

export function apply(ctx: Context) {
  const key = process.env.DEEPSEEK_API_KEY?.trim()
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
  const endpoint = new URL(baseUrl + '/chat/completions')
  const complete: Context['model']['complete'] = async (messages, schemas, signal, onText) => {
    if (!key) throw new Error('请在本机配置 DEEPSEEK_API_KEY 后重启服务。')
    // 注册表使用通用工具描述，在发请求前包装成聊天接口要求的 function 格式。
    const tools = schemas.map(schema => ({ type: 'function', function: schema }))
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools: tools.length ? tools : undefined, stream: Boolean(onText) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    })
    if (!response.ok) {
      throw new Error('模型请求失败，HTTP ' + response.status + ' ' + response.statusText)
    }
    const choice = onText ? await readStream(response, onText) : (await response.json())?.choices?.[0]
    const message = choice?.message
    if (choice?.finish_reason !== 'stop' && choice?.finish_reason !== 'tool_calls') {
      throw new Error('模型未正常完成，结束原因：' + (choice?.finish_reason ?? '未知'))
    }
    if (!isRecord(message) || message.role !== 'assistant'
      || !(message.content === null || typeof message.content === 'string')
      || !(message.reasoning_content == null || typeof message.reasoning_content === 'string')) {
      throw new Error('模型返回的消息格式无效')
    }
    // 同一批调用需要不同的 ID，否则下一步无法将每份工具结果对应到唯一的调用。
    const calls = message.tool_calls
    if (calls != null && (!Array.isArray(calls) || !calls.every(isToolCall)
      || new Set(calls.map(call => call.id)).size !== calls.length)) {
      throw new Error('模型返回的工具调用格式无效')
    }
    if (!calls?.length && choice.finish_reason === 'tool_calls') {
      throw new Error('模型报告需要调用工具，但调用列表为空')
    }
    // 保留网关返回的 reasoning_content 等字段，后续工具调用可以带回完整的助手消息。
    return { ...message, role: 'assistant', content: message.content, tool_calls: calls }
  }
  ctx.provide('model', { complete })
}
