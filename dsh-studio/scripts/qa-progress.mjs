// 生产进度回归：验证「像大模型那样在 DSH 对话里实时刷新同一条消息」。
//   node scripts/qa-progress.mjs
// 覆盖：官方 surfaceOp replace + sourceEventSeqs 链式引用、进度条从 0 到 100、
//       完成后直接给出成品、flush 持久化、替换失败降级 append、mode=append、
//       开关关闭 / 无会话服务不崩、invocation.agent.session 优先。
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

const STEPS = [
  '多个备选标题', '正文撰写', '重复度检测', '去 AI 味改写',
  '事实与逻辑核查', '结构与可读性优化', '配图规划', 'HTML 构建与规范校验',
]
const RESULT = {
  title: 'AI短剧冲双11：画质只是门槛，值钱的是可A/B测试的素材产能',
  output: './workspace/sample_output.html',
  pass: true, review_violations: 0, body_similarity: 0.0814, issues: [], stages: STEPS,
}

let importSeq = 0
async function makeHost(opts = {}) {
  const work = mkdtempSync(join(tmpdir(), 'gzh-progress-'))
  const state = join(work, 'state')
  mkdirSync(state, { recursive: true })

  const base = JSON.parse(readFileSync(realCfg, 'utf8'))
  base.topic_scope.sources = []
  base.delivery = { enabled: false, at: '00:00', max_per_day: 1, wake_model: false }
  base.progress = {
    enabled: opts.enabled !== false,
    mode: opts.mode || 'replace',
    stream_words: opts.stream_words !== false,
    throttle_ms: opts.throttle_ms || 2500,
    stream_chars: opts.stream_chars || 600,
  }
  writeFileSync(join(work, 'config.json'), JSON.stringify(base, null, 2), 'utf8')
  writeFileSync(join(state, 'pipeline.json'), JSON.stringify({
    title: 'AI短剧开始冲双11业绩：商业视频的成本结构正在被重算',
    log: STEPS.map((step, i) => ({
      step, at: new Date(Date.now() - (STEPS.length - i) * 30_000).toISOString(),
      status: 'done', note: i === 2 ? '近 14 天无重复，可入库' : '',
    })),
    result: RESULT,
  }, null, 2), 'utf8')

  process.env.GZH_STUDIO_HOME = slash(work)
  process.env.GZH_SCAN_ON_STARTUP = '0'

  const events = [], flushed = []
  let seqNo = 0
  const mkSession = id => ({
    id,
    append: (type, data, o) => {
      if (o?.surfaceOp?.op === 'replace') {
        if (opts.failReplace) throw new Error('mock host does not support replace')
        if (o.surfaceOp.startSeq >= seqNo || o.surfaceOp.endSeq >= seqNo)
          throw new Error('replace 必须引用更早的事件 seq')
        if (!Array.isArray(o.sourceEventSeqs) || !o.sourceEventSeqs.includes(o.surfaceOp.startSeq))
          throw new Error('replace 缺 sourceEventSeqs 完整覆盖')
      }
      const ev = { type, data, opts: o, seq: seqNo++ }
      events.push(ev)
      return ev
    },
  })
  const session = mkSession('sess-main')
  const direct = mkSession('sess-direct')
  const services = {}
  if (opts.withSessions !== false) {
    services.sessions = {
      get: id => (opts.noLookup ? null : id === 'sess-main' ? session : null),
      list: () => (opts.noLookup ? [] : [session]),
      flush: async s => { flushed.push(s?.id); return true },
    }
  }
  const commands = new Map()
  const logs = []
  const ctx = {
    get: name => services[name],
    commands: { register: d => { commands.set(d.name, d); return () => commands.delete(d.name) } },
    setInterval: () => () => {},
    effect: fn => fn(),
    logger: {
      info: (...a) => logs.push(['info', ...a].join(' ')),
      error: (...a) => logs.push(['error', ...a].join(' ')),
    },
  }
  const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href + '?qa-progress=' + (++importSeq))
  mod.apply(ctx)
  return {
    work, state, commands, mod, events, flushed, logs, direct,
    read: f => existsSync(join(state, f)) ? JSON.parse(readFileSync(join(state, f), 'utf8')) : null,
    call: (name, invocation = {}) => commands.get(name).handler(invocation),
  }
}

