# gzh-studio（DSH 插件）

公众号你的公众号全自动内容生产插件。跑在 DSH 宿主里，用宿主模型（`ctx.llm.stream`）创作，用 gzh-agent 内核做确定性校验。

## 边界（先读）

- **不自动发布**。成品是可一键复制的 HTML，发布按钮由人在公众号后台点。个人号无开放 API，也不该跳过终审。
- **不内置模型密钥**。全部模型调用走宿主已配置的 provider/model。
- **不让模型编事实**。检索源不可用时直接报错，不生成候选；候选的 `source_url` 必须来自检索条目。
- **AI 生图不在 DSH 内**。宿主没有生图能力，封面默认从本地图库按类别关键词匹配（0 额度）；需要 AI 生图时在 `config.json` 的 `image_api` 接外部接口（约 5-10 credits/张，启用前会说明额度）。信息图一律本地 HTML→Edge 渲染，0 额度。

## 命令

| 命令 | 作用 |
|---|---|
| `/gzh-config` | 查看当前选题范围与内容规范，显示配置文件路径 |
| `/gzh-scan` | 立即跑一次检索筛选（每日定时也会自动跑） |
| `/gzh-topics` | 看今日待确认候选清单（编号 + 角度 + 信源） |
| `/gzh-push` | 把今日清单立刻送进当前 DSH 对话（验证送达链路 / 随时重看） |
| `/gzh-progress` | 在对话里回放上一次生产的阶段进度（演示实时刷新，不重新生产） |
| `/gzh-result` | 把上一次生产结果（成品路径 / 体检 / 相似度 / 内容层问题 / 门禁状态）补送进当前对话 |
| `/gzh-gate` | 读者四问人工门禁：不带参数看四问，带 `答1\|答2\|答3\|答4` 逐条回答后才放行 |
| `/gzh-pick <编号>` | 确认选题，启动全自动生产 |
| `/gzh-status` | 看生产进度、内容层问题账与成品路径 |
| `/gzh-doctor` | 自检：插件激活、模型/Python/配置、上次检索、主动送达、内容层问题与门禁状态 |

> 敲 `/gzh-doctor` 能得到回应，就说明插件已经 ACTIVE。完全没有反应时，按文末「排错」查。

## 自动运行

检索筛选是自动的，不需要手敲 `/gzh-scan`：

- 插件激活 5 秒后检查一次，之后**每小时检查一次**距上次检索是否超过 `GZH_SCAN_INTERVAL_HOURS`（默认 24 小时），到期才跑。
- 这是「错过补跑」模式：DSH 不必连续开满 24 小时。关掉再打开，启动几秒后会自动补上欠的那次。
- 上次检索时间写在 `内容生产/state/last_scan.json`，当前清单在 `state/candidates.json`，激活标记在 `state/plugin.json`。
- 手动 `/gzh-scan` 会立刻跑一次并更新时间，不会和自动检索重复。
- **确认选题这一步按原需求保留人工**：清单出来后由人选编号，选中之后的全部环节无需干预。
- 前提仍是 DSH 在运行。DSH 关着的时候插件进程不存在，没有东西可以定时；要真正无人值守，需让 DSH 常驻或加系统级开机自启。

## 主动送达（清单自动出现在 DSH 对话里）

「跑成功」不等于「看得见」。候选默认只写进 `state/candidates.json`，早期版本要敲 `/gzh-topics` 才看得到；现在检索产出候选后，插件会**主动把清单放进 DSH 聊天区**：

```
定时扫描 → state/candidates.json
        → session.append('user/message', …, { surfaceOp:'append' })   ← 官方 surface 姿势
        → ctx.sessions.flush(session)                                   ← 持久化
        → 对话里出现「【gzh-studio 自动送达 · 日期】今日选题清单 …」
```

- **目标会话**：敲过任意一条 `/gzh-*` 命令后，从 `invocation.agent` 记下会话 id 到 `state/last_session.json`；没敲过就回退到当前最后打开的会话。
- **每天最多一次**：`state/delivery.json` 按本地日期计数，送达成功才计数，失败下一轮重试。DSH 晚开机也会补送。
- **默认不唤醒模型**：只把清单显示出来，不消耗 token、不会自作主张写稿。送达文本里写明「不是用户指令，未经 `/gzh-pick` 确认不会自动成稿」。
- `delivery.wake_model=true` 时改走 `agent.followup()`，与 DSH 自带 Schedule 提醒同款，会唤起模型回一条解读。
- `delivery.at`（默认 `00:00`，即不限制）可设成 `09:00` 之类，只在当天过了该时间才推。
- 手动 `/gzh-push` 忽略开关、时间窗与每日次数限制，随时强制重推一次，用来验证链路。
- **与 DSH 自带 Schedule 的区别**：Schedule 是模型用 `schedule_create` 建的静态提醒，绑定到创建它的 Session，宿主运行期间到期恢复会话并 follow-up；它无法动态读取当天候选。本插件的送达是插件自己按当天数据生成后推送，两者可叠加（Schedule 提醒「去看清单」，插件负责「把清单送来」）。

