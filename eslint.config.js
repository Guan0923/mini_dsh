import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import html from 'eslint-plugin-html'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
  {
    files: ['**/*.{js,mjs,ts}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
  },
  {
    // 网页脚本运行在浏览器中，单独使用浏览器的全局变量。
    files: ['src/**/*.html'],
    plugins: { html },
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.browser },
  },
])