// ---------- H1：官方 replace 原地刷新 ----------
const h1 = await makeHost()
check(h1.mod.inject.join(',') === 'commands,timer', '进度服务没有回灌 inject（仍是 commands,timer）')
check(h1.commands.size === 10 && h1.commands.has('gzh-progress') && h1.commands.has('gzh-result') && h1.commands.has('gzh-gate'),
  '10 条命令注册，含 /gzh-progress、/gzh-result 与 /gzh-gate')
const r1 = await h1.call('gzh-progress', { agent: { session: { id: 'sess-main' } } })
check(r1.kind === 'success' && /已把上一次 8 个阶段回放/.test(r1.text), '/gzh-progress 回放成功')
check(h1.events.length > 0 && h1.events[0].type === 'user/message' && h1.events[0].opts.surfaceOp === 'append',
  '首次用 surfaceOp:append 建进度卡')
const replaceEvents = h1.events.slice(1)
check(replaceEvents.length > 0 && replaceEvents.every(e => e.opts?.surfaceOp?.op === 'replace'),
  `后续 ${replaceEvents.length} 次刷新全部走 surfaceOp:replace（同一条消息原地更新）`)
let chained = true
for (let i = 0; i < replaceEvents.length; i++) {
  const prev = h1.events[i].seq
  const op = replaceEvents[i].opts.surfaceOp
  if (op.startSeq !== prev || op.endSeq !== prev || !replaceEvents[i].opts.sourceEventSeqs.includes(prev)) chained = false
}
check(chained, '每次 replace 都引用上一条事件的 seq（startSeq/endSeq/sourceEventSeqs 链式正确）')

const firstText = h1.events[0].data.content[0].text
const lastText = h1.events[h1.events.length - 1].data.content[0].text
check(firstText.includes('⏳ gzh-studio · 正在生产') && firstText.includes('多个备选标题'),
  '进度卡首帧显示「正在生产」与阶段列表')
check(firstText.includes('░') && !/▓{15}/.test(firstText), '首帧进度条接近 0%')
check(lastText.includes('✅ gzh-studio · 生产完成') && lastText.includes(RESULT.output),
  '末帧显示「生产完成」并直接给出成品路径（不用再敲 /gzh-status）')
check(lastText.includes('规范违规 0 项') && lastText.includes('0.0814'), '末帧带上 14 项体检与相似度结果')
check(lastText.includes('不是用户指令'), '进度卡写明「不是用户指令」，避免模型误读')
check((lastText.match(/▓/g) || []).length >= 18, '末帧进度条接近 100%')
check(h1.flushed.length >= h1.events.length, '每次刷新都触发 sessions.flush 持久化')
const p1 = h1.read('progress.json')
check(p1?.steps === 8 && p1?.done === 8 && p1?.mode === 'replace' && p1?.pass === true,
  'progress.json 记录 8 步全完成 / replace 模式 / 成品通过')
check(p1?.appends === 1 && p1?.replaces > 0, `仅追加 1 次、原地替换 ${p1?.replaces} 次（不刷屏）`)

// ---------- H2：宿主不支持 replace 时降级 ----------
const h2 = await makeHost({ failReplace: true })
const r2 = await h2.call('gzh-progress', { agent: { session: { id: 'sess-main' } } })
check(r2.kind === 'success' && r2.text.includes('已降级为逐条追加'), 'replace 不可用时给出可读说明，不崩')
check(h2.events.length > 1 && h2.events.every(e => e.opts.surfaceOp === 'append'), '降级后全部改为逐条 append')
check(h2.read('progress.json')?.mode === 'append(降级)', 'progress.json 标记降级模式')

