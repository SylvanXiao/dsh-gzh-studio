// 一键放行验收：不进 DSH、不敲斜杠命令，直接读插件产物并主动探测依赖。
// 运行：node scripts/acceptance.mjs        （--strict 时存在 FAIL 返回退出码 1）
// 目的：把「重启 DSH 后敲 5 条命令」压缩成 1 条命令。不替代人工确认选题与公众号发布。
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const STUDIO = process.env.GZH_STUDIO_HOME || './studio'
const STATE = join(STUDIO, 'state')
const cfgPath = join(STUDIO, 'config.json')
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {}
const PY = process.env.GZH_PYTHON || cfg.paths?.python || 'python'
const ENGINE = process.env.GZH_AGENT_HOME || cfg.paths?.engine || join(root, '..')
const ARTICLE = process.env.GZH_ARTICLE ||
  './workspace/sample_article.html'

const rows = []
const add = (name, state, detail) => {
  rows.push({ name, state, detail })
  console.log(`${state === 'PASS' ? 'PASS' : state === 'WARN' ? 'WARN' : 'FAIL'}  [${name}] ${detail}`)
}
const rj = f => { try { return JSON.parse(readFileSync(join(STATE, f), 'utf8')) } catch { return null } }
const hoursAgo = t => t ? (Date.now() - Date.parse(t)) / 3_600_000 : Infinity
const py = (args, cwd = ENGINE) => spawnSync(PY, args, {
  cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
})

// 1) 插件是否在宿主启动时被加载
const plugin = rj('plugin.json')
add('插件加载', plugin && plugin.llm_at_load && hoursAgo(plugin.loaded_at) < 24 ? 'PASS' : 'FAIL',
  plugin ? `loaded_at=${plugin.loaded_at} llm_at_load=${plugin.llm_at_load}` : '缺 plugin.json（插件未加载，需完全退出并重启 DSH）')

// 2) 启动自动自检（覆盖 /gzh-doctor 的全部信息）
const sc = rj('selfcheck.json')
const scOk = sc?.plugin_active && !/不可用/.test(sc.llm || '') && /正常/.test(sc.engine_cli || '')
add('启动自动自检', scOk ? 'PASS' : 'FAIL',
  sc ? `${sc.checked_at} · 模型 ${sc.llm} · 内核 ${sc.engine_cli}` : '缺 selfcheck.json（启动 3 秒后自动写）')

// 3) 自动补跑（覆盖 /gzh-scan 是否执行过）
const last = rj('last_scan.json')
add('自动补跑扫描', last && hoursAgo(last.at_text) < 24 ? 'PASS' : 'WARN',
  last ? `上次扫描 ${last.at_text} · 间隔 ${last.interval_hours}h` : '尚未扫描（启动 5 秒后会补跑）')

// 4) 候选清单（覆盖 /gzh-topics）
const cand = rj('candidates.json')
const n = cand?.items?.length ?? 0
add('候选清单', n > 0 && !cand?.error ? 'PASS' : 'FAIL',
  `${n} 条${cand?.error ? ' · ' + cand.error : ''}`)

// 5) 逐源诊断：明确阻塞在哪个源、为什么
const sources = cfg.topic_scope?.sources || []
const srcReport = []
for (const s of sources) {
  if (s.type === 'file') {
    let lines = 0
    try {
      lines = readFileSync(s.path, 'utf8').split(/\r?\n/)
        .filter(l => /^[-*]\s*.+\s*[|｜]\s*\S+\s*[|｜]/.test(l.trim())).length
    } catch { /* 文件不存在按 0 条处理 */ }
    srcReport.push({ name: s.name, type: s.type, items: lines })
    add(`检索源 · ${s.name}`, lines > 0 ? 'PASS' : 'WARN', `有效投喂 ${lines} 条（${s.path}）`)
  } else {
    try {
      const r = await fetch(s.url, { signal: AbortSignal.timeout(s.timeout_ms || 12000) })
      const text = await r.text()
      const items = (text.match(/<item[ >]/g) || []).length + (text.match(/<entry[ >]/g) || []).length
      const isFeed = /xml|rss|atom/i.test(r.headers.get('content-type') || '') || items > 0
      srcReport.push({ name: s.name, type: s.type, status: r.status, final_url: r.url, items })
      add(`检索源 · ${s.name}`, items > 0 ? 'PASS' : 'FAIL',
        `HTTP ${r.status} → ${r.url} · 条目 ${items}${isFeed ? '' : ' · 返回的是 HTML 非 feed（源已改版/失效）'}`)
    } catch (e) {
      srcReport.push({ name: s.name, type: s.type, error: e.message })
      add(`检索源 · ${s.name}`, 'WARN', `请求失败 ${e.name}: ${e.message}（若受本机代理限制，请在 DSH 内复测）`)
    }
  }
}

