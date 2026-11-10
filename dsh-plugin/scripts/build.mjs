// build = copy：本插件零 npm 依赖（只用 node 内置模块），无需 esbuild/TS 编译。
// 保持 lib/index.js 为构建产物合同，src/index.js 为唯一源。
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
mkdirSync(join(root, 'lib'), { recursive: true })
copyFileSync(join(root, 'src', 'index.ts'), join(root, 'lib', 'index.js'))
console.log('[gzh-agent] bundle ok: lib/index.js')
