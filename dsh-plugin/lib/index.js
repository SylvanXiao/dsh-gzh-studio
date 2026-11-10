// gzh-agent DSH 插件（pure Cordis）——薄适配层
// 业务全部在 gzh-agent 仓库的 gzh.py / core/，这里只做命令 → CLI 的转发。
// 环境变量：
//   GZH_AGENT_HOME  业务内核目录（默认 ./gzh-agent）
//   GZH_PYTHON      Python 解释器（默认 python，需已在 PATH）
//   GZH_ARTICLES_DIR  文章目录，/gzh-review 无参数/编号/片段时在此找稿（默认 ./workspace）
//   GZH_SCAN_ON_STARTUP   启动后是否先跑一轮选题扫描（默认 1；设 0 关闭）
//   GZH_SCAN_INTERVAL_HOURS 定时扫描间隔小时数（默认 24）
//
// 宿主契约（DSH 0.1.7 实测）：
//   - ctx.command / ctx.timer 都是服务，必须 inject = ['commands', 'timer']，且 API 是
//     ctx.commands.register({ definitionId, name, description, input, recordInput, handler })
//   - 命令名受 COMMAND_NAME = /^[a-z][a-z0-9_-]*$/ 约束，中文命令名注册不进去，
//     中文放进 description 与 handler 回显里
//   - handler 返回 { kind: 'success' | 'error', text }，参数在 invocation.rawInput

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// CommandDefinitionId 在 @deepseek-ai/dsh-commands/brand 里只是 TS 品牌字符串，
// 运行时为恒等函数。不直接 import 的原因：launcher 只解析组合包入口本身，
// 不代解析插件 import 的宿主包；声明宿主包依赖会破坏「零 npm 依赖、build=copy」形态。
const CommandDefinitionId = s => s

const run = promisify(execFile)

const HOME = process.env.GZH_AGENT_HOME || './gzh-agent'
const PYTHON = process.env.GZH_PYTHON || 'python'
const ARTICLES_DIR = process.env.GZH_ARTICLES_DIR || './workspace'

//   - ctx.setInterval 不是核心内置能力：实测 0.2.1-rc.5 报
//     "cannot get property 'timer' without inject"，必须 inject = ['commands', 'timer']
//     （dsh-plugin-studio event-task 配方写"无需声明"，与实机不符）
export const name = 'gzh-agent'
export const inject = ['commands', 'timer']

async function callCli(args) {
  try {
    const r = await run(PYTHON, ['gzh.py', ...args], {
      cwd: HOME,
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      timeout: 60_000,
    })
    return r.stdout.trim()
  } catch (e) {
    return {
      failed: true,
      message: e.message,
      detail: ((e.stdout || '') + (e.stderr || '')).slice(0, 800),
    }
  }
}

const ok = text => ({ kind: 'success', text })
const err = text => ({ kind: 'error', text })

// 解析 "标题 -c 类别 -a 角度" 形式的原始输入
function parseFlags(raw) {
  const cat = (raw.match(/-c\s+([^\s-]+(?:\s+[^\s-]+)*?)(?=\s+-a\s|\s*$)/) || [])[1]
  const angle = (raw.match(/-a\s+(.+?)(?=\s+-c\s|\s*$)/) || [])[1]
  const title = raw.replace(/\s+-[ca]\s+\S+(?:\s+\S+)*(?=\s+-[ca]\s|\s*$)/g, '').trim()
  return { title, cat: cat?.trim(), angle: angle?.trim() }
}

// ---------- /gzh-review 的稿件解析：编号 | 文件名片段 | 路径 | 无参数列最近 ----------

async function listRecentHtml(limit) {
  let names
  try {
    names = await readdir(ARTICLES_DIR)
  } catch {
    return []
  }
  const items = []
  for (const name of names) {
    if (!/\.(html?|md)$/i.test(name)) continue
    const st = await stat(join(ARTICLES_DIR, name)).catch(() => null)
    if (st && st.isFile()) items.push({ name, mtime: st.mtimeMs })
  }
  items.sort((a, b) => b.mtime - a.mtime)
  return limit ? items.slice(0, limit) : items
}

const numbered = items => items.map((it, i) => `  ${i + 1}｜${it.name}`).join('\n')