// 6) 内核 CLI 可读性
const cliR = py(['gzh.py', 'topics', 'list'])
const cliOut = ((cliR.stdout || '') + (cliR.stderr || '')).trim()
add('内核 CLI', cliR.status === 0 && /共 \d+ 条/.test(cliOut) ? 'PASS' : 'FAIL',
  cliOut.slice(0, 100) || `exit=${cliR.status}`)

// 7) 真稿粘贴前体检
if (existsSync(ARTICLE)) {
  const rv = py(['gzh.py', 'review', ARTICLE])
  const out = ((rv.stdout || '') + (rv.stderr || '')).trim()
  const m = out.match(/违规 (\d+) 项/)
  add('真稿粘贴前体检', m && m[1] === '0' ? 'PASS' : 'FAIL',
    (m ? `14 项体检违规 ${m[1]} 项` : out.slice(0, 100)) + ` · ${ARTICLE.split(/[\\/]/).pop()}`)
} else {
  add('真稿粘贴前体检', 'WARN', `未找到真稿 ${ARTICLE}，可用 GZH_ARTICLE 指定`)
}

// 8) 生产状态（覆盖 /gzh-status）
const pipe = rj('pipeline.json')
add('生产状态', !pipe ? 'WARN' : pipe.result?.pass ? 'PASS' : 'WARN',
  pipe ? (pipe.result?.pass ? `上次生产通过 · ${pipe.result.output}` : `上次生产未通过/进行中 · ${JSON.stringify(pipe.result).slice(0, 120)}`) : '尚无生产记录（/gzh-pick 后才有）')

// 9) 主动送达（候选是否真的进过 DSH 对话）
const dl = rj('delivery.json')
const ses = rj('last_session.json')
const dv = cfg.delivery || {}
const deliveredToday = dl?.date === new Date().toLocaleDateString('sv-SE') ||
  dl?.date === new Date().toISOString().slice(0, 10)
if (dv.enabled === false) {
  add('主动送达', 'WARN', 'config.json 里 delivery.enabled=false，已关闭自动送达；手动 /gzh-push 仍可用')
} else if (dl?.last_error) {
  add('主动送达', 'WARN', `上次送达失败：${dl.last_error}（候选文件不受影响，下一轮会重试）`)
} else if (deliveredToday && dl?.last_channel) {
  add('主动送达', 'PASS', `${dl.last_at} 已送 ${dl.candidates} 条 · 通道 ${dl.last_channel} · 会话 ${dl.session_id || '自动选择'}`)
} else {
  add('主动送达', 'WARN', '尚未送达（重启 DSH 让新插件生效后，下一次定时检查会补送；也可敲 /gzh-push 立即验证）')
}
add('送达目标会话', ses?.session_id ? 'PASS' : 'WARN',
  ses?.session_id ? `已记录 ${ses.session_id}` : '未记录；敲任意 /gzh-* 命令后自动记录，否则回退到最后打开的会话')

// 10) 生产进度是否真的在对话里刷新过
const pg = rj('progress.json')
const pv = cfg.progress || {}
if (pv.enabled === false) {
  add('生产进度', 'WARN', 'config.json 里 progress.enabled=false，已关闭；生产仍照常写 state/pipeline.json')
} else if (pg?.steps) {
  add('生产进度', 'PASS', `${pg.finished_at} · ${pg.done}/${pg.steps} 步 · ${pg.mode} · 追加 ${pg.appends} / 替换 ${pg.replaces} 次 · 成品 ${pg.pass ? '通过' : '未通过'}`)
} else {
  add('生产进度', 'WARN', '尚未产生进度卡；重启 DSH 让新插件生效后，敲 /gzh-progress 可回放上次生产验证显示效果')
}

