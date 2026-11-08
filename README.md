# mini_dsh

一个用 TypeScript 实现的、由插件组装的本地 Agent。插件运行时使用 DeepSeek 发布的 `@deepseek-ai/cordis` 4.1.0。模型、工具注册表、文件工具、会话、Agent 循环和网页都由配置选择。项目的规模和插件服务接口针对这个 mini 版本设计。[DeepSeek Harness 官方架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)

## 运行

需要 Node.js 24.12 或更高版本。首次运行前在项目目录执行 `npm.cmd ci`。设置模型密钥后运行 `npm.cmd start`，浏览器打开 [本机网页](http://127.0.0.1:4317)。在底部输入消息，按回车或点击发送。内容框显示问题、助手回答、工具调用和工具结果。刷新页面可以继续当前浏览器的会话，重启服务会清空内存历史。

```powershell
npm.cmd start
```

离线体验可在启动服务前设置 `$env:MINI_DSH_PROFILE = 'examples/offline/profile.json'`。这个示例固定调用 `list_dir(".")`，把真实目录列表作为回答。默认工作目录是启动服务时所在的目录；`MINI_DSH_CWD` 可指定其他项目。`MINI_DSH_PORT` 可更改监听端口。

服务启动时读取项目根目录的 `.env`。在其中设置 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` 和 `DEEPSEEK_BASE_URL`，修改后重启服务生效。启动进程已有的环境变量优先于文件值。DeepSeek 插件中的显式 `model` 和 `baseUrl` 配置优先于环境变量。

## 一次启动如何组装

`src/server.ts` 加载 `MINI_DSH_PROFILE` 指定的配置，默认使用 `profiles/default.json`。插件路径相对于配置文件解析。启动器等待依赖就绪后调用 `app.start()`，网页插件在本机回环地址提供页面和会话接口。

| 服务 | 默认插件 | 用途 |
| --- | --- | --- |
| `ctx.app` | `web.ts` | 提供网页，接收消息并展示会话上下文 |
| `ctx.agent` | `agent-loop.ts` | 组织模型请求和工具调用，一轮成功后提交消息 |
| `ctx.model` | `deepseek.ts` | 请求 DeepSeek，保留工具 ID 和思考字段 |
| `ctx.sessions` | `memory-session.ts` | 创建独立的内存会话 |
| `ctx.tools` | `tools.ts` | 管理工具声明及执行，并随所属插件卸载撤销注册 |
| `ctx.files` | `workspace-files.ts` | 校验参数，解析相对路径和链接，检查目录边界 |

`list-dir.ts` 和 `read-file.ts` 分别向 `ctx.tools` 注册一个工具，共用 `ctx.files`。配置中的插件声明 `inject` 依赖，提供者可以出现在消费者之后。修改 profile 后重启生效。嵌入使用时，`loadProfile()` 返回插件句柄，可用 `mounts.get(配置中的路径).dispose()` 卸载单个插件，并用 `runtime.dispose()` 释放整个组合。

## 编写一个工具插件

在 profile 旁新建 `project-name.mjs`，把 `{ "plugin": "./project-name.mjs" }` 加入该 profile 的 `plugins` 数组。

```js
import path from 'node:path'

export const inject = ['tools', 'workspace']

export function apply(ctx) {
  ctx.tools.register({
    name: 'project_name',
    description: '返回当前项目目录的名称',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => path.basename(ctx.workspace),
  })
}
```

工具的参数说明和执行函数来自同一次注册。插件卸载时，两者同时移除。扩展事件用 `ctx.on('agent/tool-call', listener)`；监听器也随所属插件移除。所有插件作为本地 Node.js 模块执行，配置中应使用可信代码。

要替换模型、会话或 Agent 循环，将 profile 中对应条目的模块路径换成你的实现，并提供同名服务。服务的 TypeScript 接口在 `src/contracts.ts`。离线示例的 `examples/offline/model.ts` 演示了最小模型插件。默认文件读取上限为 32 KiB，目录列表上限为 200 项。Agent 循环的 `config.maxSteps` 控制单轮请求次数，默认 12。

## 验证

```powershell
npm.cmd run lint
npm.cmd run check
npm.cmd test
```

测试使用模拟 HTTP 模型与临时项目，覆盖网页多步读取、刷新恢复上下文、浏览器会话隔离、外部插件、配置禁用、卸载清理、失败回滚和文件访问边界。