// ---------- H3：mode=append 配置 ----------
const h3 = await makeHost({ mode: 'append' })
await h3.call('gzh-progress', { agent: { session: { id: 'sess-main' } } })
check(h3.events.every(e => e.opts.surfaceOp === 'append'), 'progress.mode=append 时按配置逐阶段追加')
check(h3.read('progress.json')?.mode === 'append', 'progress.json 记录 append 模式')

// ---------- H4：关闭 / 无会话服务 ----------
const h4 = await makeHost({ enabled: false })
const r4 = await h4.call('gzh-progress', {})
check(r4.kind === 'error' && /进度卡未启用|没有可用的会话服务/.test(r4.text) && h4.events.length === 0,
  'progress.enabled=false 时不推送，命令给出可读提示')
const h5 = await makeHost({ withSessions: false })
const r5 = await h5.call('gzh-progress', {})
check(r5.kind === 'error' && h5.events.length === 0, '无 sessions 服务时静默降级，不抛栈')
const st5 = await h5.call('gzh-status', {})
check(st5.kind === 'success', '降级后 /gzh-status 仍可用')

// ---------- H6：命令自带 session 优先 ----------
const h6 = await makeHost({ noLookup: true })
const r6 = await h6.call('gzh-progress', { agent: { session: h6.direct } })
check(r6.kind === 'success' && h6.events.length > 0 && h6.flushed.every(id => id === 'sess-direct'),
  '优先用 invocation.agent.session 的真实对象，不依赖文件里的会话 id')

// ---------- H7：成功结果作为独立消息主动送达 ----------
const h7 = await makeHost()
const r7 = await h7.call('gzh-result', { agent: { session: { id: 'sess-main' } } })
check(r7.kind === 'success' && /已把上一次生产结果送进当前对话/.test(r7.text), '/gzh-result 把上次成功结果补送进对话')
const resultMsgs = h7.events.filter(e => /成品已生成/.test(e.data?.content?.[0]?.text || '') && e.opts?.surfaceOp === 'append')
check(resultMsgs.length === 1, '结果是一条独立的 append 消息，不是混在进度卡 replace 里')
const rt = resultMsgs[0]?.data?.content?.[0]?.text || ''
check(rt.includes(RESULT.output) && rt.includes('规范 0 项违规') && rt.includes('0.0814'),
  '结果消息含成品路径、14 项体检与相似度')
check(rt.includes('下一步：') && rt.includes('不是用户指令'), '结果消息含下一步操作与「非用户指令」声明')
check(rt.includes('已完成阶段：'), '结果消息列出已完成阶段')
const rs7 = h7.read('result.json')
check(rs7?.pass === true && rs7?.channel === 'session.append' && !!rs7?.delivered_at && !rs7?.last_error,
  'result.json 记录送达时间、通道、通过状态')
const r7b = await h7.call('gzh-result', { agent: { session: { id: 'sess-main' } } })
check(r7b.kind === 'success' && h7.events.filter(e => /成品已生成/.test(e.data?.content?.[0]?.text || '')).length === 2,
  '手动 /gzh-result 可重复补送（force 绕过「同一次只自动送一次」）')

// ---------- H8：无会话服务 / 没有结果时的降级 ----------
const h8 = await makeHost({ withSessions: false })
const r8 = await h8.call('gzh-result', {})
check(r8.kind === 'error' && /没能送达/.test(r8.text), '无会话服务时给可读错误，不抛栈')
const h9 = await makeHost()
writeFileSync(join(h9.state, 'pipeline.json'), JSON.stringify({ title: 'x', log: [] }), 'utf8')
const r9 = await h9.call('gzh-result', {})
check(r9.kind === 'error' && /还没有生产结果/.test(r9.text), '没有生产结果时给可读提示')

console.log(`\n[qa-progress] 汇总：${fails.length === 0 ? '全部通过' : fails.length + ' 项失败'}`)
for (const f of fails) console.log('  - ' + f)
process.exit(fails.length ? 1 : 0)
