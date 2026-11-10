# docs/plan.md — gzh-agent DSH 插件决策追踪

## ① 需求捕获
- 一句话目标：在 DSH 里用 `/审稿体检` `/选题入库` `/选题查重` 三条命令调用 gzh-agent 业务内核，不重复实现业务。
- 能力面：命令/工具（command-tool 配方）。无 UI、无 HTTP、无定时（后两者属后续迭代）。

## ② 形态与分发
- 形态：**pure Cordis**（纯后端命令；无 UI 不需要 bundle-client；配置热更免重启）。
- 分发：本地目录（自用 MVP；git 源分发留到开源决策后）。
- 包管理器：pnpm。

## ③ 装配
- command-tool 配方：4 条命令（含 gzh-hello 冒烟），全部在 ctx.effect() 内注册并返回 disposer。
- inject = []（只用核心内置 ctx.command；无服务依赖）。
- **降级决策**：build = copy（src/index.js → lib/index.js），不用 esbuild/TS。理由：插件零 npm 依赖，只用 node 内置模块；esbuild 原生二进制在沙箱/受限环境安装易失败，且本插件无类型编译需求。lib/index.js 合同不变。
- 命令 → CLI 转发：execFile(python, ['gzh.py', ...])，cwd=业务内核目录；PYTHONIOENCODING=utf-8 防 Windows GBK 乱码；超时 60s；失败时回传 stderr 前 800 字符。
- 环境变量 GZH_AGENT_HOME / GZH_PYTHON 可覆盖默认路径。

## ④ 验证
- [x] pnpm run bundle（copy 完成）
- [x] pnpm run gates（pure 合同 PASS，2026-11-02 升级：新增 bundle manifest / inject / 命令名 ASCII 三项实机教训检查）
- [x] skill verify_plugin.py 结构校验（11/11 PASS）
- [x] Node→Python 桥接功能冒烟（execFile/UTF-8/查重命中 t008）
- [x] **DSH 实机激活（2026-11-02）**：npm 版 0.1.7-rc.2 独立实例（./dsh-home，独立 DSH_HOME），plugin add 挂进 web profile，修复 3 个实机问题（inject=["commands"]、命令名 ASCII、内联 brand）后启动 stderr 零告警
- [ ] /gzh-hello 键入冒烟：服务已就绪，待 sylvan 在 Web UI 输入（命令执行走 UI 通道，headless 一次性任务需模型 key）

## ③a 装配修订（2026-11-02 实机）
- inject = ["commands"]（原假设 inject=[] 错误：ctx.command/ctx.commands 是需注入的服务）
- API 形态：ctx.commands.register({definitionId, name, description, input?, recordInput, handler})，handler 返回 {kind:'success'|'error', text}，参数在 invocation.rawInput
- 命令名 ASCII 化：gzh-hello / gzh-review / gzh-topic-add / gzh-topic-check（COMMAND_NAME 硬约束），中文入描述
- CommandDefinitionId 内联（宿主包不可从插件位置 import；其运行时为恒等字符串）
- 无参命令省略 input（hint 空串被拒）

## ⑤⑥ 安装与发布
- 本地目录安装命令见 README。git 源分发暂缓。
