# Trace 与 Viewer 设计

> **这是解释性文档,不是决策来源。** 权威决策在 [spec.md](../spec.md) §13。
>
> 相关:[context-design.md](context-design.md) —— session 为什么要瘦;这份文档讲 trace 为什么要肥。

---

## 1. 为什么不能只用 session

做可视化时最容易想当然的一步,是"直接渲染 `session.json` 就好了"。不行,因为 session 里根本没有思考过程。

实测同一次运行(主 agent 委派了一个 explore 子 agent):

```
session.json  消息数: 6   含子 agent 内部过程: 否
trace.jsonl   事件数: 34  含子 agent 内部过程: 是 (depth>0)
```

差的那 28 个事件,恰好是最值得看的部分:

- **子 agent 的完整内部过程**——spec §5.6 明确规定它**不进 session**(这正是委派的目的:保护主 context)。但对人来说,"子 agent 到底搜了什么、怎么得出结论的"才是关键信息。
- **时间**——每次请求耗时、每个工具执行耗时。session 里一个时间戳都没有。
- **审批决策**——用户批准了还是拒绝了。session 里只有一条 `user declined to run this tool` 的 tool_result,看不出这是策略拦下的还是人拒绝的。
- **context 事件**——什么时候触发了省略、什么时候压缩了、压掉了多少。

两者职责相反,所以必须是两个文件:

```
.tcode/sessions/<id>.json    发给模型的上下文真相 —— 要瘦,会被裁剪,会被 compaction 改写视图
.tcode/traces/<id>.jsonl     实际发生了什么     —— 要全,带时间戳,只追加不修改
```

**先有 trace 才谈得上可视化。** 没有它,做多漂亮的 UI 都没有数据可显示。

## 2. 事件格式

JSONL,每行一个对象。公共字段:

```jsonc
{ "seq": 12, "t": 1754130000123, "depth": 1, "type": "tool_call", /* 各类型自己的字段 */ }
```

**`seq` 为什么必要**:毫秒时间戳的精度不足以稳定排序——同一毫秒内可能有多个事件。viewer 需要确定的顺序,所以用单调递增的序号。重开 trace 时(`--continue`)会**接着上次的序号**数,不从 0 重来。

**`depth` 为什么这么设计**:子 agent 的事件**写进同一个文件**,靠 `depth` 区分层级。另一种做法是每个子 agent 一个文件,但那样 viewer 得自己拼接、还要解决"子 agent 的事件插在主 agent 的哪两个事件之间"——用一个共享序号的单文件,这个问题不存在。

实跑的效果(缩进即 depth):

```
 5 tool_call · spawn_agent
 6 subagent_start · explore
 7   turn_start
 8   request_start
 9   request_end · 7235ms tools=1
10   tool_call · bash
11   tool_result · bash ok=true 13ms
...
22   turn_end · finished 17164ms 363tok
23 subagent_end · explore finished
24 tool_result · spawn_agent ok=true 17164ms
```

## 3. 追踪失败绝不能拖垮 turn

这是 `trace.ts` 里唯一需要小心的地方:**追踪是辅助功能,不是关键路径。**

磁盘满、权限不对、文件被别的进程占住——任何写入失败都:

1. **只警告一次**,然后把这个 sink 标记为 broken 静默降级。不然一次 `cat` 大文件就能刷出几百行 "tracing failed"。
2. **绝不向上抛异常**。`emit()` 内部 try/catch 兜住一切。

`tests/unit/trace.test.ts` 里有两条测试锁死这一点:一条把 trace 文件替换成目录制造写入失败,断言 `warn` 只被调用一次;另一条断言 `emit()` 在这种情况下不抛。

读取端同样宽容:`readTrace` 跳过解析失败的行,不让整次读取失败——被 `kill -9` 截断的最后半行不该导致整个 trace 打不开。

## 4. Viewer:为什么不用 Electron

**结论:不需要。**

- Electron 的价值在系统托盘、原生菜单、桌面分发、跳出浏览器沙箱访问系统——这个场景**一个都不占**。
- 渲染层它同样是 Chromium,画面上相对浏览器**没有任何优势**,但要背 ~150MB 打包体积、独立构建链路、签名和自动更新。
- 数据已经是磁盘上的 JSONL。需要的不是一个"应用",是一个"查看器"。

实际方案:`tcode --view` 起一个本地 http server(Node 内建 `http`,**零新依赖**),打印 URL 并尝试打开浏览器。

### 几个具体决策

**端口用 0**,让 OS 挑空闲端口。写死端口迟早撞上 "address in use",而这个工具没有任何需要固定端口的理由。

**页面完全自包含**——CSS/JS 内联,不引 CDN。离线可用,也免得给一个本地工具引入供应链风险。有测试用正则扫描页面里所有非 `127.0.0.1` 的绝对 URL,断言为空。

**实时更新用 SSE 而不是 WebSocket**。单向推送,SSE 够用且简单得多(浏览器端就一个 `new EventSource`,断线自动重连)。服务端每 400ms `stat()` 一次文件,大小变了才重新读——空闲会话的开销就是一次 stat。实测追加事件到页面收到约 400ms。

**只读**。viewer 不提供任何修改会话或发起对话的能力。`/` 和 `/events` 之外一律 404,有测试断言这一点。

**不需要 API key**。查看历史不该要求配置 provider——`--view` 分支在 `resolveProviderConfig()` 之前就 return 了。

## 5. 代码位置

| 文件 | 职责 |
|---|---|
| `src/trace.ts` | `createFileTracer` / `NOOP_TRACER` / `readTrace` / `tracingEnabled` |
| `src/viewer/server.ts` | http server + SSE + 打开浏览器 |
| `src/viewer/page.ts` | 单文件 HTML(CSS/JS 内联) |
| `src/agent.ts` | 在 turn 循环各关键点 `emit` |
| `src/tools/spawn_agent.ts` | `subagent_start`/`end` + 传 `tracer.child()` 给子 agent |

## 6. 已知限制

- **没有轮转/清理。** trace 只增不减,长期使用会累积。目前靠用户自己删 `.tcode/traces/`。
- **`text_delta` 没有逐块记录。** 只记完整的 `assistant_text`,所以 viewer 重放不出"逐字生成"的过程。逐 delta 记录会让文件膨胀好几倍,收益不明显。
- **viewer 只看一个 session。** 没有会话列表页,换 session 要重启 `--view`。
- **SSE 是轮询驱动的**,不是 `fs.watch`。延迟上限 400ms,换来的是跨平台行为一致。
