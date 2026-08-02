# tcode

极简交互式 SWE agent CLI(常驻 REPL,LLM ⇄ 工具循环读写当前项目目录)。详见 [spec.md](spec.md)。

## 权威文档

- **[spec.md](spec.md)** —— 设计权威来源。所有架构/行为决策都应该能在这里找到依据。
- **[criteria.md](criteria.md)** —— 验收标准,`spec.md` 的可执行版本,每条对应可打勾的断言。
- **`doc/`** —— 解释性文档,**不是决策来源**。讲"为什么这么设计、模块之间怎么串",方便读代码时对照。和 spec.md 冲突时以 spec.md 为准,并且要回头修 `doc/`。
  - [doc/memory-design.md](doc/memory-design.md) —— 记忆的分层结构、`remember` 的安全设计(为什么没有 `path` 参数)、截断策略与时机
  - [doc/context-design.md](doc/context-design.md) —— 完整历史/发送视图分离、token 预算、三级降级、compaction 的触发时机与切分点约束
  - [doc/trace-and-viewer.md](doc/trace-and-viewer.md) —— trace 为什么和 session 分开、事件格式、viewer 为什么不用 Electron

**硬规则:代码里出现的行为,spec.md 必须先有对应决策。** 实现中如果发现 spec.md 没覆盖的情况(新的边界 case、和已有决策冲突的地方),先更新 spec.md 再写代码,不要边写边悄悄拍板——spec.md 和代码不同步是这个项目最容易出问题的地方。

## 当前状态

**spec §7 的模块已全部实现,v1 主链路跑通**:`npm run dev` 能进 REPL,完成"建文件 → 跑命令 → finish"的完整 turn,`--continue`/`--resume`/`--full-auto`/`spawn_agent`/bash 审批都已实跑验证过(用 DeepSeek)。

`criteria.md` 第 1-7 节还剩 2 条没打勾,都卡在**缺 Anthropic key**(本机 `.env` 里 `ANTHROPIC_API_KEY` 是空的):两个 provider 各跑一遍同一任务、跨 provider 恢复 session 的提示。补上 key 之后直接实跑即可,代码侧不需要改。

第 8 节(测试基础设施)还差:`tests/fixtures/` 的 adapter 录制回放、`tests/e2e/smoke.test.ts`、CI 配置——对应 spec §12.1 的第 3、4 层,按设计本来就排在单测/loop 测试之后。

已实现的模块与 spec §7 的对应关系,除 §7 列表外多了两个(都已在 spec 里补过决策):
- `config.ts` —— 数值配置集中解析(§8.2)
- `prompt.ts` —— system prompt 拼装(§10),主/子 agent 共用

## 每个模块做完之后

1. 对照 `criteria.md` 里对应小节,把能验证的条目从 `- [ ]` 改成 `- [x]`。不要攒到最后一次性打勾。
2. 单元测试跟实现同步写(spec §12.5),不是写完全部功能再补测试。
3. 涉及 `agent.ts`/`llm/`/`approval.ts`/`executor.ts` 这几个核心耦合点的改动,必须跑一遍 spec §12.2 的 agent loop 场景测试清单(尤其是"finish 与其他 tool_use 混在同一响应"那条回归锁)。

## 测试

测试框架用 **vitest**(轻量、不需要额外服务),`npm test` 跑全部。目前 116 条全绿,全部离线、不接网络:

- `tests/unit/` —— security / session / config / edit_file / tools(read/write/bash/finish/截断)/ approval / memory + prompt / spawn_agent 的 role 映射 / 两个 adapter 的往返转换
- `tests/loop/agent-loop.test.ts` —— spec §12.2 的 8 条场景全覆盖(含"finish 与其他 tool_use 混在同一响应"那条回归锁),外加单条 tool_result 截断、历史裁剪、子 agent bash 仍走审批

写新测试按 spec §12.4 的目录结构放。

## 配置放哪儿(spec §8.2)

优先级从高到低,`process.loadEnvFile()` 不覆盖已存在的键,所以"先加载的赢":

1. 真实环境变量 —— `PROVIDER=anthropic tcode` 这种一次性覆盖
2. `<项目根目录>/.env` —— 只对这个项目生效
3. `~/.tcode/.env` —— 全局默认,API key 放这里

本机已经配好 `~/.tcode/.env`(deepseek)。**不要**建议用户往 `~/.zshrc` 里 export API key——那是早期方案,已经明确废弃。

## 常用命令

```
npm run dev      # tsx src/index.ts,开发模式跑 REPL
tcode --view     # 在浏览器里查看某次会话的完整经过(含子 agent 内部过程)
npm run build    # tsc 编译到 dist/
npm test         # vitest run,单测 + loop 场景测试
npm run test:watch
```

## 手工验证 REPL 时的坑

用管道喂输入(`printf '...' | npm run dev`)只能验证不需要交互的路径:stdin 一到 EOF,readline 立刻 close,后面 bash 审批的提问会直接拿到 EOF(按设计降级成"拒绝")。要验证审批的 y/n,得让 stdin 保持打开:

```
{ echo "任务"; sleep 30; echo "y"; sleep 30; } | npx tsx src/index.ts
```
