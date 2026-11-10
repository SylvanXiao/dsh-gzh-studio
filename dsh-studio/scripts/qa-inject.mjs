// 缺陷注入 / 边界回归（高级测试用）。运行：node scripts/qa-inject.mjs
// 每个场景用独立临时 STUDIO 与独立模块实例，互不污染；不碰真实选题库与真实文章目录。
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const lib = pathToFileURL(join(root, 'lib', 'index.js')).href
const slash = p => p.replace(/\\/g, '/')
const realCfg = join(process.env.GZH_STUDIO_HOME || './studio', 'config.json')
const realPy = 'python'
const badPy = 'C:/definitely/not/exists/python.exe'
const SOURCE = 'https://example.com/a'
let seq = 0
const results = []
const check = (scene, cond, msg) => { results.push({ scene, ok: !!cond, msg }); console.log(`${cond ? 'PASS' : 'FAIL'}  [${scene}] ${msg}`) }

function setup(opts = {}) {
  const work = mkdtempSync(join(tmpdir(), 'gzh-qa-'))
  const inbox = join(work, 'inbox.md')
  writeFileSync(inbox, `- 某厂把 Agent 接进车间巡检流程 | ${SOURCE} | 官方公告称巡检记录整理时间下降\n`, 'utf8')
  const cfg = JSON.parse(readFileSync(realCfg, 'utf8'))
  cfg.topic_scope.sources = [{ name: 'qa投喂', type: 'file', path: slash(inbox) }]
  cfg.paths = { ...cfg.paths, workspace: slash(join(work, 'out')) }
  if (opts.configPython) cfg.paths.python = opts.configPython
  writeFileSync(join(work, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8')
  mkdirSync(join(work, 'out'), { recursive: true })
  if (opts.stalePipeline || opts.staleLast || opts.freshLast) {
    mkdirSync(join(work, 'state'), { recursive: true })
  }
  if (opts.stalePipeline) {
    writeFileSync(join(work, 'state', 'pipeline.json'), JSON.stringify({
      title: '上次被中断的任务', log: [{ step: '正文撰写', status: 'running', at: '2026-11-07T00:00:00Z' }],
    }, null, 2), 'utf8')
  }
  if (opts.staleLast || opts.freshLast) {
    const hoursAgo = opts.staleLast ? 25 : 1
    const at = Date.now() - hoursAgo * 3600000
    writeFileSync(join(work, 'state', 'last_scan.json'), JSON.stringify({
      at, at_text: new Date(at).toISOString(),
    }, null, 2), 'utf8')
  }
  if (opts.lock) {
    mkdirSync(join(work, 'state'), { recursive: true })
    const at = opts.lock === 'stale' ? Date.now() - 31 * 60_000 : Date.now()
    writeFileSync(join(work, 'state', 'pipeline.lock'), JSON.stringify({
      pid: process.pid, title: '预置锁', at,
    }, null, 2), 'utf8')
  }
  process.env.GZH_STUDIO_HOME = slash(work)
  process.env.GZH_SCAN_ON_STARTUP = opts.startup ? '1' : '0'
  process.env.GZH_PYTHON = opts.python || realPy
  process.env.GZH_AGENT_HOME = opts.badHome
    ? slash(join(work, 'no-such-engine'))
    : './gzh-agent'
  return work
}

function makeCtx(reply, opts = {}) {
  const commands = new Map()
  const logs = []
  const llm = {
    listProviders: () => [{ id: 'qa-provider' }],
    listModels: async () => [{ id: 'qa-model' }],
    stream: async function* (options) {
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
      const u = options?.messages?.[0]?.content?.[0]?.text || ''
      yield { type: 'text-delta', index: 0, text: JSON.stringify(reply(u)) }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const ctx = {
    get: name => (name === 'llm' ? llm : undefined),
    commands: { register: d => { commands.set(d.name, d); return () => commands.delete(d.name) } },
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return () => clearInterval(t) },
    effect: fn => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    logger: { info: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
  }
  return { ctx, commands, logs }
}

async function scene(name, opts, body) {
  const work = setup(opts)
  const { ctx, commands, logs } = makeCtx(opts.reply || (() => ({ items: [] })), opts)
  const mod = await import(lib + '?qa=' + (++seq))
  mod.apply(ctx)
  const call = async (cmd, rawInput = '') => commands.get(cmd).handler({ rawInput })
  const readState = f => {
    const p = join(work, 'state', f)
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
  }
  try { await body({ work, call, readState, logs, mod, commands }) }
  catch (e) { check(name, false, '场景异常：' + e.message) }
}

const normal = u => u.includes('请筛出最多')
  ? { items: [{ title: '巡检记录被 Agent 接管之后', angle: '流程重排', category: 'AI工具', reason: '有信源', source_url: SOURCE }] }
  : { titles: ['标题'], sections: [{ h2: '一、', paras: ['正文'] }], hook: '钩子', methodology: '方法', actions: ['一步'], next: '', sources: [SOURCE], gold: '金句' }

// 1) 模型编造信源：候选必须拒绝非检索来源的 URL
await scene('D1-伪造信源', { reply: () => ({ items: [{
  title: '凭空编的选题', angle: '编的', category: 'AI工具', reason: '编的', source_url: 'https://evil.example/fake',
}] }) }, async ({ call, readState }) => {
  await call('gzh-scan')
  const s = readState('candidates.json')
  check('D1-伪造信源', !(s?.items || []).some(x => x.source_url.includes('evil.example')),
    `候选清单不得收录非检索来源 URL（实际收录 ${(s?.items || []).length} 条）`)
})

// 2) 上次生产被中断后，新任务必须仍可启动
await scene('D4-中断状态', { reply: normal, stalePipeline: true }, async ({ call }) => {
  await call('gzh-scan')
  const r = await call('gzh-pick', '1')
  check('D4-中断状态', r.kind === 'success', `/gzh-pick 不应被残留 running 状态永久拒绝（实际 ${r.kind}: ${r.text.slice(0, 60)}）`)
})

// 3) CLI 内核挂掉时，不能让未查重的候选照常入库且毫无提示
await scene('D12-CLI不可用', { reply: normal, badHome: true }, async ({ call, readState }) => {
  await call('gzh-scan')
  const s = readState('candidates.json')
  const silent = (s?.items || []).length > 0 && !s?.error
  check('D12-CLI不可用', !silent,
    `CLI 失败时应显性报错或拒绝产出候选（实际候选 ${(s?.items || []).length} 条、error=${s?.error || '无'}）`)
})

// 4) config.paths.python 声明了就必须被使用
await scene('D17-配置Python', { reply: normal, python: badPy, configPython: realPy }, async ({ call, readState }) => {
  await call('gzh-scan')
  const s = readState('candidates.json')
  check('D17-配置Python', s?.deduped === 1,
    `config.paths.python 应覆盖错误的 GZH_PYTHON，让查重照常工作（实际 deduped=${s?.deduped}，scanned=${s?.scanned}）`)
})

// 5) 命令边界：非法编号、越界编号、无清单、无任务
await scene('E-命令边界', { reply: normal }, async ({ call }) => {
  const t0 = await call('gzh-topics')
  check('E-命令边界', t0.kind === 'error' || /还没有清单|候选 0 条/.test(t0.text), '/gzh-topics 无清单时给可读提示')
  const s0 = await call('gzh-status')
  check('E-命令边界', s0.kind === 'error' || /还没有生产任务/.test(s0.text), '/gzh-status 无任务时给可读提示')
  for (const bad of ['0', 'abc', '-1', '99']) {
    const r = await call('gzh-pick', bad)
    check('E-命令边界', r.kind === 'error', `/gzh-pick ${bad} 应被拒绝`)
  }
  const doctor = await call('gzh-doctor')
  check('E-命令边界', doctor.kind === 'success' && doctor.text.includes('已激活'), '/gzh-doctor 返回激活状态')
})

// 6) 自动检索的「错过补跑」：25h 未扫要自动补，1h 内不该重复扫
await scene('A-错过补跑', { reply: normal, startup: true, staleLast: true }, async ({ readState }) => {
  // 启动补跑在 5s 后触发，内部还有若干次 CLI 子进程，轮询等它真正写完
  const deadline = Date.now() + 20_000
  let s = null
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 400))
    s = readState('candidates.json')
    if (s?.items?.length) break
  }
  check('A-错过补跑', !!s && (s.items || []).length === 1,
    `25h 未扫描时启动应自动补跑（实际候选 ${(s?.items || []).length} 条）`)
})
await scene('A-未到期不重扫', { reply: normal, startup: true, freshLast: true }, async ({ readState }) => {
  await new Promise(r => setTimeout(r, 7000))
  check('A-未到期不重扫', readState('candidates.json') === null,
    '1h 前刚扫过，启动后不应重复检索')
})

// 7) 并发锁：新鲜锁拒绝、陈旧锁自动清理、同时两次 pick 只启动一个
const badForPipeline = u => {
  if (u.includes('请筛出最多')) return { items: [{
    title: '巡检记录被 Agent 接管之后', angle: '流程重排', category: 'AI工具', reason: '有信源', source_url: SOURCE,
  }] }
  if (u.includes('请写完整正文') || u.includes('下面这段不是合法 JSON')) return 'NOT_JSON'
  return { titles: ['标题'], sections: [{ h2: '一、', paras: ['正文'] }], hook: '钩子',
    methodology: '方法', actions: ['一步'], sources: [SOURCE], gold: '金句' }
}
await scene('C-新鲜锁', { reply: badForPipeline, lock: 'fresh' }, async ({ call }) => {
  await call('gzh-scan')
  const r = await call('gzh-pick', '1')
  check('C-新鲜锁', r.kind === 'error' && r.text.includes('锁'), `新鲜锁应拒绝新生产（实际 ${r.kind}）`)
})
await scene('C-陈旧锁', { reply: badForPipeline, lock: 'stale' }, async ({ call }) => {
  await call('gzh-scan')
  const r = await call('gzh-pick', '1')
  check('C-陈旧锁', r.kind === 'success', `31 分钟前的陈旧锁应自动清理（实际 ${r.kind}: ${r.text.slice(0, 60)}）`)
})
await scene('C-并发', { reply: badForPipeline, delayMs: 800 }, async ({ call }) => {
  await call('gzh-scan')
  const rs = await Promise.all([call('gzh-pick', '1'), call('gzh-pick', '1')])
  const started = rs.filter(r => r.kind === 'success').length
  check('C-并发', started === 1, `同时两次 /gzh-pick 只能启动一个（实际启动 ${started} 个）`)
})

// 8) 结构化 JSON 重试 + 启动自动自检（建议 1/3）
let brokenTitleOnce = 0
const retryReply = u => {
  if (u.includes('请筛出最多')) return { items: [{
    title: '巡检记录被 Agent 接管之后', angle: '流程重排', category: 'AI工具', reason: '有信源', source_url: SOURCE,
  }] }
  if (u.includes('请给 3 个公众号标题方案')) { brokenTitleOnce++; return 'NOT_JSON' }
  if (u.includes('下面这段不是合法 JSON')) return { titles: ['修好的主标题', '备选二', '备选三'] }
  if (u.includes('逐句检查这篇文章')) return { issues: [], fixed_sections: normal('').sections }
  if (u.includes('设计 ') || u.includes('信息图编辑')) return { figs: [{
    title: '记录整理链路', subtitle: '入口 → 整理 → 复核',
    items: [{ label: '记录入口' }, { label: '自动整理' }, { label: '人工复核' }], footer: '口径：官方公告',
  }] }
  return normal('')
}
await scene('R-JSON重试', { reply: retryReply }, async ({ call, readState, logs }) => {
  brokenTitleOnce = 0
  await call('gzh-scan')
  await call('gzh-pick', '1')
  const deadline = Date.now() + 90_000
  let s = null
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500))
    s = readState('pipeline.json')
    if (s?.result) break
  }
  const note = (s?.log || []).find(x => x.step === '多个备选标题')?.note || ''
  check('R-JSON重试', note.includes('结构化重试'), `非法 JSON 应触发一次结构化重试（note=${note || '空'}）`)
  check('R-JSON重试', !!s?.result, '重试后流水线应继续跑完并写出结果')
  let sc = null
  const scDeadline = Date.now() + 12_000
  while (Date.now() < scDeadline) {
    sc = readState('selfcheck.json')
    if (sc?.plugin_active) break
    await new Promise(r => setTimeout(r, 300))
  }
  check('R-自检自动化', !!sc?.plugin_active,
    '启动 3 秒后自动写 state/selfcheck.json（无需敲命令）' + (sc ? '' : '；日志=' + logs.slice(-3).join(' | ')))
})

// 9) 无 llm 服务时仍必须 ACTIVE（PENDING 回归）
{
  const work = setup({})
  const commands = new Map()
  const ctx = {
    get: () => undefined,
    commands: { register: d => { commands.set(d.name, d) } },
    setInterval: () => () => {}, effect: fn => fn(),
    logger: { info() {}, error() {} },
  }
  const mod = await import(lib + '?qa=' + (++seq))
  mod.apply(ctx)
  check('E-无模型服务', commands.size === 10 && existsSync(join(work, 'state', 'plugin.json')),
    '无 llm 服务时 10 条命令仍注册、加载标记仍写出')
}

console.log('\n[qa-inject] 汇总：' + results.filter(r => r.ok).length + ' PASS / ' + results.filter(r => !r.ok).length + ' FAIL')
if (results.some(r => !r.ok)) {
  console.log('[qa-inject] 缺陷清单：')
  for (const r of results.filter(r => !r.ok)) console.log('  - [' + r.scene + '] ' + r.msg)
  process.exitCode = 1
}
