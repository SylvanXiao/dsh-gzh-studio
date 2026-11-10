// mock 宿主回归测试。
//   node scripts/mock-host.mjs            有 llm 服务：验证检索 → 模型筛选 → 候选清单
//   node scripts/mock-host.mjs --no-llm   无 llm 服务：验证插件仍能 ACTIVE、命令仍可注册（PENDING 回归）
// 关键回归点：把 llm 写进 inject 时，无 llm 的宿主会让插件停在 PENDING，
// 结果就是「命令敲不出来、自动扫描也从不运行」。这里锁死「无 llm 也必须激活」。
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const noLlm = process.argv.includes('--no-llm')
const slash = p => p.replace(/\\/g, '/')

const work = mkdtempSync(join(tmpdir(), 'gzh-studio-host-'))
const inbox = join(work, 'inbox.md')
writeFileSync(inbox,
  '- 某厂把 Agent 接进车间巡检流程 | https://example.com/a | 官方公告称巡检记录整理时间下降\n', 'utf8')
const realCfg = join(process.env.GZH_STUDIO_HOME || './studio', 'config.json')
const cfg = JSON.parse(readFileSync(realCfg, 'utf8'))
cfg.topic_scope.sources = [{ name: 'mock本地投喂', type: 'file', path: slash(inbox) }]
cfg.paths = { ...(cfg.paths || {}), workspace: slash(join(work, 'out')) }
writeFileSync(join(work, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8')

// 模块顶层读 env，必须在 import 之前设好
process.env.GZH_STUDIO_HOME = slash(work)
process.env.GZH_SCAN_ON_STARTUP = '0'

const commands = new Map()
const logs = []
const disposes = []
let timerCount = 0
let streamCalls = 0

const article = {
  hook: '巡检记录交给 Agent 之后，先变的是流程，不是人数。',
  titles: ['巡检记录被 Agent 接管之后', '车间里多了一个整理记录的同事', '把整理时间还给现场'],
  sections: [
    { h2: '一、入口变了', paras: ['官方公告里提到，巡检记录的整理时间有下降。这个变化落在记录环节，不落在人的去留上。', '过去整理靠人翻表格，现在入口先交给工具过一遍。'] },
    { h2: '二、成本结构跟着动', paras: ['整理时间省下来之后，现场的人能把注意力放回异常判断。', '这类提效通常先体现在等待时间上，通常未必马上体现在人数上。'] },
    { h2: '三、给产品的一道题', paras: ['工具接进流程，验收标准要跟着改，不然还是用老指标衡量新流程。', '把端到端耗时和异常漏检率放在一起看，比只看单环节耗时靠谱。'] },
  ],
  methodology: '给提效工具记两本账：省下的时间，和多出来的能力。只记第一本，容易把新流程看窄。',
  actions: ['先量一遍当前记录整理耗时', '把异常漏检率一起记进基线', '两周后回看端到端指标'],
  next: '下一篇拆验收标准怎么改。',
  sources: ['https://example.com/a（官方公告）'],
  gold: '效率工具的上限，常常卡在验收表上。',
}
const figs = { figs: [{ title: '记录整理链路', subtitle: '入口 → 整理 → 复核', items: [{ label: '记录入口' }, { label: '自动整理' }, { label: '人工复核' }], footer: '口径：官方公告，仅作示意' }] }

function mockText(options) {
  const u = options?.messages?.[0]?.content?.[0]?.text || ''
  if (u.includes('请筛出最多')) return { items: [{
    title: '巡检记录被 Agent 接管之后', angle: '从记录整理切到流程重排', category: 'AI工具',
    reason: 'AI 落地具体行业', source_url: 'https://example.com/a',
  }] }
  if (u.includes('请给 3 个公众号标题方案')) return { titles: article.titles }
  // 故意让事实核查报一条问题，验证 content_issues 真的落地（以前 issues 被直接丢掉）。
  if (u.includes('逐句检查这篇文章')) return {
    issues: ['测试：两处时间口径没标来源'], fixed_sections: article.sections,
  }
  if (u.includes('设计 ') || u.includes('信息图编辑')) return figs
  return article
}

const llm = noLlm ? null : {
  listProviders: () => [{ id: 'mock-provider' }],
  listModels: async () => [{ id: 'mock-model' }],
  stream: async function* (options) {
    streamCalls++
    yield { type: 'text-delta', index: 0, text: JSON.stringify(mockText(options)) }
    yield { type: 'finish', reason: 'stop' }
  },
}

// 会话服务：让送达与生产进度都能在 mock 宿主里跑通（真机走同一套官方 surface API）。
const surfaceEvents = []
let surfaceSeq = 0
const mockSession = {
  id: 'sess-mock',
  append: (type, data, opts) => {
    const ev = { type, data, opts, seq: surfaceSeq++ }
    surfaceEvents.push(ev)
    return ev
  },
}
const services = {
  llm,
  sessions: {
    get: () => mockSession,
    list: () => [mockSession],
    flush: async () => true,
  },
}

const ctx = {
  get: name => services[name],
  commands: { register: d => { commands.set(d.name, d); return () => commands.delete(d.name) } },
  setInterval: (fn, ms) => { const t = setInterval(fn, ms); timerCount++; return () => clearInterval(t) },
  effect: fn => { disposes.push(fn()); return () => {} },
  logger: {
    info: (...a) => logs.push(['info', ...a].join(' ')),
    error: (...a) => logs.push(['error', ...a].join(' ')),
  },
}

const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href + '?v=' + Date.now())
mod.apply(ctx)

const fails = []
const check = (cond, msg) => { if (!cond) fails.push(msg); console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`) }

check(mod.inject.join(',') === 'commands,timer', 'inject 只声明 commands/timer（llm 不阻塞加载）')
check(commands.size === 10, `10 条命令全部注册（实际 ${commands.size}：${[...commands.keys()].join(',')}）`)
check(timerCount === 1, '定时检查器已设置')
check(existsSync(join(work, 'state', 'plugin.json')), '写出加载标记 state/plugin.json')
const plugin = JSON.parse(readFileSync(join(work, 'state', 'plugin.json'), 'utf8'))
check(plugin.llm_at_load === !noLlm, `加载标记记录 llm 可用性 = ${!noLlm}`)

const doctor = await commands.get('gzh-doctor').handler({})
check(doctor.kind === 'success' && doctor.text.includes('已激活'), '/gzh-doctor 回显插件已激活')
check(noLlm ? doctor.text.includes('宿主模型：不可用') : doctor.text.includes('宿主模型：可用'),
  `/gzh-doctor 正确反映宿主模型${noLlm ? '不可用' : '可用'}`)

const config = await commands.get('gzh-config').handler({})
check(config.kind === 'success' && config.text.includes('选题范围'), '/gzh-config 可读配置')

if (!noLlm) {
  const scan = await commands.get('gzh-scan').handler({})
  check(scan.kind === 'success' && /候选 1 条/.test(scan.text), '/gzh-scan 检索并筛出 1 条候选')
  check(streamCalls >= 1, `宿主模型被调用 ${streamCalls} 次（走 ctx.get("llm")）`)
  const topics = await commands.get('gzh-topics').handler({})
  check(topics.kind === 'success' && topics.text.includes('巡检记录被 Agent 接管之后'), '/gzh-topics 能列出候选')
  check(existsSync(join(work, 'state', 'last_scan.json')), '手动扫描后写入 last_scan.json（避免自动重复扫）')
} else {
  const scan = await commands.get('gzh-scan').handler({})
  check(scan.kind === 'success', '/gzh-scan 在 llm 缺失时不崩溃（降级为 0 候选）')
  const topics = await commands.get('gzh-topics').handler({})
  check(topics.kind === 'success' || topics.kind === 'error', '/gzh-topics 在 llm 缺失时给出可读结果')
}

if (!noLlm && process.argv.includes('--full')) {
  mkdirSync(join(work, 'out'), { recursive: true })
  const picked = await commands.get('gzh-pick').handler({ rawInput: '1' })
  check(picked.kind === 'success', '/gzh-pick 1 启动全自动生产')
  const deadline = Date.now() + 180_000
  let state = null
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 800))
    const p = join(work, 'state', 'pipeline.json')
    if (existsSync(p)) {
      state = JSON.parse(readFileSync(p, 'utf8'))
      if (state.result) break
    }
  }
  check(!!state?.result, '生产流水线跑完（超时 180s）')
  check(state?.result?.pass === true, `成品校验通过（违规 ${state?.result?.review_violations} 项）`)
  const out = state?.result?.output
  check(!!out && existsSync(out), '成品 HTML 已落盘：' + (out || '-'))
  if (out && existsSync(out)) {
    const html = readFileSync(out, 'utf8')
    check(/src="data:image\//.test(html), '图片 base64 内嵌')
    check(!/<img[^>]+src="https?:/.test(html), '无远程图片')
  }
  // 真实流水线（非回放）也要边跑边刷新进度卡，并在成功后另发一条独立结果消息。
  let prog = null, res = null
  for (let i = 0; i < 20; i++) {
    const pp = join(work, 'state', 'progress.json'), rp = join(work, 'state', 'result.json')
    if (existsSync(pp)) prog = JSON.parse(readFileSync(pp, 'utf8'))
    if (existsSync(rp)) res = JSON.parse(readFileSync(rp, 'utf8'))
    if (prog?.steps && res?.delivered_at) break
    await new Promise(r => setTimeout(r, 250))
  }
  check(surfaceEvents.some(e => e.opts?.surfaceOp === 'append'), '会话里出现进度卡（surface append）')
  check(surfaceEvents.some(e => e.opts?.surfaceOp?.op === 'replace'), '阶段推进时进度卡原地刷新（surface replace）')
  check(!!prog && prog.steps >= 8 && prog.pass === true,
    `progress.json 记录 ${prog?.steps ?? 0} 个阶段、成品通过`)
  check(surfaceEvents.some(e => /成品已生成/.test(e.data?.content?.[0]?.text || '') && e.opts?.surfaceOp === 'append'),
    '生产成功后另发一条独立结果消息（不混在进度卡里）')
  check(!!res && res.pass === true && !res.last_error, 'result.json 记录成功结果已送达对话')

  // 内容层问题账 + 读者四问门禁：0 违规不能当成「可以直接发」。
  check(Array.isArray(state?.result?.content_issues) &&
    state.result.content_issues.some(x => /\[事实核查\] 测试：两处时间口径没标来源/.test(x)),
    '事实核查 issues 落地到 pipeline.json 的 content_issues')
  check(state?.result?.reader_gate?.status === 'pending', '新生产默认待读者四问人工放行')
  const resultMsgs = surfaceEvents.filter(e => e.opts?.surfaceOp === 'append')
    .map(e => e.data?.content?.[0]?.text || '')
  check(resultMsgs.some(t => /内容层问题：\d+ 项/.test(t)), '结果消息显示内容层问题数')
  check(resultMsgs.some(t => /读者四问：⚠ 待人工确认/.test(t)), '结果消息明确写出读者四问待确认')
  const gateCard = await commands.get('gzh-gate').handler({})
  check(gateCard.kind === 'success' && /能不能全自动运行/.test(gateCard.text), '/gzh-gate 可查看本次成品的四问')
}

for (const d of disposes) { if (typeof d === 'function') d() }
console.log('\n[mock-host] 临时目录：' + work)
if (logs.length) console.log('[mock-host] 宿主日志：\n  ' + logs.slice(0, 8).join('\n  '))
if (fails.length) { console.error(`\n[mock-host] FAIL ${fails.length} 项`); process.exit(1) }
console.log(`\n[mock-host] PASS（${noLlm ? '无 llm 降级场景' : '有 llm 全链路场景'}）`)
process.exit(0)
