// 两个文件工具共用这份参数说明；实际调用时由 ctx.files.resolve 再校验路径。
export const pathParameter = {
  type: 'object',
  properties: { path: { type: 'string', description: '相对于工作目录的路径' } },
  required: ['path'],
  additionalProperties: false,
}