配置项在 `config.json` 的 `delivery` 段，改完保存即生效，不用重启；**插件代码本身更新过，则必须完全退出并重启一次 DSH**。

## 生产进度（像大模型那样在对话里实时刷新）

早期版本 `/gzh-pick` 只回一句「已启动」，用户还得敲 `/gzh-status` 才知道跑到哪了。现在确认选题后，**同一张进度卡会在对话里原地刷新**：

```
⏳ gzh-studio · 正在生产　AI短剧开始冲双11业绩…
▓▓▓▓▓▓░░░░░░░░░░░░░░  3/8 步　46s　模型已输出 2,140 字
✓ 01 多个备选标题
✓ 02 正文撰写
✓ 03 重复度检测　近 14 天无重复，可入库
› 04 去 AI 味改写
· 05 事实与逻辑核查
…
```

- **原地刷新**用官方 surface 协议：首次 `session.append('user/message', …, {surfaceOp:'append'})` 拿到 `event.seq`，之后每次用 `{surfaceOp:{op:'replace',startSeq:seq,endSeq:seq}, sourceEventSeqs:[seq]}` 覆盖上一个节点。链式引用每次更新后的新 seq，不会刷屏。
- **模型流式感**来自 `ask()` 收集 `text-delta` 时累计字数，按 `throttle_ms` / `stream_chars` 节流刷新，所以写正文那几十秒里「已输出 N 字」会一直涨。
- **完成后进度卡直接给出成品路径、14 项体检结果与相似度**，不必再敲 `/gzh-status`。失败时同一张卡变成「⚠ 生产中断」并写出原因。
- **另外再发一条独立的「成品已生成」消息**：标题、文件、规范违规数、相似度、完成时间、已完成阶段、下一步操作一次交代清楚，避免进度卡被折叠或划走后错过结果。同一次生产只自动送一次，`progress.notify_on_finish=false` 可关。失败也发一条「生产未通过」并带原因。状态写 `state/result.json`。
- **`/gzh-result` 补送**：读 `state/pipeline.json` 里的上一次结果，主动送进当前对话，**不重新生产、不耗额度**。之前已经跑成功但从没在对话里看到过结果的，重启后敲这一条就能补上。
- 配置 `progress`：`enabled / mode(replace|append) / stream_words / throttle_ms / stream_chars`。宿主不支持 replace 时自动降级为逐阶段追加消息；没有会话服务时静默降级为只写 `state/pipeline.json`，流水线照常跑。
- **`/gzh-progress` 回放**：读 `state/pipeline.json` 的真实阶段与时间戳，在对话里把上次生产重放一遍（约 2 秒），用来验证显示效果或回顾过程，**不会重新生产、不消耗模型额度**。重启 DSH 后敲它就能立刻看到进度卡长什么样。
- 进度状态写 `state/progress.json`（步数、追加/替换次数、是否降级、成品是否通过），`acceptance.mjs` 会检查。

## 内容层检查与「读者四问」人工门禁（0 违规 ≠ 可发布）

14 项体检只查形式层：破折号、加粗、绝对词、字体白底……第 4 篇返工三次，机器每次都报 0 违规，人却一眼看出「立意选错了、读者没兴趣」。2026-11-09 补上三层：

**① 模型看见的问题不再丢。** 流水线「事实与逻辑核查」原来只取 `fixed_sections` 直接改稿，`issues` 被丢掉，用户不知道机器看见了什么。现在 `fact.issues` 与各阶段结构化降级 note、体检诊断统一写进 `state/pipeline.json` 的 `content_issues`，并出现在结果消息、`/gzh-status`、`/gzh-result` 和进度卡上。

**② 两项体检规则做成真检查。** 原来 `source-required` / `ending-echo` 属 `manual_flag` / `cross_article`，`review.py` 直接 `return None`，报告里只留一句「提示人工执行」，命中 0 也算绿灯。现在：

