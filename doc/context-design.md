# Context 管理设计(含 compaction)

> **这是解释性文档,不是决策来源。** 权威决策在 [spec.md](../spec.md) §3.1;这份文档解释"为什么这么设计、什么时候发生什么"。两边冲突时以 spec.md 为准,并且应该回头修这份文档。
>
> 相关:[memory-design.md](memory-design.md) —— memory 是**跨 session 的沉淀**,这份文档讲的是**单 session 内的压缩**,两者不是一回事。

---

## 1. 唯一的核心不变量

**`session.messages` 是完整、不可破坏的真相。所有裁剪只作用于"这一次发给模型的视图"。**

```
session.messages         完整历史,永不裁剪,原样落盘
        ↓  buildSendView(session, budget)   —— 纯函数,不改 session
发给 llm.send() 的 messages    可能带摘要、可能省略了旧的 tool_result
```

这条不变量是整个模块存在的理由。早期版本没有它——直接就地覆写 `session.messages` 再落盘,结果是:

- 被裁掉的工具输出**永久丢失**,`--continue` 回来也拿不回
- 换一个 context 更大的模型也救不回来,因为磁盘上的数据已经没了
- 那不是 context 管理,是数据丢失

现在 `context.ts` 里所有函数都是纯函数,不碰 session。唯一会写回 session 的是 compaction 的**摘要缓存**,而它是**追加**的,不删任何 message。

`tests/loop/agent-loop.test.ts` 的 "omits old tool output from the REQUEST without touching session.messages" 锁死了这条:断言请求里出现了省略标记,同时断言落盘的三条 tool_result 一个字节都没少。

## 2. Memory 算不算 context?

这是最容易混淆的一点,因为 "context" 在这个项目里有**两个不同的含义**:

| | Memory 算不算 |
|---|---|
| **Context window** —— 物理层面,一次请求发给模型的全部内容 | **算。** 记忆拼进 system prompt,每一轮请求都带着,实打实占窗口 |
| **Context 管理** —— 模块层面,`context.ts` 做的事 | **不算。** 记忆从不经过 `buildSendView`,不会被省略、也不会被 compaction 压缩 |

一句话:**记忆消耗 context,但不归 context 管理模块管辖。**

```
                   ┌─────────── context window ───────────┐
每次请求发送的内容 = │ system prompt (含 memory) │ 对话历史 │
                   └───────────────────────────┴──────────┘
                        ↑                          ↑
                   memory.ts 管                context.ts 管
                   启动时读一次,之后固定        每轮重建视图,可省略/可压缩
```

两者的交汇点在预算计算:

```
historyTokens = 窗口 × threshold − 预留输出 − system prompt 的 token 数
                                              ↑ 记忆的开销在这里被扣掉
```

所以**记忆和对话历史是此消彼长的**:记忆写得越多,留给对话的空间越少。实测(deepseek 65536 窗口):

```
无记忆时          historyTokens = 40593
16000 字符记忆时  historyTokens = 36497   (正好少 4096)
```

这就是 `MEMORY_MAX_TOKENS` 存在的理由——没有它,一个几千行的 `AGENTS.md` 能把对话预算挤到接近 0。

**预算不够时会在启动时报警**(spec §3.1)。三项加起来可能超过窗口本身,这时 `historyTokens` 被兜底到 0,每次请求都退化到最省略的形态——"能跑但很傻",而用户不知道为什么。所以启动时校验一次,低于 `MIN_USABLE_HISTORY_TOKENS`(默认 2000)就把算式**每一项**列出来:

```
warning: no context left for conversation history — every request will be maximally degraded.
  context window            8000
  × COMPACT_THRESHOLD 0.75   = 6000
  − RESERVED_OUTPUT_TOKENS  8192
  − system prompt           390
  = history budget          0
  → RESERVED_OUTPUT_TOKENS is eating most of the window; lower it.
```

最后一行会指出**当前最该调的那个参数**(预留输出占比过半 / 记忆占比过大 / 窗口本身太小),而不是让用户自己算。不退出进程——窗口小不代表不能用,短对话仍然能正常工作,继不继续由用户决定。

记忆本身的加载、分层和截断策略见 [memory-design.md](memory-design.md)。

## 3. 为什么按 token 而不是字符

字符数和 context 上限**没有对应关系**:

| 文本 | 字符数 | 大致 token 数 |
|---|---|---|
| `hello world this is a test` | 26 | ~6 |
| `你好世界这是一个测试` | 10 | ~10 |

中文尤其离谱:一个汉字 1 个字符但通常算 1 个 token,而 4 个 ASCII 字符才 1 个 token。同样"20000 字符"的预算,英文能装 5000 token,中文要装 20000 token——差 4 倍。按字符设阈值,要么英文场景白白浪费 3/4 的窗口,要么中文场景直接撞墙报错。

### 估算器的取舍

`tokens.ts` 是**启发式**的,不引 tiktoken 之类的依赖:

