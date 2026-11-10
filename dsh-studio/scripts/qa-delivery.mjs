// 主动送达回归：验证「候选清单自动进 DSH 对话」这条链路。
//   node scripts/qa-delivery.mjs
// 覆盖：官方 session.append(surfaceOp:'append') 姿势、flush、每日一次防重复、
//       时间窗、wake_model 走 agent.followup、无会话服务时降级不崩、手动 /gzh-push 绕过开关。
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const realCfg = join(process.env.GZH_STUDIO_HOME || './studio', 'config.json')
const slash = p => p.replace(/\\/g, '/')
const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const fails = []
const check = (cond, msg) => {
  if (!cond) fails.push(msg)
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
}

const CANDIDATES = [
  { title: 'AI 巡检把石化厂的成本账算清了', angle: '先算流程时间，再算人数', category: '商业趋势', reason: '有官方信源', source_url: 'https://example.com/a' },
  { title: '大模型从会回答到盯全程', angle: '产品形态变了，验收标准也得改', category: 'AI工具', reason: '有可靠信源', source_url: 'https://example.com/b' },
]

let importSeq = 0
async function makeHost(opts = {}) {
  const work = mkdtempSync(join(tmpdir(), 'gzh-delivery-'))
  const state = join(work, 'state')
  mkdirSync(state, { recursive: true })

  const base = JSON.parse(readFileSync(realCfg, 'utf8'))
  base.topic_scope.sources = []                 // tick 不该触发真实联网检索
  base.delivery = {
    enabled: opts.enabled !== false,
    at: opts.at || '00:00',
    max_per_day: opts.max_per_day || 1,
    wake_model: !!opts.wake_model,
  }
  writeFileSync(join(work, 'config.json'), JSON.stringify(base, null, 2), 'utf8')
  // 扫描标记为「刚扫过」，tick 只走补送分支，不跑 scanOnce
  writeFileSync(join(state, 'last_scan.json'), JSON.stringify({
    at: Date.now(), at_text: new Date().toISOString(), interval_hours: 24,
  }), 'utf8')
  writeFileSync(join(state, 'candidates.json'), JSON.stringify({
    date: localDay(), scanned: 25, deduped: 25, items: CANDIDATES, rejected_sources: 0,
  }, null, 2), 'utf8')

  // 模块顶层读 env，必须在 import 之前设好；带唯一 query 强制重新求值。
  process.env.GZH_STUDIO_HOME = slash(work)
  process.env.GZH_SCAN_ON_STARTUP = '0'

  const appended = [], flushed = [], followups = []
  const session = {
    id: 'sess-1',
    append: (type, data, opts2) => { appended.push({ type, data, opts: opts2 }); return { seq: appended.length } },
  }
  const services = {}
  if (opts.withSessions !== false) {
    services.sessions = {
      get: id => (id === 'sess-1' ? session : null),
      list: () => [session],
      flush: async s => { flushed.push(s?.id); return true },
    }
    services.agents = {
      get: id => (id === 'sess-1' ? { session, followup: m => followups.push(m) } : null),
    }
  }
  const commands = new Map()
  const logs = []
  let tick = null
  const ctx = {
    get: name => services[name],
    commands: { register: d => { commands.set(d.name, d); return () => commands.delete(d.name) } },
    setInterval: fn => { tick = fn; return () => { tick = null } },
    effect: fn => fn(),
    logger: {
      info: (...a) => logs.push(['info', ...a].join(' ')),
      error: (...a) => logs.push(['error', ...a].join(' ')),
    },
  }
  const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href + '?qa-delivery=' + (++importSeq))
  mod.apply(ctx)
  return {
    work, state, commands, mod, appended, flushed, followups, logs,
    tick: async () => { if (tick) await tick() },
    read: f => existsSync(join(state, f)) ? JSON.parse(readFileSync(join(state, f), 'utf8')) : null,
    writeCfg: patch => {
      const c = JSON.parse(readFileSync(join(work, 'config.json'), 'utf8'))
      Object.assign(c.delivery, patch)
      writeFileSync(join(work, 'config.json'), JSON.stringify(c, null, 2), 'utf8')
    },
  }
}

// ---------- H1：默认送达（只显示、不唤醒模型） ----------
const h1 = await makeHost()
check(h1.mod.inject.join(',') === 'commands,timer', '送达服务没有回灌 inject（仍是 commands,timer，不会 PENDING）')
check(h1.commands.size === 10 && h1.commands.has('gzh-push') && h1.commands.has('gzh-progress') && h1.commands.has('gzh-result') && h1.commands.has('gzh-gate'),
  '10 条命令注册，含 /gzh-push、/gzh-progress、/gzh-result、/gzh-gate')

