import { Context, type Fiber } from '@deepseek-ai/cordis'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 按配置挂载插件。返回的 mounts 可单独卸载插件，dispose 则释放整套运行环境。 */
export async function loadProfile(filename: string, cwd: string) {
  const profile = JSON.parse(await readFile(filename, 'utf8'))
  if (!Array.isArray(profile?.plugins)) throw new Error('配置文件需要 plugins 数组')
  const workspace = await realpath(cwd)
  if (!(await stat(workspace)).isDirectory()) throw new Error('工作目录必须指向目录')

  const ctx = new Context()
  ctx.provide('workspace', workspace)
  const mounts = new Map<string, Fiber>()
  try {
    for (const row of profile.plugins) {
      if (!row || typeof row.plugin !== 'string' || !row.plugin.trim()) {
        throw new Error('每个插件配置都需要模块路径 plugin')
      }
      if (row.enabled === false) continue
      if (mounts.has(row.plugin)) throw new Error('重复挂载插件：' + row.plugin)
      // 插件路径以配置文件所在目录为基准，因此从其他工作目录启动也能找到同一个插件。
      const location = path.resolve(path.dirname(filename), row.plugin)
      const module = await import(pathToFileURL(location).href)
      mounts.set(row.plugin, ctx.plugin(module.default ?? module, row.config ?? {}))
    }

    // 后挂载的服务可能唤醒先前等待依赖的插件。只要还有生命周期任务，就继续等待。
    do {
      await Promise.all([...mounts.values()].map(fiber => fiber.await()))
    } while ([...mounts.values()].some(fiber => fiber.inertia))
    for (const [name, fiber] of mounts) {
      const missing = Object.keys(fiber.inject).filter(key => ctx.get(key) == null)
      if (missing.length) throw new Error(name + ' 缺少服务：' + missing.join(', '))
    }
    return { ctx, mounts, dispose: () => ctx.fiber.dispose() }
  } catch (error) {
    // 启动中途失败时，撤销此前已经完成的服务注册和资源分配。
    await ctx.fiber.dispose()
    throw error
  }
}
