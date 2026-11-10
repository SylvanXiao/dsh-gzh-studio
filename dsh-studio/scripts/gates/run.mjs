// 一致性门禁：pure 形态最小检查集。
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const fails = []

if (pkg.type !== 'module') fails.push('package.type 必须 module')
if (pkg.main !== 'lib/index.js') fails.push('package.main 必须 lib/index.js')
for (const k of ['.', './package.json', './cordis.patch.yml']) {
  if (!pkg.exports?.[k]) fails.push(`exports 缺 ${k}`)
}
if (!existsSync(join(root, 'lib', 'index.js'))) fails.push('lib/index.js 不存在，先 node scripts/build.mjs')
if (Object.keys(pkg.dependencies ?? {}).some(d => d.startsWith('@deepseek-ai/')))
  fails.push('禁止声明 @deepseek-ai/* 依赖（宿主包不可从插件位置解析）')
if (!pkg.name.match(/^[a-z][a-z0-9-]*$/)) fails.push('name 必须小写连字符')

const patchRel = pkg.dsh?.bundle?.patch
if (!patchRel) fails.push('缺 dsh.bundle.patch 声明，插件不会激活')
else if (!existsSync(join(root, patchRel))) fails.push(`patch 文件不存在：${patchRel}`)

if (existsSync(join(root, 'lib', 'index.js'))) {
  const lib = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  for (const m of lib.matchAll(/name:\s*['"]([^'"]+)['"]/g)) {
    if (/^(gzh-|内容|选题|生产)/.test(m[1]) && !/^[a-z][a-z0-9_-]*$/.test(m[1]))
      fails.push(`命令名不符合宿主约束：${m[1]}`)
  }
  if (!/export const inject\s*=/.test(lib)) fails.push('缺 export const inject 声明行')
  for (const key of ['commands', 'timer']) {
    if (!new RegExp(`inject\\s*=\\s*\\[[^\\]]*['"]${key}['"]`).test(lib)) fails.push(`inject 缺 ${key}`)
  }
  // llm 只能可选获取：一旦写进 inject，桌面端服务未就绪时整插件停在 PENDING，
  // apply 不执行 → 命令注册不上、定时扫描也不跑（2026-11-08 实测踩过）。
  if (/inject\s*=\s*\[[^\]]*['"](llm|sessions|agents)['"]/.test(lib))
    fails.push('禁止把 llm / sessions / agents 写进 inject：可选服务未就绪会让插件停在 PENDING')
  if (!/ctx\.get\(['"]llm['"]\)/.test(lib))
    fails.push('宿主模型必须走 ctx.get("llm") 可选获取')
  if (!/llm\.stream\(/.test(lib)) fails.push('未调用宿主模型 llm.stream（禁止内置第三方模型密钥）')
  if (/ctx\.llm\./.test(lib)) fails.push('残留 ctx.llm.* 直接访问，请改用 llmOf(ctx)')
  if (!/name:\s*['"]gzh-doctor['"]/.test(lib)) fails.push('缺 /gzh-doctor 自检命令')
  if (!/name:\s*['"]gzh-push['"]/.test(lib)) fails.push('缺 /gzh-push 手动送达命令')
  if (!/name:\s*['"]gzh-progress['"]/.test(lib)) fails.push('缺 /gzh-progress 进度回放命令')
  if (!/name:\s*['"]gzh-result['"]/.test(lib)) fails.push('缺 /gzh-result 结果补送命令')
  if (!/name:\s*['"]gzh-gate['"]/.test(lib)) fails.push('缺 /gzh-gate 读者四问人工门禁命令')
  if (!/reader_gate\.json/.test(lib)) fails.push('缺 reader_gate.json（门禁状态无法验收）')
  if (!/READER_QUESTIONS/.test(lib)) fails.push('缺读者四问定义 READER_QUESTIONS')
  if (!/gateEnabled\(/.test(lib)) fails.push('缺门禁开关 reader_gate.enabled')
  if (!/content_issues/.test(lib)) fails.push('缺内容层问题账 content_issues（fact.issues 又会被丢掉）')
  if (!/fact\?\.issues|fact\.issues/.test(lib)) fails.push('事实核查 issues 未落地到 pipeline.json')
  if (!/content_notes/.test(lib)) fails.push('未收 build.py 的内容层诊断 content_notes')
  if (!/deliverResult\(/.test(lib)) fails.push('缺生产结果主动送达 deliverResult')
  if (!/result\.json/.test(lib)) fails.push('缺 result.json（结果送达状态无法验收）')
  if (!/notify_on_finish/.test(lib)) fails.push('缺 notify_on_finish 开关（成功通知不能关闭）')
  // 生产进度必须走官方 replace surface 协议，不能只靠追加消息刷屏。
  if (!/op:\s*['"]replace['"]/.test(lib)) fails.push("缺 surfaceOp:{op:'replace'}（进度卡不能原地刷新）")
  if (!/sourceEventSeqs/.test(lib)) fails.push('replace 缺 sourceEventSeqs（surface 合同会拒绝 append）')
  if (!/ACTIVE_PROGRESS/.test(lib)) fails.push('模型流式输出未接进度卡 tick（看不到「已输出 N 字」）')
  if (!/progress\.json/.test(lib)) fails.push('缺 progress.json（进度状态无处验收）')
  if (!existsSync(join(root, 'scripts', 'qa-progress.mjs')))
    fails.push('缺生产进度回归 scripts/qa-progress.mjs')
  // 主动送达必须走官方 surface 姿势，且用可选服务获取，不能回灌 inject。
  if (!/surfaceOp:\s*['"]append['"]/.test(lib)) fails.push("缺 session.append 的 surfaceOp:'append'（清单进不了聊天区）")
  if (!/sessions\?\.flush\?\.\(/.test(lib) && !/sessions\.flush\(/.test(lib))
    fails.push('送达后缺 sessions.flush 持久化')
  if (!/last_session\.json/.test(lib)) fails.push('缺 last_session.json（记不住该往哪个会话推）')
  if (!/delivery\.json/.test(lib)) fails.push('缺 delivery.json（每日一次防重复会失效）')
  if (!existsSync(join(root, 'scripts', 'qa-delivery.mjs')))
    fails.push('缺主动送达回归 scripts/qa-delivery.mjs')
  if (!/check-batch/.test(lib)) fails.push('检索必须走批量查重 check-batch（禁止逐条起 Python）')
  if (!/acquireLock\(/.test(lib)) fails.push('缺并发锁 acquireLock')
  if (!/askJson\(/.test(lib)) fails.push('缺结构化模型重试 askJson')
  if (!/selfcheck\.json/.test(lib)) fails.push('缺启动自动自检 selfcheck.json')
  if (/sk-[A-Za-z0-9]{16,}/.test(lib)) fails.push('疑似硬编码密钥')
}

// R7：build.py 顶层输入读取必须落在 try 内，否则 execFile 拿到空 stdout / 非零退出码
const buildPy = join(root, 'studio', 'build.py')
if (existsSync(buildPy)) {
  const bp = readFileSync(buildPy, 'utf8')
  if (/^payload\s*=\s*json\.load\(open\(/m.test(bp) || /^cfg\s*=\s*json\.load\(open\(/m.test(bp))
    fails.push('build.py 顶层禁止直接读 payload/config（异常会抛栈且 stdout 无 JSON）')
  if (!/def _init\(/.test(bp)) fails.push('build.py 缺 _init() 输入初始化')
  if (!/^\s*_init\(\)\s*$/m.test(bp)) fails.push('build.py 的 try 里必须调用 _init()')
  if (!/def _fail\(/.test(bp)) fails.push('build.py 缺统一失败报告 _fail()')
  if (!/content_notes/.test(bp)) fails.push('build.py 未把体检内容层诊断收进 content_notes')
  if (!existsSync(join(root, 'scripts', 'qa-build.mjs'))) fails.push('缺 R7 失败路径回归 scripts/qa-build.mjs')
} else {
  fails.push('缺 studio/build.py')
}

// 内容层两项必须已经是真检查，不许退回 manual_flag / cross_article 空转。
const rulesMd = join(root, '..', 'rules', 'rules.md')
if (existsSync(rulesMd)) {
  const rr = readFileSync(rulesMd, 'utf8')
  if (!/check:\s*source_anchor/.test(rr)) fails.push('rules.md 的 source-required 不是真检查')
  if (!/check:\s*corpus_similarity/.test(rr)) fails.push('rules.md 的 ending-echo 不是真检查')
  if (!existsSync(join(root, '..', 'data', 'published', 'endings.md')))
    fails.push('缺结尾金句语料 data/published/endings.md（ending-echo 会标未生效）')
} else {
  fails.push('缺 rules/rules.md')
}
if (!existsSync(join(root, 'scripts', 'qa-gate.mjs')))
  fails.push('缺读者四问门禁回归 scripts/qa-gate.mjs')

if (fails.length) {
  console.error('[gates] FAIL:\n  ' + fails.join('\n  '))
  process.exit(1)
}
console.log('[gates] PASS: pure 形态合同检查通过')