const topics = await h1.commands.get('gzh-topics').handler({ agent: { session: { id: 'sess-1' } } })
check(topics.kind === 'success', '敲 /gzh-topics 仍正常返回清单')
check(h1.read('last_session.json')?.session_id === 'sess-1', '从 invocation.agent 记下目标会话 id')

const pushed = await h1.commands.get('gzh-push').handler({ agent: { session: { id: 'sess-1' } } })
check(pushed.kind === 'success' && /已把 2 条候选送进当前对话/.test(pushed.text), '/gzh-push 手动送达成功')
check(h1.appended.length === 1, 'session.append 被调用一次')
const ev = h1.appended[0]
check(ev?.type === 'user/message' && ev?.opts?.surfaceOp === 'append',
  "走官方姿势 session.append('user/message', …, {surfaceOp:'append'})")
check(ev?.data?.role === 'user' && typeof ev?.data?.id === 'string' && ev.data.id.length > 10,
  '消息带 role 与稳定的 id')
const text = ev?.data?.content?.[0]?.text || ''
check(text.includes(CANDIDATES[0].title) && text.includes(CANDIDATES[1].title), '送达文本含两条候选标题')
check(text.includes('/gzh-pick <编号>') && text.includes('不是用户指令'), '送达文本写清确认方式与「非用户指令」')
check(h1.flushed.includes('sess-1'), 'sessions.flush 持久化了会话')
check(h1.followups.length === 0, '默认不唤醒模型、不消耗 token')

const d1 = h1.read('delivery.json')
check(d1?.date === localDay() && d1?.count === 1 && d1?.candidates === 2, 'delivery.json 记录今日送达 1 次 / 2 条候选')
check(d1?.last_channel === 'session.append' && !d1?.last_error && d1?.session_id === 'sess-1',
  'delivery.json 记录通道与目标会话，无错误')

await h1.tick()
check(h1.appended.length === 1 && h1.read('delivery.json')?.count === 1,
  '同一天的定时 tick 不重复送达（每日一次）')

// 只有送达成功才计数：失败后下一轮要能重试
const future = new Date(Date.now() + 60 * 60_000)
if (future.getDate() === new Date().getDate()) {
  const atStr = `${String(future.getHours()).padStart(2, '0')}:${String(future.getMinutes()).padStart(2, '0')}`
  const hAt = await makeHost({ at: atStr })   // 独立实例验证时间窗
  await hAt.tick()
  check(hAt.appended.length === 0, `未到 delivery.at（${atStr}）时间窗时不送达`)
} else {
  check(true, '跨日边界跳过时间窗用例（不影响主链路）')
}

// ---------- H2：wake_model=true 走 agent.followup ----------
const h2 = await makeHost({ wake_model: true })
await h2.commands.get('gzh-topics').handler({ agent: { session: { id: 'sess-1' } } })
const p2 = await h2.commands.get('gzh-push').handler({ agent: { session: { id: 'sess-1' } } })
check(p2.kind === 'success' && h2.followups.length === 1 && h2.appended.length === 0,
  'wake_model=true 走 agent.followup（与 DSH Schedule 同款），不重复 append')
check(h2.read('delivery.json')?.last_channel === 'agent.followup', 'delivery.json 记录 followup 通道')
check(h2.flushed.length === 1, 'followup 之后同样 flush 持久化')

// ---------- H3：无会话服务时降级不崩 ----------
const h3 = await makeHost({ withSessions: false })
const p3 = await h3.commands.get('gzh-push').handler({ agent: { session: { id: 'sess-1' } } })
check(p3.kind === 'error' && /没能送达/.test(p3.text), '无 sessions 服务时 /gzh-push 给出可读错误，不抛栈')
check(!!h3.read('delivery.json')?.last_error, '失败原因写进 delivery.json（下一轮可重试）')
const t3 = await h3.commands.get('gzh-topics').handler({})
check(t3.kind === 'success' && t3.text.includes(CANDIDATES[0].title), '送达失败不影响 /gzh-topics 与候选文件')

// ---------- H4：关闭自动送达，手动 /gzh-push 仍可用 ----------
const h4 = await makeHost({ enabled: false })
const p4 = await h4.commands.get('gzh-push').handler({ agent: { session: { id: 'sess-1' } } })
check(p4.kind === 'success' && h4.appended.length === 1, '自动送达关闭时，用户手动 /gzh-push 仍然生效')
await h4.tick()
check(h4.appended.length === 1, '自动送达关闭后，定时 tick 不再推送')

console.log(`\n[qa-delivery] 汇总：${fails.length === 0 ? '全部通过' : fails.length + ' 项失败'}`)
for (const f of fails) console.log('  - ' + f)
process.exit(fails.length ? 1 : 0)