// 11) 生产成功的结果是否单独送进过对话
const rs = rj('result.json')
if (cfg.progress?.notify_on_finish === false) {
  add('生产结果送达', 'WARN', 'progress.notify_on_finish=false，已关闭自动结果通知；可敲 /gzh-result 手动补送')
} else if (rs?.delivered_at && !rs?.last_error) {
  add('生产结果送达', 'PASS', `${rs.delivered_at} · ${rs.pass ? '成品已生成' : '生产未通过'} · 通道 ${rs.channel}`)
} else {
  add('生产结果送达', 'WARN', '尚未送达；重启 DSH 后敲 /gzh-result 可把这次已成功的成品结果补送进对话，不用重新生产')
}

// 12) 内容层问题账：模型事实核查发现的问题是否留痕（以前只改稿、issues 被丢）
const ci = pipe?.result?.content_issues
if (pipe?.result && !Array.isArray(ci)) {
  add('内容层问题账', 'WARN', '上次结果来自旧版插件，尚无 content_issues 字段；重启 DSH 并跑一次 /gzh-pick 后生效')
} else {
  add('内容层问题账', Array.isArray(ci) ? 'PASS' : 'WARN',
    Array.isArray(ci) ? `上次生产留痕 ${ci.length} 项${ci.length ? ' · ' + ci[0].slice(0, 70) : '（模型与体检均未报问题）'}`
      : '尚无生产记录，/gzh-pick 后才有内容层问题账')
}

// 13) 读者四问人工门禁：0 违规不等于可发布
const rg = cfg.reader_gate || {}
const gate = rj('reader_gate.json')
if (rg.enabled === false) {
  add('读者四问门禁', 'WARN', 'config.json 里 reader_gate.enabled=false，0 违规会直接当成完成；建议重新打开')
} else if (!pipe?.result) {
  add('读者四问门禁', 'WARN', '尚无生产记录，跑一次 /gzh-pick 后才会生成门禁状态')
} else if (gate?.finished_at !== pipe.result.finished_at) {
  add('读者四问门禁', 'WARN', '门禁状态与最近一次成品不匹配（或插件尚未重启写入新状态）；敲 /gzh-gate 看四问')
} else if (gate.status === 'approved') {
  add('读者四问门禁', 'PASS', `${gate.answered_at} 已人工放行，四问答案已留痕（发布仍需真人点按钮）`)
} else {
  add('读者四问门禁', 'WARN',
    `当前 ${gate.status || 'pending'}：形式层 0 违规不等于可发布，敲 /gzh-gate 答1|答2|答3|答4 才算放行`)
}

const fails = rows.filter(r => r.state === 'FAIL').length
const warns = rows.filter(r => r.state === 'WARN').length
const report = {
  checked_at: new Date().toISOString(), studio: STUDIO,
  summary: { pass: rows.filter(r => r.state === 'PASS').length, warn: warns, fail: fails },
  verdict: fails ? '未放行' : warns ? '基本放行（有提示项）' : '自动验收通过',
  checks: rows, sources: srcReport,
  manual_only: [
    '插件代码更新后：完全退出并重启一次 DSH（插件只在宿主启动时加载），重启后敲 /gzh-push 验证清单能出现在对话里',
    '确认选题：/gzh-pick <编号> —— 原需求刻意保留的人工环节，不自动代选',
    '读者四问：/gzh-gate 答1|答2|答3|答4 —— 0 违规只证明形式层合格，立意与读者兴趣由人放行',
    '公众号后台真实粘贴：图片转存微信 CDN、白底与版式确认，需真人看一眼',
    '发布：按产品边界不自动发布，人工点按钮',
  ],
}
mkdirSync(STATE, { recursive: true })
writeFileSync(join(STATE, 'acceptance.json'), JSON.stringify(report, null, 2), 'utf8')
console.log(`\n[acceptance] ${report.verdict}：${report.summary.pass} PASS / ${warns} WARN / ${fails} FAIL`)
console.log('[acceptance] 已写 ' + join(STATE, 'acceptance.json'))
if (fails) console.log('[acceptance] 阻塞项：' + rows.filter(r => r.state === 'FAIL').map(r => r.name).join('、'))
console.log('[acceptance] 仍需人工：重启 DSH 让代码生效 · 确认选题 · /gzh-gate 读者四问放行 · 公众号粘贴 · 发布（其余已自动）')
if (fails && process.argv.includes('--strict')) process.exit(1)
