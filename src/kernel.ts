type Cleanup = () => void | Promise<void>
type Entry = (ctx: Context, config: never) => unknown
type Plugin = ({ apply: Entry } | (new (ctx: Context, config: never) => Service)) & { inject?: string[] }
type State = 'pending' | 'loading' | 'active' | 'unloading' | 'failed' | 'disposed'

/** 每个根 Context 有独立的服务表。提供者完成启动后，其服务才对消费者可见。 */
type Binding = { owner: Fiber; value: unknown }

class Registry {
  services = new Map<string, Binding>()
  fibers = new Set<Fiber>()

  refresh() {
    for (const fiber of this.fibers) fiber.activate()
  }
}

export class Fiber {
  readonly ctx: Context
  readonly registry: Registry
  readonly inject: string[]
  readonly parent?: Fiber
  private run?: () => unknown
  private children = new Set<Fiber>()
  readonly bindings = new Map<string, Binding>()
  private cleanups: Cleanup[] = []
  private loading?: Promise<void>
  private stopping?: Promise<void>
  private removed = false
  private error?: unknown
  state: State

  constructor(ctx: Context, registry: Registry, parent?: Fiber, plugin?: Plugin, config?: unknown) {
    this.ctx = ctx
    this.registry = registry
    this.parent = parent
    this.inject = plugin?.inject ?? []
    this.state = parent ? 'pending' : 'active'
    if (plugin) {
      this.run = () => {
        if (typeof plugin === 'function') return new plugin(ctx, config as never)
        return plugin.apply(ctx, config as never)
      }
      registry.fibers.add(this)
      parent?.children.add(this)
    }
  }

  /** 记录本次挂载创建的资源，手动释放与自动卸载共用同一个清理函数。 */
  effect(setup: () => Cleanup) {
    if (this.state !== 'active' && this.state !== 'loading') throw new Error('插件已停止')
    const cleanup = setup()
    const release = () => {
      const i = this.cleanups.indexOf(release)
      if (i < 0) return
      this.cleanups.splice(i, 1)
      return cleanup()
    }
    this.cleanups.push(release)
    return release
  }

  activate() {
    if (this.state !== 'pending' || this.removed) return
    const bindings = new Map<string, Binding>()
    for (const name of this.inject) {
      const binding = this.registry.services.get(name)
      if (binding?.owner.state !== 'active') return
      bindings.set(name, binding)
    }
    for (const [name, binding] of bindings) this.bindings.set(name, binding)
    this.state = 'loading'
    this.loading = Promise.resolve().then(async () => {
      if (this.state !== 'loading') return
      const cleanup = await this.run?.()
      if (typeof cleanup === 'function') this.cleanups.push(cleanup as Cleanup)
      if (this.state === 'loading') this.state = 'active'
    }).catch(error => {
      this.error = error
      void this.stop(false).catch(() => {})
    }).finally(() => {
      this.loading = undefined
      this.registry.refresh()
    })
  }

  async await() {
    while (this.loading || this.stopping) await (this.stopping ?? this.loading)
    if (this.state === 'failed') throw this.error
    return this
  }

  dispose() { return this.stop(true) }

  // 显式撤销单个服务时也要卸载它的消费者；消费者清理期间仍能访问旧服务。
  release(name: string, binding: Binding) {
    if (this.bindings.get(name) === binding) return this.stop(false)
  }

  /** 先让消费者停止，随后撤销自己的资源；依赖恢复时只重新激活仍挂载的 Fiber。 */
  private stop(remove: boolean): Promise<void> {
    this.removed ||= remove
    if (this.stopping) return this.stopping
    if (this.state === 'disposed') return Promise.resolve()
    this.state = 'unloading'
    this.stopping = Promise.resolve().then(async () => {
      const work = [...this.children].map(child => child.dispose())
      for (const fiber of this.registry.fibers) {
        if ([...fiber.bindings.values()].some(binding => binding.owner === this)) work.push(fiber.stop(false))
      }
      const errors = (await Promise.allSettled(work)).filter(result => result.status === 'rejected').map(result => result.reason)
      await this.loading
      for (const cleanup of [...this.cleanups].reverse()) {
        try { await cleanup() } catch (error) { errors.push(error) }
      }
      this.cleanups.length = 0
      this.bindings.clear()
      if (this.removed) {
        this.registry.fibers.delete(this)
        this.parent?.children.delete(this)
      }
      this.state = this.removed ? 'disposed' : this.error ? 'failed' : 'pending'
      if (errors.length) throw new AggregateError(errors, '插件清理失败')
    }).finally(() => {
      this.stopping = undefined
      this.registry.refresh()
    })
    return this.stopping
  }
}

export class Service {
  readonly ctx: Context
  constructor(ctx: Context, name: string) {
    this.ctx = ctx
    ctx.provide(name, this)
  }
}

export class Context {
  readonly fiber: Fiber
  private registry: Registry

  constructor(parent?: Context, plugin?: Plugin, config?: unknown) {
    this.registry = parent?.registry ?? new Registry()
    // 从调用方上下文读取服务，因此工具注册等副作用能归属于调用方 Fiber。
    const ctx = new Proxy(this, {
      get(target, key, receiver) {
        if (typeof key === 'string' && !(key in target)) return target.lookup(key, receiver)
        return Reflect.get(target, key, receiver)
      },
    })
    this.fiber = new Fiber(ctx, this.registry, parent?.fiber, plugin, config)
    return ctx
  }

  private lookup(name: string, caller: Context) {
    const committed = caller.fiber.bindings.get(name)
    const entry = committed ?? this.registry.services.get(name)
    if (!entry || (!committed && entry.owner.state !== 'active' && entry.owner !== caller.fiber)) return
    if (!(entry.value instanceof Service)) return entry.value
    return new Proxy(entry.value, {
      get(target, key, receiver) {
        return key === 'ctx' ? caller : Reflect.get(target, key, receiver)
      },
    })
  }

  get(name: string) { return this.lookup(name, this) }

  provide(name: string, value: unknown) {
    return this.effect(() => {
      if (this.registry.services.has(name)) throw new Error('重复服务：' + name)
      const binding = { owner: this.fiber, value }
      this.registry.services.set(name, binding)
      this.registry.refresh()
      return async () => {
        this.registry.services.delete(name)
        await Promise.all([...this.registry.fibers].map(fiber => fiber.release(name, binding)))
      }
    })
  }

  effect(setup: () => Cleanup) { return this.fiber.effect(setup) }

  plugin(plugin: Plugin, config: unknown = {}) {
    if (!['loading', 'active'].includes(this.fiber.state)) throw new Error('父插件已停止')
    const { fiber } = new Context(this, plugin, config)
    fiber.activate()
    // 句柄支持立即 dispose，也支持 await ctx.plugin() 等待异步启动。
    return new Proxy(fiber, {
      get(target, key) {
        if (key === 'then') return (resolve: (fiber: Fiber) => void, reject: (error: unknown) => void) => target.await().then(resolve, reject)
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as Fiber & PromiseLike<Fiber>
  }
}
