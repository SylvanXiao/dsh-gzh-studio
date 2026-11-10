// build = copy：零 npm 依赖（只用 node 内置模块），无需编译器。
// src/index.ts 是纯 JS 语法（历史命名），copy 成 lib/index.js 即为产物。
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
mkdirSync(join(root, 'lib'), { recursive: true })
copyFileSync(join(root, 'src', 'index.ts'), join(root, 'lib', 'index.js'))
console.log('[gzh-studio] bundle ok: lib/index.js')
