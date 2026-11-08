import { Context, type Fiber } from './kernel.ts'
import { createHost } from './host.ts'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

type Row = { plugin: string; enabled?: boolean; config?: unknown }

export async function loadProfile(filename: string, cwd: string) {
  const profile = JSON.parse(await readFile(filename, 'utf8'))
  if (!Array.isArray(profile?.plugins)) throw new Error('配置文件需要 plugins 数组')
  const workspace = await realpath(cwd)
  if (!(await stat(workspace)).isDirectory()) throw new Error('工作目录必须指向目录')
  const rows = new Map<string, Row>()
  for (const row of profile.plugins) {
    if (typeof row?.plugin !== 'string' || !row.plugin.trim()) throw new Error('每个插件配置都需要模块路径 plugin')
    if (rows.has(row.plugin)) throw new Error('重复挂载插件：' + row.plugin)
    rows.set(row.plugin, row)
  }
  const ctx = new Context()
  const mounts = new Map<string, Fiber>()
  async function mount(row: Row) {
    const location = path.resolve(path.dirname(filename), row.plugin)
    const module = await import(pathToFileURL(location).href)
    mounts.set(row.plugin, ctx.plugin(module.default ?? module, row.config ?? {}))
  }

  // 提供者完成启动后可能唤醒已检查过的消费者，直到整批挂载都稳定再返回。
  async function settle() {
    do {
      await Promise.all([...mounts.values()].map(fiber => fiber.await()))
    } while ([...mounts.values()].some(f => f.state === 'loading' || f.state === 'unloading'))
  }
  function list() {
    return [...rows.keys()].map(plugin => {
      const fiber = mounts.get(plugin)
      return { plugin, enabled: !!fiber && fiber.state !== 'disposed', state: fiber?.state ?? 'disposed',
        missing: fiber?.inject.filter(key => ctx.get(key) == null) ?? [] }
    })
  }

  // 多个标签页共用同一组插件，按请求顺序完成挂载或卸载。
  let changes = Promise.resolve()
  function toggle(name: string, enabled: boolean) {
    const task = changes.then(async () => {
      // host 在调用前已按 list() 校验插件存在，这里直接取配置行。
      const row = rows.get(name)!
      const fiber = mounts.get(name)
      if (enabled && (!fiber || fiber.state === 'disposed')) {
        await mount(row)
        try { await settle() } catch (error) {
          await mounts.get(name)?.dispose()
          mounts.delete(name)
          throw error
        }
      } else if (!enabled && fiber) {
        await fiber.dispose()
        mounts.delete(name)
        await settle()
      }
    })
    changes = task.catch(() => {})
    return task
  }

  try {
    ctx.provide('workspace', workspace)
    ctx.provide('host', createHost(ctx, list, toggle))
    for (const row of rows.values()) if (row.enabled !== false) await mount(row)
    await settle()
    for (const row of list()) {
      if (row.enabled && row.missing.length) throw new Error(row.plugin + ' 缺少服务：' + row.missing.join(', '))
    }
    return { ctx, mounts, dispose: () => ctx.fiber.dispose() }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
