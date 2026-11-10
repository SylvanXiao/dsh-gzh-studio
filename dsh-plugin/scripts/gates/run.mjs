// 一致性门禁：pure 形态最小检查集。
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url)))) // scripts/gates/run.mjs → 插件根
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const fails = []

const need = ['type:module', "main:lib/index.js"]
if (pkg.type !== 'module') fails.push('package.type 必须 module')
if (pkg.main !== 'lib/index.js') fails.push('package.main 必须 lib/index.js')
for (const k of ['.', './package.json']) {
  if (!pkg.exports?.[k]) fails.push(`exports 缺 ${k}`)
}
if (!existsSync(join(root, 'lib', 'index.js'))) fails.push('lib/index.js 不存在，先 pnpm run bundle')
if (Object.keys(pkg.dependencies ?? {}).some(d => d.startsWith('@deepseek-ai/')))
  fails.push('禁止声明 @deepseek-ai/* 依赖（宿主包不可从插件位置解析，2026-11-02 实机教训）')
if (!pkg.name.match(/^[a-z][a-z0-9-]*$/)) fails.push('name 必须小写连字符')

// 组合包合同（2026-11-02 实机：缺 dsh.bundle 声明只作普通依赖，宿主不激活）
const patchRel = pkg.dsh?.bundle?.patch
if (!patchRel) fails.push('缺 dsh.bundle.patch 声明，dsh plugin add 后不会激活')
else if (!existsSync(join(root, patchRel))) fails.push(`patch 文件不存在：${patchRel}`)

// 宿主命令名约束（COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u）
if (existsSync(join(root, 'lib', 'index.js'))) {
  const lib = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  for (const m of lib.matchAll(/name:\s*['"]([^'"]+)['"]/g)) {
    if (/^(gzh-|审稿|选题)/.test(m[1]) && !/^[a-z][a-z0-9_-]*$/.test(m[1]))
      fails.push(`命令名 "${m[1]}" 不符宿主 COMMAND_NAME（小写 ASCII），改用 ASCII 名+中文描述`)
  }
  // 2026-11-05 实机：ctx.setInterval 需 timer 服务，inject 必须同时含 commands 与 timer
  // 只认真实声明行，避免误匹配注释里的旧示例（2026-11-05 踩坑）
  const injectLine = (lib.match(/^export const inject\s*=\s*\[([^\]]+)\]/m) || [])[1] || ''
  if (!/['"]commands['"]/.test(injectLine))
    fails.push('必须 inject commands，否则 ctx.commands 不可访问（实机教训）')
  if (!/['"]timer['"]/.test(injectLine))
    fails.push('必须 inject timer，否则 ctx.setInterval 报 "cannot get property timer without inject"（2026-11-05 实机教训）')
}

if (fails.length) {
  console.error('[gates] FAIL\n  - ' + fails.join('\n  - '))
  process.exit(1)
}
console.log('[gates] PASS: pure 形态合同检查通过')
