// gzh-studio —— DSH 全自动内容生产插件（pure Cordis，零 npm 依赖）
//
// 宿主能力：
//   ctx.commands.register  命令（斜杠命令，名字只允许小写 ASCII）
//   ctx.setInterval        定时检查（须 inject timer）
//   ctx.get('llm')         宿主模型，可选获取。故意不写进 inject：DSH 里 inject 的服务
//                          未就绪时插件会一直停在 PENDING，apply 不执行、命令全注册不上、
//                          定时也不会跑。官方可选服务写法就是 ctx.get() 在使用处取。
//   ctx.logger             日志
//   ctx.get('sessions')    会话服务，可选获取；用于把候选清单主动送进 DSH 对话
//   ctx.get('agents')      活跃 Agent 注册表，可选获取；wake_model 时走官方 followup
//   invocation.agent       斜杠命令调用上下文，记录用户当前正在看的会话
//
// 送达链路：定时扫描 → state/candidates.json → session.append('user/message', …, {surfaceOp:'append'})
//           → ctx.sessions.flush() → 清单直接出现在 DSH 对话里。不唤醒模型、不消耗 token。
//           找不到会话服务时降级为「只写 state」，绝不拖垮扫描与命令。
//
// 确定性阶段交给 Python 内核（gzh-agent/gzh.py 查重与规范校验）与 studio/build.py
// （信息图渲染 / 封面匹配 / HTML 组装 / 一键复制）。模型只负责创作与判断。
//
// 流程：定时检索 → 候选清单（state/candidates.json）→ 用户确认编号
//       → 标题 → 正文 → 查重 → 去 AI 味 → 事实逻辑核查 → 结构优化
//       → 配图 → HTML 构建 → 规范校验（不合格自动回修）→ 成品路径回显
//
// 环境变量：
//   GZH_STUDIO_HOME   工作区配置目录（默认 ./studio）
//   GZH_AGENT_HOME    业务内核目录（默认 ./gzh-agent）
//   GZH_PYTHON        Python 解释器（默认 python）
//   GZH_SCAN_ON_STARTUP      启动后是否首扫（默认 1，设 0 关闭）
//   GZH_SCAN_INTERVAL_HOURS  定时扫描间隔小时（默认 24）

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, readdir, stat, rename, open, unlink } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const CommandDefinitionId = s => s

const HOME = process.env.GZH_AGENT_HOME || './gzh-agent'
const STUDIO = process.env.GZH_STUDIO_HOME || './studio'
let PYTHON = process.env.GZH_PYTHON || 'python'
let pythonChecked = false

// config.paths.python 是配置好的解释器；显式 GZH_PYTHON 优先，但只在该解释器确实可用时采用。
// 桌面端 Electron 启动的进程 PATH 常与终端不同，这里逐个探活再回退，避免整条链路静默失效。
async function ensurePython(ctx, cfg) {
  if (pythonChecked) return
  pythonChecked = true
  const tries = [PYTHON, cfg?.paths?.python, 'python'].filter((v, i, a) => v && a.indexOf(v) === i)
  for (const candidate of tries) {
    try {
      await run(candidate, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 8_000 })
      PYTHON = candidate
      return
    } catch { /* 试下一个 */ }
  }
  ctx.logger.error('[gzh-studio] 没有可用的 Python 解释器：选题查重与 HTML 构建会失败')
}
const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const STATE = join(STUDIO, 'state')
const DRAFTS = join(STUDIO, 'drafts')
const LAST_SESSION = join(STATE, 'last_session.json')
const DELIVERY_STATE = join(STATE, 'delivery.json')
const RESULT_STATE = join(STATE, 'result.json')
const PROGRESS_STATE = join(STATE, 'progress.json')
const CANDIDATES = join(STATE, 'candidates.json')
const GATE_STATE = join(STATE, 'reader_gate.json')

// 读者四问（2026-11-09 定规）：14 项 0 违规只证明形式层合格。
// 第 4 篇返工三次，机器全绿但读者没兴趣——成稿必须经人回答这四问才算放行。
const READER_QUESTIONS = [
  '能不能全自动运行？哪几段自己跑、哪一步还得人按，一次说清。',
  '运行的结果怎么样？给一次真实运行的数据，不要只给形容词。',
  '这个插件我能不能用？门槛、依赖、什么人用不上，写清楚。',
  '如何使用？从装好到出稿，给能照做的步骤顺序。',
]
const NEGATIVE_ANSWER = /^(否|不|没有|没|不确定|不知道|不行|待定|未写|没写|说不清)[。.!！]?$/
const gateEnabled = cfg => cfg?.reader_gate?.enabled !== false
// config.json 里的 reader_gate.questions 是唯一可改口径；缺省或不成 4 条时回退到内置四问。
const gateQuestions = cfg => {
  const q = cfg?.reader_gate?.questions
  return Array.isArray(q) && q.length === 4 && q.every(x => typeof x === 'string' && x.trim())
    ? q : READER_QUESTIONS
}
const gateLabel = s => ({ approved: '已人工放行', needs_revision: '有否定答案，需改稿', disabled: '已关闭' }[s] || '待人工确认')

export const name = 'gzh-studio'
// 只声明一定就绪的两个服务。llm 用 ctx.get('llm') 按需取，避免整个插件因 llm 未就绪而 PENDING。
export const inject = ['commands', 'timer']

const ok = text => ({ kind: 'success', text })
const err = text => ({ kind: 'error', text })
// 本机日期（上海 UTC+8）。候选 / 送达都按本地日算，避免凌晨用 toISOString() 落到昨天。
const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const STALE_MS = 30 * 60_000   // 超过 30 分钟没推进的生产任务视为上次宿主退出时中断
const LOCK = join(STATE, 'pipeline.lock')

async function loadCfg(ctx) {
  try {
    const cfg = JSON.parse(await readFile(join(STUDIO, 'config.json'), 'utf8'))
    await ensurePython(ctx, cfg)
    return cfg
  } catch (e) {
    ctx.logger.error('[gzh-studio] 配置读取失败', e.message)
    return null
  }
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}
async function writeJson(path, data) {
  // 原子写：先写同目录临时文件再 rename，避免并发读状态时读到半截 JSON。
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await rename(tmp, path)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}

// 独占创建锁文件；陈旧锁（超过 STALE_MS）自动清理一次，防宿主崩溃后死锁。
async function acquireLock(title) {
  const payload = JSON.stringify({ pid: process.pid, title, at: Date.now() }, null, 2)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(LOCK, 'wx')
      try { await fh.writeFile(payload, 'utf8') } finally { await fh.close() }
      return true
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const s = await readJson(LOCK, null)
      const stale = !s || Date.now() - (s.at || 0) > STALE_MS
      if (!stale) return false
      await unlink(LOCK).catch(() => {})
    }
  }
  return false
}
async function releaseLock() { await unlink(LOCK).catch(() => {}) }

async function cli(args) {
  try {
    const r = await run(PYTHON, ['gzh.py', ...args], {
      cwd: HOME, encoding: 'utf8', windowsHide: true, timeout: 120_000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    return (r.stdout || '').trim()
  } catch (e) {
    return 'CLI_ERROR: ' + ((e.stdout || '') + (e.stderr || '') + e.message).slice(0, 600)
  }
}

// 一次进程完成全部素材查重（内核 topics check-batch）。失败直接抛，绝不静默跳过查重。
async function batchCheck(items, days) {
  const tmp = join(STATE, '_batch_titles.json')
  await writeJson(tmp, items.map(x => x.title))
  const r = await cli(['topics', 'check-batch', '--file', tmp, '--days', String(days)])
  if (r.startsWith('CLI_ERROR')) throw new Error('批量查重失败：' + r.slice(0, 200))
  const parsed = asJson(r)
  if (!parsed || parsed.error || !Array.isArray(parsed.results))
    throw new Error('批量查重返回不可解析：' + String(parsed?.error || r).slice(0, 200))
  if (parsed.results.length !== items.length)
    throw new Error(`批量查重结果条数不符：${parsed.results.length} / ${items.length}`)
  return items.filter((_, i) => !parsed.results[i].duplicate)
}

// ---------- 宿主模型调用（可选服务，不注入 inject） ----------

// 官方可选服务写法：使用处 ctx.get('llm')。缺失时返回 null，由调用方给出可读错误，
// 而不是让插件停在 PENDING、连 /gzh-doctor 都敲不出来。
function llmOf(ctx) {
  try { return typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm }
  catch { return null }
}

const LLM_MISSING = '宿主 LLM 服务暂不可用。插件本身已激活，但生成候选/正文需要 DSH 的 llm 服务就绪；敲 /gzh-doctor 看当前状态。'

async function pickLlm(ctx, cfg) {
  const llm = llmOf(ctx)
  if (!llm) throw new Error(LLM_MISSING)
  const given = cfg?.llm || {}
  let provider = given.provider
  if (!provider) {
    try {
      const ps = llm.listProviders()
      provider = ps[0]?.id || ps[0]?.name || 'deepseek-account'
    } catch { provider = 'deepseek-account' }
  }
  let model = given.model
  if (!model) {
    try {
      const ms = await llm.listModels(provider)
      model = ms[0]?.id || ms[0]?.name || 'deepseek-flash'
    } catch { model = 'deepseek-flash' }
  }
  return { provider, model, maxTokens: given.max_tokens || 6000, temperature: given.temperature ?? 0.7 }
}

// 一次完整的模型调用；只收集 text-delta，忽略推理块与 usage。
async function ask(ctx, cfg, system, user, maxTokens) {
  const llm = llmOf(ctx)
  if (!llm) throw new Error(LLM_MISSING)
  const { provider, model, temperature } = await pickLlm(ctx, cfg)
  let text = ''
  const options = {
    provider, model, system, temperature,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens: maxTokens || (cfg?.llm?.max_tokens || 6000),
  }
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') {
      const delta = String(chunk.text || '')
      text += delta
      // 模型在写正文时，进度卡的「已输出 N 字」会跟着涨，像大模型的流式过程。
      if (ACTIVE_PROGRESS) ACTIVE_PROGRESS.tick(delta.length)
    }
    else if (chunk.type === 'finish' && chunk.reason === 'error') throw new Error('宿主模型调用失败：' + chunk.reason)
  }
  return text.trim()
}

