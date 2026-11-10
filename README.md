# dsh-gzh-studio

**DeepSeekHarness（DSH）的 Cordis 插件**，把公众号内容生产流水线接进 DSH 对话。

两个插件，可单独使用：

| 目录 | 命令数 | 作用 |
|---|---|---|
| `dsh-plugin/` | 4 | 基础适配层：冒烟、成稿体检、选题入库、选题查重。薄转发到业务内核 CLI |
| `dsh-studio/` | 10 | 全自动生产：配置、扫描、候选、确认、状态、进度、结果、强推、自检、读者四问门禁 |

## 这是什么，不是什么

- **是**：一套 DSH 插件的接入实现。命令注册、定时补跑、把结果主动送进会话、进度卡原地刷新、独立结果消息、人工放行门禁。
- **不是**：独立 Agent。不自带模型、不自带 agent 循环、不自带权限层与界面，这些全部借用宿主。
- **不含**：业务内核（`gzh.py` / `core/`）与各账号自己的规则文件、选题数据。本仓库只给接口契约和空白模板。
- **不做**：自动发布。成稿权在人。

## 值得复用的几处实现

1. `inject` 只声明开机即就绪的 `commands` / `timer`。DSH 里 inject 声明的服务未就绪会让插件一直停在 PENDING，`apply` 不执行、命令注册不上、定时不跑。宿主模型等可选服务统一用 `ctx.get()` 在使用处取。
2. 定时任务按「错过补跑」设计。启动 5 秒首查，之后每小时判距上次是否超过 24 小时，时间戳写 `state/last_scan.json`。宿主关机期间插件不存在，补跑补的是下一次开机错过的那一轮，不是后台常驻。
3. 主动送达走官方 surface：`session.append('user/message', ...)` + `ctx.sessions.flush()`，结果直接出现在 DSH 对话里。找不到会话服务时降级为只写 state。
4. 进度卡用 `surfaceOp: {op:'replace', startSeq, endSeq}` 链式覆盖上一节点；结果另发一条独立消息，避免被进度卡折叠或划走。
5. 形式检查之外留一道人工门禁 `/gzh-gate`：四问逐条作答（能不能全自动 / 运行结果怎么样 / 我能不能用 / 如何使用），按 `finished_at` 绑定成品，新生产一次需重新放行。

## 前置条件

- DSH `0.1.7-rc.2` 或更高（整仓 MIT，插件 SDK 无独立协议与额外分发条款；2026-11-01 核实）
- Node.js（ESM）、Python 3、Pillow
- 一个实现 `docs/INTEGRATION.md` 所述 CLI 契约的业务内核

## 快速开始

```bash
git clone https://github.com/SylvanXiao/dsh-gzh-studio.git
cd dsh-gzh-studio
cp examples/config.example.json ./studio/config.json
# 按 docs/INTEGRATION.md 准备业务内核，然后设置环境变量
export GZH_AGENT_HOME=/path/to/your/kernel
export GZH_STUDIO_HOME=/path/to/your/studio
```

在 DSH 的 profile 中登记插件（两种方式都要写）：

- `package.json` 的 `dependencies` 加 `"gzh-studio": "link:<CLONE_PATH>/dsh-studio"`
- `dsh.profile.bundles` 加包名 `gzh-studio`

Windows 下 `link:` 目标必须是原生 Junction，Git Bash 的 `ln -s` 生成 MSYS 软链，Node 跟随不了。插件代码改动后需完全退出并重启 DSH 才生效。

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `GZH_AGENT_HOME` | 业务内核目录 | `./gzh-agent` |
| `GZH_STUDIO_HOME` | 工作区配置目录（含 `config.json` 与 `state/`） | `./studio` |
| `GZH_PYTHON` | Python 解释器 | `python` |
| `GZH_SCAN_ON_STARTUP` | 启动后是否首查，设 `0` 关闭 | `1` |
| `GZH_SCAN_INTERVAL_HOURS` | 距上次检索超过多少小时触发补跑 | `24` |

本仓库已把作者自用版本里硬编码的本机绝对路径全部改成上表的相对默认值。逻辑未改，配置路径以环境变量为准。

## 自检

开箱可跑，不依赖任何本机配置：

```bash
cd dsh-plugin && node scripts/gates/run.mjs     # 纯形态合同检查
```

`dsh-studio/scripts/` 下的 QA 脚本是作者自用回归工具，需要一份完整的 `config.json` 作测试基线。`examples/config.example.json` 只是结构骨架，跑 QA 前请按 `docs/INTEGRATION.md` 补全字段：

```bash
cp examples/config.example.json ./studio/config.json
export GZH_STUDIO_HOME=./studio
export GZH_AGENT_HOME=./gzh-agent
cd dsh-studio && node scripts/qa-inject.mjs          # inject 门禁 20 项
cd dsh-studio && node scripts/qa-gate.mjs            # 读者四问门禁
cd dsh-studio && node scripts/acceptance.mjs         # 不进 DSH 的一键放行验收
```

`acceptance.mjs` 只做静态与状态检查。新插件在 DSH 未完全重启前不会生效，验收会如实报 WARN，不会伪装成绿灯。

## 协议

MIT。作者自用版为私有仓库，本仓库只公开 DSH 插件层。