| 规则 | 真检查做法 |
|---|---|
| `source-required` | 按段落抽数字/事件断言，定位「信源 / 参考 / 口径说明」栏。**全文无信源栏或信源栏为空 → 报错**；有信源栏时把「段内未标出处」的段数写成 `待核实 N 段` 诊断，由 `build.py` 收进 `content_notes`，在结果消息里强制给人看。这样不会把作者自己跑出来的实测数据当外部事实误报。 |
| `ending-echo` | 取正文最后一个加粗块当结尾金句，与 `data/published/endings.md` 的已发布金句逐条比对（相似度 ≥0.72 或连续 ≥12 字雷同即报 warn）。**语料为空会明确写 `[未生效]`**，不把「没检查」伪装成「通过」。 |

语料库只收已发布文章结尾，新增文章发布后追加一行即可。口径：第 4/5 篇与自动生产样稿未发布，故意不收，否则拿它们当体检样本会「自己撞自己」。

**③ 读者四问人工门禁。** 每次生产结束后写 `state/reader_gate.json`，按 `finished_at` 绑定本次成品（新生产必须重新放行），默认 `pending`。结果消息、进度卡、`/gzh-status` 都显示「待人工确认」并列出四问：

```
1｜能不能全自动运行？哪几段自己跑、哪一步还得人按，一次说清。
2｜运行的结果怎么样？给一次真实运行的数据，不要只给形容词。
3｜这个插件我能不能用？门槛、依赖、什么人用不上，写清楚。
4｜如何使用？从装好到出稿，给能照做的步骤顺序。
```

敲 `/gzh-gate` 看四问；`/gzh-gate 答1|答2|答3|答4` 逐条回答。四问都要填、每问至少两个字，写「通过 / 放行 / ok」不算答案，任一项答「否 / 不确定 / 没写」标 `needs_revision` 需改稿。放行后同步回 `pipeline.result.reader_gate` 并另发一条独立门禁消息进对话。`config.json` 的 `reader_gate.enabled=false` 可关，但关闭后 0 违规就等于直接完成，不建议。

回归：`node scripts/qa-gate.mjs`（门禁卡、拦截、放行、否定答案、状态同步、降级），内核 `pytest` 覆盖两项真检查与语料为空的 `[未生效]`。

## 全自动流水线（确认后无需人工干预）

```
多标题 → 正文 → 查重(topics check) → 去 AI 味改写 → 事实与逻辑核查
→ 结构/标题/可读性优化 → 配图规划 → HTML 构建 → 14 项规范校验
→ 不合格自动回修一轮 → 成品 HTML + 校验报告 + 内容层问题账 → 读者四问人工门禁
```

每步状态写 `内容生产/state/pipeline.json`，可追溯。成品含 base64 内嵌图片、微软雅黑内联、白底、工具区、一键复制按钮。**成稿只是「形式层 + 内容层都留了证据」，发布前仍要 `/gzh-gate` 人工放行。**

## 稳健性与验收