- 对一个 minimal CLI 来说 tokenizer 太重
- 各家 provider 的 tokenizer 本来就不一样,引一个也只是"对某一家准"
- 我们只需要"context 有多满"这个量级正确,足够及时触发压缩就行

规则:CJK/全角字符按 1 token/字,其余按 1 token/4 字符,再加上每条消息和每个 block 的固定开销。

**刻意高估。** 低估会直接撞 API 上限、请求失败;高估只是提前一点压缩。两种错误的代价不对称,所以偏向保守那边。

## 4. 预算怎么算

```
historyTokens = contextWindowTokens × COMPACT_THRESHOLD
                − RESERVED_OUTPUT_TOKENS
                − system prompt 的 token 数
```

- `contextWindowTokens`:**provider 的属性**,不是全局默认值(anthropic 200000 / deepseek 65536)。差别太大,写死一个必然要么浪费要么撞墙。可用 `CONTEXT_WINDOW_TOKENS` 覆盖。
- `COMPACT_THRESHOLD`(默认 0.75):留 25% 余量,因为估算器不精确。
- `RESERVED_OUTPUT_TOKENS`(默认 8192):模型的回复也要占窗口,这部分不能算进历史预算。
- system prompt 每轮都要发,所以要从预算里扣掉。

预算在**每个 turn 开始时算一次**(system prompt 在进程生命周期内固定),不是每轮工具循环都重算。

## 5. 三级降级

超预算时依次尝试,**能在低级别解决就不上高级别**:

| 级别 | 做什么 | 发生在哪 | 会写盘吗 |
|---|---|---|---|
| **1. 单条截断** | 单条 tool_result 超 `MAX_OUTPUT_CHARS` 时首尾各留一半 | 工具执行时 | **会** |
| **2. 视图内省略** | 从最旧开始,把 tool_result 内容换成 `[omitted, original content was N chars]` | 构建视图时 | 不会 |
| **3. Compaction** | 调一次 LLM 把最旧的一批消息压成摘要 | 构建视图后 | 只写摘要缓存 |

第 1 级是**唯一**会进 `session.messages` 的截断——超大的工具输出本身就不该进历史,首尾各留一半已经能保住"开头的命令"和"结尾的报错"这两个最有用的部分。

第 2 级只影响这次请求。**注意它只能省略 `tool_result`**——`text` 和 `tool_use` 省不掉(省了模型就不知道自己说过什么、调过什么了)。所以当体积主要在对话文本或工具入参里时,第 2 级救不了场,必须上第 3 级。

> 这一点我在写测试时踩过:最初想用"超大 tool_result"触发 compaction,结果永远触发不了——因为第 2 级正好把它省略掉了。测试里改成把体积放进 `tool_use` 的入参才真正走到第 3 级。

## 6. 时机:compaction 到底什么时候发生

```
runTurn 开始
  └─ 算预算(一次)
  └─ for 每一轮工具循环:              ← 注意是每一轮,不是每个 turn 一次
       ├─ buildSendView(session, budget)
       │    ├─ 完整视图放得下?         → 直接发,level = "full"
       │    ├─ 省略旧 tool_result 够?  → 发省略版,level = "omitted"
       │    └─ 还是放不下?             → needsCompaction = true
       │
       ├─ 若 needsCompaction:
       │    ├─ 调 LLM 生成摘要(一次额外的、不带 tools 的请求)
       │    ├─ 成功 → 写入 session.compactions,立刻重建视图,同一轮继续
       │    └─ 失败 → 打印警告,退回第 2 级的视图,turn 不中断
       │
       └─ llm.send(view.messages, ...)
```

几个容易误解的点:

**compaction 可能在一个 turn 的中间发生。** 视图是每一轮工具循环重建的,不是每个 turn 一次。一个 turn 里连读三个大文件,完全可能在第三轮时触发压缩。

**触发条件是三个条件同时成立**,不只是"超预算":

1. 完整视图超预算,且
2. 省略掉旧 tool_result 之后**仍然**超预算,且
3. 新的切分点比已有摘要覆盖的范围更远(`cutIndex > alreadyCovered`)

第 3 个条件是防死循环的:如果已经压到不能再压,再压一次也不会释放空间,那就别浪费一次 LLM 调用。

**compaction 自己要花一次 LLM 调用。** 它是一次独立的、`tools: []` 的请求(所以测试里可以用 `tools.length === 0` 认出它)。这次调用不计入 `MAX_TOOL_ITERATIONS`。

**失败不中断 turn。** 摘要那次调用如果报错(网络、限流、模型返回空),打印一行警告,退回第 2 级的视图继续跑。用户的任务不该因为"压缩失败"而崩掉。

## 7. 切分点为什么必须闭合

这是 compaction 里最容易出错、后果最严重的地方。

一条 assistant 消息里的 `tool_use`,必须有后续消息里的 `tool_result` 回填它。如果摘要的切分点落在两者中间:

```
messages[0..k)  ← 被摘要替换掉,其中包含 tool_use(id=t1)
messages[k..]   ← 保留,但 t1 的 tool_result 在这里面
                   或者更糟:tool_use 留下了,tool_result 被摘要吃掉了
```

