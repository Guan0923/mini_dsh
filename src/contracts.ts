import '@deepseek-ai/cordis'

/** 模型发起一次工具调用时给出 id，执行结果通过 tool_call_id 与该调用配对。 */
export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface AssistantMessage {
  role: 'assistant'
  content: string | null
  reasoning_content?: string | null
  tool_calls?: ToolCall[] | null
}

export type Message =
  | { role: 'system' | 'user'; content: string }
  | AssistantMessage
  | { role: 'tool'; tool_call_id: string; content: string }

/** 发给模型的工具说明。parameters 描述调用参数的 JSON 结构。 */
export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface Tool extends ToolSchema {
  execute(args: unknown): Promise<string> | string
}

/** 一份会话记录。Agent 取得最终回答后，将本轮的提问、工具往返和回答一起追加。 */
export interface Transcript {
  read(): readonly Message[]
  append(turn: readonly Message[]): void
}

// 在这里声明插件共享的服务类型；运行时由各插件调用 ctx.provide 或通过 Service 注册。
declare module '@deepseek-ai/cordis' {
  interface Context {
    workspace: string
    files: { resolve(args: unknown): Promise<string> }
    tools: {
      register(tool: Tool): () => void
      schemas(): ToolSchema[]
      execute(call: ToolCall): Promise<string>
    }
    model: { complete(messages: Message[], tools: ToolSchema[], signal: AbortSignal, onText?: (text: string) => void): Promise<AssistantMessage> }
    sessions: { open(): Transcript }
    agent: { ask(session: Transcript, question: string, onText?: (text: string) => void, signal?: AbortSignal): Promise<string> }
    app: { start(): Promise<string> }
  }

  interface Events {
    'agent/tool-call'(call: ToolCall): void
  }
}
