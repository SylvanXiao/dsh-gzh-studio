# gzh-agent（DSH 插件）

公众号运营 Agent 的 DSH 适配层（pure Cordis）。业务内核在上级仓库（`../core`、`../gzh.py`），本插件只做命令转发。

## 命令

> 宿主约束：命令名只允许小写 ASCII（`COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u`），中文放进描述与回显。

| 命令 | 说明 | 原设计名 |
|---|---|---|
| `/gzh-hello` | 链路自检（冒烟），返回选题库条数 | `/gzh-hello` |
| `/gzh-review <文件>` | 按 rules.md 逐项体检 HTML/Markdown 成稿 | `/审稿体检` |
| `/gzh-topic-add <标题> -c 类别 -a 角度` | 选题入库，自动查重 | `/选题入库` |
| `/gzh-topic-check <标题>` | 近 7 天选题查重，不入库 | `/选题查重` |

## 配置（环境变量）

- `GZH_AGENT_HOME`：业务内核目录，默认 `./gzh-agent`
- `GZH_PYTHON`：Python 解释器，默认 `python`
- `GZH_ARTICLES_DIR`：文章目录，`/gzh-review` 无参数/编号/文件名片段时在此找稿，默认 `./workspace`
- `GZH_SCAN_ON_STARTUP`：启动 30 秒后是否先跑一轮选题扫描，默认 `1`（设 `0` 关闭）
- `GZH_SCAN_INTERVAL_HOURS`：定时选题扫描间隔（小时），默认 `24`

## 定时选题扫描（event-task）

插件激活后自动运行：启动 30 秒先扫一轮，之后每 24 小时（可用 `GZH_SCAN_INTERVAL_HOURS` 调）执行
`gzh.py topics list` + `gzh.py topics stale`，把库内条数 / 候选数 / 挂起 ≥14 天候选写入插件日志
（`[gzh-scan]` 前缀）。只读不写，不碰选题库数据；扫描是"汇总待办"，抓取外部选题源不在 MVP 范围。

## 开发

```bash
pnpm run bundle   # copy src/index.js → lib/index.js（零依赖，无需编译器）
pnpm run gates    # pure 形态合同检查
```

## 安装（本地目录）

```bash
dsh plugin --profile web add /d/BaiduSyncdisk/project/gzh-agent/dsh-plugin
dsh web
# 冒烟：/gzh-hello 返回选题库条数即通
```

要求插件 package.json 声明 `dsh.bundle.patch` 并随包携带 `cordis.patch.yml`，否则只作普通依赖安装、宿主不激活（2026-11-02 实机确认）。

## 实机激活记录（2026-11-02，DSH 0.1.7-rc.2 npm 版，独立实例 ./dsh-home）

1. `cannot get property "command" without inject`：`ctx.command` 是服务，需 `inject = ["commands"]`，且 API 为 `ctx.commands.register({ definitionId, name, description, input?, recordInput?, handler })`，handler 返回 `{ kind: 'success'|'error', text }`。
2. 命令名约束 `COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u`：中文命令名注册即抛错，改 ASCII 名。
3. launcher 只解析组合包入口，不代解析插件 import 的宿主包：`@deepseek-ai/dsh-commands/brand` 不可直接 import（其运行时仅为品牌恒等字符串，已内联）。
4. `input.hint` 空串会被 normalizeDefinition 拒绝：无参命令应整体省略 `input`。
5. 修复后启动 stderr 无任何 warning，gzh-agent 三 bundle（base + web-app + gzh-agent）组合激活。
