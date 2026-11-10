// 读者四问人工门禁回归：0 违规不等于可发布。
//   node scripts/qa-gate.mjs
// 覆盖：门禁卡四问、缺答案/橡皮图章答案拦截、逐条回答放行、状态同步回 pipeline、
//       独立门禁消息送达、否定答案标需改稿、开关关闭、/gzh-status 与 /gzh-result 同步。
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const realCfg = join(process.env.GZH_STUDIO_HOME || './studio', 'config.json')
const slash = p => p.replace(/\\/g, '/')

const fails = []
const check = (cond, msg) => {
  if (!cond) fails.push(msg)
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
}

const STEPS = ['多个备选标题', '正文撰写', '重复度检测', '去 AI 味改写',
  '事实与逻辑核查', '结构与可读性优化', '配图规划', 'HTML 构建与规范校验']
const FINISHED = '2026-11-09T08:54:19.959Z'

let importSeq = 0
async function makeHost(opts = {}) {
  const work = mkdtempSync(join(tmpdir(), 'gzh-gate-'))
  const state = join(work, 'state')
  mkdirSync(state, { recursive: true })

  const base = JSON.parse(readFileSync(realCfg, 'utf8'))
  base.topic_scope.sources = []
  base.delivery = { enabled: false, at: '00:00', max_per_day: 1, wake_model: false }
  base.progress = { enabled: false, notify_on_finish: false }
  base.reader_gate = { ...(base.reader_gate || {}), enabled: opts.enabled !== false }
  writeFileSync(join(work, 'config.json'), JSON.stringify(base, null, 2), 'utf8')

  const result = {
    title: '两分半，它自己写完了一篇公众号', finished_at: FINISHED,
    output: './workspace/sample_output.html',
    pass: true, review_violations: 0, issues: [], body_similarity: 0.0814, stages: STEPS,
    content_issues: ['[事实核查] 两处时间口径没标来源', '[体检内容层] 1 段数字断言段内未标出处'],
    reader_gate: { status: opts.initialGate || 'pending', questions: [] },
  }
  writeFileSync(join(state, 'pipeline.json'), JSON.stringify({
    title: 'AI短剧开始冲双11业绩', log: STEPS.map(step => ({ step, status: 'done' })),
    content_issues: result.content_issues, result,
  }, null, 2), 'utf8')
  if (opts.savedGate) {
    writeFileSync(join(state, 'reader_gate.json'), JSON.stringify(opts.savedGate, null, 2), 'utf8')
  }

  process.env.GZH_STUDIO_HOME = slash(work)
  process.env.GZH_SCAN_ON_STARTUP = '0'

  const events = []
  let seqNo = 0
  const session = {
    id: 'sess-main',
    append: (type, data, o) => {
      const ev = { type, data, opts: o, seq: seqNo++ }
      events.push(ev)
      return ev
    },
  }
  const services = opts.withSessions === false ? {} : {
    sessions: {
      get: () => session, list: () => [session], flush: async () => true,
    },
  }
  const commands = new Map()
  const ctx = {
    get: name => services[name],
    commands: { register: d => { commands.set(d.name, d); return () => commands.delete(d.name) } },
    setInterval: () => () => {},
    effect: fn => fn(),
    logger: { info: () => {}, error: () => {} },
  }
  const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href + '?qa-gate=' + (++importSeq))
  mod.apply(ctx)
  return {
    work, state, commands, events,
    read: f => existsSync(join(state, f)) ? JSON.parse(readFileSync(join(state, f), 'utf8')) : null,
    call: (name, invocation = {}) => commands.get(name).handler(invocation),
  }
}

// H1：不带参数 → 门禁卡（四问 + 状态 + 内容层问题数）
const h1 = await makeHost()
const card = await h1.call('gzh-gate')
check(card.kind === 'success' && /读者四问人工门禁/.test(card.text), '/gzh-gate 不带参数返回门禁卡')
check(/待人工确认/.test(card.text) && /内容层问题 2 项/.test(card.text),
  '门禁卡显示「待人工确认」与内容层问题数')
for (const q of ['能不能全自动运行', '运行的结果怎么样', '我能不能用', '如何使用'])
  check(card.text.includes(q), `门禁卡含读者问题：${q}`)
check(/答1\|答2\|答3\|答4/.test(card.text), '门禁卡给出四问回答格式')