// 返回 { file } 命中 | { listing } 需要用户再选 | { error } 明确失败
async function resolveArticleArg(raw) {
  const input = raw.trim().replace(/^["']|["']$/g, '')
  if (!input) {
    const items = await listRecentHtml(8)
    if (!items.length) return { error: `文章目录下没找到 HTML/Markdown：${ARTICLES_DIR}` }
    return { listing: `最近改动的稿件（用 /gzh-review <编号> 或 <文件名片段> 选中）：\n${numbered(items)}` }
  }
  if (/^\d+$/.test(input)) {
    const items = await listRecentHtml(50)
    const pick = items[Number(input) - 1]
    if (!pick) return { error: `编号 ${input} 不在最近列表里，敲 /gzh-review 重新看列表` }
    return { file: join(ARTICLES_DIR, pick.name) }
  }
  if (/[\\/]/.test(input) || /^[a-zA-Z]:/.test(input)) {
    return { file: resolve(ARTICLES_DIR, input) }
  }
  const items = await listRecentHtml(0)
  const hits = items.filter(it => it.name.toLowerCase().includes(input.toLowerCase()))
  if (hits.length === 1) return { file: join(ARTICLES_DIR, hits[0].name) }
  if (hits.length > 1) {
    return { listing: `「${input}」命中 ${hits.length} 个文件，换个更长的片段：\n${numbered(hits.slice(0, 8))}` }
  }
  return { error: `没找到文件名含「${input}」的稿件；敲 /gzh-review 看最近列表，或直接给完整路径` }
}

// ---------- review 输出瘦身：默认摘要卡，full 给全量 ----------

// CLI 结论行形如「共 14 项检查，违规 N 项。」；条目行形如「✅ [rule] warn 命中 N 处（上限 X）」，
// 摘录行以缩进 + … 开头且属于其上方最近一条。
function briefReview(out) {
  const lines = out.split('\n')
  const summary = (lines.find(l => /共 \d+ 项检查/.test(l)) || '').trim()
  const findings = []
  for (const l of lines) {
    const m = l.match(/^([✅❌])\s*\[([\w-]+)\]\s*\S*\s*命中 (\d+) 处（上限 (\d+)）/)
    if (m) findings.push({ bad: m[1] === '❌', rule: m[2], hit: +m[3], limit: +m[4], excerpts: [] })
    else if (findings.length && /^\s+…/.test(l)) {
      const cur = findings[findings.length - 1]
      if (cur.bad && cur.excerpts.length < 2) cur.excerpts.push(l.trim())
    }
  }
  const bad = findings.filter(f => f.bad)
  if (!bad.length) {
    const noted = findings
      .filter(f => f.hit > 0)
      .map(f => `  ${f.rule} ${f.hit}/${f.limit}`)
      .join('\n')
    return `✅ ${summary}${noted ? `\n提醒项（未超限）：\n${noted}` : ''}\n要逐项全量：/gzh-review <编号> full`
  }
  const parts = bad.map(
    f => `❌ [${f.rule}] 命中 ${f.hit} 处（上限 ${f.limit}）${f.excerpts.length ? '\n' + f.excerpts.map(e => '   ' + e).join('\n') : ''}`
  )
  return `${summary}\n${parts.join('\n')}\n其余 ${findings.length - bad.length} 项通过；要全量：/gzh-review <编号> full`
}

// 每日选题扫描（event-task 配方）：汇总选题库状态并写日志。
// ctx.logger 是核心内置能力；ctx.setInterval 不是，必须 inject timer（见文件头实机记录）。
async function scanOnce(ctx) {
  const list = await callCli(['topics', 'list'])
  if (list && list.failed) {
    ctx.logger.error('[gzh-scan] 选题库读取失败', list.detail)
    return
  }
  const total = (list.match(/共 (\d+) 条/) || [])[1] ?? '?'
  const stale = await callCli(['topics', 'stale'])
  const staleLine = stale && !stale.failed ? stale.split('\n')[0] : `挂起查询失败：${stale?.detail ?? ''}`
  const ready = (list.match(/\| 候选 \|/g) || []).length // 状态列恰为「候选」的行数
  ctx.logger.info(`[gzh-scan] 每日选题扫描：库内 ${total} 条，候选 ${ready} 条；${staleLine}`)
}

export function apply(ctx) {
  // 定时选题扫描：启动 30s 后先跑一轮，之后按 GZH_SCAN_INTERVAL_HOURS（默认 24h）循环。
  ctx.effect(() => {
    const hours = Number(process.env.GZH_SCAN_INTERVAL_HOURS) || 24
    const startup = process.env.GZH_SCAN_ON_STARTUP !== '0'
    const first = startup ? setTimeout(() => { scanOnce(ctx).catch(e => ctx.logger.error('[gzh-scan] 首扫异常', e?.message)) }, 30_000) : null
    const timer = ctx.setInterval(() => { scanOnce(ctx).catch(e => ctx.logger.error('[gzh-scan] 定时扫描异常', e?.message)) }, hours * 3_600_000)
    return () => {
      if (first) clearTimeout(first)
      // cordis timer 可能返回 dispose 函数，也可能返回 interval id，两种都兼容
      if (typeof timer === 'function') timer()
      else clearInterval(timer)
    }
  })

  // 冒烟：链路自检（/gzh-hello 返回选题库条数即通）
  ctx.commands.register({
    definitionId: CommandDefinitionId('gzh-agent'),
    name: 'gzh-hello',
    description: 'gzh-agent 链路自检（冒烟）',
    recordInput: false,
    handler: async () => {
      const out = await callCli(['topics', 'list'])
      if (out && out.failed) return err(`调用失败：${out.message}\n${out.detail}`)
      const n = (out.match(/共 (\d+) 条/) || [])[1]
      return n != null
        ? ok(`gzh-agent 在线，选题库共 ${n} 条。`)
        : err(`gzh-agent 已响应但输出异常：\n${out.slice(0, 300)}`)
    },
  })

  // 审稿体检：/gzh-review [编号 | 文件名片段 | 路径] [full]
  ctx.commands.register({
    definitionId: CommandDefinitionId('gzh-agent'),
    name: 'gzh-review',
    description: '按 rules.md 对成稿体检。用法：/gzh-review 直接列最近稿件；/gzh-review 2 体检编号2；文件名片段或完整路径也行；结尾加 full 看逐项全量',
    input: { hint: '[编号 | 文件名片段 | 路径] [full]' },
    recordInput: false,
    handler: async invocation => {
      const raw = (invocation.rawInput || '').trim()
      // full/全量 允许写在开头或结尾
      const wantFull = /(^|\s)(full|全量)(\s|$)/i.test(raw)
      const arg = wantFull ? raw.replace(/(^|\s)(full|全量)(\s|$)/i, ' ').trim() : raw
      const r = await resolveArticleArg(arg)
      if (r.error) return err(r.error)
      if (r.listing) return ok(r.listing)
      const out = await callCli(['review', r.file])
      if (out && out.failed) return err(`调用失败：${out.message}\n${out.detail}`)
      return ok(wantFull ? out : briefReview(out))
    },
  })

  // 选题入库：/gzh-topic-add <标题> -c 类别 -a 角度
  ctx.commands.register({
    definitionId: CommandDefinitionId('gzh-agent'),
    name: 'gzh-topic-add',
    description: '选题入库，自动查重（原 /选题入库）。用法：/gzh-topic-add <标题> -c AI工具 -a 切入角度',
    input: { hint: '<标题> -c <类别> -a <角度>' },
    recordInput: false,
    handler: async invocation => {
      const { title, cat, angle } = parseFlags(invocation.rawInput || '')
      if (!title) return err('用法：/gzh-topic-add <标题> -c AI工具 -a 角度')
      const args = ['topics', 'add', title, '--cat', cat || 'AI工具']
      if (angle) args.push('--angle', angle)
      const out = await callCli(args)
      if (out && out.failed) return err(`调用失败：${out.message}\n${out.detail}`)
      return ok(out)
    },
  })

  // 选题查重：/gzh-topic-check <标题>
  ctx.commands.register({
    definitionId: CommandDefinitionId('gzh-agent'),
    name: 'gzh-topic-check',
    description: '近 7 天选题查重，不入库（原 /选题查重）。用法：/gzh-topic-check <标题>',
    input: { hint: '<标题>' },
    recordInput: false,
    handler: async invocation => {
      const title = (invocation.rawInput || '').trim()
      if (!title) return err('用法：/gzh-topic-check <标题>')
      const out = await callCli(['topics', 'check', title, '--days', '7'])
      if (out && out.failed) return err(`调用失败：${out.message}\n${out.detail}`)
      return ok(out)
    },
  })
}
