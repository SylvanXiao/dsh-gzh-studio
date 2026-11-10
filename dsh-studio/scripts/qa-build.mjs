// R7 回归：build.py 的顶层输入读取异常必须转成一行可解析 JSON，且退出码保持 0。
// 运行：node scripts/qa-build.mjs
// 原因：插件用 execFile 调 Python，非零退出码会直接 reject，stdout 的 JSON 到不了调用方。
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const BUILD = join(root, 'studio', 'build.py')
const realCfgPath = join(process.env.GZH_STUDIO_HOME || './studio', 'config.json')
const slash = p => p.replace(/\\/g, '/')

function pythonOf() {
  if (process.env.GZH_PYTHON) return process.env.GZH_PYTHON
  if (existsSync(realCfgPath)) {
    const cfg = JSON.parse(readFileSync(realCfgPath, 'utf8'))
    if (cfg.paths?.python) return cfg.paths.python
  }
  return 'python'
}
const PY = pythonOf()
const work = mkdtempSync(join(tmpdir(), 'gzh-qa-build-'))
const realCfg = existsSync(realCfgPath) ? JSON.parse(readFileSync(realCfgPath, 'utf8')) : null

const results = []
const check = (name, ok, msg) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${name}] ${msg}`)
}

// 每个坏输入返回 payload 路径（或 null 表示不传参数）
const f = (name, content) => {
  const p = join(work, name)
  writeFileSync(p, content, 'utf8')
  return slash(p)
}
const payload = (obj, name) => f(name, JSON.stringify({
  work: slash(work), slug: 'qa', output_dir: slash(work), ...obj,
}, null, 2))
const baseCfg = realCfg || { paths: { edge: 'x', engine: 'y' }, content_spec: { format: { font_inline: 'z' } }, gates: {} }
const goodCfg = f('cfg_ok.json', JSON.stringify(baseCfg, null, 2))

const cases = [
  { name: 'R7-无参数', args: [] },
  { name: 'R7-payload不存在', args: [slash(join(work, 'no_such.json'))] },
  { name: 'R7-payload坏JSON', args: [f('p_broken.json', '{"work": ')] },
  { name: 'R7-payload顶层数组', args: [f('p_array.json', '[]')] },
  { name: 'R7-payload缺config_path', args: [payload({}, 'p_nocfg.json')] },
  { name: 'R7-config路径不存在', args: [payload({ config_path: slash(join(work, 'no_cfg.json')) }, 'p_badcfgpath.json')] },
  { name: 'R7-config坏JSON', args: [payload({ config_path: f('cfg_broken.json', '{"paths": ') }, 'p_cfgbroken.json')] },
  {
    name: 'R7-config缺paths.edge',
    args: [payload({ config_path: (() => { const c = JSON.parse(JSON.stringify(baseCfg)); delete c.paths.edge; return f('cfg_noedge.json', JSON.stringify(c)) })() }, 'p_noedge.json')],
  },
  {
    name: 'R7-config缺font_inline',
    args: [payload({ config_path: (() => { const c = JSON.parse(JSON.stringify(baseCfg)); delete c.content_spec.format.font_inline; return f('cfg_nofont.json', JSON.stringify(c)) })() }, 'p_nofont.json')],
  },
]

// 可选依赖缺失：用一个抛错的 fake PIL 抢占 PYTHONPATH，验证 import 异常同样被兜住
const fakePkg = join(work, 'PIL')
mkdirSync(fakePkg, { recursive: true })
writeFileSync(join(fakePkg, '__init__.py'), "raise ImportError('mock pillow missing')\n", 'utf8')
cases.push({
  name: 'R7-Pillow缺失',
  args: [payload({ config_path: goodCfg }, 'p_nopil.json')],
  env: { PYTHONPATH: slash(work) },
})

for (const c of cases) {
  const r = spawnSync(PY, [BUILD, ...c.args], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(c.env || {}) },
  })
  const lines = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean)
  let rep = null
  try { rep = JSON.parse(lines[lines.length - 1]) } catch { /* 留给断言失败 */ }
  const issue = rep?.issues?.[0] || ''
  const noTraceback = !(r.stderr || '').includes('Traceback')
  const ok = r.status === 0 && noTraceback && rep !== null &&
    rep.pass === false && rep.review_violations === -1 &&
    Array.isArray(rep.issues) && rep.issues.length > 0 && issue.includes('构建异常')
  check(c.name, ok, `exit=${r.status} JSON=${rep ? 'ok' : '空'} issue="${issue.slice(0, 80)}" stderr=${(r.stderr || '').trim().slice(0, 60) || '(空)'}`)
}

const passed = results.filter(Boolean).length
console.log(`\n[qa-build] 汇总：${passed} PASS / ${results.length - passed} FAIL　|　Python: ${PY}`)
if (passed !== results.length) process.exit(1)