// H2：答案数量不足 / 橡皮图章答案都要拦
const h2 = await makeHost()
const short = await h2.call('gzh-gate', { rawInput: '能自动|有数据|能用' })
check(short.kind === 'error' && /需要 4 个答案/.test(short.text), '只答 3 问被拦下')
const rubber = await h2.call('gzh-gate', { rawInput: '通过|放行|ok|yes' })
check(rubber.kind === 'error' && /不算答案/.test(rubber.text), '「通过/放行/ok/yes」不算答案，门禁不是橡皮图章')
check(h2.read('reader_gate.json') === null, '被拦下时不会写放行状态')

// H3：逐条回答 → 放行 + 状态同步 + 独立消息
const h3 = await makeHost()
const ok = await h3.call('gzh-gate', {
  rawInput: '找素材到出成稿自动跑，开工要我敲一次 /gzh-pick 1|16:51 到 16:54，8 阶段 8/8、0 违规|要装 DSH 与 Python，不用 DSH 的人用不了|装插件后 /gzh-scan 看候选，再 /gzh-pick，最后 /gzh-gate 放行',
})
check(ok.kind === 'success' && /已人工放行/.test(ok.text), '四问逐条回答后放行')
const g3 = h3.read('reader_gate.json')
check(g3?.status === 'approved' && g3.finished_at === FINISHED, 'reader_gate.json 记 approved 且绑定本次生产')
check(Object.keys(g3?.answers || {}).length === 4, '四问答案逐条留痕')
check(h3.read('pipeline.json').result.reader_gate.status === 'approved', '放行状态同步回 pipeline.result')
check(h3.events.some(e => e.type === 'user/message' && /读者四问已人工放行/.test(e.data?.content?.[0]?.text || '') && e.opts?.surfaceOp === 'append'),
  '放行后另发一条独立门禁结果消息进对话')
check(h3.events.some(e => /发布按钮仍由人点/.test(e.data?.content?.[0]?.text || '')),
  '门禁消息明确：发布按钮仍由人点')
const status3 = await h3.call('gzh-status')
check(/读者四问：已人工放行/.test(status3.text), '/gzh-status 同步显示已人工放行')
const result3 = await h3.call('gzh-result')
check(result3.kind === 'success' && /内容层问题 2 项/.test(result3.text) && /已人工放行/.test(result3.text),
  '结果补送同时显示内容层问题数与门禁状态')

// H4：任一否定答案 → 需改稿，不放行
const h4 = await makeHost()
const neg = await h4.call('gzh-gate', {
  rawInput: '能自动跑完|给不出真实运行数据|不确定|按 /gzh-pick 开工',
})
check(neg.kind === 'success' && /需改稿/.test(neg.text), '答案含否定项时标记需改稿，命令本身不报错')
check(h4.read('reader_gate.json')?.status === 'needs_revision', 'reader_gate.json 记 needs_revision')
check(h4.events.some(e => /读者四问未通过/.test(e.data?.content?.[0]?.text || '')),
  '未通过也单独送一条门禁消息')

// H5：门禁关闭 / 无会话服务 / 没有成品 都不崩
const h5 = await makeHost({ enabled: false, initialGate: 'disabled' })
const cfg5 = await h5.call('gzh-config')
check(/读者四问门禁：已关闭/.test(cfg5.text), 'config 显示门禁已关闭')
const card5 = await h5.call('gzh-gate', { rawInput: '' })
check(card5.kind === 'success' && /已关闭/.test(card5.text), '门禁关闭时门禁卡仍可读')
const h6 = await makeHost({ withSessions: false })
const ok6 = await h6.call('gzh-gate', { rawInput: '自动跑|跑了 8 步|用 DSH 才行|敲 /gzh-pick' })
check(ok6.kind === 'success' && /没有可用会话服务/.test(ok6.text) && h6.read('reader_gate.json')?.status === 'approved',
  '无会话服务时放行状态照常落盘，送达降级不拖垮门禁')

// H6：旧成品（无门禁字段）也要能初始化门禁
const h7 = await makeHost({ savedGate: { finished_at: 'old-run', status: 'approved' } })
const card7 = await h7.call('gzh-gate')
check(/待人工确认/.test(card7.text), '旧放行状态不能沿用到新成品（按 finished_at 重新判定）')

if (fails.length) { console.error(`\n[qa-gate] FAIL ${fails.length} 项`); process.exit(1) }
console.log('\n[qa-gate] PASS：读者四问人工门禁全链路回归通过')
process.exit(0)
