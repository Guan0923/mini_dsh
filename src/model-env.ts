// 相对于项目源码定位，启动服务时的工作目录可以是其他项目。
export const modelEnvFile = new URL('../.env', import.meta.url)