下一次请求就是一个**悬空的 tool_use**,API 直接报错。这和 spec §3 里"消息历史必须闭合"是同一个坑——那条讲的是 `finish` 不能提前 break,这条讲的是摘要不能乱切。

实现上:

```
preferred = messages.length − COMPACT_KEEP_RECENT
cutIndex  = 从 preferred 往回找,第一个"所有已发起的 tool_use 都已回填"的位置
```

`isClosedAt(messages, i)` 扫描 `[0, i)`,遇到 `tool_use` 记下 id、遇到 `tool_result` 划掉 id,最后集合为空才算闭合。找不到就返回 0,意思是"这次不压缩"——宁可不压,不能压坏。

`tests/loop/agent-loop.test.ts` 的 "never cuts between a tool_use and its tool_result" 对每一条 compaction 断言 `danglingToolUseIds(messages.slice(0, upToIndex))` 为空。

## 8. 摘要缓存:为什么不删原文

`session.compactions` 记的是:

```jsonc
{ "upToIndex": 24, "summary": "…", "tokensBefore": 41000, "createdAt": "…" }
```

含义是"`messages[0, 24)` 这段,发给模型时可以用 `summary` 代替"。**`messages` 一条都不删。**

这样有三个好处:

1. **不用每轮重算摘要。** 缓存住了,后续请求直接复用,省钱省时间。
2. **完整历史仍在。** 想回头看当时到底发生了什么,原文都在。
3. **`compactions` 整个删掉也没事。** 它是纯缓存,删了只是下次重新算一遍,不丢任何信息。

同一个 session 可能有多条 compaction(压了又压),生效的是 `upToIndex` 最大的那条——后面的摘要覆盖范围包含前面的。

## 9. 可观测性

context 状态**不能悄悄发生**。用户看得到的:

```
› ⋮ read big1.txt
  ⋮ read big2.txt
  ⋯ older tool output omitted from this request to stay within context
  ⋮ read big3.txt
  ✓ finish (done)

  [context 2.2k/6.0k]
```

- 每轮 turn 结束显示用量
- 第 2 级触发时打印一行(每个 turn 只打一次,避免刷屏)
- compaction 触发时打印"正在压缩 N 条",完成后打印新的用量
- compaction 失败时打印警告和原因

## 10. 代码位置

| 文件 | 职责 |
|---|---|
| `src/tokens.ts` | 启发式 token 估算 + `formatTokens` 显示格式 |
| `src/context.ts` | `computeBudget` / `buildSendView` / `isClosedAt` / `findCutIndex` / `activeCompaction` / 摘要用的 prompt 和 transcript 渲染。**全是纯函数** |
| `src/agent.ts` | `compact()` —— 唯一会调 LLM 生成摘要、并写回 `session.compactions` 的地方;turn 循环里的触发逻辑 |
| `src/session.ts` | `Compaction` 类型 + `compactions` 字段 |
| `src/config.ts` | `COMPACT_THRESHOLD` / `COMPACT_KEEP_RECENT` / `RESERVED_OUTPUT_TOKENS` / `MAX_OUTPUT_CHARS` |
| `src/llm/providers.ts` | 各 provider 的 `contextWindowDefault` |

## 11. 已知限制

- **token 是估算的,不是精确值。** 估算器偏保守,但极端情况(大量 emoji、罕见 Unicode)仍可能偏差较大。真撞上 API 上限时,现在没有"收到 context 超限错误后自动重试更小的视图"这一层兜底。
- **compaction 是一次性的粗粒度摘要。** 压过的内容再压一次只会摘要摘要,信息逐层损失。分级摘要(让很久以前的事保留粗粒度印象)属于后续增强(spec §11)。
- **摘要质量取决于模型。** 用小模型跑 compaction 可能丢关键细节。目前用的是当前配置的同一个 provider/model,没有为摘要单独配一个更便宜或更强的模型。
- **第 2 级只能省略 `tool_result`。** 如果 context 被超长对话文本撑满,只能靠第 3 级。
- **实跑验证覆盖到第 2 级,第 3 级只在测试里验证过。** 见下。

## 12. 验证状态

| 行为 | 单测/loop 测试 | 真实模型实跑 |
|---|---|---|
| 完整历史不被破坏 | ✅ | ✅(落盘 8004 字节一个不少) |
| 第 2 级省略 | ✅ | ✅(`⋯ older tool output omitted`) |
| 用量显示 | ✅ | ✅(`[context 2.2k/6.0k]`) |
| 第 3 级 compaction 触发并缓存摘要 | ✅ | ❌ 未实跑触发 |
| 切分点不拆散 tool_use/tool_result | ✅ | ❌ |
| 摘要失败降级不中断 turn | ✅ | ❌ |

第 3 级没实跑触发,是因为实测场景里第 2 级的省略就足够把用量压下来了(够用就不会升级)。要真实触发需要构造"大量不可省略内容"的场景——比如一段超长的纯对话。
