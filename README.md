# mini_dsh

[![TypeScript 5.9](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![Node.js 24.12+](https://img.shields.io/badge/Node.js-24.12%2B-43853D?logo=nodedotjs&logoColor=white)](package.json)
[![ESLint](https://img.shields.io/badge/ESLint-4B32C3?logo=eslint&logoColor=white)](eslint.config.js)

一个可以边用边拆的 TypeScript Agent。打开网页，让它列出当前目录，再去设置里关掉目录工具。回到同一段对话，问同一个问题，你就能看见这个开关究竟改变了什么。

mini_dsh 把 DeepSeek Harness 的插件化思路做成了一个可以本地运行、从头读懂的项目。聊天页面背后，模型、工具和会话各自由插件提供。负责启动插件、等待依赖、撤销工具注册的内核也在仓库里。想弄清一个 Agent 如何获得或失去一种能力，可以从一次真实的工具调用一路追到管理它的 Fiber。

## 第一次运行：让一个工具消失，再把它加回来

准备 **Node.js 24.12 或更高版本**，在项目根目录打开 PowerShell。下面的示例在本地运行，体验工具调用只需要安装项目依赖。

```powershell
npm.cmd ci
$env:MINI_DSH_PROFILE = 'examples/offline/profile.json'
npm.cmd run dev
```

1. 打开[聊天页](http://127.0.0.1:4317/)，输入「当前目录有什么？」。页面会显示工具调用 `list_dir`、参数 `{"path":"."}` 和你机器上的真实目录内容。
2. 打开[插件设置](http://127.0.0.1:4317/settings)，关闭 `list-dir.ts`。返回对话再问一次，这次会收到「当前配置未启用 list_dir。」
3. 重新开启 `list-dir.ts`，再问一次。目录工具立即恢复，前两轮对话也还在。

这里用的是一个行为固定的[离线模型插件](examples/offline/model.ts)。它每轮都会检查 Agent 提供的工具清单，因此同一个问题可以稳定地演示开关前后的区别。你还可以试着关闭 `workspace-files.ts`：这次目录插件的开关依然开启，状态却变成了「等待依赖」。重新启用文件服务后，它会自动恢复。

## 开关背后发生了什么？

目录插件声明自己需要 `files` 和 `tools` 两项服务。配置加载器调用 `ctx.plugin()` 时，内核为**这一次挂载**创建一个 Fiber。依赖就绪后，Fiber 执行插件的 `apply(ctx)`，目录插件才把 `list_dir` 注册进工具表。下面这几处源码正好能串起整个过程。

| 你在页面上看到的事 | 可以跟进去看的代码 |
| --- | --- |
| 设置里多了一个已挂载的插件 | 配置加载器导入模块并保存 Fiber 句柄。[profile.ts](src/profile.ts) |
| 「等待依赖」变成「运行中」 | Fiber 的 `activate()` 查找服务提供者并执行插件入口。[kernel.ts](src/kernel.ts) |
| 发出问题后，模型调用 `list_dir` | Agent 读取当时的工具清单，将调用交给工具表执行，再把结果带回模型。[agent-loop.ts](src/plugins/agent-loop.ts) |
| 关闭插件后，工具从清单中消失 | 注册工具时，`ctx.effect()` 把删除操作交给调用方的 Fiber；卸载会执行这项清理。[tools.ts](src/plugins/tools.ts) |

插件开关对当前服务的所有会话生效，重启后重新读取配置。聊天页的「清理上下文」只清理当前浏览器会话。消息保存在内存里，重启进程、关闭网页插件或关闭会话插件都会释放已有会话。

## 接入模型，试一次跨文件问答

切回默认配置后，可以问：「读一下 README，找出开发启动命令，再检查 package.json 里有没有对应的脚本。」默认配置同时启用列目录和读文件工具。页面会逐步显示模型返回的正文，并在本轮完成后展示工具调用、参数和结果。

在项目根目录的 `.env` 中填入网关信息。模型插件会在基础地址后追加 `/chat/completions`。

```dotenv
DEEPSEEK_BASE_URL=https://your-gateway.example/v1
DEEPSEEK_MODEL=your-model-id
DEEPSEEK_API_KEY=your-api-key
```

如果刚才运行了离线示例，按 `Ctrl+C` 停止服务，在同一 PowerShell 窗口执行：

```powershell
Remove-Item Env:MINI_DSH_PROFILE -ErrorAction SilentlyContinue
npm.cmd run dev
```

默认插件组合在 [profiles/default.json](profiles/default.json)。要让工具读取另一个项目，可以在启动前设置 `$env:MINI_DSH_CWD`。端口由 `MINI_DSH_PORT` 指定，默认是 `4317`。

## 加一个自己的工具

例如，让模型能回答「这个工作目录叫什么？」。新建 `src/plugins/project-name.ts`：

```ts
import path from 'node:path'
import type { Context } from '../kernel.ts'

export const inject = ['workspace', 'tools']

export function apply(ctx: Context) {
  ctx.tools.register({
    name: 'project_name',
    description: '返回当前工作目录的名称',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => path.basename(ctx.workspace),
  })
}
```

在默认配置的 `plugins` 数组中加入 `{ "plugin": "../src/plugins/project-name.ts" }`，重启后即可在设置页找到它。模型会在下一次请求中收到新的工具说明。想换模型、会话存储或 Agent 循环时，可以从它们各自的[服务接口](src/contracts.ts)入手。

## 开发命令

| 命令 | 用途 |
| --- | --- |
| `npm.cmd run dev` | 开发启动，已加载的 TypeScript 模块变化后自动重启 |
| `npm.cmd start` | 普通启动 |
| `npm.cmd run lint` | 检查代码规则 |
| `npm.cmd run check` | 检查 TypeScript 类型 |
| `npm.cmd test` | 运行插件生命周期、文件工具和 Web 对话测试 |