- **批量查重**：检索阶段走内核 `gzh.py topics check-batch --file <标题数组.json>`，一次进程处理全部素材。20 条素材实测从约 7.4 s 降到 0.36 s。
- **结构化模型重试**：`askJson` 在首次输出不可解析或缺关键字段时，让模型只修格式重试一次；仍失败按阶段降级，并在 `state/pipeline.json` 的步骤 `note` 里写明「已降级沿用上一版本」，不再静默沿用草稿。正文等关键阶段两次失败直接报错。
- **并发锁**：`state/pipeline.lock` 独占创建，多会话同时 `/gzh-pick` 只启动一个；超过 30 分钟的陈旧锁自动清理，宿主重启时清掉上个进程的锁。状态文件统一改为临时文件 + rename 原子写。
- **真机自检**：宿主启动 3 秒后自动写 `state/selfcheck.json`（插件是否 ACTIVE、宿主模型、Python、内核 CLI、检索源、上次检索时间）。不用敲命令也能判断插件有没有被加载；命令是否真的可敲，仍需 `/gzh-doctor` 确认。
- **粘贴验收**：真稿预检已通过（4 张 base64 图、0 远程图、59 个文字块全内联微软雅黑与白底、14 项 0 违规）。人工步骤见测试报告第 8 节。
- **构建失败可解析**：`studio/build.py` 的 payload / config 读取与 Pillow 导入统一收进 `_init()`，由 `__main__` 的 try 兜住；任何失败都输出一行 `pass:false` 的 JSON 并**保持退出码 0**，因为宿主用 `execFile` 调用，非零退出码会直接 reject、stdout 的报告就到不了插件。失败路径回归 `node scripts/qa-build.mjs` 覆盖 10 种坏输入（缺参数、文件不存在、坏 JSON、缺字段、Pillow 缺失）。
- **内容层问题账 + 读者四问门禁**：`fact.issues`、结构化降级 note、`source-required` / `ending-echo` 的诊断统一写 `state/pipeline.json` 的 `content_issues`，结果消息与 `/gzh-status` 都显示；每次成品默认 `reader_gate.status=pending`，必须 `/gzh-gate` 逐条回答四问才放行。`node scripts/qa-gate.mjs` 覆盖拦截、放行、否定答案、状态同步与无会话服务降级。
- **一键放行验收**：`node scripts/acceptance.mjs` 不进 DSH、不敲斜杠命令，直接读 `state/plugin.json` / `selfcheck.json` / `last_scan.json` / `candidates.json` / `delivery.json` / `last_session.json` / `pipeline.json` / `reader_gate.json`，主动探测每个检索源、跑内核 CLI 与真稿 14 项体检，汇总 PASS/WARN/FAIL 并写 `state/acceptance.json`（`--strict` 时存在 FAIL 返回退出码 1）。把「重启后敲 5 条命令」压缩成一条；不替代人工确认选题、读者四问放行、公众号粘贴与发布。
- **主动送达可降级**：`sessions` / `agents` 都是用 `ctx.get()` 可选获取的服务，不写进 `inject`。宿主没提供会话服务时只写 `state/delivery.json` 的 `last_error`，扫描与斜杠命令照常工作，不抛栈、不拖垮插件。回归 `node scripts/qa-delivery.mjs` 覆盖官方 append 姿势、flush、每日一次、时间窗、`wake_model`、无会话服务降级、手动强推。
- **候选日期按本地日算**：`candidates.json` 的 `date` 与送达判定都用本机日期（上海 UTC+8），避免凌晨用 `toISOString()` 把今天写成昨天；历史 UTC 日期文件仍兼容。
- **生产进度可降级**：进度卡走官方 `surfaceOp:replace` 原地刷新，宿主不支持时自动退化为逐条 append，没有会话服务时退化为只写 `state/pipeline.json`。回归 `node scripts/qa-progress.mjs` 覆盖 replace 链式引用、进度条、完成态、降级、开关、直接会话优先；`mock-host.mjs --full` 另验证真实流水线边跑边刷新。

## 配置

唯一配置文件：`./studio/config.json`（可用 `GZH_STUDIO_HOME` 改目录）。

- `topic_scope.sources`：检索源数组。`type=file` 读本地投喂 `inbox.md`（`- 标题 | 链接 | 摘要`），`type=rss` 抓 RSS。
- `topic_scope.categories / focus / exclude`：选题范围。
- `content_spec`：作者视角、立场、去 AI 味阈值、事实规则、排版与配图规范。
- `llm.provider / model`：留空自动用宿主当前模型。
- `delivery`：主动送达开关、每日次数、时间窗、是否唤醒模型（`enabled / max_per_day / at / wake_model`）。
- `progress`：生产进度卡开关、刷新模式、模型字数流式节流、成功后是否另发独立结果消息（`enabled / mode / stream_words / throttle_ms / stream_chars / notify_on_finish`）。
- `reader_gate`：读者四问人工门禁（`enabled / questions`）。四问可按需要改措辞，但不要删到只剩「通过 / 不通过」。
- `gates`：校验阈值（规范必须 0 违规、正文相似度告警线）。

改完保存，下次运行生效，无需重新构建。

## 环境变量

| 变量 | 默认 |
|---|---|
| `GZH_STUDIO_HOME` | `./studio` |
| `GZH_AGENT_HOME` | `./gzh-agent` |
| `GZH_PYTHON` | `python` |
| `GZH_SCAN_ON_STARTUP` | `1`（设 `0` 关闭启动首扫） |
| `GZH_SCAN_INTERVAL_HOURS` | `24` |

## 开发