// 容错解析模型返回的 JSON（剥掉代码围栏、截取首尾大括号）
function asJson(text) {
  let s = text.replace(/```(?:json)?/gi, '').trim()
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a < 0 || b <= a) {
    const c = s.indexOf('['), d = s.lastIndexOf(']')
    if (c >= 0 && d > c) s = s.slice(c, d + 1)
  } else s = s.slice(a, b + 1)
  try { return JSON.parse(s) } catch { return null }
}

// 结构化模型调用：首次输出不可解析或缺关键字段时，让模型只修格式重试一次。
// 仍失败则按 fallback 决定「降级并写 note」或抛错，绝不静默沿用上一阶段草稿。
async function askJson(ctx, cfg, system, user, maxTokens, label, requiredKey, fallback) {
  const raw = await ask(ctx, cfg, system, user, maxTokens)
  const first = asJson(raw)
  if (first && (!requiredKey || first[requiredKey] !== undefined)) return { data: first, note: '' }
  const repair = await ask(ctx, cfg,
    '你是 JSON 格式修复器。只输出一个合法 JSON 对象，不要解释、不要代码围栏、不要 markdown。',
    `下面这段不是合法 JSON（或缺少字段 ${requiredKey || '结构'}）。只修格式、补上该字段，内容原样保留：\n` +
    String(raw).slice(0, 6000), maxTokens)
  const second = asJson(repair)
  if (second && (!requiredKey || second[requiredKey] !== undefined))
    return { data: second, note: `${label}：首次输出不可解析，已结构化重试一次` }
  if (fallback !== undefined) {
    ctx.logger.error(`[gzh-studio] ${label}：两次输出均不可用，降级沿用上一版本`)
    return { data: fallback, note: `${label}：两次输出均不可用，已降级沿用上一版本` }
  }
  throw new Error(`${label}：两次输出都不是合法 JSON（缺 ${requiredKey || '结构'}）`)
}

// ---------- 检索源 ----------

function rssItems(xml, limit) {
  const out = []
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/\1>/gi) || []
  for (const b of blocks.slice(0, limit)) {
    const pick = tag => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim() : ''
    }
    const link = (b.match(/<link[^>]*href=["']([^"']+)["']/i) || b.match(/<link[^>]*>([^<]+)</i) || [])[1] || ''
    const title = pick('title')
    if (title) out.push({ title, url: link, summary: pick('description') || pick('summary') })
  }
  return out
}

async function fetchSources(ctx, cfg) {
  const sources = cfg.topic_scope.sources || []
  const collected = []
  for (const src of sources) {
    try {
      if (src.type === 'file') {
        const raw = await readFile(src.path, 'utf8')
        for (const line of raw.split(/\r?\n/)) {
          const m = line.trim().match(/^[-*]\s*(.+?)\s*[|｜]\s*(\S+)\s*[|｜]\s*(.*)$/)
          if (m) collected.push({ title: m[1].trim(), url: m[2].trim(), summary: m[3].trim(), source: src.name })
        }
      } else if (src.type === 'rss' || src.type === 'url') {
        const r = await fetch(src.url, { signal: AbortSignal.timeout(src.timeout_ms || 12000) })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const xml = await r.text()
        for (const it of rssItems(xml, src.limit || 20))
          collected.push({ ...it, source: src.name })
      }
    } catch (e) {
      ctx.logger.error('[gzh-studio] 检索源失败 ' + src.name, e.message)
    }
  }
  return collected
}

// ---------- 每日检索 + 筛选 ----------

function scopePrompt(cfg) {
  const s = cfg.topic_scope
  return [
    '你在为微信公众号「' + s.account + '」做选题初筛。',
    '账号定位：' + s.positioning,
    '优先方向：' + s.focus.join('；'),
    '必须排除：' + s.exclude.join('；'),
    '可选类别：' + s.categories.join('、'),
  ].join('\n')
}

async function scanOnce(ctx, cfg) {
  // 内核不可用时直接停手。否则逐条查重全部失败，候选会绕过查重照常产出，用户毫无察觉。
  const probe = await cli(['topics', 'list'])
  if (probe.startsWith('CLI_ERROR')) {
    const msg = '选题库内核不可用，本次不生成候选（避免跳过查重）：' + probe.slice(0, 200)
    ctx.logger.error('[gzh-studio] ' + msg)
    await writeJson(join(STATE, 'candidates.json'), {
      date: localDay(), scanned: 0, deduped: 0, items: [], error: msg,
    })
    return
  }
  const items = await fetchSources(ctx, cfg)
  if (!items.length) {
    ctx.logger.error('[gzh-studio] 所有检索源均不可用，本次不生成候选（禁止模型编造选题）')
    await writeJson(join(STATE, 'candidates.json'), {
      date: localDay(), items: [],
      error: '检索源不可用，未生成候选。检查 config.json 的 topic_scope.sources，或往 inbox 手工投喂素材。',
    })
    return
  }
  // 一次进程批量查重（旧实现逐条起 Python，20 条素材约 8s）；失败就停手，不跳过查重。
  let deduped = []
  try {
    deduped = await batchCheck(items, cfg.topic_scope.dedup_days || 14)
  } catch (e) {
    const msg = '批量查重失败，本次不生成候选（避免跳过查重）：' + e.message
    ctx.logger.error('[gzh-studio] ' + msg)
    await writeJson(join(STATE, 'candidates.json'), {
      date: localDay(), scanned: items.length, deduped: 0, items: [], error: msg,
    })
    return
  }
  const n = cfg.topic_scope.candidates_per_run || 6
  const system = scopePrompt(cfg) + '\n只输出 JSON，不要解释。'
  const user = '以下是今日检索到的原始条目（JSON）：\n' + JSON.stringify(deduped.slice(0, 60)) +
    '\n\n请筛出最多 ' + n + ' 条符合范围的候选，按值得写的程度排序。输出格式：' +
    '{"items":[{"title":"候选题（可直接当标题用）","angle":"一句话切入角度，要有产品判断","category":"可选类别之一","reason":"为什么符合范围，一句话","source_url":"原文链接"}]}' +
    '\n硬性要求：source_url 必须来自上面给出的条目，不许凭空生成；无法核实的条目直接丢弃。'
  // 信源必须能指回检索条目。prompt 约束不算数，代码层再兜一次，防止模型编造 URL。
  const allowed = new Set(deduped.map(x => x.url).filter(Boolean))
  let picked = []
  let rejected = 0
  let warning = ''
  try {
    const res = await askJson(ctx, cfg, system, user, 2500, '候选筛选', 'items', { items: [] })
    warning = res.note
    const rawPicked = (res.data?.items || []).filter(x => x.title && x.source_url)
    const valid = rawPicked.filter(x => allowed.has(x.source_url))
    rejected = rawPicked.length - valid.length
    picked = valid.slice(0, n)
    if (rejected) ctx.logger.error(`[gzh-studio] 丢弃 ${rejected} 条信源不在检索结果中的候选（禁止模型编造出处）`)
  } catch (e) {
    warning = '模型筛选失败：' + e.message
    ctx.logger.error('[gzh-studio] ' + warning)
  }
  await writeJson(join(STATE, 'candidates.json'), {
    date: localDay(),
    scanned: items.length, deduped: deduped.length, items: picked, rejected_sources: rejected,
    ...(warning ? { warning } : {}),
  })
  ctx.logger.info(`[gzh-studio] 每日检索完成：原始 ${items.length} 条，查重后 ${deduped.length} 条，候选 ${picked.length} 条`)
}

// ---------- 全自动生产流水线 ----------

function contentSpecPrompt(cfg) {
  const c = cfg.content_spec
  return [
    scopePrompt(cfg),
    '作者视角：' + c.voice,
    '立场：' + c.stance,
    '结构：全文 ' + c.structure.word_count.join('-') + ' 字；' + c.structure.sections.join(' → ') +
      '；行动栏目名固定「' + c.structure.action_column_name + '」；禁用栏目名：' + c.structure.action_column_ban.join('、'),
    '去 AI 味：破折号「——」≤' + c.deai.dash_max + '；加粗金句 ≤' + c.deai.bold_max +
      '；避免 ' + c.deai.avoid.join('；') + '；禁用绝对词 ' + c.deai.absolutes_ban.join('、') +
      '（改写成 ' + c.deai.absolutes_soften_to.join('、') + '）',
    '事实：' + c.facts.rule + '；禁止 ' + c.facts.forbid.join('；'),
    '篇间衔接只用：' + c.structure.series_link_words.join(' / ') + '；禁用：' + c.structure.series_link_ban.join(' / '),
  ].join('\n')
}

function figHtml(spec) {
  // 暖米底 + 深蓝/橙扁平矢量；真图示（横条/卡片），不用项目符号清单
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const items = (spec.items || []).slice(0, 4)
  const bars = items.map((it, i) => {
    const y = 118 + i * 52
    const w = Math.max(90, 300 - i * 32)
    return `<rect x="40" y="${y}" width="${w}" height="34" rx="8" fill="${i === 1 ? '#e08a3c' : '#2f3c4d'}"/>` +
      `<circle cx="62" cy="${y + 17}" r="11" fill="${i === 1 ? '#e08a3c' : '#2f3c4d'}" stroke="#f4e9d5" stroke-width="2"/>` +
      `<text x="62" y="${y + 21.5}" text-anchor="middle" font-size="11" font-weight="bold" fill="#fdf6ea">${i + 1}</text>` +
      `<text x="82" y="${y + 21.5}" font-size="12.5" font-weight="bold" fill="#fdf6ea">${esc(it.label)}</text>`
  }).join('')
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}</style></head><body>` +
    `<svg width="540" height="360" viewBox="0 0 540 360" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="540" height="360" fill="#f4e9d5"/>` +
    `<text x="270" y="46" text-anchor="middle" font-family="'Microsoft YaHei','PingFang SC',sans-serif" font-size="20" font-weight="bold" fill="#2f3c4d">${esc(spec.title)}</text>` +
    `<text x="270" y="68" text-anchor="middle" font-family="'Microsoft YaHei','PingFang SC',sans-serif" font-size="11.5" fill="#8a7a63">${esc(spec.subtitle || '')}</text>` +
    bars +
    `<line x1="40" y1="332" x2="500" y2="332" stroke="#c9b694" stroke-width="2" stroke-dasharray="1,6" stroke-linecap="round"/>` +
    `<text x="270" y="350" text-anchor="middle" font-family="'Microsoft YaHei','PingFang SC',sans-serif" font-size="9.5" fill="#8a7a63">${esc(spec.footer || '')}</text>` +
    `</svg></body></html>`
}

async function chooseCover(ctx, cfg, category, title) {
  const imgs = cfg.content_spec.images || {}
  const dirs = imgs.local_library_dirs || []
  const words = (imgs.category_keywords || {})[category] || []
  for (const d of dirs) {
    try {
      const files = await readdir(d)
      const jpgs = files.filter(f => /\.(jpe?g|png)$/i.test(f))
      const hit = jpgs.find(f => words.some(w => f.includes(w))) || jpgs.find(f => f.includes('封面'))
      if (hit) return join(d, hit)
    } catch (e) { ctx.logger.error('[gzh-studio] 图库读取失败', d + ' ' + e.message) }
  }
  return ''
}

async function pipeline(ctx, cfg, pick, reporter) {
  const log = []
  // 内容层问题账：事实核查发现的问题 + 各阶段结构化降级，全部留痕，供人工复算。
  // 以前模型只回 fixed_sections 直接改稿，issues 被丢掉，用户不知道机器看见了什么。
  const contentIssues = []
  if (reporter) reporter.start(pick.title)
  const step = async (name, fn) => {
    const i = log.length
    log.push({ step: name, at: new Date().toISOString(), status: 'running' })
    await writeJson(join(STATE, 'pipeline.json'), { title: pick.title, log, content_issues: contentIssues })
    reporter?.stepBegin(i)
    const r = await fn()
    log[log.length - 1].status = 'done'
    log[log.length - 1].note = typeof r === 'string' ? r.slice(0, 120) : (r?.note || '')
    if (typeof r?.note === 'string' && r.note) contentIssues.push(`[${name}] ${r.note}`)
    await writeJson(join(STATE, 'pipeline.json'), { title: pick.title, log, content_issues: contentIssues })
    reporter?.stepDone(i, log[log.length - 1].note)
    return r
  }
  const spec = contentSpecPrompt(cfg)

  // 1) 多个备选标题
  const tRes = await step('多个备选标题', () => askJson(ctx, cfg, spec + '\n只输出 JSON。',
    `选题：${pick.title}\n切入角度：${pick.angle}\n请给 3 个公众号标题方案，主推的放第一个。格式：{"titles":["...","...","..."]}`,
    1200, '多个备选标题', 'titles'))
  const titles = tRes.data.titles

  // 2) 正文撰写（结构化）
  const dRes = await step('正文撰写', () => askJson(ctx, cfg, spec + '\n只输出 JSON，不要解释。',
    `选题：${pick.title}\n角度：${pick.angle}\n主推标题：${titles[0]}\n信源：${pick.source_url}\n` +
    `请写完整正文，输出格式：{"hook":"一句话钩子","sections":[{"h2":"一、…","paras":["…","…"]}],` +
    `"methodology":"可复用方法论，一段","actions":["行动项1","行动项2","行动项3"],"next":"下一篇预告，一段",` +
    `"sources":["信源1（含链接或出处）","信源2"],"gold":"结尾金句"}\n` +
    `要求：3-6 个小节；每段 2-5 句；数字与事件必须能指回信源，查不到就不要写；结尾金句不要与「上限由放权设计决定」「权限收得回来才敢往外放」撞句。`,
    cfg.llm?.max_tokens || 8000, '正文撰写', 'sections'))
  let draft = dRes.data
  if (!draft?.sections?.length) throw new Error('正文生成失败或结构不可解析')

  // 3) 重复度检测（标题查重 + 正文相似度在 build.py 里做）
  await step('重复度检测', async () => {
    const r = await cli(['topics', 'check', titles[0], '--days', String(cfg.topic_scope.dedup_days || 14)])
    if (!r.includes('无重复')) throw new Error('主推标题与已发选题重复：' + r)
    return r
  })

  // 4) 去 AI 味改写
  const deaiRes = await step('去 AI 味改写', () => askJson(ctx, cfg, spec + '\n只输出 JSON。',
    `下面是文章正文 JSON。请逐段改写得更自然：拆掉「不是A而是B」堆叠、去掉 LLM 式过渡标签、` +
    `把绝对词软化、破折号控制在 ${cfg.content_spec.deai.dash_max} 处内、别每段都放金句。` +
    `保留全部事实与信源，不新增数据，不改变结构。输出同样格式的 JSON：\n${JSON.stringify(draft)}`,
    cfg.llm?.max_tokens || 8000, '去 AI 味改写', 'sections', draft))
  draft = deaiRes.data

  // 5) 事实与逻辑核查
  const factRes = await step('事实与逻辑核查', () => askJson(ctx, cfg,
    '你是事实核查编辑。只输出 JSON，不要解释。',
    `逐句检查这篇文章：数字/事件/引述有没有出处；不同口径的数字有没有被做差值或用箭头连成递进链；` +
    `小节之间有没有逻辑矛盾；有没有把推演写成亲历。输出 {"issues":["问题描述"],"fixed_sections":[{"h2":"…","paras":[…]}]}。` +
    `fixed_sections 给出删掉无出处断言、修好口径后的完整正文；没有问题就原样返回。\n${JSON.stringify(draft)}`,
    cfg.llm?.max_tokens || 8000, '事实与逻辑核查', 'fixed_sections',
    { issues: [], fixed_sections: draft.sections }))
  const fact = factRes.data
  if (fact?.fixed_sections?.length) draft.sections = fact.fixed_sections
  // 模型看见的内容层问题以前只拿 fixed_sections 直接改稿，issues 全被丢掉。
  // 现在逐条留痕：写到 pipeline.json、结果消息，人工能复算机器到底改了什么。
  for (const x of (Array.isArray(fact?.issues) ? fact.issues : [])) {
    const s = String(x || '').trim().slice(0, 200)
    if (s) contentIssues.push('[事实核查] ' + s)
  }

  // 6) 结构 / 标题 / 可读性优化
  const optRes = await step('结构与可读性优化', () => askJson(ctx, cfg, spec + '\n只输出 JSON。',
    `基于核查后的正文，做最后一遍整体优化：小节顺序是否顺、开头是否绕、标题是否卖洞察、长句是否要断。` +
    `输出 {"titles":["主推","备选2","备选3"],"hook":"…","sections":[…],"methodology":"…","actions":[…],"next":"…","sources":[…],"gold":"…"}。\n${JSON.stringify({ titles, ...draft })}`,
    cfg.llm?.max_tokens || 8000, '结构与可读性优化', 'sections', { titles, ...draft }))
  const finalArticle = optRes.data
  const finalTitles = finalArticle.titles || titles

  // 7) 配图（信息图按正文要点生成，HTML → 本地渲染；封面从图库匹配）
  const date = new Date().toISOString().slice(0, 10)
  const work = join(DRAFTS, date)
  await mkdir(work, { recursive: true })
  const figRes = await step('配图规划', () => askJson(ctx, cfg,
    '你是信息图编辑。只输出 JSON，不要解释。',
    `根据正文，设计 ${cfg.content_spec.images.min_figs}-${cfg.content_spec.images.max_figs} 张横版信息图。` +
    `每张给图示标题、副标题、3-4 个短标签（每个 ≤12 字）、底注。标签取自正文，不新增数据。` +
    `输出 {"figs":[{"title":"…","subtitle":"…","items":[{"label":"…"}],"footer":"…"}]}\n${JSON.stringify(finalArticle.sections?.map(s => ({ h2: s.h2, paras: s.paras })) || [])}`,
    2000, '配图规划', 'figs', { figs: [] }))
  const figs = (figRes.data?.figs || []).slice(0, cfg.content_spec.images.max_figs || 4)
  for (let i = 0; i < figs.length; i++)
    await writeFile(join(work, `fig${i + 1}.html`), figHtml(figs[i]), 'utf8')
  const cover = await chooseCover(ctx, cfg, pick.category, finalTitles[0])

  // 8) HTML 构建（含 base64 内嵌 / 白底 / 微软雅黑 / 一键复制 / 规范校验）
  const payload = {
    titles: finalTitles, hook: finalArticle.hook || '', sections: finalArticle.sections || [],
    methodology: finalArticle.methodology || '', actions: finalArticle.actions || [],
    next: finalArticle.next || '', sources: finalArticle.sources || [], gold: finalArticle.gold || '',
    action_title: cfg.content_spec.structure.action_column_name,
    cover, figs: figs.map((_, i) => `fig${i + 1}.html`), work,
    output_dir: cfg.paths.workspace,
    slug: finalTitles[0].replace(/[\\/:*?"<>|｜：:，,。\s]+/g, '_').slice(0, 28),
    config_path: join(STUDIO, 'config.json'),
  }
  const payloadPath = join(work, 'payload.json')
  await writeJson(payloadPath, payload)
  const buildOut = await step('HTML 构建与规范校验', async () => {
    const r = await run(PYTHON, [join(PLUGIN_DIR, 'studio', 'build.py'), payloadPath], {
      encoding: 'utf8', windowsHide: true, timeout: 300_000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    return (r.stdout || '').trim()
  })
  const report = asJson(buildOut) || { pass: false, raw: buildOut.slice(0, 400) }

  // 9) 规范不合格 → 自动回修一轮
  if (!report.pass && report.review_violations > 0) {
    reporter?.addStep('规范不合格自动回修')
    await step('规范不合格自动回修', async () => {
      const fixed = (await askJson(ctx, cfg, spec + '\n只输出 JSON。',
        `体检报告显示 ${report.review_violations} 项违规：${JSON.stringify(report.issues || [])}。` +
        `请修好后输出完整文章 JSON（字段同上，只输出 sections/actions/sources/gold/hook 等）。\n${JSON.stringify(finalArticle)}`,
        cfg.llm?.max_tokens || 8000, '规范回修', 'sections', {})).data
      if (fixed?.sections) {
        payload.sections = fixed.sections
        payload.actions = fixed.actions || payload.actions
        payload.sources = fixed.sources || payload.sources
        await writeJson(payloadPath, payload)
        const r2 = await run(PYTHON, [join(PLUGIN_DIR, 'studio', 'build.py'), payloadPath], {
          encoding: 'utf8', windowsHide: true, timeout: 300_000,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        })
        const rep2 = asJson((r2.stdout || '').trim())
        if (rep2) Object.assign(report, rep2)
      }
      return '回修完成'
    })
  }

  // 确定性体检里的内容层诊断（source-required 的待核实段数、ending-echo 的未生效提示）
  // 也进同一本问题账；放在自动回修之后取，保证是最终那一版报告的值。
  for (const x of (Array.isArray(report.content_notes) ? report.content_notes : [])) {
    const s = '[体检内容层] ' + String(x).slice(0, 200)
    if (!contentIssues.includes(s)) contentIssues.push(s)
  }

  const gateStatus = gateEnabled(cfg) ? 'pending' : 'disabled'
  const questions = gateQuestions(cfg)
  const result = {
    title: finalTitles[0], finished_at: new Date().toISOString(),
    output: report.output || '', pass: !!report.pass,
    review_violations: report.review_violations, issues: report.issues || [],
    body_similarity: report.body_similarity, stages: log.map(x => x.step),
    content_issues: contentIssues,
    reader_gate: { status: gateStatus, questions },
  }
  await writeJson(join(STATE, 'pipeline.json'), {
    title: pick.title, log, content_issues: contentIssues, result,
  })
  // 新一次生产必须重新放行：门禁状态按 finished_at 绑定，不能沿用上一篇的批准。
  await writeJson(GATE_STATE, {
    finished_at: result.finished_at, title: result.title, output: result.output,
    status: gateStatus, questions: result.reader_gate.questions,
    answers: {}, updated_at: result.finished_at,
    note: gateStatus === 'pending'
      ? '14 项 0 违规只是形式层；请用 /gzh-gate 逐条回答读者四问后才算放行。'
      : 'config.reader_gate.enabled=false，人工门禁已关闭。',
  })
  return result
}

// ---------- 主动送达：把候选清单送进 DSH 对话 ----------

// sessions / agents 都是可选服务，绝不写进 inject。mock 宿主或精简宿主里没有时，
// 送达降级为「只写 state」，扫描与斜杠命令照常工作。
function service(ctx, name) {
  try {
    const s = typeof ctx.get === 'function' ? ctx.get(name) : null
    if (s) return s
  } catch { /* 服务未注册 */ }
  try { return ctx[name] || null } catch { return null }
}

function afterAt(now, at) {
  const m = String(at || '00:00').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return true
  return now.getHours() * 60 + now.getMinutes() >= Number(m[1]) * 60 + Number(m[2])
}

// 官方 CommandInvocation 带 invocation.agent（「Exact agent whose UI received the command」）。
// 用户敲过任意一条 /gzh-* 命令，就把他正在看的那个会话记下来，自动送达才知道往哪推。
async function recordSession(invocation) {
  const a = invocation?.agent
  const sid = a?.session?.id || a?.sessionId || a?.id
  if (!sid) return
  await writeJson(LAST_SESSION, {
    session_id: sid, at: Date.now(), at_text: new Date().toISOString(),
  }).catch(() => {})
}

function deliveryText(cand) {
  const lines = (cand.items || []).map((it, i) =>
    `${i + 1}｜${it.title}\n   角度：${it.angle || '-'}\n   类别：${it.category || '-'}　信源：${it.source_url}`)
  return [
    `【gzh-studio 自动送达 · ${cand.date || localDay()}】今日选题清单（检索 ${cand.scanned || 0} 条 → 候选 ${lines.length} 条）`,
    '',
    ...lines,
    '',
    '这是插件定时生成后自动放进对话的通知，不是用户指令。未经 /gzh-pick 确认不会自动成稿。',
    '想写哪篇敲 /gzh-pick <编号>；只想重看清单敲 /gzh-topics；想立刻重推敲 /gzh-push。',
  ].join('\n')
}

// DSH 官方投递姿势：session.append('user/message', …, {surfaceOp:'append'}) 进聊天 surface，
// 再 ctx.sessions.flush() 持久化。wake_model=true 时改用与 Schedule 同款的 agent.followup()。
async function pushToSession(ctx, cfg, text) {
  const sessions = service(ctx, 'sessions')
  const agents = service(ctx, 'agents')
  const rec = await readJson(LAST_SESSION, null)
  const sid = rec?.session_id
  let agent = null, session = null
  if (sid) {
    try { agent = agents?.get?.(sid) || null } catch { agent = null }
    try { session = agent?.session || sessions?.get?.(sid) || null } catch { session = null }
  }
  if (!session) {
    try {
      const list = sessions?.list?.() || []
      session = list[list.length - 1] || null
    } catch { session = null }
  }
  if (!session || typeof session.append !== 'function')
    throw new Error('找不到可送达的会话（sessions 服务不可用或当前没有打开的会话）')
  const message = {
    id: randomUUID(), role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
  let channel = 'session.append'
  if (cfg?.delivery?.wake_model === true && agent && typeof agent.followup === 'function') {
    agent.followup(message)
    channel = 'agent.followup'
  } else {
    try {
      session.append('user/message', message, { surfaceOp: 'append' })
    } catch {
      // 少数宿主版本的 user/message 投影自己补 id，去掉 id 再按官方最小结构试一次。
      const { id, ...bare } = message
      session.append('user/message', bare, { surfaceOp: 'append' })
      channel = 'session.append(bare)'
    }
  }
  try { await sessions?.flush?.(session) }
  catch (e) { ctx.logger.error('[gzh-studio] 会话持久化提示', e.message) }
  return { channel, session_id: sid || session?.id || '' }
}

// 自检文件在启动 3 秒写、送达在 5 秒跑，不同步会留下「selfcheck 说尚未送达、
// delivery.json 说已送达」的自相矛盾状态。每次送达结果都回填一次。
async function syncSelfcheck(patch) {
  const sc = await readJson(join(STATE, 'selfcheck.json'), null)
  if (!sc) return
  await writeJson(join(STATE, 'selfcheck.json'), { ...sc, ...patch }).catch(() => {})
}

// 每日最多 max_per_day 次；按本地日期计，DSH 晚开机也能补送（跟自动扫描同一套「错过补跑」）。
// 只有送达成功才记次数，失败下一轮会重试，不静默丢消息。
async function maybeDeliver(ctx, cfg, force = false) {
  const d = cfg?.delivery || {}
  // 手动 /gzh-push 是用户明确要求，绕过开关与时间窗；定时送达仍受配置约束。
  if (!force && d.enabled === false) return { skipped: '未启用自动送达' }
  const now = new Date(), today = localDay(now)
  const st = await readJson(DELIVERY_STATE, {})
  if (!force) {
    if (st.date === today && (st.count || 0) >= (d.max_per_day || 1)) return { skipped: '今日已送达' }
    if (!afterAt(now, d.at || '00:00')) return { skipped: `未到送达时间 ${d.at || '00:00'}` }
  }
  const cand = await readJson(CANDIDATES, null)
  if (!cand || cand.error) return { skipped: '候选清单有错误，未送达' }
  if (!cand.items?.length) return { skipped: '候选为空，未送达' }
  // 兼容历史文件：早期候选日期写的是 UTC 日（toISOString），两种都认。
  if (!force && cand.date && cand.date !== today && cand.date !== new Date().toISOString().slice(0, 10))
    return { skipped: '候选不是今日的，等下一次自动扫描' }
  const text = deliveryText(cand)
  try {
    const r = await pushToSession(ctx, cfg, text)
    await writeJson(DELIVERY_STATE, {
      date: today, count: st.date === today ? (st.count || 0) + 1 : 1,
      last_at: now.toISOString(), last_channel: r.channel, session_id: r.session_id,
      candidates: cand.items.length, reason: force ? '手动 /gzh-push' : '定时自动送达', last_error: '',
    })
    await syncSelfcheck({
      delivery_last: now.toISOString(), delivery_channel: r.channel,
      delivery_error: '', delivery_session: r.session_id,
    })
    ctx.logger.info(`[gzh-studio] 已把 ${cand.items.length} 条候选送进 DSH 对话（${r.channel}）`)
    return { ok: true, ...r, text, count: cand.items.length }
  } catch (e) {
    await writeJson(DELIVERY_STATE, {
      ...st, date: st.date || today, last_at: now.toISOString(), last_error: e.message,
    })
    await syncSelfcheck({ delivery_error: e.message })
    ctx.logger.error('[gzh-studio] 主动送达失败（候选文件不受影响）', e.message)
    return { skipped: '送达失败：' + e.message }
  }
}

// ---------- 生产结果：成功/失败单独送一条醒目消息 ----------
//
// 进度卡会原地刷新成「生产完成」，但卡片可能被折叠或划走。所以成稿后另发一条独立消息，
// 专门交代成品在哪、体检过没过、下一步做什么。与「清单送达」共用 pushToSession 通道。

// 门禁状态在结果消息里必须显眼：0 违规不等于可发布。
function gateLine(status, questions = READER_QUESTIONS) {
  if (status === 'approved') return '读者四问：✅ 已人工放行（state/reader_gate.json）'
  if (status === 'needs_revision') return '读者四问：⚠ 有否定答案，标记需改稿，别发布'
  if (status === 'disabled') return '读者四问：已关闭（config.reader_gate.enabled=false）　注意：0 违规不代内容质量'
  return [
    '读者四问：⚠ 待人工确认。14 项 0 违规只证明形式层合格，别直接粘后台。',
    ...questions.map((q, i) => `  ${i + 1}｜${q}`),
    '  回答：/gzh-gate 答1|答2|答3|答4（任一项答「否/不确定」会标记需改稿）',
  ].join('\n')
}

function resultText(r) {
  const good = !!r?.pass
  const when = r?.finished_at ? new Date(r.finished_at).toLocaleString('zh-CN') : ''
  const issues = Array.isArray(r?.content_issues) ? r.content_issues : []
  const gate = good ? (r?.reader_gate?.status || 'pending') : ''
  const questions = r?.reader_gate?.questions?.length === 4 ? r.reader_gate.questions : READER_QUESTIONS
  const lines = [
    `${good ? '✅' : '⚠'} gzh-studio · ${good ? '成品已生成' : '生产未通过'}`,
    r?.title ? `标题：${r.title}` : '',
    r?.output ? `文件：${r.output}` : '',
    good
      ? `形式层：14 项规范 ${r.review_violations ?? '-'} 项违规　正文相似度 ${r.body_similarity ?? '-'}${when ? '　完成于 ' + when : ''}`
      : `原因：${r?.error || r?.issues?.join('；') || '见 state/pipeline.json'}`,
    good
      ? `内容层问题：${issues.length} 项${issues.length ? '\n  · ' + issues.slice(0, 3).join('\n  · ') + (issues.length > 3 ? `\n  · 其余 ${issues.length - 3} 项见 state/pipeline.json` : '') : '（模型事实核查与体检未报问题）'}`
      : '',
    good ? gateLine(gate, questions) : '',
    r?.stages?.length ? `已完成阶段：${r.stages.join(' → ')}` : '',
    good
      ? (gate === 'approved'
        ? '下一步：用 Chrome/Edge 打开 HTML → 一键复制全文 → 粘进公众号后台；发布按钮仍由你点。'
        : '下一步：先敲 /gzh-gate 回答读者四问，再去打开 HTML 粘贴。')
      : '可敲 /gzh-status 看完整进度，或重新 /gzh-pick <编号>。',
    '',
    '（插件自动送达的生产结果，不是用户指令。）',
  ].filter(x => x !== undefined && x !== null)
  return lines.join('\n')
}

async function deliverResult(ctx, cfg, r, force = false) {
  const st = await readJson(RESULT_STATE, {})
  const stamp = r?.finished_at || new Date().toISOString()
  // 同一次生产只自动送一次；手动 /gzh-result 用 force 可以补送。
  if (!force && st.finished_at === stamp && st.delivered_at && !st.last_error)
    return { ok: false, skipped: '这次结果已送达过' }
  try {
    // 结果消息只显示、不唤醒模型，避免为了一句通知又开一轮对话。
    const quietCfg = { ...(cfg || {}), delivery: { ...(cfg?.delivery || {}), wake_model: false } }
    const sent = await pushToSession(ctx, quietCfg, resultText(r))
    await writeJson(RESULT_STATE, {
      delivered_at: new Date().toISOString(), finished_at: stamp,
      channel: sent.channel, session_id: sent.session_id,
      pass: !!r?.pass, title: r?.title || '', output: r?.output || '', last_error: '',
      content_issues: r?.content_issues?.length ?? 0,
      reader_gate: r?.reader_gate?.status || (r?.pass ? 'pending' : 'n/a'),
    })
    ctx.logger.info(`[gzh-studio] 生产结果已送进 DSH 对话（${sent.channel}）`)
    return { ok: true, ...sent }
  } catch (e) {
    await writeJson(RESULT_STATE, { ...st, finished_at: stamp, last_error: e.message })
    ctx.logger.error('[gzh-studio] 生产结果送达失败（成品文件不受影响）', e.message)
    return { ok: false, error: e.message }
  }
}

// ---------- 生产进度：像大模型那样在对话里实时刷新同一条消息 ----------
//
// 官方 surface 协议：首次 session.append('user/message', …, {surfaceOp:'append'}) 拿到 event.seq；
// 之后用 {surfaceOp:{op:'replace',startSeq:seq,endSeq:seq}, sourceEventSeqs:[seq]} 覆盖上一个节点，
// 就能让同一张进度卡原地刷新，不用刷屏。宿主版本不支持 replace 时自动降级为逐条 append。

const PROGRESS_STEPS = [
  '多个备选标题', '正文撰写', '重复度检测', '去 AI 味改写',
  '事实与逻辑核查', '结构与可读性优化', '配图规划', 'HTML 构建与规范校验',
]
let ACTIVE_PROGRESS = null   // 当前流水线的 reporter；pipeline 已被独占锁串行化，全局单实例安全

function progressOpt(cfg) {
  const p = cfg?.progress || {}
  return {
    enabled: p.enabled !== false,
    mode: p.mode === 'append' ? 'append' : 'replace',
    stream_words: p.stream_words !== false,
    throttle_ms: Math.max(500, Number(p.throttle_ms) || 2500),
    stream_chars: Math.max(100, Number(p.stream_chars) || 600),
  }
}

class ProgressReporter {
  constructor(ctx, session, sessions, opt) {
    this.ctx = ctx
    this.session = session
    this.sessions = sessions
    this.opt = opt
    this.seq = null
    this.degraded = false
    this.appends = 0
    this.replaces = 0
    this.title = ''
    this.steps = []
    this.startedAt = 0
    this.lastAt = 0
    this.lastChars = 0
    this.words = 0
    this.finished = false
    this.failure = ''
    this.result = null
    this.lastText = ''
  }

  start(title, names) {
    this.title = title || ''
    this.steps = (names || PROGRESS_STEPS).map(name => ({ name, status: 'todo', note: '' }))
    this.startedAt = Date.now()
    this.lastAt = this.startedAt
    this.emit()
  }

  addStep(name) {
    this.steps.push({ name, status: 'running', note: '' })
    this.emit()
    return this.steps.length - 1
  }

  stepBegin(i) {
    if (!this.steps[i]) return
    this.steps[i].status = 'running'
    // 不单独 emit：阶段内由模型流式字数触发刷新，避免无意义的空转写入。
  }

  stepDone(i, note) {
    if (!this.steps[i]) return
    this.steps[i].status = 'done'
    this.steps[i].note = String(note || '').replace(/\s+/g, ' ').slice(0, 40)
    this.emit()
  }

  tick(chars) {
    if (!this.opt.stream_words || this.finished || !this.startedAt) return
    this.words += Math.max(0, chars || 0)
    const now = Date.now()
    if (now - this.lastAt < this.opt.throttle_ms && this.words - this.lastChars < this.opt.stream_chars) return
    this.lastAt = now
    this.lastChars = this.words
    this.emit()
  }

  render() {
    const done = this.steps.filter(s => s.status === 'done').length
    const total = this.steps.length || 1
    const pct = Math.round(done / total * 100)
    const filled = Math.round(20 * done / total)
    const bar = '▓'.repeat(filled) + '░'.repeat(20 - filled)
    const elapsed = Math.round((Date.now() - (this.startedAt || Date.now())) / 1000)
    const head = this.finished
      ? (this.failure ? '⚠ gzh-studio · 生产中断' : '✅ gzh-studio · 生产完成')
      : '⏳ gzh-studio · 正在生产'
    const lines = this.steps.map((s, i) => {
      const mark = s.status === 'done' ? '✓' : s.status === 'running' ? '›' : '·'
      const note = s.status === 'done' && s.note ? '　' + s.note : ''
      return `${mark} ${String(i + 1).padStart(2)} ${s.name}${note}`
    })
    const out = [
      `${head}　${this.title}`,
      `${bar} ${done}/${total} 步　${elapsed}s${this.words ? '　模型已输出 ' + this.words + ' 字' : ''}`,
      '',
      ...lines,
    ]
    if (this.failure) out.push('', '中断原因：' + this.failure)
    if (this.finished && this.result) {
      out.push('', `成品：${this.result.output || '未生成'}`,
        `规范违规 ${this.result.review_violations ?? '-'} 项　正文相似度 ${this.result.body_similarity ?? '-'}`,
        `内容层问题 ${this.result.content_issues?.length ?? 0} 项　读者四问 ${this.result.pass ? gateLabel(this.result.reader_gate?.status) : '不适用'}`)
      if (this.result.pass) out.push(this.result.reader_gate?.status === 'approved'
        ? '用 Chrome/Edge 打开 → 一键复制 → 粘进公众号后台。'
        : '先敲 /gzh-gate 回答读者四问，0 违规不直接放行。')
    }
    out.push('', '（插件自动刷新的进度通知，不是用户指令；最终以成品文件为准。）')
    return out.join('\n')
  }

  emit() {
    const text = this.render()
    this.lastText = text
    const message = {
      id: randomUUID(), role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }
    let ev = null
    if (this.seq !== null && this.opt.mode === 'replace' && !this.degraded) {
      try {
        ev = this.session.append('user/message', message, {
          surfaceOp: { op: 'replace', startSeq: this.seq, endSeq: this.seq },
          sourceEventSeqs: [this.seq],
        })
        this.replaces++
      } catch (e) {
        this.degraded = true
        this.ctx.logger.error('[gzh-studio] 进度卡原地刷新不可用，降级为逐条追加', e.message)
      }
    }
    if (!ev) {
      try {
        ev = this.session.append('user/message', message, { surfaceOp: 'append' })
      } catch {
        const { id, ...bare } = message
        ev = this.session.append('user/message', bare, { surfaceOp: 'append' })
      }
      this.appends++
    }
    this.seq = ev?.seq ?? null
    Promise.resolve(this.sessions.flush(this.session)).catch(() => {})
    return ev
  }

  finish(result, failure) {
    this.finished = true
    this.failure = failure || ''
    this.result = result || null
    if (!failure) for (const s of this.steps) if (s.status !== 'done') s.status = 'done'
    this.emit()
    return this.writeState()
  }

  writeState() {
    return writeJson(PROGRESS_STATE, {
      finished_at: new Date().toISOString(), title: this.title,
      steps: this.steps.length, done: this.steps.filter(s => s.status === 'done').length,
      appends: this.appends, replaces: this.replaces,
      mode: this.degraded ? 'append(降级)' : this.opt.mode,
      words: this.words, pass: !!this.result?.pass, failure: this.failure,
      session_id: this.session?.id || '',
    }).catch(() => {})
  }
}

// 目标会话优先用命令自带的 invocation.agent.session（真实对象，比从文件读 id 可靠）。
// 没有会话服务时返回 null：流水线照常跑，只是不往对话里刷进度，所有 mock 回归不受影响。
async function createProgress(ctx, cfg, directSession) {
  const opt = progressOpt(cfg)
  if (!opt.enabled) return null
  const sessions = service(ctx, 'sessions')
  let session = directSession && typeof directSession.append === 'function' ? directSession : null
  if (!session) {
    const rec = await readJson(LAST_SESSION, null)
    try { session = (rec?.session_id && sessions?.get?.(rec.session_id)) || null } catch { session = null }
    if (!session) {
      try { const list = sessions?.list?.() || []; session = list[list.length - 1] || null } catch { session = null }
    }
  }
  if (!session || typeof session.append !== 'function' || typeof sessions?.flush !== 'function') return null
  return new ProgressReporter(ctx, session, sessions, opt)
}

// ---------- 插件入口 ----------

// 真机验收自动化：宿主启动后自动写 state/selfcheck.json。
// 不敲任何命令也能判断插件是否 ACTIVE、宿主模型/Python/内核是否可用，减少人工验收步骤。
async function selfCheck(ctx, cfg) {
  let model = '不可用'
  if (llmOf(ctx)) {
    try { const p = await pickLlm(ctx, cfg); model = `${p.provider} / ${p.model}` }
    catch (e) { model = '不可用：' + e.message }
  }
  let python = '不可用'
  try {
    const r = await run(PYTHON, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 8_000 })
    python = ((r.stdout || r.stderr || '').trim() || '已响应')
  } catch (e) { python = '不可用：' + e.message }
  let engine = '未通过'
  try {
    const out = await cli(['topics', 'list'])
    engine = out.startsWith('CLI_ERROR') ? '未通过：' + out.slice(0, 120)
      : '正常（' + (out.match(/共 \d+ 条/) || [''])[0] + '）'
  } catch (e) { engine = '未通过：' + e.message }
  const candidates = await readJson(CANDIDATES, null)
  const last = await readJson(join(STATE, 'last_scan.json'), null)
  const dl = await readJson(DELIVERY_STATE, null)
  const ses = await readJson(LAST_SESSION, null)
  const pr = await readJson(PROGRESS_STATE, null)
  const rs = await readJson(RESULT_STATE, null)
  const pipe = await readJson(join(STATE, 'pipeline.json'), null)
  const gt = await readJson(GATE_STATE, null)
  const rep = {
    checked_at: new Date().toISOString(), plugin_active: true,
    llm: model, python: PYTHON + ' · ' + python,
    config: cfg ? '可读' : '读取失败', engine_cli: engine,
    sources: (cfg?.topic_scope?.sources || []).map(x => x.name),
    last_scan: last?.at_text || '尚未运行',
    candidates: candidates?.items?.length ?? 0,
    candidate_error: candidates?.error || '',
    delivery_enabled: cfg?.delivery?.enabled !== false,
    delivery_last: dl?.last_at || '尚未送达',
    delivery_channel: dl?.last_channel || '',
    delivery_error: dl?.last_error || '',
    delivery_session: ses?.session_id || '',
    progress_enabled: cfg?.progress?.enabled !== false,
    progress_mode: cfg?.progress?.mode === 'append' ? 'append' : 'replace',
    progress_last: pr?.finished_at || '尚未生产',
    progress_steps: pr?.steps || 0,
    progress_channel: pr?.mode || '',
    result_enabled: cfg?.progress?.notify_on_finish !== false,
    result_delivered: rs?.delivered_at || '尚未送达',
    result_channel: rs?.channel || '',
    result_error: rs?.last_error || '',
    content_issues: pipe?.result?.content_issues?.length ?? pipe?.content_issues?.length ?? 0,
    reader_gate: gt?.status || (pipe?.result ? (pipe.result.reader_gate?.status || 'pending') : '尚无生产'),
    reader_gate_at: gt?.answered_at || gt?.updated_at || '',
    note: '命令注册是否生效仍需在 DSH 里敲 /gzh-doctor 确认；本文件只证明 apply 已执行。',
  }
  await writeJson(join(STATE, 'selfcheck.json'), rep)
  return rep
}

// ---------- 读者四问人工门禁：0 违规不等于可发布 ----------
//
// 形式层 14 项体检、内容层问题账都是机器给的证据；「这稿子读者有没有兴趣」只能人判。
// 门禁状态写 state/reader_gate.json，并按 finished_at 绑定本次生产。
// 放行后同步回 pipeline.result，让 /gzh-status 与 /gzh-result 不会显示旧状态。

function gateCard(g, r) {
  const issues = r?.content_issues?.length ?? 0
  const qs = g?.questions?.length === 4 ? g.questions : READER_QUESTIONS
  return [
    '【gzh-studio 读者四问人工门禁】',
    `状态：${gateLabel(g.status)}　内容层问题 ${issues} 项（详见 /gzh-result）`,
    r?.title ? `本次成品：${r.title}` : '',
    r?.output ? `文件：${r.output}` : '',
    '',
    '成稿前请逐条回答，答不出来就说明立意或材料还没到位：',
    ...qs.map((q, i) => `${i + 1}｜${q}`),
    '',
    '回答格式：/gzh-gate 答1|答2|答3|答4（四问都要填，每问至少两个字）',
    '任一项答「否 / 不确定 / 没写」会标记需改稿，不会放行。',
    '这是插件的门禁提示，不是用户指令。',
  ].filter(x => x !== null && x !== undefined).join('\n')
}

function gateMessage(g, r) {
  const approved = g.status === 'approved'
  const qs = g?.questions?.length === 4 ? g.questions : READER_QUESTIONS
  return [
    `${approved ? '✅' : '⚠'} gzh-studio · 读者四问${approved ? '已人工放行' : '未通过，需改稿'}`,
    r?.title ? `标题：${r.title}` : '',
    r?.output ? `文件：${r.output}` : '',
    '',
    ...qs.map((q, i) => `${i + 1}｜${q}\n   答：${g.answers?.[String(i + 1)] || '-'}`),
    '',
    approved
      ? '可以打开 HTML → 一键复制 → 粘进公众号后台；发布按钮仍由人点。'
      : '有否定答案，先改稿再重新 /gzh-gate，别直接发布。',
    '（插件自动送达的门禁结果，不是用户指令。）',
  ].filter(x => x !== null && x !== undefined).join('\n')
}

export function apply(ctx) {
  // 同步写：插件一 ACTIVE 标记就在，排查时不用赌异步写入有没有落地。
  try {
    mkdirSync(STATE, { recursive: true })
    writeFileSync(join(STATE, 'plugin.json'), JSON.stringify({
      name: 'gzh-studio', loaded_at: new Date().toISOString(), llm_at_load: !!llmOf(ctx),
      studio: STUDIO, config: join(STUDIO, 'config.json'),
    }, null, 2), 'utf8')
  } catch { /* 标记写失败不影响插件功能 */ }

  // 崩溃恢复：宿主被关掉时 pipeline.json 会停在 running，标记成中断，避免 /gzh-status 永远显示「进行中」。
  readJson(join(STATE, 'pipeline.json'), null).then(s => {
    if (!s || s.result || !s.log?.some?.(x => x.status === 'running')) return
    const last = s.log[s.log.length - 1]
    if (last?.at && Date.now() - Date.parse(last.at) < STALE_MS) return
    s.log = s.log.map(x => x.status === 'running' ? { ...x, status: 'interrupted' } : x)
    s.result = { pass: false, error: '上次生产在宿主退出时中断，可重新 /gzh-pick' }
    return writeJson(join(STATE, 'pipeline.json'), s)
  }).catch(() => {})

  // 宿主重启后，上个进程留下的锁必然失效（单机单实例假设），启动时清掉避免白等 30 分钟。
  readJson(LOCK, null).then(s => {
    if (s && s.pid !== process.pid) return unlink(LOCK).catch(() => {})
  }).catch(() => {})

  const intervalH = Number(process.env.GZH_SCAN_INTERVAL_HOURS) || 24
  const dueMs = intervalH * 3_600_000
  let scanning = false
  const markScanned = () => writeJson(join(STATE, 'last_scan.json'), {
    at: Date.now(), at_text: new Date().toISOString(), interval_hours: intervalH,
  }).catch(e => ctx.logger.error('[gzh-studio] 扫描时间写入失败', e.message))

  // 「错过补跑」：每小时检查一次距上次扫描是否超过 intervalH，不必让 DSH 连续开满 24 小时。
  // 关掉再打开时，启动 5 秒后就会补上欠的那一次，所以自动检索不会漏。
  // 同一次 tick 里顺带做主动送达：扫描出结果立刻送进对话；没到扫描时间也可能补送当天清单。
  const checkScan = async (force = false) => {
    if (scanning) return false
    let cfg = null
    let due = force
    if (!force) {
      const last = await readJson(join(STATE, 'last_scan.json'), { at: 0 })
      due = Date.now() - (last.at || 0) >= dueMs
      if (!due) {
        // 扫描未到期，但当天清单可能还没送到对话里（例如 DSH 刚开机）。
        cfg = await loadCfg(ctx)
        if (cfg) await maybeDeliver(ctx, cfg).catch(e => ctx.logger.error('[gzh-studio] 补送异常', e.message))
        return false
      }
    }
    scanning = true
    try {
      cfg = await loadCfg(ctx)
      if (cfg) await scanOnce(ctx, cfg)
      else ctx.logger.error('[gzh-studio] 自动扫描跳过：配置读取失败')
      await markScanned()
      return true
    } catch (e) {
      ctx.logger.error('[gzh-studio] 自动扫描异常', e.message)
      await markScanned() // 失败也记时间，避免每小时反复重试
      return false
    } finally {
      scanning = false
      if (cfg) await maybeDeliver(ctx, cfg).catch(e => ctx.logger.error('[gzh-studio] 送达异常', e.message))
    }
  }

  ctx.effect(() => {
    const startup = process.env.GZH_SCAN_ON_STARTUP !== '0'
    const first = startup ? setTimeout(() => {
      checkScan().catch(e => ctx.logger.error('[gzh-studio] 启动补扫异常', e.message))
    }, 5_000) : null
    const timer = ctx.setInterval(() => {
      checkScan().catch(e => ctx.logger.error('[gzh-studio] 定时检查异常', e.message))
    }, 60 * 60_000)
    return () => {
      if (first) clearTimeout(first)
      if (typeof timer === 'function') timer()
      else clearInterval(timer)
    }
  })

  // 查看候选清单
  ctx.commands.register({
    definitionId: CommandDefinitionId('gzh-studio'),
    name: 'gzh-topics',
    description: '查看今日待确认选题清单（每日自动检索筛选）',
    recordInput: false,
    handler: async invocation => {
      await recordSession(invocation)
      const s = await readJson(join(STATE, 'candidates.json'), null)
      if (!s) return err('还没有清单。敲 /gzh-scan 立即检索一次，或等每日自动扫描。')
      if (s.error) return err(s.error)
      if (!s.items?.length) return ok(`今日检索 ${s.scanned || 0} 条，查重后 ${s.deduped || 0} 条，符合范围的候选 0 条。`)
      const lines = s.items.map((it, i) =>
        `${i + 1}｜${it.title}\n    角度：${it.angle || '-'}\n    类别：${it.category || '-'}　信源：${it.source_url}`)
      return ok(`今日候选（${s.date}，检索 ${s.scanned} 条 → 候选 ${s.items.length} 条）：\n\n${lines.join('\n\n')}\n\n确认哪个：/gzh-pick <编号>`)
    },
  })

  // 手动把清单送进当前对话：既能验证送达链路，也能随时重看，不必等下一次定时。
  ctx.commands.register({
    definitionId: CommandDefinitionId('gzh-studio'),
    name: 'gzh-push',
    description: '把今日选题清单立刻送进当前 DSH 对话（定时也会自动送一次）',
    recordInput: false,
    handler: async invocation => {
      await recordSession(invocation)
      const cfg = await loadCfg(ctx)
      if (!cfg) return err('配置读取失败：' + join(STUDIO, 'config.json'))
      const r = await maybeDeliver(ctx, cfg, true)
      if (!r.ok) return err('没能送达：' + (r.skipped || '未知原因') +
        '\n候选文件仍在 state/candidates.json，敲 /gzh-topics 可以直接看。')
      return ok(`已把 ${r.count} 条候选送进当前对话（${r.channel}）。\n` +
        `想让它每天自动出现，确认 config.json 里 delivery.enabled=true；配置改完保存即生效，不用重启。`)
    },
  })

  // 手动触发检索
  ctx.commands.register({
    definitionId: CommandDefinitionId('gzh-studio'),
    name: 'gzh-scan',
    description: '立即跑一次选题检索与筛选（定时也会自动跑）',
    recordInput: false,
    handler: async invocation => {
      await recordSession(invocation)
      const cfg = await loadCfg(ctx)
      if (!cfg) return err('配置读取失败：' + join(STUDIO, 'config.json'))
      await checkScan(true)
      const s = await readJson(join(STATE, 'candidates.json'), {})
      return ok(`检索完成：原始 ${s.scanned || 0} 条，候选 ${s.items?.length || 0} 条。${s.error || ''}\n敲 /gzh-topics 看清单。`)
    },
  })

  // 确认选题 → 全自动生产
  ctx.commands.register({
    definitionId: CommandDefinitionId('gzh-studio'),
    name: 'gzh-pick',
    description: '确认候选编号并全自动生产成稿（标题/正文/查重/改写/核查/配图/HTML/校验）',
    input: { hint: '<清单编号>' },
    recordInput: false,
    handler: async invocation => {
      await recordSession(invocation)
      const raw = (invocation.rawInput || '').trim()
      const idx = Number(raw) - 1
      if (!Number.isInteger(idx) || idx < 0) return err('用法：/gzh-pick <编号>（编号从 /gzh-topics 里取）')
      const cfg = await loadCfg(ctx)
      if (!cfg) return err('配置读取失败：' + join(STUDIO, 'config.json'))
      const s = await readJson(join(STATE, 'candidates.json'), {})
      const pick = s.items?.[idx]
      if (!pick) return err('编号不在当前清单里。敲 /gzh-topics 重新看。')
      const running = await readJson(join(STATE, 'pipeline.json'), {})
      const lastStep = running.log?.[running.log.length - 1]
      // 只有「近 30 分钟内还在推进」才算真在跑；宿主重启后残留的 running 不该永久占坑。
      const active = running.log?.some?.(x => x.status === 'running') &&
        lastStep?.at && Date.now() - Date.parse(lastStep.at) < STALE_MS
      if (active) return err('已有生产任务在跑，敲 /gzh-status 看进度。')
      // 原子独占锁：多会话/双击同时 pick 时只有一个能真正启动。
      if (!(await acquireLock(pick.title))) return err('已有生产任务占用锁，敲 /gzh-status 看进度。')
      // 异步执行，命令立即返回；进度卡在会话里自动刷新，全程无需人工干预。
      const reporter = await createProgress(ctx, cfg, invocation.agent?.session)
      ACTIVE_PROGRESS = reporter || null
      pipeline(ctx, cfg, pick, reporter).then(async r => {
        ctx.logger.info(`[gzh-studio] 生产完成：${r.title} → ${r.output}`)
        try {
          await reporter?.finish(r)
          if (cfg.progress?.notify_on_finish !== false) await deliverResult(ctx, cfg, r)
        } catch (e) { ctx.logger.error('[gzh-studio] 结果通知异常（成品不受影响）', e.message) }
      }).catch(async e => {
        ctx.logger.error('[gzh-studio] 生产失败', e.message)
        // 保留已经留痕的内容层问题账与阶段日志，别让一次失败把证据抹掉。
        const cur = await readJson(join(STATE, 'pipeline.json'), {})
        await writeJson(join(STATE, 'pipeline.json'), {
          ...cur, title: pick.title, result: { pass: false, error: e.message },
        })
        try {
          await reporter?.finish(null, e.message)
          if (cfg.progress?.notify_on_finish !== false)
            await deliverResult(ctx, cfg, { pass: false, error: e.message, finished_at: new Date().toISOString() })
        } catch (e2) { ctx.logger.error('[gzh-studio] 失败通知异常', e2.message) }
      }).finally(() => { ACTIVE_PROGRESS = null; releaseLock() })
      return ok(`已选中「${pick.title}」，全自动生产已启动。\n` +
        (reporter ? '处理过程会在这条对话里实时刷新，完成后直接给出成品路径，不用再敲命令查。'
          : '当前宿主没有会话服务，进度仍写 state/pipeline.json，敲 /gzh-status 查。') + '\n' +
        `流程：标题 → 正文 → 查重 → 去 AI 味 → 事实核查 → 结构优化 → 配图 → HTML → 规范校验（不合格自动回修）。\n` +
        `成稿后还会列出内容层问题，并要你用 /gzh-gate 回答读者四问才算放行；14 项 0 违规不等于可发布。`)
    },
  })

  // 进度与成品
  ctx.commands.register({
    definitionId: CommandDefinitionId('gzh-studio'),
    name: 'gzh-status',
    description: '查看全自动生产进度与成品路径',
    recordInput: false,
    handler: async invocation => {
      await recordSession(invocation)
      const s = await readJson(join(STATE, 'pipeline.json'), null)
      if (!s) return err('还没有生产任务。')
      if (s.result) {
        const r = s.result
        const ci = r.content_issues?.length ?? s.content_issues?.length ?? 0
        const gate = gateLabel(r.reader_gate?.status)
        return ok(`${r.pass ? '✅ 成品已生成' : '⚠ 任务结束但未完全通过'}\n标题：${r.title}\n文件：${r.output || r.error || '-'}\n` +
          `形式层违规：${r.review_violations ?? '-'} 项　正文相似度：${r.body_similarity ?? '-'}\n` +
          `内容层问题：${ci} 项${ci ? '\n  · ' + (r.content_issues || s.content_issues || []).slice(0, 3).join('\n  · ') : ''}\n` +
          `读者四问：${gate}${r.pass ? '（/gzh-gate 逐条回答后才算可发布）' : ''}\n` +
          (r.issues?.length ? '待关注：' + r.issues.join('；') + '\n' : '') +
          `已完成阶段：${(r.stages || s.log?.map(x => x.step) || []).join(' → ')}\n\n` +
          (r.pass && r.reader_gate?.status !== 'approved'
            ? '先敲 /gzh-gate 回答读者四问，再去打开 HTML 粘贴。'
            : '用 Chrome/Edge 打开 HTML → 一键复制 → 粘进公众号后台。'))
      }
      return ok('进行中：\n' + (s.log || []).map((x, i) => `  ${i + 1}. ${x.step}　${x.status}`).join('\n') +
        `\n内容层问题（当前）：${s.content_issues?.length ?? 0} 项`)
    },
  })

  // 回放上一次生产的阶段进度：重启 DSH 后不用重新生产，也能立刻看到进度卡长什么样。
  ctx.commands.register({
    definitionId: CommandDefinitionId('gzh-studio'),
    name: 'gzh-progress',
    description: '在对话里回放上一次生产的阶段进度（演示实时刷新，不重新生产）',
    recordInput: false,
    handler: async invocation => {
      await recordSession(invocation)
      const cfg = await loadCfg(ctx)
      if (!cfg) return err('配置读取失败：' + join(STUDIO, 'config.json'))
      const s = await readJson(join(STATE, 'pipeline.json'), null)
      if (!s?.log?.length) return err('还没有生产记录，先 /gzh-pick <编号> 跑一次。')
      const rep = await createProgress(ctx, cfg, invocation.agent?.session)
      if (!rep) return err('进度卡未启用，或当前宿主没有可用的会话服务；可敲 /gzh-status 看文字版进度。')
      rep.start(s.title || '（未命名）', s.log.map(x => x.step))
      for (let i = 0; i < s.log.length; i++) {
        rep.stepBegin(i)
        await new Promise(r => setTimeout(r, 220))
        rep.stepDone(i, s.log[i].note)
      }
      await rep.finish(s.result || null, s.result?.error || '')
      return ok(`已把上一次 ${s.log.length} 个阶段回放进当前对话（阶段与时间戳来自 state/pipeline.json 的真实记录，不是重新生产）。\n` +
        `刷新方式：${rep.opt.mode}${rep.degraded ? '（已降级为逐条追加）' : '（同一条消息原地刷新）'}，追加 ${rep.appends} 次 / 替换 ${rep.replaces} 次。\n` +
        `想看真过程，下次敲 /gzh-pick <编号> 会边跑边刷新。`)
    },
  })

  // 把上一次生产结果补送进对话：已经成功的成品不用重新生产也能看到。
  ctx.commands.register({
    definitionId: CommandDefinitionId('gzh-studio'),
    name: 'gzh-result',
    description: '把上一次生产结果（成品路径 / 体检 / 相似度）送进当前 DSH 对话',
    recordInput: false,
    handler: async invocation => {
      await recordSession(invocation)
      const cfg = await loadCfg(ctx)
      if (!cfg) return err('配置读取失败：' + join(STUDIO, 'config.json'))
      const p = await readJson(join(STATE, 'pipeline.json'), null)
      if (!p?.result) return err('还没有生产结果，先 /gzh-pick <编号> 跑一次。')
      const r = await deliverResult(ctx, cfg, p.result, true)
      if (!r.ok) return err('没能送达：' + (r.error || r.skipped || '未知原因') +
        '\n结果仍在 state/pipeline.json，敲 /gzh-status 可以直接看。')
      return ok(`已把上一次生产结果送进当前对话（${r.channel}）。\n` +
        (p.result.pass
          ? `成品：${p.result.output}\n形式层 14 项 ${p.result.review_violations} 项违规　正文相似度 ${p.result.body_similarity}\n` +
            `内容层问题 ${p.result.content_issues?.length ?? 0} 项　读者四问 ${gateLabel(p.result.reader_gate?.status)}`
          : '注意：上一次生产未通过，详情见送达的消息。') +
        (p.result.pass && p.result.reader_gate?.status !== 'approved'
          ? '\n尚未人工放行：敲 /gzh-gate 逐条回答读者四问。' : '') +
        '\n这是独立的结果通知；生产过程的进度卡可用 /gzh-progress 回放。')
    },
  })

  // 读者四问人工门禁：不带参数看四问与当前状态；带四个答案才放行。
  ctx.commands.register({
    definitionId: CommandDefinitionId('gzh-studio'),
    name: 'gzh-gate',
    description: '读者四问人工门禁：0 违规不直接放行，逐条回答后才算可发布',
    input: { hint: '<答1|答2|答3|答4>' },
    recordInput: false,
    handler: async invocation => {
      await recordSession(invocation)
      const cfg = await loadCfg(ctx)
      if (!cfg) return err('配置读取失败：' + join(STUDIO, 'config.json'))
      const qs = gateQuestions(cfg)
      const p = await readJson(join(STATE, 'pipeline.json'), null)
      if (!p?.result) return err('还没有成品，先 /gzh-pick <编号> 跑一次。')
      const r = p.result
      if (!r.pass) return err('上一次生产未通过，门禁只对通过的成品生效。敲 /gzh-status 看原因。')
      const saved = await readJson(GATE_STATE, null)
      const g = saved?.finished_at === r.finished_at ? saved : {
        finished_at: r.finished_at, title: r.title, output: r.output,
        status: r.reader_gate?.status || (gateEnabled(cfg) ? 'pending' : 'disabled'),
        questions: r.reader_gate?.questions?.length === 4 ? r.reader_gate.questions : qs,
        answers: {}, updated_at: r.finished_at,
      }
      const raw = (invocation.rawInput || '').trim()
      if (!raw) return ok(gateCard(g, r))
      const parts = raw.split(/[|｜\n]+/).map(x => x.trim()).filter(Boolean)
      if (parts.length !== 4)
        return err(`需要 4 个答案，用 | 分隔（收到 ${parts.length} 个）。格式：/gzh-gate 答1|答2|答3|答4\n` +
          qs.map((q, i) => `  ${i + 1}｜${q}`).join('\n'))
      if (parts.some(x => x.length < 2))
        return err('每问至少写两个字，别用「ok」「1」糊弄；这四问是发布前最后一道人工确认。')
      if (parts.some(x => /^(通过|放行|ok|yes)$/i.test(x)))
        return err('「通过 / 放行」不算答案。请写出这一问的具体内容，门禁不是橡皮图章。')

      const negative = parts.some(x => NEGATIVE_ANSWER.test(x))
      const status = negative ? 'needs_revision' : 'approved'
      const answers = {}
      qs.forEach((_, i) => { answers[String(i + 1)] = parts[i] })
      const next = {
        ...g, finished_at: r.finished_at, title: r.title, output: r.output,
        status, questions: qs, answers,
        answered_at: new Date().toISOString(), negative,
        note: negative ? '至少一问答了否定/不确定，标记需改稿' : '四问均由人工逐条回答后放行',
      }
      await writeJson(GATE_STATE, next)
      // 同步回 pipeline.result：/gzh-status、/gzh-result、进度卡读的都是这份状态。
      p.result = { ...r, reader_gate: { status, questions: qs } }
      await writeJson(join(STATE, 'pipeline.json'), p)

      let delivered = '（当前宿主没有可用会话服务，门禁结果只写进了 state/reader_gate.json）'
      try {
        const quietCfg = { ...(cfg || {}), delivery: { ...(cfg?.delivery || {}), wake_model: false } }
        await pushToSession(ctx, quietCfg, gateMessage(next, r))
        delivered = '并已单独送进当前对话'
      } catch (e) {
        ctx.logger.error('[gzh-studio] 门禁结果送达失败（放行状态不受影响）', e.message)
      }
      return ok(status === 'approved'
        ? `✅ 读者四问已人工放行，${delivered}。\n` +
          '放行范围只覆盖「立意与读者兴趣」，版式、图片转存、发布按钮仍要真人确认。\n' +
          '状态：state/reader_gate.json；想重看结果敲 /gzh-result。'
        : `⚠ 有否定答案，本次标记「需改稿」，${delivered}。\n` +
          '先按否定那一问改稿，再重新 /gzh-gate 回答四问；别直接发布。')
    },
  })

  // 配置查看（范围与规范按需调整）
  ctx.commands.register({
    definitionId: CommandDefinitionId('gzh-studio'),
    name: 'gzh-config',
    description: '查看当前选题范围与内容规范配置（直接改文件即可调整）',
    recordInput: false,
    handler: async invocation => {
      await recordSession(invocation)
      const cfg = await loadCfg(ctx)
      if (!cfg) return err('配置读取失败：' + join(STUDIO, 'config.json'))
      const s = cfg.topic_scope, c = cfg.content_spec
      return ok(`配置文件：${join(STUDIO, 'config.json')}（改完保存，下次运行生效）\n\n` +
        `选题范围：${s.categories.join(' / ')}\n检索源：${(s.sources || []).map(x => x.name + '(' + x.type + ')').join('、') || '未配置'}\n` +
        `候选数/次：${s.candidates_per_run}　查重窗口：${s.dedup_days} 天\n排除：${s.exclude.join('；')}\n\n` +
        `内容规范：破折号 ≤${c.deai.dash_max}、加粗 ≤${c.deai.bold_max}、字数 ${c.structure.word_count.join('-')}、行动栏目「${c.structure.action_column_name}」\n` +
        `配图：封面走本地图库匹配（0 额度）${c.images.image_api?.enabled ? '，已启用外部生图 API（约 ' + c.images.cover_credits + '）' : ''}，信息图 ${c.images.min_figs}-${c.images.max_figs} 张本地渲染（0 额度）\n` +
        `主动送达：${cfg.delivery?.enabled === false ? '已关闭' : '开启'}　每天最多 ${cfg.delivery?.max_per_day || 1} 次　不早于 ${cfg.delivery?.at || '00:00'}　${cfg.delivery?.wake_model ? '唤醒模型' : '只显示不唤醒模型'}\n` +
        `生产进度：${cfg.progress?.enabled === false ? '已关闭' : '开启'}　${cfg.progress?.mode === 'append' ? '逐条追加' : '同一条消息原地刷新'}　模型字数流式 ${cfg.progress?.stream_words === false ? '关' : '开'}\n` +
        `结果通知：${cfg.progress?.notify_on_finish === false ? '已关闭' : '开启'}（成稿后另发一条独立成功消息）\n` +
        `读者四问门禁：${gateEnabled(cfg) ? '开启' : '已关闭'}（0 违规不直接放行，/gzh-gate 逐条回答四问；状态写 state/reader_gate.json）\n` +
        `模型：${cfg.llm?.provider || '自动选宿主 provider'} / ${cfg.llm?.model || '自动选宿主 model'}`)
    },
  })

  // 自检：这条命令能执行，就证明插件已经 ACTIVE（不再是 PENDING）
  ctx.commands.register({
    definitionId: CommandDefinitionId('gzh-studio'),
    name: 'gzh-doctor',
    description: '自检：插件是否激活、宿主模型/Python/配置是否可用、上次自动检索时间',
    recordInput: false,
    handler: async invocation => {
      await recordSession(invocation)
      let modelLine = '宿主模型：不可用。' + LLM_MISSING
      if (llmOf(ctx)) {
        try {
          const p = await pickLlm(ctx, await loadCfg(ctx))
          modelLine = `宿主模型：可用　${p.provider} / ${p.model}`
        } catch (e) { modelLine = '宿主模型：' + e.message }
      }
      let pyLine = 'Python：未知'
      try {
        const r = await run(PYTHON, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
        pyLine = 'Python：' + ((r.stdout || r.stderr || '').trim() || '已响应')
      } catch (e) { pyLine = 'Python：调用失败 ' + e.message }
      const cfg = await loadCfg(ctx)
      const last = await readJson(join(STATE, 'last_scan.json'), null)
      const cand = await readJson(join(STATE, 'candidates.json'), null)
      const sc = await readJson(join(STATE, 'selfcheck.json'), null)
      const dl = await readJson(DELIVERY_STATE, null)
      const ses = await readJson(LAST_SESSION, null)
      const gt = await readJson(GATE_STATE, null)
      const pipe = await readJson(join(STATE, 'pipeline.json'), null)
      const dv = cfg?.delivery || {}
      return ok([
        '✅ gzh-studio 已激活（这条命令能执行就是证据）',
        modelLine,
        pyLine,
        `配置：${cfg ? '可读' : '读取失败'}　${join(STUDIO, 'config.json')}`,
        `真机自检：${sc ? sc.checked_at + ' · 内核 ' + sc.engine_cli : '尚未生成（启动 3 秒后写入 state/selfcheck.json）'}`,
        `自动检索：每 ${intervalH} 小时一次，每小时检查是否到期；DSH 关掉再打开会自动补跑`,
        `上次检索：${last?.at_text || '尚未运行'}　当前候选：${cand?.items?.length ?? 0} 条${cand?.error ? '（' + cand.error + '）' : ''}`,
        `主动送达：${dv.enabled === false ? '已关闭' : '开启'}（每天最多 ${dv.max_per_day || 1} 次，不早于 ${dv.at || '00:00'}，${dv.wake_model ? '唤醒模型' : '只显示不唤醒模型'}）`,
        `最近送达：${dl?.last_at || '尚未送达'}${dl?.last_error ? '　失败：' + dl.last_error : dl?.last_channel ? '　通道：' + dl.last_channel : ''}`,
        `目标会话：${ses?.session_id || '未记录；敲任意 /gzh-* 命令后自动记录，否则回退到最后打开的会话'}`,
        `内容层问题账：上次生产 ${pipe?.result?.content_issues?.length ?? 0} 项（模型事实核查 + 体检诊断，写 state/pipeline.json 与结果消息）`,
        `读者四问门禁：${gateEnabled(cfg) ? '开启' : '已关闭'}　当前 ${gateLabel(gt?.status || pipe?.result?.reader_gate?.status)}${gt?.answered_at ? '（' + gt.answered_at + '）' : ''}　敲 /gzh-gate 看四问并放行`,
        '命令：/gzh-config · /gzh-scan · /gzh-topics · /gzh-push · /gzh-progress · /gzh-result · /gzh-gate · /gzh-pick <编号> · /gzh-status · /gzh-doctor',
      ].join('\n'))
    },
  })

  // 启动 3 秒后自动写真机自检（无需敲命令就能判断插件是否真的被宿主加载）。
  setTimeout(() => {
    loadCfg(ctx).then(cfg => selfCheck(ctx, cfg))
      .catch(e => ctx.logger.error('[gzh-studio] 自动自检异常', e.message))
  }, 3_000)
}
