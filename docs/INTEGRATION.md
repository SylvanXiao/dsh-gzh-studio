# 业务内核 CLI 契约

本仓库不含业务内核。两个插件通过 `execFile` 调用内核 CLI，只要实现下面的契约即可替换成自己的实现。

## 入口

`python gzh.py <subcommand> ...`，stdout 输出单行 JSON，供插件解析。
调用方是 `execFile`，非 0 退出码会让插件直接 reject，因此顶层不能抛异常；失败时也应输出一行 `{"pass": false, ...}` 并保持退出码 0。

## 子命令

| 命令 | 用途 | 插件侧调用点 |
|---|---|---|
| `review <file>` | 对成稿跑规范体检，返回 14 项检查结果与违规明细 | `/gzh-review`、`/gzh-status`、`acceptance.mjs` |
| `topics add <标题> --cat <类别> --angle <角度>` | 选题入库，自动查重 | `/gzh-topic-add` |
| `topics list` | 列出候选 | `/gzh-topics` |
| `topics stale` | 列出挂起过久的选题 | 候选挂起提醒 |
| `topics check <标题>` | 近 7 天查重，不入库 | `/gzh-topic-check` |
| `topics check-batch --file <标题数组.json>` | 一次进程批量查重 | 扫描阶段（避免逐条起进程） |

## 目录约定

| 路径 | 内容 |
|---|---|
| `$GZH_AGENT_HOME/gzh.py` | CLI 入口 |
| `$GZH_AGENT_HOME/rules/rules.md` | 人可读改、机器可执行的规则文件 |
| `$GZH_AGENT_HOME/data/topics.md` | 选题库（Markdown 表格） |
| `$GZH_STUDIO_HOME/config.json` | 工作区配置，结构见 `examples/config.example.json` |
| `$GZH_STUDIO_HOME/state/` | 运行时状态：`pipeline.json` / `candidates.json` / `last_scan.json` / `reader_gate.json` |

## 规则文件

`rules/rules.md` 是账号自己的资产：立场口径、文风标准、查重窗口、格式要求。本仓库不提供作者自用版本，只给 `examples/rules.example.md` 空白模板。规则参数与代码解耦，改规则不需要改插件。

## 可选依赖

`dsh-studio/studio/build.py` 负责确定性阶段（信息图渲染、封面处理、HTML 组装、规范校验）。它从 `config.json` 读路径，Pillow 与浏览器路径都放在配置里，代码本身不绑定任何本机目录。
