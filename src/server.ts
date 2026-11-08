import { fileURLToPath } from 'node:url'
import { modelEnvFile } from './model-env.ts'
import { loadProfile } from './profile.ts'

async function main() {
  try {
    process.loadEnvFile(modelEnvFile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // 配置文件选择要装配的插件，MINI_DSH_CWD 单独指定工具可以访问的项目。
  const defaultProfile = fileURLToPath(new URL('../profiles/default.json', import.meta.url))
  const runtime = await loadProfile(process.env.MINI_DSH_PROFILE || defaultProfile, process.env.MINI_DSH_CWD || '.')
  try {
    console.log(await runtime.ctx.app.start())
    const stop = () => { void runtime.dispose() }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