```bash
node scripts/build.mjs                   # src/index.ts → lib/index.js（build = copy，零依赖）
node scripts/gates/run.mjs               # pure 形态合同检查
node scripts/mock-host.mjs --no-llm      # 回归：无 llm 服务也必须 ACTIVE
node scripts/mock-host.mjs               # 回归：有 llm 的检索链路
node scripts/mock-host.mjs --full        # 回归：完整流水线到成品 HTML
node scripts/qa-inject.mjs               # 缺陷注入 / 边界 / 自动补跑（20 项）
node scripts/qa-build.mjs                # build.py 顶层失败路径（10 项）
node scripts/qa-delivery.mjs             # 主动送达链路回归（24 项）
node scripts/qa-progress.mjs             # 进度卡 + 结果送达回归（33 项）
node scripts/qa-gate.mjs                 # 读者四问人工门禁回归
node scripts/acceptance.mjs              # 不进 DSH 的一键放行验收
```

内核侧回归：`cd <gzh-agent> && python -m pytest -q`（含 `tests/test_qa_regression.py`）。

`inject = ['commands', 'timer']`。**`llm` / `sessions` / `agents` 故意不写进 inject**：官方框架里 inject 声明的服务未就绪时插件会一直停在 PENDING，`apply` 不执行，命令注册不上、定时扫描也不会跑。宿主模型与会话服务改用 `ctx.get(name)` 在调用处按需取，服务不可用时给可读提示或降级，不影响插件激活。门禁会拦住任何把它们写回 inject 的改动。

## 安装到桌面端

桌面 profile 由 Electron 独占管理，`dsh plugin add` 会被拒，用手动 link（已装）：

1. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 加 `"gzh-studio": "link:<CLONE_PATH>/dsh-studio"`
2. 同一个文件的 `dsh.profile.bundles` 加 `"gzh-studio"`（两处都要，缺一处启动时不认这个 bundle）
3. `node_modules/gzh-studio` 建 Windows Junction 指向插件目录
4. 重启桌面端 DSH

备份见 `package.json.bak-studio`。

## 排错（敲命令没反应时按顺序看）

1. **重启过桌面端 DSH 吗**：插件只在宿主启动时加载，改完代码或 `package.json` 必须重启。
2. **看 `内容生产/state/plugin.json`**：文件不存在 = 插件没 ACTIVE。检查上面「安装到桌面端」的两处登记，以及 `node_modules/gzh-studio` 的 `LinkType` 是否为 `Junction`（Git Bash 的 `ln -s` 生成 MSYS 软链，Node 跟随不了）。
3. **文件存在但命令仍不出**：看插件面板里 `gzh-studio` 是不是 PENDING。当前版本只声明 `commands`/`timer`，正常不会 PENDING。
4. **能敲 `/gzh-doctor` 但候选为 0**：看它回显的宿主模型、Python、配置三项，以及 `state/candidates.json` 的 `error`。检索源全挂时插件会明确报错，不会让模型编选题；可往 `inbox.md` 投喂真实素材。
5. **清单没自动出现在对话里**：先敲 `/gzh-push` 手动推一次。成功 = 送达链路没问题，等下一次定时检查即可；报「没能送达」看 `state/delivery.json` 的 `last_error` 与 `state/last_session.json` 有没有记下会话 id。`/gzh-doctor` 会回显最近送达时间、通道与目标会话。
6. **生产时看不到进度**：敲 `/gzh-progress` 回放上一次生产，能出卡片就说明 surface 链路通。若报「进度卡未启用，或当前宿主没有可用的会话服务」，看 `config.json` 的 `progress.enabled` 和 `state/plugin.json`；`state/progress.json` 的 `mode` 显示 `append(降级)` 表示宿主不支持 replace，过程会变成逐条消息而不是原地刷新。
7. **没看到「成品已生成」**：先敲 `/gzh-result` 补送上一次结果（不重新生产）；想立刻看文字版敲 `/gzh-status`。`state/result.json` 有 `last_error` 说明会话服务不可用，成品文件本身不受影响。自动通知可用 `progress.notify_on_finish` 关闭。
8. **结果写着「待人工确认」**：这是设计，不是故障。敲 `/gzh-gate` 看四问，再 `/gzh-gate 答1|答2|答3|答4` 逐条回答；答不出就先改稿。`state/reader_gate.json` 的 `finished_at` 必须和 `state/pipeline.json` 的 `result.finished_at` 一致，否则说明插件还是旧版没重启。
9. **体检说 `ending-echo [未生效]`**：`data/published/endings.md` 语料丢了或路径不对；补回后重跑 `gzh.py review`。这项会明确写「未生效」，不会静默给绿灯。
