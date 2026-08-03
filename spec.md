# tcode 设计方案

## 1. 定位

一个极简的交互式 SWE agent CLI:常驻 REPL,每轮接收用户的一条指令,agent 通过一组结构化工具(bash / 读文件 / 改文件)读写当前项目目录来完成任务,直到它认为这一轮做完了就把控制权交还给用户。

设计上参照 [Codex CLI](https://github.com/openai/codex) 和 [opencode](https://github.com/sst/opencode) 的工具化 agent loop 模式。v1 取其核心骨架 + 流式输出 + 单层子 agent 委派,裁掉的是真正的并行多 agent 编排、沙箱、TUI、LSP 等复杂度,保持"minimal";但长期方向是向 Codex / opencode 对齐,裁掉的这些能力是**延后而非放弃**,v1 在几个关键耦合点上预留扩展空间(见第 7 节"扩展点小结"),避免以后对齐时推倒重写。

### 非目标(v1 暂不做,已预留扩展点)

- 沙箱隔离(seatbelt / landlock / container)——bash 工具直接在宿主机 cwd 下执行。用轻量的执行前确认(见 5.1)顶替,而不是自己发明一个简化沙箱;等真要做沙箱时直接参考 Codex 的实现,而不是在此基础上改。
- **真正的并行多 agent 编排**——参考 Codex(`multi_agent_mode`/`fork_thread`)和 opencode 的 subagent 机制,v1 做的是"单层、串行"的子 agent 委派(见新 5.6 `spawn_agent`):主 agent 一次只等一个子 agent 跑完,子 agent 不能再派生孙 agent。真正的并发编排(同时跑多个子 agent、结果聚合、失败重试)、自定义 subagent 角色配置(而不是内置的 `general`/`explore` 两种)留到后续增强。
- **运行时热切换 provider**——v1 支持配置多个 provider(见 8 节,包括 DeepSeek),但一次启动/一次进程只用配置里指定的那一个,换 provider 要改配置重启,不做会话中途 `/provider xxx` 这种热切换。
- TUI / 富终端 UI——普通 stdin/stdout REPL,但 CLI 展示层(`index.ts`)和 agent 引擎(`agent.ts`/`session.ts`/`tools/`)严格解耦,以后换 TUI 时只替换展示层。
- LSP 集成、diff 预览、MCP 等——MCP 工具接入的话,只需要把远程工具注册进现有的工具注册表(见 5 节),不需要改 loop。

## 2. 运行模式

交互式 REPL,以自己的命令名调用(而不是 `npm start`),参照 `codex` / `opencode` 的用法:

```
$ tcode
$ tcode --continue        # 恢复 cwd 下最近一次会话
$ tcode --resume <id>     # 恢复指定会话
$ tcode sessions          # 列出当前目录的全部会话(时间倒序),然后退出
$ tcode --view [<id>]     # 在浏览器里查看某次会话的完整经过(见 13.4)
```

实现方式:`package.json` 增加 `bin` 字段,把命令名注册为可执行入口:

```jsonc
{
  "name": "tcode",
  "bin": { "tcode": "./dist/index.js" }
}
```

- 发布/本地使用:`npm link`(或 `npm i -g .`)后即可在任意目录下直接敲 `tcode`。命令名和包名一致,不用单独记。
  - 早期版本用过单字母的 `t`,已废弃:一个字母的全局命令跟用户已有的工具/alias 撞车概率太高(`t` 在不少人的 shell 里是 `tmux`/`task`/`git log --oneline` 之类的 alias),而且 tab 补全时毫无提示性。宁可多敲四个字母。
- 开发调试时(未 link/未构建):用 `npm run dev`(内部跑 `tsx src/index.ts`)代替,效果等价,但这只是开发方式,不是最终产品的调用方式。
- 启动时锁定 `cwd` 为项目根目录(工作目录范围的基准)。
- 每次用户在 prompt 输入一条消息,agent 内部可能执行多轮"LLM ⇄ 工具"交互(一次 turn),直到没有更多工具调用或模型调用了 `finish`,再打印结果、把提示符还给用户。
- 输入空行 / `exit` / `Ctrl+D` 退出进程。

## 3. Agent Turn 循环

```
function runTurn(session, userInput):
    session.messages.push({ role: "user", content: userInput })

    loop forever:                          # 默认不设上限,见下方 MAX_TOOL_ITERATIONS
        response = llm.send(session.messages, TOOLS, SYSTEM_PROMPT, onTextDelta: print)
                                              # 文本是边生成边通过 onTextDelta 打印的(流式),不是等 response 完整了再打印;
                                              # response 仍然是 send() resolve 之后拿到的完整累积结果,下面的逻辑不用感知是不是流式
        session.messages.push({ role: "assistant", content: response.content })

        toolUses = toolUseBlocksOf(response)
        if toolUses.isEmpty():
            break                            # 模型没有调用工具,turn 结束

        results = []
        for toolUse in toolUses:             # 按顺序串行执行,不并发(避免同批多个写操作互相竞争)
            print(summaryLineOf(toolUse))    # 一行摘要,如 "$ bash: npm test" / "✎ edit src/foo.ts",让用户看到 agent 在做什么
            if needsConfirmation(toolUse) and not confirm(toolUse):
                results.push(userDeclinedResult(toolUse))   # 用户拒绝:回填一个 is_error 的 tool_result,不是静默跳过
            else:
                results.push(execute(toolUse))

        session.messages.push({ role: "user", content: toolResultBlocksOf(results) })
        # 注意:无论本批是否包含 finish,都要先把这批 toolUses 全部执行完、生成对应 tool_result 再决定是否跳出循环。
        # 绝不能在生成 tool_result 之前 break——否则 session 里会留下悬空的 tool_use,--continue 恢复时 Anthropic API 会报错。

        if toolUses.any(t => t.name == "finish"):
            break                            # finish 只是提示性收尾,已回填 tool_result,不再回调 LLM

    session.save()
```

要点:

- **`finish` 的 `status` 是可选的,默认 `done`。** 实跑里模型经常只给 `summary`,于是工具抛错、终端上打出一行红色的 `"status" is required`,而循环仍然按"已完成"收尾——**工具拒绝了循环接受的东西**,用户看到的是绿色的 ✓ 底下压着一条红色报错,自相矛盾。省略 `status` 时唯一合理的解释就是 `done`(`finishPayloadOf` 本来就是这么兜底的),把它设成必填只是在制造这条矛盾。
- **`finish` 是提示性的**,不是进程退出信号。模型调用 `finish(summary, status)` 表示"这轮任务我认为做完了",CLI 打印 summary 并结束当前 turn 的内部循环,但进程继续跑 REPL,等待用户下一条输入。
- **消息历史必须闭合**:一次响应里可能同时出现 `finish` 和其他 tool_use(模型经常这么做,比如先读一下文件再收尾)。循环永远先把该批所有 tool_use 执行完、`tool_result` 全部回填,再判断要不要 break;不能因为看到 `finish` 就跳过其余工具的执行/结果回填,否则下次 `--continue` 会因为 assistant 消息里有未闭合的 tool_use 而直接报错。
- **turn 的工具调用次数默认不设上限。**
  - 早期决策是"默认 50 次,到了强制中断,防止死循环烧 token"。**已推翻。** 实跑撞到的是这样一轮:让它把整个项目改成 TypeScript + React,50 次调用全是有效工作(读文件、写 `.tsx`、改 state),干到一半被闸刀砍掉,留下一个改了一半、两种写法混在一起的仓库——比"烧掉一些 token"糟糕得多。大改造需要几十上百次工具调用是常态,不是异常。
  - 这条决策当初成立,是因为**那时候没有中断手段**,计数器是唯一的刹车。现在 `Esc` 能随时停(见 3.2)、steering 能中途改方向、context 到阈值会自动压缩,计数器不再是唯一的刹车,而它砍掉正常工作的代价一直都在。
  - 计数器本来也拦不住真正的死循环:模型反复"改一次 → 测失败 → 改回去"这种,50 次照样跑满,只是把烧钱换成了半成品。
- **`MAX_TOOL_ITERATIONS` 保留成可选上限**,默认不设(`0`/未设置 = 无限)。给无人值守的场景用:CI、脚本、`--full-auto` 跑批。设了就仍然按老行为在到达时中断并提示。
- **代替计数器的是可见性**:每 `PROGRESS_EVERY_ITERATIONS`(默认 25)次工具调用打一行进度(已调用次数、累计 token、怎么停),让长跑「看得见」而不是「被砍断」。无人值守时这行进入日志,有人值守时它就是按 Esc 的依据。
- 工具执行报错时,以 `is_error: true` 的 tool_result 形式喂回给模型,让它自己决定重试或改变策略,而不是让进程崩溃。
- `bash` 默认需要用户确认才会执行(见 5.1);`needsConfirmation`/`confirm` 是独立的 policy 函数(`approval.ts`,见 7 节),不写死在循环里。`--full-auto` 启动参数可以让 `needsConfirmation` 恒为 false,跳过确认。
- **流式是 v1 就要有的接口设计**,不是事后加的开关(见 8.1)。`llm.send()` 统一接受 `onTextDelta` 回调,不管 adapter 内部是不是真流式:真流式的 adapter(Anthropic 优先做)边收边调回调;还没做流式的 adapter 可以先整段收完一次性调用回调兜底——`agent.ts` 的调用方式不用因为某个 provider 还没支持流式而分叉。
- **Context 管理见 3.1**——长 session 的 `messages` 会持续增长,这是独立的一块,不是循环里顺手做的事。

### 3.1 Context 管理

核心原则:**`session.messages` 是完整、不可破坏的真相,裁剪只作用于"这一次发给模型的视图"。**

早期版本的做法是就地覆写 `session.messages` 再落盘——那不是 context 管理,是数据丢失:被裁掉的工具输出永久没了,`--continue` 也拿不回来,换一个 context 更大的模型也救不回来。现在的分层是:

```
session.messages         完整历史,永远不被裁剪,原样落盘
        ↓  buildSendView(session, budget)   —— 纯函数,不改 session
发给 llm.send() 的 messages    可能带摘要、可能省略了旧的 tool_result
```

**预算怎么算**(`context.ts`):

- 按 **token 估算**而不是字符数。字符数和 context 上限没有对应关系,中文尤其离谱(一个汉字 1 个字符,但通常算 1 个 token,而 4 个 ASCII 字符才 1 个 token)。
- 估算器是启发式的,不引 tokenizer 依赖(tiktoken 之类对一个 minimal CLI 太重,而且各家 tokenizer 还不一样):CJK/全角字符按 1 token/字,其余按 1 token/4 字符,**宁可高估**——低估会直接撞 API 报错,高估只是早一点压缩。
- 预算 = `CONTEXT_WINDOW_TOKENS × COMPACT_THRESHOLD − 预留输出`。`CONTEXT_WINDOW_TOKENS` 默认值按 provider 给(见 8.2),可配置覆盖。
- 统计**所有** block(text / tool_use / tool_result),不是只算 tool_result——纯对话和模型的长篇输出同样会撑爆 context。

**超预算时的三级降级**,依次尝试,能在低级别解决就不上高级别:

1. **单条截断**(已有,见 5.1):单条 tool_result 超 `MAX_OUTPUT_CHARS` 时首尾各留一半。这一级发生在工具执行时,是唯一会写进 `session.messages` 的截断——因为超大输出本身就不该进历史。
2. **视图内省略**:从最旧开始,把 tool_result 的内容在**视图里**替换成 `[omitted, original content was N chars]`。只影响这次请求,`session.messages` 不动。
3. **Compaction(摘要)**:仍然超预算时,调一次 LLM 把最旧的一批消息压成一段摘要。

**Compaction 的几个硬约束**:

- **切分点必须闭合**:绝不能把 assistant 消息里的 `tool_use` 和后面回填它的 `tool_result` 拆到摘要边界两侧,否则下次请求就是一个悬空 tool_use,API 直接报错(和 3 节"消息历史必须闭合"是同一个坑)。切分点只能落在"所有已发起的 tool_use 都已回填"的位置。
- **摘要结果缓存进 session,原文不删**:session 增加 `compactions` 字段(见 4 节)记录 `{ upToIndex, summary }`,`messages` 一条不少。这样既不用每轮重新调 LLM 算摘要,又保住了完整历史。
- **保留最近的消息不压缩**:至少保留最后 `COMPACT_KEEP_RECENT` 条(默认 8),否则模型会丢掉正在做的事的上下文。
- **摘要失败不能让 turn 挂掉**:摘要那次 LLM 调用如果报错,降级回第 2 级(视图内省略)并打印提示,不中断用户的 turn。

**可观测性**:用户必须能看见 context 状态,不能悄悄发生。每轮 turn 结束在提示符上方显示用量(如 `[context 12.3k/64k]`),触发省略或 compaction 时各打印一行说明。

**预算不可用时必须报警,不能静默降级。** `historyTokens` 的算式是"窗口 × 阈值 − 预留输出 − system prompt",三项加起来可能超过窗口本身(窗口配得太小、记忆写得太多、或两者叠加),这时预算会被兜底到 0。此时每一次请求都退化到最省略的形态,行为看起来"能跑但很傻",而用户完全不知道发生了什么。

所以启动时要校验一次:预算低于 `MIN_USABLE_HISTORY_TOKENS`(默认 2000,见 8.2)时打印明确警告,**把算式里的每一项都列出来**(窗口多大、阈值多少、预留多少、system prompt 占了多少、其中记忆占了多少),让用户能直接看出该调哪个参数。

不退出进程——窗口小不代表不能用,短对话仍然可以正常工作,是否继续由用户决定。

### 3.2 中断与执行期间的输入

v1 早期的 REPL 在一个 turn 跑完之前完全不接受输入,而且没有任何中断机制。实际用起来有三个后果,都很伤:

- 模型跑偏了只能干等,或者 Ctrl+C 杀进程。
- **Ctrl+C 杀进程 = 这一轮的消息全部丢失**——`session.save()` 只在 turn 末尾执行一次。
- 想在执行途中补一句"不对,先看看 X"做不到。

**中断键:`Esc`(主)/ `Ctrl+C`(备)**

`Esc` 是这类工具的事实标准——Claude Code、Codex、opencode、Gemini CLI、Kimi 全部用 Esc 中断,用户的肌肉记忆在那里。`Ctrl+C` 同时保留:部分终端会吞掉 Esc,而且 Esc 是 ANSI 转义序列的前缀,方向键之类会走同一条路径,需要一个不依赖它的退路。

**判定单独的 Esc 有个坑**:readline 把它报成 `{ name: "escape", meta: true }`——`meta` 在这里不是修饰键,Esc 本身**就是** meta 前缀,所以 readline 把标志打在产生它的那个键上。按"只接受无修饰键"的常规写法排除 `meta`,排掉的正好是所有 Esc。按 `name` 过滤就够了:方向键虽然走同一条转义序列,readline 会先解析成 `up`/`down`,不会漏进来。

**中断做什么**:

- 中断是**协作式**的,不是强杀。设置中断标志后:
  1. **当前批次已发起的工具必须执行完、`tool_result` 必须全部回填**——这和 3 节"消息历史必须闭合"是同一条约束,中断也不能例外,否则留下悬空 tool_use,下次 `--continue` 直接报错。
  2. 不再发起下一次 LLM 调用。
  3. 落盘,turn 以 `interrupted` 结束,提示符还给用户。
- **正在跑的命令要立刻停掉**,先 `SIGTERM`,2 秒后仍未退出再 `SIGKILL`。
  - 早期版本的决策是"不强杀,等它自己跑完",理由是怕留下不一致的中间状态。**这条决策是错的,已推翻**:实际体验是按下 Esc 之后还要干等最长 `COMMAND_TIMEOUT_MS`(默认 60 秒),中断形同虚设。参照实现全都会停掉正在跑的工具调用(Claude Code 的文档原话是 "Stop the current response or tool call mid-turn")。
  - "怕留下不一致状态"的担心并没有消失,只是**权衡的另一边更重**:用户按中断,是因为已经判断当前这条路不该继续走;让它继续跑到底才是更大的伤害。而且用户自己在终端 Ctrl+C 杀掉半截的 `npm install` 是家常便饭,这个风险模型他们本来就熟悉。
- **已经拿到的输出照样回填**进 `tool_result`,并标注"被用户中断"。中断不是丢弃已完成的工作。
- 子 agent 也一起中断:中断信号透传给 `spawn_agent` 内部的 `runTurn`,否则主循环停了而子 agent 还在跑。
- 中断后 `messages` 里会留下一条说明"用户中断了这一轮",让模型在下一轮知道上一轮没做完。
- **第二次 Ctrl+C 才退出进程**。第一次是中断当前 turn,第二次是真的想走。turn 没在跑时,Ctrl+C 直接退出。

**执行期间的输入**:

- turn 执行期间 REPL 继续接受输入,输入的内容**进队列**。
- 排队时给出可见反馈(如 `⏎ queued`),否则用户不知道自己敲的东西有没有被吃掉。

**排队的消息插进当前 turn(steering)**

早期决策是"排队消息一律是**下一轮**的输入,不插进正在跑的 turn——那会破坏消息历史的结构"。**这条已推翻**:破坏结构的是插在一批工具调用的**中间**,插在闭合点上没有任何问题,而闭合点这个 turn 每一轮都有。

实际后果也确实不能接受:模型跑偏时唯一的选择是 Esc 中断(丢掉半截工作)或者干等它把整条错路走完。"补一句话把它掰回来"这个最常用的动作反而没有。

参照实现的做法一致:

- **Claude Code CLI**:打字进来的消息在下一个 LLM 暂停点冲进当前 turn,包括工具调用之间的间隙,不等整个 turn 结束。形式是**挂在下一条 tool_result 消息上一起发**。
- **Codex CLI**:把两种意图拆成两个键——`Tab` 排队(下一轮),`Enter` steer(注入当前 turn),底层是专门的 `turn/steer` RPC,注入点同样是"当前这批工具调用执行完、下一次 LLM 调用之前"。

**tcode 的决策**:

- **注入点 = 这一批 `tool_result` 全部回填之后、下一次 LLM 调用之前。** 和 3 节"消息历史必须闭合"是同一个切分点,compaction 和中断用的也是它。不需要新的不变量。
- **形式 = 追加成同一条 user 消息里的一个 text block**,和 `tool_result` 并排,不另起一条消息。少一次 role 交替。
  - 由此带出一条 adapter 硬约束(实跑撞出来的 400):**OpenAI 线格式里,assistant 带 `tool_calls` 的消息后面必须紧跟应答它的 `tool` 消息,中间插一条 `user` 就是 400**。所以 openai-compat adapter 展开一条 user 消息时,必须**先出全部 `tool_result`、再出 text**,不能按 block 在数组里的顺序出。这条在 steering 之前不可达——只有 steering 会造出"同一条 user 消息里既有 tool_result 又有 text"。
- 前面加一行来源说明,否则模型分不清这段文字是工具输出还是用户说的话。**内容和当前计划冲突时,以新消息为准**——用户中途开口就是为了改方向。
- **模型这一批调了 `finish`,或者已经被中断,就不注入**,消息留给下一轮。turn 已经结束,注入进去等于没人回答它,消息被静默吞掉。
- turn 结束后队列里还有剩余的(比如正好卡在 `finish` 那一批),照旧作为下一轮的输入自动发出。
- **不学 Codex 拆 `Tab`/`Enter`。** 两个键两种语义要求用户在敲字之前就想清楚"这句话该现在生效还是下一轮生效",而当前 turn 还剩多久他并不知道。tcode 只有一种行为:能插就插,插不进去就顺延到下一轮。
- 子 agent 不接收 steering(见 5.6):用户面对的是主 agent,主 agent 是否要把新指令转达给子 agent 是它自己的判断。

**执行期间的输入行**:

光"能接受输入"不够。第一版只做到了功能接通——`rl` 照常 emit `line`、消息照常进队列——但 turn 一开始提示符就消失了,敲的字直接落在流式输出中间,和模型吐出来的文本混成一片。用户的原话是"没有输入框了,我没法输入啊":**功能在,但没有任何界面告诉他还能输入,等于没有。**

所以约束加强为:turn 执行期间,输入行必须**始终可见并固定在屏幕最下方**。

- 提示符在 turn 开始时立刻画出来,turn 结束才收走。中间一直在。
- **输出永远渲染在输入行上方,不与输入行共享同一行。**
- 流式输出的**半行**(还没等到 `\n` 的部分)也要立刻显示,不能攒到整行才吐——模型的一个自然段经常几百字没有换行,按行缓冲会卡住好几秒什么都看不见,把流式的意义抹掉。半行单独占一块区域,输入行永远在它下面。
- 每次写输出时:先擦掉「半行 + 输入行」这个 frame,写完输出再重画,输入行回到最下方。
- **输入行归 readline 所有**,不自己实现行编辑——readline 每次按键都会重画它自己那一块。我们只负责保证那一块始终是屏幕上的最后一块。
- 行数计算按**显示宽度**算,CJK 全角字符占 2 列。这不是锦上添花:算错行数会导致擦除范围错位,把已经输出的内容吃掉或者留下残影,而这个项目的使用者就是中文输入。
- **非 TTY(管道、重定向)时整套退化成直接写 stdout**,不发任何光标控制序列。管道里没有"屏幕"可言,发了只会污染输出。

## 4. 会话持久化

会话历史落盘为 JSON,支持 `--continue` / `--resume` 恢复:

```
<project-root>/.tcode/sessions/<session-id>.json
```

```jsonc
{
  "id": "2026-08-02T09-15-00-abc123",
  "cwd": "/path/to/project",
  "provider": "anthropic",
  "model": "claude-sonnet-5",
  "createdAt": "2026-08-02T09:15:00.000Z",
  "updatedAt": "2026-08-02T09:20:00.000Z",
  "messages": [ /* 归一化的内部 message 格式,原样存储(见 8 节)——不是某个 provider 的原始 wire 格式,这样换 provider 也能读旧 session */ ],
  "compactions": [
    // 3.1 的摘要缓存。messages 一条都不删,这里只记录"[0, upToIndex) 这段可以用 summary 代替发给模型"
    { "upToIndex": 24, "summary": "用户要求重构 auth 模块…", "tokensBefore": 41000, "createdAt": "2026-08-02T09:19:00.000Z" }
  ]
}
```

- `--continue`:读取该目录下 `updatedAt` 最新的会话文件。
- `--resume <id>`:按文件名精确匹配。
- `tcode sessions`:列出该目录下的全部会话,**按时间倒序**(最近的在最上面),然后退出。
- 不传参数:新建会话(新 id,空 messages)。

**恢复必须是能被发现的**(实际踩到的问题):

- 用户不知道 `--continue` 存在,直接敲 `tcode`,于是每次重启都从零开始——一天下来同一个目录里攒了 8 份互不相干的会话,每份都以为自己是第一次见到这个项目。功能是好的,没人找得到而已。
- 所以:**当前目录存在历史会话、且用户没带任何恢复参数时,启动横幅里多打一行**告诉他怎么接上上次(带上上次的时间和消息数,让他判断值不值得接)。
- **不把 `--continue` 变成默认行为**。默认新开是对的:开一个全新任务时继承上一个任务的上下文,既烧 token 又会让模型拿着过期的结论跑偏。参照实现(Claude Code、Codex)默认也都是新开。提示 ≠ 改默认。
- `--resume <id>` 光有精确匹配还不够用:**id 是时间戳加随机串,没有任何地方能列出来**,用户只能自己去 `ls .tcode/sessions/`。所以 `tcode sessions` 是 `--resume` 的必要配套,不是锦上添花。
- 列表用**子命令**而不是 `--sessions` 开关:它不修改本次运行的行为,而是一个独立动作——打印完就退出,根本不进 REPL。和 `--continue`/`--full-auto` 那种"这次怎么跑"的修饰词不是一类东西。
- `.tcode/` 加入 `.gitignore`。
- `compactions` 是**可选**字段:v1 早期的 session 文件没有它,读取时按空数组处理,不做迁移、不报错。它也是纯缓存——整个删掉只会导致下次重新算一遍摘要,不丢任何信息。
- 恢复的 session 记录着当时用的 `provider`/`model`,仅作展示用;`--continue`/`--resume` 一律用**当前配置**的 active provider 继续跑。如果和 session 里记录的不一致,启动时打印一行提示(比如"该会话由 deepseek 创建,当前用 anthropic 继续"),不阻塞、不报错——历史消息是归一化格式,换 provider 继续没有兼容性问题。

## 5. 工具集

工具定义为归一化的 tool schema(name / description / input JSON Schema),统一注册在 `src/tools/index.ts`;由 `llm/` 下对应的 provider adapter 转换成各自 wire format(Anthropic 的 `input_schema` vs OpenAI 兼容格式的 `function.parameters`,见 8 节)。所有路径类工具在执行前都做**目录越界检查**(见第 6 节)。

### 5.1 `bash`

```jsonc
{ "command": "string", "timeout_ms": "number?" }
```

- **分级审批**(取代早期"一律确认"的单一档位)。判定标准只有一条:**这条命令会不会写到项目目录之外。**

  | | 需要确认吗 |
  |---|---|
  | 读任何东西(含系统文件、`/etc`、别的项目) | **不需要** |
  | 写/删/改项目目录**之内** | **不需要** |
  | 写/删/改项目目录**之外** | **需要** |
  | 提权、系统级管理、对外发布 | **需要** |

  读是无害的:`cat /etc/hosts`、`ls /usr/local` 不会破坏任何东西,为它们弹确认纯属噪音。每条 `ls`、每次 `npm test` 都要点一次 y,是把安全网变成了噪音——用户会形成"无脑回车"的肌肉记忆,真正危险的命令来了也照样放行。**审批疲劳本身就是安全问题。**

  判定按**管道/连接符切段**(`|`、`&&`、`||`、`;`),逐段判断,**任何一段需要确认则整条确认**。这样 `cat a.txt > /etc/hosts` 不会因为首词是 `cat` 就被放行,`x | tee /etc/y` 也不会漏。

  单段的判定:
  - `sudo` / `su` / `doas` → 确认。提权是一回事;更实际的是它会弹密码提示,而 `bash` 是同步阻塞执行,会把终端挂死。
  - 输出重定向(`>`、`>>`)到 `ROOT` 之外的路径 → 确认。例外:`/dev/null`、`/dev/stdout`、`/dev/stderr`,太常用且无害。
  - 首词是**只读命令**(`cat`/`ls`/`grep`/`find`/`head`/`tail`/`wc`/`file`/`stat`/`which`/`diff`/`echo`/`pwd`/`date`,以及 `git status|log|diff|show|branch`)且没有上面的写重定向 → **放行**,不管它读的是什么路径。
  - 其余命令(会写的命令)出现指向 `ROOT` 之外的绝对路径、`~`、`$HOME`、`../` → 确认。
  - 系统级管理命令 → 确认:`brew`/`apt`/`apt-get`/`yum`/`dnf`/`pacman`/`systemctl`/`launchctl`/`defaults`/`crontab`/`diskutil`/`shutdown`/`reboot`/`mkfs`。
  - 全局安装(`npm`/`yarn`/`pnpm` 带 `-g` 或 `--global`)→ 确认。
  - `git push` → 确认。不改本地文件,但**对外发布且难以撤回**,同属"影响超出这个目录"。
  - 以上都不触发 → 放行。

  自动放行的命令**仍然打印摘要行**,用户看得见它跑了什么,只是不用逐条点确认。

- **这套判定是启发式的,不是保证。** bash 命令是不透明的字符串,"这条命令会不会写到项目外"在一般情况下不可判定——`cd /tmp && rm -rf x` 里没有指向外部的绝对路径 token,`eval "$X"` 更是完全无法静态分析。这和 6 节已记录的限制一脉相承:**bash 本来就没有沙箱**。分级审批降低的是噪音、提高的是"危险命令更容易被注意到"的概率,不提供任何强保证。真正的保证要等沙箱(见 11 节)。
  - 对比:`read_file`/`edit_file`/`write_file` 走 `resolveInRoot`(见 6 节),那是**硬保证**——路径越界直接拒绝,不是靠猜。
- `remember(scope: "user")` 写 `~/.tcode/AGENTS.md`,在 `ROOT` 之外,但**不需要确认**:目标路径写死在代码里、模型无法影响(见 5.7),且每次写入强制打印内容。那是 tcode 自己的配置目录,不是用户的系统文件。
- `--full-auto` 跳过全部确认,含上面需要确认的那一档。
- 实际执行通过一层 `executor.run(command, opts)` 封装(`child_process.spawn` 的薄封装,**异步**),不在工具里直接调用子进程 API——以后要接沙箱执行器(seatbelt/landlock/容器)时只替换这一层。
  - **必须异步,不能用 `spawnSync`。** `spawnSync` 会阻塞整个 event loop,期间信号处理器无法运行——用户按下中断键后要等命令自己跑完(最长 `COMMAND_TIMEOUT_MS`)才会有任何反应,3.2 的中断形同虚设。这是实测踩出来的坑,不是理论问题。
  - `run()` 接受一个 `AbortSignal`。收到中断时立刻 `SIGTERM`,2 秒后仍在则 `SIGKILL`,并把**已经收到的 stdout/stderr 原样返回**(见 3.2)。超时用同一套终止逻辑,只是触发源不同。
  - **信号必须发给整个进程组,不能只发给 shell。** 子进程用 `detached: true` 起在自己的进程组里,终止时对 `-pid` 发信号。原因:`sh -c "echo x; sleep 10"` 里 shell 会 fork 出 `sleep`,只杀 shell 的话 `sleep` 变成孤儿、继续持有管道,`close` 事件永远不触发——中断了个寂寞,而且留下孤儿进程(opencode 的 #3057 就是这个问题)。实测复合命令在 605ms 内终止且无残留。
- 在 `cwd` 下执行,复用已有的输出截断逻辑(`MAX_OUTPUT_CHARS`,首尾各留一半 + 截断提示),默认超时沿用现有的 60s。
- 返回 `{ stdout, stderr, exitCode }`。
- 不做命令白名单/黑名单,不做沙箱隔离——执行前确认是 v1 唯一的安全网,风险由确认操作的人承担(这是"minimal"阶段的取舍,见第 1 节)。
- 长驻/后台进程(dev server、watch 等)v1 不支持:`bash` 是同步阻塞调用,超时后强制结束——这是已知限制,不是遗漏,留给后续增强(见 11 节)。

### 5.2 `read_file`

```jsonc
{ "path": "string", "offset": "number?", "limit": "number?" }
```

- 类似 `cat -n`,带行号返回内容,便于模型在 `edit_file` 里精确引用 `old_string`。
- 支持 `offset`/`limit` 分段读取大文件。
- 文件不存在 / 是目录 → 返回 `is_error: true` 的说明。

### 5.3 `edit_file`

```jsonc
{ "path": "string", "old_string": "string", "new_string": "string", "replace_all": "boolean?" }
```

- 字符串替换(非 diff/patch):在文件内容中查找 `old_string`。
- 默认要求**唯一匹配**——找不到或匹配多处且 `replace_all` 非 true 时报错,把上下文(匹配了几处)带回给模型,让它加更多上下文重试。
- `old_string === ""` 时:文件不存在则视为创建新文件(等价于 write);文件已存在则报错并提示改用 `write_file`,不做隐式的"全文替换"或"追加",避免语义歧义。

### 5.4 `write_file`

```jsonc
{ "path": "string", "content": "string" }
```

- 整文件写入/覆盖,用于新建文件或模型判断整文件重写更合适的场景。
- 与 `edit_file` 互补:小改动用 edit,新文件或大改用 write。

### 5.5 `finish`

```jsonc
{ "summary": "string", "status": "\"done\" | \"blocked\"" }
```

- 无副作用,纯粹的信号工具。执行体只是把参数原样返回作为 tool_result——这一步**一定会执行**,和同批其他工具一样按顺序跑、回填 tool_result;只是这批 tool_result 全部回填之后,agent loop 看到本批含有 `finish` 就不再发起下一次 LLM 调用(见第 3 节)。
- `status: "blocked"` 用于模型主动说明"这轮我卡住了,需要用户澄清",区别于正常完成。

### 5.6 `spawn_agent`

参考 opencode 内置的 `general`/`explore` 两种 subagent 和 Codex 的 spawn/subagent 机制,做**单层、串行**的子任务委派——不是完整的多 agent 编排(见第 1 节非目标)。

```jsonc
{ "task": "string", "role": "\"general\" | \"explore\"" }
```

- 复用同一份 `agent.ts` 的 `runTurn` 逻辑跑一个子 agent,不是另写一套循环:子 agent 用**全新的、空的**归一化 message 历史(不共享主 session 的历史),`task` 作为子 agent 的初始 user 输入。
- **`role` 决定子 agent 的工具集裁剪**,而不是让模型随意定制权限:
  - `general`——除 `spawn_agent` 自身外的全部工具都可用。
  - `explore`——只读定位场景(比如"这个模式在代码里哪些地方用到了"),只给 `read_file`/`bash`,不给 `edit_file`/`write_file`。
- **工具集里天生不包含 `spawn_agent` 自己**,这是防止无限递归的机制,不是靠 prompt 劝阻或者显式深度计数器——子 agent 物理上拿不到这个工具。
- 子 agent 内部照样受 `approval.ts` 管——不会因为是子 agent 就自动放行 `bash`,否则变成绕过审批的后门。
- 子 agent 结束(遇到 `finish` 或撞到 `MAX_TOOL_ITERATIONS`)后,**只把 `finish` 的 `summary`(或最后一条文本)作为这次 `spawn_agent` 调用的 tool_result 返回给主 agent**,子 agent 内部完整的中间过程不落回主 session——这是引入子 agent 的主要目的:保护主 context 不被中间搜索/试错过程占满。
- 子 agent 的 message 历史**不落盘**:3 节末尾的 `session.save()` 只对主 session 生效,`runTurn` 的落盘动作是可注入的,`spawn_agent` 传一个 no-op 进去——否则每次委派都会在 `.tcode/sessions/` 下多出一个没人会 `--resume` 的垃圾文件。
- 子 agent 的每一步照样按 3 节的方式打印到终端(带一个前缀,比如缩进或 `[subagent]` 标记,让用户分得清是主 agent 还是子 agent 在动作),但不写入主 session 的 `messages`。
- v1 是**同步阻塞**的:主循环调用 `spawn_agent` 后等子 agent 跑完才继续,不支持同一响应里并发起多个 `spawn_agent`(如果模型这么做,依然按 3 节"按顺序串行执行"处理)。真正的并行编排留到后续增强(见 11 节)。

### 5.7 `remember`

```jsonc
{ "scope": "\"user\" | \"project\"", "content": "string" }
```

- 往分层记忆文件里**追加**一条(见 9 节):`user` → `~/.tcode/AGENTS.md`,`project` → `<ROOT>/AGENTS.md`。
- **没有 `path` 参数**——目标路径由 `scope` 决定、写死在实现里。这是刻意的:`remember` 是 6 节目录限制的唯一例外,如果它接受任意路径,就等于给了模型一个绕过目录检查写任意文件的后门。
- 文件不存在则创建(用户级会顺带建 `~/.tcode/`)。追加时自带分隔,不破坏已有内容。
- 执行后在终端打印写入了什么,用户对 agent 记了什么始终可见。
- 无需 approval 确认(v1 只有 `bash` 需要),但因为它会留下跨 session 的持久影响,打印是强制的。

## 6. 目录范围限制

- 启动时记录 `ROOT = path.resolve(cwd)`。
- `read_file` / `edit_file` / `write_file` 在执行前用 `path.resolve(ROOT, inputPath)`,校验结果以 `ROOT + path.sep` 开头(或等于 `ROOT`),否则拒绝并报错("path escapes project root")。
- **唯一例外:`remember(scope: "user")`** 会写 `~/.tcode/AGENTS.md`,在 `ROOT` 之外(见 5.7/9.2)。之所以可以放行,是因为它的目标路径写死在实现里、不接受路径参数——模型没法把它当成任意文件写入的通道。除此之外没有第二个工具能写 `ROOT` 外。
- `bash` 工具本身**不做沙箱隔离**,只是把 `cwd` 设为 `ROOT`——模型仍可能通过 `cd ..` 或绝对路径访问外部,这是已知的 minimal 取舍,在 spec 里显式记录,不是遗漏。

## 7. 模块结构

```
src/
  index.ts          # CLI 入口:解析 --continue/--resume/--full-auto,readline REPL,加载/保存 session。只做展示层,不含 agent 逻辑
  agent.ts           # runTurn(session, userInput, opts?): LLM ⇄ 工具循环,只依赖 llm/ 暴露的归一化类型,不感知具体 provider。
                      # opts.tools 可覆盖默认工具集——spawn_agent 内部就是拿一份裁剪过的 tools 子集、一个空 messages 数组,递归调 runTurn
  llm/
    index.ts           # send(messages, tools, system, { onTextDelta }) -> response:按 PROVIDER 配置解析出当前 provider,委派给对应 adapter
    types.ts            # 归一化类型:Message / ToolDefinition / ToolUseBlock / ToolResultBlock / Response
    providers.ts         # provider 注册表:name -> { adapter, envPrefix, baseUrlDefault }(见 8 节)
    adapters/
      anthropic.ts        # Anthropic Messages API 适配(与归一化类型基本 1:1)
      openai-compat.ts     # OpenAI Chat Completions 兼容适配(DeepSeek 等 OpenAI 兼容 provider 复用这一个)
  session.ts         # Session 类型 + load/save/findLatest
  security.ts         # resolveInRoot(root, path)
  config.ts           # loadEnvFiles(root):按 8.2 的优先级加载 <project>/.env 和 ~/.tcode/.env。
                      # 以及启动时从 env 解析一次的数值配置(见 8.2):MAX_TOOL_ITERATIONS / COMMAND_TIMEOUT_MS /
                      # MAX_OUTPUT_CHARS / HISTORY_TOOL_RESULT_BUDGET_CHARS。常量集中一处,agent.ts / tools/ 都从这里取,
                      # 不各自散读 process.env(provider 的 key/model/base_url 不在这里,归 llm/providers.ts 管)
  approval.ts         # needsConfirmation(toolUse) + confirm(toolUse):v1 只对 bash 返回 true,未来升级成分级 policy 时只改这里
  executor.ts         # executor.run(command, opts):v1 是 execSync/spawnSync 的薄封装,未来接沙箱时只替换这里
  memory.ts           # 分层记忆(见 9 节):加载 ~/.tcode/AGENTS.md + <project>/AGENTS.md|TCODE.md,
                      # 以及 remember 的追加写入
  tokens.ts           # estimateTokens(text) / estimateMessagesTokens(messages):启发式 token 估算(见 3.1)
  trace.ts            # 事件追踪(见 13):追加写 .tcode/traces/<id>.jsonl。tracer.child() 给子 agent 加一层 depth。
                      # 写失败只警告一次并降级成 no-op,绝不拖垮 turn
  viewer/
    server.ts         # tcode --view 的本地 http server + SSE(见 13.4)
    page.ts           # 单文件 HTML,CSS/JS 内联,不引 CDN
  ui/
    theme.ts          # 颜色能力分级 + 语义/品牌色板(见 16.3)
    chrome.ts         # 框、横幅、状态栏、右对齐(见 16.2)。纯函数
    editor.ts         # 行编辑器(见 16.4):缓冲、光标、历史、补全。不碰 stdout,
                      # 渲染成"行 + 光标位置"交给 live-screen 画
    select.ts         # 单键选择的覆盖层(见 16.6):确认框、会话选择器共用
    highlight.ts      # 粗粒度语法高亮(见 16.8)。五类着色,认不出语言就不高亮
    live-screen.ts    # 屏幕底部区域(见 3.2/16.2):输出/半行/spinner/输入区的擦除与重画
    width.ts          # displayWidth(text) / displayPos(text, cols):按显示宽度算列数(CJK 占 2),
                      # 先剥 ANSI。算法刻意和 readline 内部的 kGetDisplayPos 一致——输入行归它画,
                      # 两套换行模型对不上,第一个宽字符就会错位(见 3.2)
    keys.ts           # isInterruptKey(key):键盘判定。只有一个函数,但单独放是因为它只能靠真终端触发,
                      # 放成内联条件就没法测——Esc 中断第一版正是这么静默失效的(见 3.2)
    format.ts         # 工具调用/结果摘要/diff/markdown 的行级渲染(见 14),纯函数,不碰 stdout
    spinner.ts        # 执行中的状态指示(见 14.4 P2)
    paste.ts          # 括号粘贴(见 15.1):把原始 stdin 拆成"按键"和"整段粘贴"。
                      # 必须在 readline 之前拿到数据,所以 readline 读的是一个由它喂的流
    completer.ts      # Tab 路径补全(见 15.4),补全范围不越出项目目录
  context.ts          # buildSendView(session, budget):完整历史 → 发送视图。三级降级 + compaction 切分点选择。
                      # 纯函数,不改 session、不发请求;真正调 LLM 生成摘要的那一步由 agent.ts 触发后写回 session.compactions
  commands.ts         # 斜杠命令的解析与帮助文本(见 15.3)。纯函数;分发留在 REPL,
                      # 因为只有它握着 session 和 agent deps
  history.ts          # 输入历史的读写(见 15.5):<project>/.tcode/history,按项目存
  mentions.ts         # @path 展开(见 15.4):给模型的消息附上文件内容,给终端一行折叠摘要。
                      # 引用即读取,同样受 6 节的目录范围限制
  prompt.ts           # buildSystemPrompt({ root, memory, fullAuto }):按 10 节要点拼 system prompt。
                      # 单独一个模块而不是塞进 index.ts——子 agent 也要用同一份(见 5.6),放展示层会导致两处拼装逻辑
  tools/
    index.ts          # 工具注册表:name -> { schema, execute }
    bash.ts
    read_file.ts
    edit_file.ts
    write_file.ts
    finish.ts
    remember.ts        # 分层记忆写入(见 5.7),目标路径由 scope 决定、不接受路径参数
    spawn_agent.ts     # role -> 工具子集的映射表 + 递归调用 agent.runTurn(见 5.6)
```

测试代码在独立的 `tests/` 目录,不放进 `src/`,结构见 12 节。

**扩展点小结**(对应第 1 节"已预留扩展点"):`llm/` 已经是多 provider 架构(v1 内建,不是"以后再做"),新增一个 OpenAI 兼容 provider 只需要在 `providers.ts` 注册,复用 `openai-compat.ts`;真要接一个 wire format 完全不同的 provider 才需要新写 adapter。`tools/index.ts` 的注册表模式方便接 MCP 工具;`executor.ts` 隔离命令执行,方便接沙箱;`approval.ts` 隔离 confirm policy,方便做分级审批;`index.ts` 与 agent 引擎解耦,方便换 TUI。

## 8. Provider 与配置

### 8.1 Provider 抽象

- `llm/types.ts` 定义归一化类型(`Message`、`ToolDefinition`、`ToolUseBlock`、`ToolResultBlock`、`Response` 等),`agent.ts`/`session.ts`/`tools/` 全部只认这套类型,不感知具体 provider 的 wire format。
- `llm/adapters/` 下按 **wire format**(不是按厂商)分 adapter:
  - `anthropic.ts`——Anthropic Messages API(`/v1/messages`),tool schema 用 `input_schema`,tool_result 靠 `tool_use_id` 配对,system 是独立参数。
  - `openai-compat.ts`——OpenAI Chat Completions 格式(`/chat/completions`),tool schema 包在 `function.parameters` 里,tool_result 是 `role: "tool"` 消息配 `tool_call_id`,system 是一条 `role: "system"` 消息。DeepSeek、以及其他自称"OpenAI 兼容"的 provider 都复用这一个 adapter,靠 `base_url` 区分。
- `llm/providers.ts` 是一张注册表,把 provider 名字映射到"用哪个 adapter + 从哪些环境变量读 key/model/base_url":

  ```ts
  {
    anthropic: { adapter: "anthropic",      apiKeyEnv: "ANTHROPIC_API_KEY", modelEnv: "ANTHROPIC_MODEL", baseUrlEnv: "ANTHROPIC_BASE_URL", contextWindowDefault: 200000 },
    deepseek:  { adapter: "openai-compat",  apiKeyEnv: "DEEPSEEK_API_KEY",  modelEnv: "DEEPSEEK_MODEL",  baseUrlEnv: "DEEPSEEK_BASE_URL", baseUrlDefault: "https://api.deepseek.com", contextWindowDefault: 65536 },
  }
  ```

- 加一个新的 OpenAI 兼容 provider(比如 Moonshot、通义千问的兼容模式)只需要在这张表里加一行,不用碰 adapter 代码;只有 wire format 既不是 Anthropic 也不是 OpenAI 兼容时才需要新写一个 adapter。
- `llm/index.ts` 的 `send()` 在启动时按 `PROVIDER` 解析一次配置(`provider`、`apiKey`、`model`、`baseUrl`),整个进程生命周期内固定,不做运行时切换(见第 1 节非目标)。
- **流式**:`send(messages, tools, system, { onTextDelta })` 是统一接口,`onTextDelta` 在文本生成过程中增量调用。`anthropic.ts` 用 Anthropic 的 SSE(`content_block_delta` 的 `text_delta`/`input_json_delta`)做真流式,是 v1 优先实现的一个,因为默认 provider 就是 Anthropic;`openai-compat.ts` 理论上同样走 SSE(`delta.content`/`delta.tool_calls[].function.arguments`),如果实现进度滞后,v1 允许先整段收完再一次性调用 `onTextDelta` 兜底,不阻塞主线,但接口形状不能变。

### 8.2 配置项

沿用现有 `.env.example`,改成按 provider 分组:

```
PROVIDER=anthropic                   # 当前生效的 provider,对应 providers.ts 里的 key,默认 anthropic

ANTHROPIC_API_KEY=sk-ant-xxxxx
ANTHROPIC_MODEL=claude-sonnet-5      # 可选
ANTHROPIC_BASE_URL=                  # 可选,自定义网关时用

DEEPSEEK_API_KEY=sk-xxxxx
DEEPSEEK_MODEL=deepseek-chat         # 可选
DEEPSEEK_BASE_URL=                   # 可选,默认 https://api.deepseek.com

MAX_TOOL_ITERATIONS=                 # 可选,单轮 turn 内工具调用次数上限。默认不设(0/未设置 = 无限),
                                     # 给 CI / 无人值守跑批用;交互使用靠 Esc 停(见 3.2)
PROGRESS_EVERY_ITERATIONS=25         # 可选,每多少次工具调用打一行进度;0 = 不打
COMMAND_TIMEOUT_MS=60000             # 可选,bash 工具超时
MAX_OUTPUT_CHARS=30000               # 可选,单条 tool_result 内容上限(超出按首尾各留一半截断,见 5.1)

CONTEXT_WINDOW_TOKENS=               # 可选,模型 context 窗口。不设时按 provider 取默认值(见下)
COMPACT_THRESHOLD=0.75               # 可选,用量占 context 窗口多少时开始压缩(见 3.1)
COMPACT_KEEP_RECENT=8                # 可选,compaction 时至少保留最近多少条消息不压缩
RESERVED_OUTPUT_TOKENS=8192          # 可选,给模型输出预留的 token,不计入历史预算
MEMORY_MAX_TOKENS=4000               # 可选,两层记忆合计上限(见 9.3/9.4)
MIN_USABLE_HISTORY_TOKENS=2000       # 可选,历史预算低于此值时启动报警(见 3.1)
TRACE=on                             # 可选,设为 off 关闭事件追踪(见 13.3)
```

- 上面这些数值配置由 `config.ts` 在启动时解析一次(见 7 节),`agent.ts`/`tools/`/`context.ts` 一律从它取值,不各自读 `process.env`;非法值(非数字、<= 0)回退到默认值,不报错退出——数值配置写错不该拦住启动,和缺 API key 的处理级别不同。
- `CONTEXT_WINDOW_TOKENS` 不设时按 provider 注册表里的 `contextWindowDefault` 取(anthropic 200000 / deepseek 65536)。各家窗口差别很大,写死一个全局默认值必然要么浪费要么撞墙,所以它和 `modelDefault` 一样属于 provider 的属性(见 8.1)。
- 早期版本有个 `HISTORY_TOOL_RESULT_BUDGET_CHARS`(按字符数的历史预算),已废弃——按字符算和 context 上限没有对应关系,详见 3.1。

- **配置来源与优先级**(从高到低),都用 Node 内建的 `process.loadEnvFile()` 读,不引第三方 dotenv:

  1. 真实环境变量 —— 一次性覆盖用,比如 `PROVIDER=anthropic tcode`
  2. 项目根目录的 `.env` —— 某个项目要用不同 provider/model 时的项目级覆盖
  3. 用户级的 `~/.tcode/.env` —— 全局默认,tcode 自己的配置

  `loadEnvFile()` 不覆盖 `process.env` 里已有的键,所以实现上就是"按 2 → 3 的顺序加载",先加载的自然赢,不需要手写优先级合并。三个位置都不存在时静默跳过,直到 `resolveProviderConfig` 因为缺 key 报错退出。

- **用户级配置放 `~/.tcode/.env`**,而不是让用户往 shell profile(`~/.zshrc` 等)里 export:
  - `tcode` 是全局命令,在任意项目目录都要能拿到 key。要求每个项目放一份 `.env` 太啰嗦,而 API key 写进 shell profile 会污染所有进程的环境、也不好按工具管理。
  - 目录名和项目里的 `.tcode/`(会话存放处,见 4 节)保持一致:`~/.tcode/` 放用户级的东西,`<project>/.tcode/` 放项目级的东西。
  - 这是纯文件约定,v1 不做 `tcode login` 之类的配置命令——用户自己创建/编辑这个文件,格式和 `.env.example` 完全一样。
- 启动时只读取 `PROVIDER` 指向的那组变量(比如 `PROVIDER=deepseek` 时只要求 `DEEPSEEK_API_KEY` 存在,不要求 `ANTHROPIC_API_KEY`)。
- 缺少当前 provider 必须的 `*_API_KEY` 时,启动直接报错退出,不进入 REPL。
- `--full-auto` 是启动参数而非环境变量:跳过 `approval.ts` 的确认,让 `bash` 全自动执行,风险自行承担。

### 8.3 已知限制

- v1 不做"多个 provider 同时挂载、模型按任务路由"这种编排,只是"配置里指定一个、用一个"。
- 不同 provider 的 tool-calling 可靠性/格式细节有差异(比如 DeepSeek 对并行 tool_call 的支持程度),`openai-compat.ts` 只保证归一化类型能正确来回转换,不对具体模型的工具调用质量做兜底或特殊 prompt 调优。

## 9. 记忆

记忆是**分层的静态 Markdown 文件**,启动时读进 system prompt,agent 也能主动往里写。

### 9.1 两层

| 层 | 位置 | 放什么 |
|---|---|---|
| 用户级 | `~/.tcode/AGENTS.md` | 跨项目的个人偏好("回答用中文"、"提交信息写中文"、常用工具链) |
| 项目级 | `<project>/AGENTS.md`,回退 `<project>/TCODE.md` | 这个项目的约定、常用命令、注意事项 |

- 两层**都加载**,不是二选一。拼进 system prompt 时用户级在前、项目级在后,并各自标明来源——**更具体的层优先级更高**,冲突时项目级说了算,这一点要在 prompt 里对模型明说。
- 项目级同目录下 `AGENTS.md` 和 `TCODE.md` 同时存在时,只取 `AGENTS.md`(和之前一致)。
- 任何一层不存在都静默跳过,不报错、不阻塞启动。
- 和用户级配置(`~/.tcode/.env`,见 8.2)同目录,`~/.tcode/` 就是 tcode 的用户级家目录。

### 9.2 可写:`remember` 工具

只读的记忆等于每个新 session 都从零开始。给 agent 一个写入口(工具定义见 5.7):

- 追加式,不是覆写——`remember` 往对应文件末尾追加一条,不会重写用户已有的内容。
- **写用户级记忆是 6 节目录限制的唯一例外**,必须在 6 节显式记录,不能默默放行。`remember` 是唯一能写 `ROOT` 之外的工具,而且只能写死路径 `~/.tcode/AGENTS.md`,不接受任意路径参数——参数只有 `scope` 和 `content`,没有 `path`,模型没有借它做任意文件写入的余地。
- 每次写入都在终端打印一行(写了哪一层、写了什么),用户始终知道 agent 记了什么。
- 项目级的 `AGENTS.md` 在 `ROOT` 内,agent 本来就能用 `write_file`/`edit_file` 改;`remember` 的价值是**语义明确**(这是"记住"而不是"改一个文件")+ 统一两层的写法 + 打通用户级。

### 9.3 不做的

- 不做语义检索/向量库。记忆是全量拼进 prompt 的静态文本,不是 RAG。
- 不做后台自动提炼——agent 只在用户明确要求("记住…")或自己判断有长期价值时调 `remember`,不做每轮结束偷偷总结用户习惯这种事。
- 记忆文件全量进 system prompt,所以要有上限:两层合计超过 `MEMORY_MAX_TOKENS`(默认 4000,见 8.2)时截断并在启动时打印警告,防止记忆本身把 context 吃光。

### 9.4 截断规则

超过 `MEMORY_MAX_TOKENS` 时按以下顺序处理:

1. **层间**:从**用户级**开始砍,项目级最后动(项目级更具体、更该保留)。
2. **层内:按条目截断,不按字符。** 记忆文件是 `- xxx` 的条目列表,按字符切会把一条记忆切成半句话——`- 部署前必` 这种残句比没有这条记忆更危险,模型可能照着半句瞎猜。条目是最小不可分割单位。
3. **层内:保留最新的条目,丢弃最旧的。** `remember` 是追加到文件末尾的,所以越靠后的条目越新。理由:新记忆通常是对旧记忆的修正或补充,两条冲突时应该新的赢;而且"刚让 agent 记住的那条立刻失效"是最反直觉的行为。
4. **丢弃必须可见**:启动时不能只说"被截断了",要明确列出丢掉了哪几条(至少列出条数和被丢弃条目的开头),否则用户没法知道该去清理什么。

- **保底**:如果算上"已截断"标记之后一条都放不下,仍然保留**最新的那一条**。一个只剩标记、没有任何真实条目的记忆层,比留一条超一点预算的记忆更没用。标记本身也要写得短,免得在小预算下反过来挤掉它要宣告的内容。
- 文件开头的非条目内容(标题、说明段落)在条目之外单独保留,不参与条目截断——那通常是文件的结构性说明,丢了会让剩下的条目失去上下文。如果连它都放不下,说明 `MEMORY_MAX_TOKENS` 配得太小,按警告处理。

## 10. System Prompt 要点(实现时展开)

- 说明当前工作目录 = 项目根目录,所有相对路径基于此。
- 说明工具用途分工:`read_file` 先读后改、`edit_file` 小改动、`write_file` 新文件/整体重写、`bash` 跑命令/测试、`finish` 收尾。
- 明确要求:改完代码后如果项目有测试/构建命令,尽量跑一下再 `finish`。
- 明确 `finish` 的语义(仅结束当前 turn,不是退出程序)。
- 明确 `bash` 默认需要用户确认才会执行,不要假设命令会立即生效;不要为了绕过确认把危险操作拆成多个小步骤。
- 如果读取到分层记忆(见 9 节),按"用户级 → 项目级"顺序拼进去,各自标明来源,并明确告诉模型:记忆里的约定优先级高于默认行为,两层冲突时**项目级优先**。
- 说明 `remember` 的用途和边界:用户明确要求记住某件事、或发现了值得跨 session 保留的项目约定时才调;不要把一次性的临时信息写进记忆。

## 11. 后续可选增强(不在 v1 范围)

- `openai-compat.ts` 补齐真流式(如果 v1 先用整段兜底上线的话)
- bash 沙箱(seatbelt/landlock/容器),替换 5.1 里的 `executor.run`
- 分级 approval policy(untrusted/on-failure/on-request/never),替换 v1 "bash 一律确认"的单一档位
- 运行时热切换 provider(会话中途换 provider,而不是改配置重启);更多非 Anthropic/OpenAI 兼容 wire format 的 provider adapter
- Diff 预览(`edit_file` 执行前展示将要发生的变更)
- ~~长 session 的 context 摘要/裁剪~~ —— **已实现,见 3.1**(完整历史/发送视图分离 + token 预算 + 三级降级 + compaction)
- ~~记忆的分层与可写~~ —— **已实现,见 9 节**(用户级/项目级两层 + `remember` 工具)
- 记忆的语义检索(当记忆文件大到 `MEMORY_MAX_TOKENS` 装不下时,按当前任务挑相关片段,而不是全量拼接或粗暴截断)
- compaction 的分级摘要(现在是"旧的压成一段";更好的做法是保留多级摘要,让很久以前的事也能有粗粒度的印象)
- 后台任务管理(dev server / watch 等长驻进程,而不是现在同步阻塞的 `bash`)
- 真正的并行多 agent 编排(同时跑多个 `spawn_agent`、结果聚合、失败重试,对应 Codex 的 `multi_agent_mode`)
- 自定义 subagent 角色配置(而不是 v1 内置的 `general`/`explore` 两种固定 role)

## 12. 测试与验证策略

参考了 Codex CLI(`codex-rs/core/tests/suite/`)和 opencode 的实际测试结构:两者都不是靠"多写几个功能测试"验证 agent,而是分层——**确定性的控制流用自动化测试锁死,模型输出质量这块自动化测试测不出来,靠 eval/dogfooding**。这一节是 v1 就要有的,不是后续增强——不然之后改 `agent.ts`/`llm/`/`approval.ts` 这几个核心耦合点时很容易在不知不觉中回归,即使功能上"新加的东西能跑",也可能把已经验证过的旧行为改坏(负优化)。

### 12.1 四层验证,分工不同

1. **纯逻辑单元测试**(无网络,最快最稳,每次改动都跑)
2. **假模型的 agent loop 场景测试**(无网络,专测控制流分支)
3. **provider adapter 的录制/回放测试**(用 fixture,专测 wire format 转换)
4. **真实端到端冒烟测试**(接真实模型,少量、非阻塞、定期跑)

外加一层不算自动化测试、但不可省略的:**人工 dogfooding**——自举,用 tcode 开发 tcode 自己,靠使用中的直觉发现"模型这次表现变差了"这类自动化测不出来的问题。

### 12.2 具体覆盖什么

**单元测试**:
- `security.ts`:`resolveInRoot` 的越界判断(`../`、绝对路径、恰好等于 ROOT 等边界 case)。
- `tools/edit_file.ts`:唯一匹配 / 零匹配 / 多匹配(`replace_all` 为 true/false)/ `old_string === ""` 的两种分支(建新文件 vs 文件已存在报错)。
- `session.ts`:save/load、`--continue` 选 `updatedAt` 最新的文件、`--resume <id>` 精确匹配不到时的报错。
- `llm/adapters/anthropic.ts` 与 `openai-compat.ts`:归一化类型 → wire format → 归一化类型的往返测试,重点测 tool_use/tool_result 的 id 配对、system prompt 拼接方式、stop/finish reason 映射——provider 适配层最容易在无声无息中错的地方。
- `approval.ts`:`needsConfirmation` 对各工具类型的判断,`--full-auto` 时恒为 `false`。
- `tools/spawn_agent.ts`:`role` → 工具子集的映射是否正确(`explore` 拿不到 `edit_file`/`write_file`/`spawn_agent`);子 agent 的工具集里确认不包含 `spawn_agent` 自己。

**agent loop 场景测试**(给 `agent.ts` 注入一个可编程的假 `llm.send()`,按顺序吐预设 response,不接真实网络):至少覆盖这份 spec 里明确写过的每一个行为决策点,而不是笼统地"测一下 loop"——

1. 空 `toolUses` → turn 结束,不再调 LLM。
2. 单独一个 `finish` → 执行、回填 tool_result、break。
3. **`finish` 与其他 tool_use 混在同一响应** → 全部执行、tool_result 全部回填、消息历史闭合;再模拟一次"追加新 user 消息"的 `--continue` 场景,断言不会因为悬空 tool_use 报错(这是第 3 节修过的那个 bug 的回归锁,必须有专门用例,不能只留在 spec 文字里)。
4. 工具执行抛错 → `is_error: true` 回填,loop 不崩溃、继续调 LLM。
5. 用户拒绝确认(mock `confirm` 返回 `false`)→ 回填拒绝结果、不执行、loop 继续。
6. 配了 `MAX_TOOL_ITERATIONS` 时,连续这么多次都返回 tool_use、不返回 `finish` → 中断并提示,session 仍完整可保存;**不配时不截断**,只按 `PROGRESS_EVERY_ITERATIONS` 打进度行。
7. 单批多个非 `finish` 工具 → 按顺序串行执行(用一个带副作用的假工具断言执行顺序,而不是并发)。
8. `spawn_agent` 执行时递归调用一次子 `runTurn`(用假 `llm.send()` 模拟子 agent 也调用了 `finish`)→ 断言主 session 只多了一条 `spawn_agent` 的 tool_result(内容是子 agent 的 summary),不包含子 agent 的中间消息;且传给子 `runTurn` 的工具集里不含 `spawn_agent`。

**provider adapter 录制/回放测试**:每个 provider 录一份最小 fixture(纯文本回复 / 单 tool_use 回复 / 多 tool_use 回复各一份),存在 `tests/fixtures/<provider>/` 下,回放跑 adapter 断言归一化 `Response` 结构正确。加新工具类型、SDK 升级、provider 报 breaking change 时人工刷新 fixture。

**端到端冒烟测试**:在临时目录建一个干净的 git 仓库,跑几个真实代表性任务(新建文件、`edit_file` 唯一匹配成功、`edit_file` 多匹配报错后模型重试成功、读不存在的文件报错、`bash` 跑测试),接真实模型,断言**最终文件状态/退出码**而不是模型说了什么原话。不阻塞每次提交,发版前或 nightly 跑。

### 12.3 回归防护:哪些改动必须先过 12.2 第二层

`agent.ts`、`llm/`、`approval.ts`、`executor.ts` 是影响面最大的几个核心耦合点(见 7 节"扩展点小结")——任何改动这几个文件的 PR,强制要求 agent loop 场景测试全绿再合并。单测 + loop 场景测试完全不需要网络,可以直接卡 CI;adapter fixture 测试和 e2e 冒烟测试成本更高、更不稳定,作为独立 job,允许失败但需要人工定期查看,不卡合并。

### 12.4 目录结构

```
tests/
  unit/
    security.test.ts
    edit_file.test.ts
    session.test.ts
    adapters.test.ts
    approval.test.ts
  loop/
    agent-loop.test.ts       # 12.2 里列的场景清单,用假 llm.send() 跑
  fixtures/
    anthropic/*.json
    deepseek/*.json
  e2e/
    smoke.test.ts             # 接真实模型,单独跑,不卡 CI
```

### 12.5 第一次实现完之后,具体怎么验证

12.1-12.4 是长期的分层策略,不是"写完代码之后才做"的事——单测和 loop 场景测试应该跟实现同步写。但对于**第一个能跑起来的版本**,建议按这个顺序过一遍,而不是直接开始写自动化测试:

1. **手工过一遍 12.2 的 7+1 条 loop 场景清单**:在一个 scratch 目录里 `npm run dev`,用真实模型手动触发(比如故意让模型在收尾时顺带读一个文件,制造"`finish` 和其他 tool_use 混在一起"的场景)。这一步比直接写自动化测试更快发现设计层面的问题——如果手工都跑不通,测试写了也没用。
2. **把第 1 步里手工验证过的场景,原样转成 loop 场景测试**(用假 `llm.send()` 固化下来),之后不再需要每次手工重来一遍。
3. **单测跟着实现同步写**,尤其是 `llm/adapters/*` 的往返转换——两个 provider 的 adapter 代码写完就立刻写对应单测,不要攒到最后。
4. **两个 provider 各跑一遍同样的真实任务**(比如都用"新建一个文件并跑测试"这个任务分别跑一次 Anthropic 和 DeepSeek),确认行为一致——provider 抽象是这一轮新加的,不能只验证一个 provider 就算过关。
5. **手动触发一次 `spawn_agent`**:给主 agent 一个适合委派的任务(比如"在代码库里找出所有用到某个函数的地方"),确认子 agent 的完整过程只打印在终端、不进主 session 的历史,且主 session 里最终只留下一条 `spawn_agent` 的 tool_result。
6. **跑一次 12.2 的端到端冒烟清单**,接真实模型,断言最终文件状态。
7. **开始用 tcode 开发 tcode 自己**(dogfooding)——这是唯一能发现"模型这次表现是不是变差了"这类问题的方式,没有替代品,持续做,不是一次性步骤。

## 13. 追踪与可视化

### 13.1 为什么 trace 必须和 session 分开

`session.messages` 存的是"发给模型的东西",不是"实际发生了什么"。两者差得很远:

- 子 agent 的完整中间过程**故意不进 session**(见 5.6,这正是委派的目的)——但那恰恰是最值得看的思考过程。
- 每轮耗时、token 用量、工具执行时长、审批批准还是拒绝、compaction 什么时候触发压缩了什么——session 里一个都没有。
- session 会被 compaction 改写视图、会被裁剪(见 3.1);trace 要如实、要全、只追加不修改。

所以是两个平行的产物,职责相反:

```
.tcode/sessions/<id>.json    发给模型的上下文真相 —— 要瘦,会被裁剪
.tcode/traces/<id>.jsonl     实际发生了什么     —— 要全,只追加不修改
```

**先有 trace 才谈得上可视化。** 没有它,做任何 UI 都没有数据可显示。

### 13.2 事件格式

每行一个 JSON 对象(JSONL),公共字段:

```jsonc
{ "seq": 12, "t": 1754130000123, "depth": 0, "type": "tool_call", /* 各类型自己的字段 */ }
```

- `seq`——单调递增序号。时间戳精度不足以稳定排序,而 viewer 需要确定的顺序。
- `t`——`Date.now()` 毫秒。
- `depth`——嵌套层级。主 agent 是 0,子 agent 是 1。**子 agent 的事件写进同一个 trace 文件**,靠 `depth` 区分,这样 viewer 能画出嵌套结构,而不需要拼接多个文件。

事件类型(v1):

| type | 关键字段 |
|---|---|
| `session_start` | provider, model, root, fullAuto, contextWindowTokens |
| `turn_start` | input |
| `request_start` | iteration, viewLevel, tokens, messageCount |
| `request_end` | durationMs, stopReason, textLength, toolCount |
| `assistant_text` | text |
| `tool_call` | id, name, input |
| `approval` | id, name, decision("approved" \| "declined") |
| `tool_result` | id, name, ok, durationMs, content |
| `subagent_start` | role, task |
| `subagent_end` | role, outcome, summary |
| `context_omitted` | tokens, budget |
| `compaction` | upToIndex, tokensBefore, tokensAfter, ok, error? |
| `turn_end` | outcome, durationMs, usage, finish? |
| `error` | message |

- `tool_result` 的 `content` 复用 `MAX_OUTPUT_CHARS` 的截断规则——trace 要全,但不该因为一次 `cat` 大文件就写出几百 MB。
- 写入失败(磁盘满、权限问题)**只打印一次警告然后静默降级**,绝不能让追踪失败拖垮用户的 turn。追踪是辅助功能,不是关键路径。

### 13.3 开关与生命周期

- 默认**开启**。JSONL 体积很小(工具输出已截断),而可观测性是这个功能存在的理由;默认关掉等于没做。
- `TRACE=off` 关闭(见 8.2)。关闭时用一个 no-op tracer,调用点不需要判空。
- trace 文件和 session 一一对应,`--continue`/`--resume` 时**追加**到同一个文件,不新建——一次会话的完整经过应该在一个文件里。

### 13.4 Viewer

```
tcode --view              # 打开最近一次会话
tcode --view <session-id> # 打开指定会话
```

- 起一个**本地 http server**(Node 内建 `http`,零新依赖),打印 URL 并尝试打开浏览器。
- **不用 Electron**:数据已经在磁盘上,需要的是查看器不是应用。Electron 的价值在系统托盘、原生菜单、桌面分发,这个场景一个都不占,而渲染层它同样是 Chromium,画面上没有优势,却要背打包体积和构建链路。
- 页面是单文件 HTML,CSS/JS 内联,不引 CDN——离线可用,也免得给一个本地工具引入供应链风险。
- 实时更新:`/events` 走 SSE,tcode 跑着的时候页面自动追加新事件。
- 只读。viewer 不提供任何修改会话/发起对话的能力,它就是个查看器。

## 14. 终端呈现(UI)

### 14.1 现状诊断

先说清楚要解决的是什么。下面是当前一次真实输出的原貌:

```
› Read a.txt, then change the letter a to z in it, then run ls. Then finish.
$ cat a.txt
Now let me change the letter `a` to `z` in `a.txt`. I'll use `sed`:
$ sed -i '' 's/a/z/' a.txt
$ ls -la
The letter `a` was successfully changed to `z` in `a.txt`, and `ls -la` confirmed the file listing.
✓ finish (done)

✓ done: Read a.txt (was 'a'), replaced the letter with 'z'…

[context 954/65.5k]
```

问题按严重程度排,**第一条不是审美问题**:

1. **工具结果完全看不见。** `$ ls -la` 下面什么都没有。模型说"改成功了""ls 确认了文件列表",用户只能选择相信——**没有任何独立核对的手段**。一个会自己动手改代码的工具,把动手的结果藏起来,这是信任问题不是观感问题。
2. **`✎ edit file.ts` 不显示改了什么。** 同上,更严重:文件已经被改了,而用户看不到 diff。
3. **零颜色。** 全文件树里除了 viewer 和光标控制,没有一个 SGR 转义序列。所有信息——用户输入、模型文本、命令、报错、元信息——视觉重量完全一样,眼睛没有任何着力点。
4. **执行中没有任何进度反馈。** `$ sleep 10` 打完之后是十秒空白,分不清"在跑""在等网络""挂了"。
5. **助手文本不渲染 markdown。** 反引号、`**` 原样出现在终端里,模型的排版意图全部丢失。
6. **层次只靠 `$ ⋮ ✎ ✓` 四个符号承载**,而它们同色同粗细,等于没有层次。

### 14.2 框架选型:不引入 TUI 框架

参照实现分两派:

| | 框架 | 屏幕模型 |
|---|---|---|
| Claude Code / Gemini CLI / Copilot CLI | **Ink**(React for CLI,Yoga flexbox 算布局,输出 ANSI) | inline |
| Codex CLI | **ratatui**(Rust) | 全屏 widget 树 |
| opencode | **bubbletea**(Go,Elm 架构) | 全屏 |

**tcode 的决策:不引入框架,继续自绘 ANSI。** 理由:

- **要的东西不需要布局引擎。** 14.1 那六条里,没有一条需要 flexbox、需要分栏、需要虚拟滚动。需要的是颜色、缩进、diff、spinner——都是行级渲染。Claude Code 用 Ink 是因为它有 389 个组件文件、8 万行 UI 代码;为了给六行输出上色引入 React + Yoga,是拿架构复杂度换一个不存在的问题。
- **Ink 要接管输入,和现有实现正面冲突。** 3.2 那套 readline + `ui/live-input.ts` 的固定输入行是实跑调出来的(含 CJK 宽度、deferred wrap、Esc 的 meta 陷阱),换 Ink 等于全部推倒重来,换来的是同一个效果。
- **地基已经在了。** `ui/width.ts` 的显示宽度、`ui/live-input.ts` 的 frame 擦除重排,正是自绘所需的全部基础设施。
- **零运行时依赖是这个项目的既有性质**(目前只有 `@anthropic-ai/sdk` 一个),不为上色破例。

**逃生门**:如果以后真要做分栏、可滚动的 diff 面板、多 agent 并排这类**布局问题**,那时候再上 Ink——判据是"出现了布局问题",不是"觉得不够花哨"。

### 14.3 硬约束

- **绝不进 alternate screen。** 全屏 TUI 退出时会把整屏擦掉,用户往回翻不到刚才 agent 干了什么。对一个会改代码的工具,scrollback 是审计记录,不是装饰。inline 渲染这条不能动。
- **非 TTY(管道、重定向、CI)时输出纯文本**,不含任何转义序列——这是 3.2 已有的约束,现在扩展到颜色。
- 尊重 **`NO_COLOR`**(设了就无色,不管值是什么)和 **`FORCE_COLOR`**(强制上色,给 CI 里想要颜色的场景),`TERM=dumb` 视为无色。
- **只用 16 色基本色,不用 truecolor。** 理由和 Claude Code 提供 ANSI 主题一样:SSH、tmux、老终端、CI 日志里 truecolor 会退化成噪音,而 16 色到处都对。用户的终端主题本来就定义了这 16 色,跟着它走比自己指定 RGB 更协调。
- **一切宽度计算必须走 `ui/width.ts`**,它已经先剥 ANSI 再算宽度。上色之后行宽计算错位会直接破坏 3.2 的 frame 擦除。
- 颜色是**语义**不是装饰:同一类信息永远同一个颜色,不因为"这行看起来单调"就换色。

### 14.4 分阶段方案

**P0 —— 工具结果可见(先做,这条不是 UI 优化是缺陷修复)**

- 每个工具调用下面,缩进显示**给人看的结果摘要**,默认最多 6 行,超出显示 `… +N lines`(完整内容照旧进 `tool_result` 给模型,两者互不影响)。
- 这需要在工具接口上把**"给模型的结果"和"给人的摘要"分开**——现在 `execute()` 只返回前者。这是 5 节的结构性改动,不是展示层能自己解决的。
- 各工具的摘要形态:
  - `bash`:stdout 前几行;**exit code 非 0 时标红并显示 stderr**(现在失败和成功长得一模一样)
  - `read_file`:`123 lines`,不重复打印文件内容(模型要看,人不要)
  - `edit_file` / `write_file`:**显示 diff**,`+` 绿 `-` 红,超长只显示改动附近
  - `spawn_agent`:保持现有的 `│` 前缀缩进
- 失败的工具调用必须视觉上一眼可辨——现在 `is_error` 的结果在终端上完全不可见。

**P1 —— 颜色与层次**

一张语义色板,不是调色盘:

| 角色 | 样式 |
|---|---|
| 用户输入回显 | 默认色加粗 |
| 助手文本 | 默认色 |
| 工具调用行 | 符号青色 + 命令/路径默认色 |
| 工具结果摘要 | 暗色(dim)缩进 |
| 错误 / 非零退出 | 红 |
| 完成 / diff 增行 | 绿 |
| 元信息(context、进度、提示、排队) | 暗色 |
| 中断 | 黄 |

**P2 —— 执行中的状态指示**

- 盲文点 spinner(`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`)+ 已用秒数 + 当前在做什么,画在输入行**上方**,复用 3.2 的 frame。
- 区分**"在等模型"**和**"在跑工具"**——现在两者都是一片空白,而它们的正常耗时差一个数量级,分不清就没法判断该不该按 Esc。
- 非 TTY 不画 spinner(会在日志里刷出几百行垃圾)。

**P3 —— 助手文本的 markdown 渲染**

- 行级渲染:`**粗体**`、`` `行内代码` ``、`# 标题`、`- 列表`、`> 引用`。
- **流式的难点是 markdown 跨 chunk**:`**bold**` 的两个星号可能分在两次 delta 里。所以按**行**渲染——攒够一行再渲染那一行,行内的标记就完整了。这和 3.2"半行也要立刻显示"冲突,冲突处以 3.2 为准:**只对已完成的行做 markdown 渲染,半行按原样流式输出**,等换行到了再重绘那一行。
- **不做语法高亮。** 需要按语言做词法分析,是数量级更大的工程,而代码块加个左边框已经解决了"看得出这是代码"的问题。

**不做的:给输入行加边框。** Claude Code 有,但那是 Ink 在管输入;tcode 的输入行归 readline 画,加边框要接管换行和光标定位,风险大收益小。

### 14.5 模块划分

```
src/ui/
  width.ts        # 已有
  live-input.ts   # 已有
  keys.ts         # 已有
  style.ts        # 颜色能力检测(isTTY / NO_COLOR / FORCE_COLOR / TERM)+ 语义色板。
                  # 无色时所有函数退化成恒等函数,调用方不需要写 if
  format.ts       # 行级渲染:工具调用行、结果摘要缩进与截断、diff 着色、markdown 行渲染
  spinner.ts      # 状态指示:帧推进、已用时间、等模型/跑工具的区分
```

- `style.ts` 必须**无色时退化成恒等函数**,而不是让调用方到处 `if (color)`——那种写法一定会漏,漏了就在管道里泄转义序列。
- `format.ts` 是**纯函数**:输入结构化数据,输出字符串,不碰 stdout。这样它能脱离终端单测,和 `width.ts` 一样——14.1 那些问题里有几条本来就是"只能靠肉眼在真终端发现"的类型。

## 15. 交互便利性

14 节解决的是**看得懂**(工具干了什么、哪里失败了)。这一节解决**用着顺手**——两者是不同的轴,前者做完之后后者的差距反而更显眼。

### 15.1 先修一个数据丢失(不是便利性问题)

**粘贴多行文本时,第一行之后的内容会无声消失。** 实测:粘 5 行进去,模型只收到第 1 行,回答"我没看到你说的 stack trace";其余 4 行既没进队列也没有任何提示。

原因在 REPL 的 `line` 事件:整段粘贴在**一次** data 事件里被 readline 同步拆成 5 个 `line`,第 1 行被 `ask()` 取走并触发 turn,但 turn 是异步启动的,第 2-5 行到达时 `controller` 还是 `null`,于是 `if (!controller) return` 把它们丢掉了。

这是**静默丢用户输入**,比任何 UI 问题都严重,排在所有便利性改进之前。

**修法不是"把它们也塞进队列"**——那会让一次粘贴变成 5 个独立 turn,同样不是用户的意思。正确的修法是让终端告诉我们"这是一次粘贴":

- 启用**括号粘贴模式**(bracketed paste):进入 REPL 时发 `\x1b[?2004h`,退出时发 `\x1b[?2004l`。终端会把粘贴内容包在 `\x1b[200~` 和 `\x1b[201~` 之间。
- 在这对标记之间收到的所有内容(**含换行**)拼成**一条**消息,不拆分、不逐行提交。
- 收到 `\x1b[201~` 才算这条输入准备好;此时如果 turn 在跑就进队列走 steering(见 3.2),否则作为本轮输入。
- 终端不支持括号粘贴时(标记不会出现)退化成现在的逐行行为,但**空闲期到达的行也必须进队列**,绝不丢弃——退化可以,静默丢数据不行。

### 15.2 多行输入

粘贴解决了"从别处拷进来",但**手写**一段多行输入(比如带格式的需求描述)现在做不到:回车即提交。

- **`\` 结尾续行**:一行以反斜杠结尾时,不提交,进入续行状态,提示符换成续行标记。这是 shell 的既有肌肉记忆,零学习成本。
- 不用 `Alt+Enter`/`Shift+Enter`:大量终端根本不把这两个组合传给程序(它们在终端层面就被吃掉或映射成普通 Enter),做了也是薛定谔的功能。参照实现里它们能用,是因为那些工具自己接管了整个输入层。

### 15.3 斜杠命令

**REPL 里目前一个命令都没有**——包括没有 `/help`。想换 session、想手动压缩、想知道有哪些功能,唯一的办法是退出进程重开,或者去读 spec。

以 `/` 开头的输入不发给模型,由 REPL 本地处理(模型确实需要以 `/` 开头的字面输入时,极少见,可以用引号包起来说明):

| 命令 | 作用 |
|---|---|
| `/help` | 列出全部命令和快捷键。**没有它等于整个 CLI 没有说明书** |
| `/sessions` | 等价于 `tcode sessions`,但不用退出 |
| `/resume [id]` | 不带 id 时列出并交互选择,当场切换到那个会话 |
| `/new` | 在当前目录另起一个空会话,不退出进程 |
| `/compact` | 手动触发 3.1 的压缩,不等阈值 |
| `/context` | 打印当前 token 占用明细(system prompt / memory / 历史各占多少) |
| `/model` | 显示当前 provider/model;带参数时切换 |
| `/init` | 扫描当前项目生成初版 `AGENTS.md`(见 9 节) |

- **命令一律不进 `session.messages`**,它们是对 CLI 说的话,不是对模型说的。
- 未知命令给出提示并列出可用命令,**不**默默发给模型——用户打错一个命令却收到模型一本正经的回答,是最难排查的一类困惑。

### 15.4 补全与文件引用

- **Tab 补全文件路径**。现在按 Tab 只会插入一个字面制表符。readline 原生支持 `completer`,补全项限制在项目目录内(见 6 节)。
- **`@路径` 引用文件**:输入里出现 `@src/foo.ts` 时,REPL 把该文件内容随消息一并送出,并在终端上折叠成一行 `@src/foo.ts (128 lines)`。现在要让模型看某个文件,只能用散文描述路径再等它自己调 `read_file`,多一个来回而且容易打错。
  - `@` 补全走同一套 completer。
  - 引用的文件同样受 6 节的目录范围限制。
  - 超过 `MAX_OUTPUT_CHARS` 的文件按 5.1 的规则截断,并明确告诉用户截断了。

### 15.5 输入历史持久化

readline 的历史现在**只在内存里**,进程一退就没了——`.tcode/` 下只有 `sessions` 和 `traces`。

- 落到 `<project>/.tcode/history`,按项目存而不是全局:同一台机器上不同项目的输入几乎没有交集,混在一起只会让上翻变得更费劲。
- 启动时读回 readline 的 `history`,退出时写出,上限 `HISTORY_MAX_ENTRIES`(默认 500)。
- **不记录以 `/` 开头的命令**?不,要记录——重复执行 `/compact` 这类命令正是上翻的常见用途。

### 15.6 其余

- **`tcode --resume` 不带 id**:现在必须先 `tcode sessions` 把 id 抄下来。不带 id 时应该直接列出并让用户选。
- **`tcode -p "<任务>"`**:一次性非交互执行后退出。现在只能靠管道喂 stdin,而管道会连带触发一堆交互路径的退化行为(见 3.2)。`-p` 让"在脚本里用 tcode"成为一条明确支持的路径。
- **turn 结束时汇总本轮改动的文件**(`3 files changed: src/a.ts, src/b.ts, README.md`)。用户下一步几乎总是 `git diff` 或 `git add`,而现在要从滚动历史里自己拼出改了哪些文件。

### 15.7 优先级

1. **15.1 粘贴丢数据** —— 这是 bug,不排优先级,先修。
2. **15.3 `/help` 和斜杠命令** —— 对"便利"的提升最大,而且 `/help` 的缺失意味着现在整个 CLI 没有任何自我说明。
3. **15.4 Tab 补全 + `@` 引用** —— 每一轮输入都在用的东西。
4. **15.5 历史持久化**、**15.2 多行输入** —— 高频但单次收益小。
5. **15.6** —— 明确有用,但都能用现有手段绕过。

## 16. 现代化终端呈现

14 节让输出**看得懂**,15 节让操作**用着顺手**,这一节解决**第一眼**——用户要拿它给别人演示,而演示场合看的是印象,不是功能清单。

### 16.1 推翻两条自己的决策

- **§14.4 "不做输入框边框"** —— 当时的理由是"输入行归 readline 画,加边框要接管换行和光标定位,风险大收益小"。**收益的估算错了**:带边框的输入框是"这个工具是现代的"这个判断里权重最大的单一元素,参照实现无一例外都有。风险的估算没错,代价确实是接管输入层——所以下面就接管。
- **§14.2 "不引入框架"** —— 这条**继续成立**,理由要更新。当时说"要的东西不需要布局引擎";现在要的东西需要一点布局,但需要的是**一个固定的三段式**(输出区 / 输入框 / 状态栏),不是通用布局问题。为一个固定版式引入 flexbox 引擎,依赖从 1 个变成 ~40 个,并且 §3.2 / §15.1 那些实跑调出来的行为(CJK 宽度、Esc 的 meta 陷阱、括号粘贴)全部要在别人的输入层上重验一遍。

**结论:自己写行编辑器,不上框架。** 地基已经在了——`ui/width.ts` 的显示宽度、`ui/live-input.ts` 的 frame 擦除重排,正是自绘输入框所需的全部东西。

**但按键解析继续用 `readline.emitKeypressEvents`。** 它是一个纯解析器(把字节流变成 `{name, ctrl, meta, shift}`),不是输入层的所有者;自己重写 ANSI 按键解析没有任何收益,只会重新踩一遍 Esc 那种坑。被替换掉的是 `readline.Interface`——行缓冲、历史、补全、`question()` 全部自己实现。

**顺带清掉的包袱**:`prevRows` 那套光标交接、`ask()` 前必须 `live.stop()` 的移交、粘贴过滤器要绕开 readline 才能拿到原始字节——这些都是"输入层是别人的"带来的,自己拥有之后一并消失。

### 16.2 版式

```
╭──────────────────────────────────────────╮
│  tcode                                    │
│  deepseek-chat · ~/project                │
╰──────────────────────────────────────────╯

› fix the auth bug

  ⋮ read src/auth.ts                 128 lines
  ✎ src/auth.ts                          +3 -1
     41   const token = req.headers.token
     42 - if (!token) return null
     42 + if (!token) throw new AuthError()
  $ npm test
     12 passing

  ✓ fixed the missing auth check

╭──────────────────────────────────────────╮
│ ›                                         │
╰──────────────────────────────────────────╯
  deepseek-chat · 4.2k/65.5k · ⏎ send · esc stop
```

- **屏幕是三段**:输出区(向上滚动,永不重绘)、输入框、状态栏。输入框和状态栏合起来是"底部区域",每次输出前擦掉、写完重画——和 3.2 已有的 frame 机制是同一套,只是从 1 行变成 3 行。
- **元数据右对齐**(`128 lines`、`+3 -1`)。左边是动作,右边是结果,眼睛扫一列就够,不用逐行读到尾。
- **diff 带行号**,`-`/`+` 顶格在行号右侧。
- **圆角框**(`╭╮╰╯`)。方角看起来像旧终端程序,圆角是这一代工具的共同语言。
- **框宽跟随终端宽度**,上限 100 列(再宽读起来反而累),下限 40 列;窄于下限时退化成不画框、只留提示符——小窗口里画框只会挤没内容。
- **状态栏常驻**:模型、context 占用、当前可用的键。它替代了每轮末尾那行 `[context …]`——常驻的东西不需要重复播报。

### 16.3 配色

- **truecolor 优先,16 色回退,无色兜底。** 三级能力检测:`NO_COLOR`/`TERM=dumb` → 无色;`COLORTERM` 是 `truecolor`/`24bit`,或 `TERM` 含 `256color` → 全彩;其余 → 16 色。
- **理由变了**:14.3 当时选 16 色是为了"跟随用户终端主题,更协调"。演示场合的要求正好相反——**画面必须在别人的机器上长得一样**,而 16 色由对方的主题决定,完全不可控。所以固定强调色,并保留 16 色回退给 SSH/CI。
- **强调色只有一个**,用于品牌元素(框线、提示符、logo)。语义色(错误红、新增绿、删除红)照旧,不参与品牌。多强调色会让画面变花,那是"廉价"而不是"现代"。
- 灰阶用于次要信息,层级只做三档(主要/次要/极弱),再多眼睛分辨不出来,只是噪音。

### 16.4 行编辑器要覆盖的

自己实现意味着这些不再是白送的,必须逐条做到,否则"现代"换来的是"不好用":

- 插入、退格、Delete、左右移动、Home/End(含 `Ctrl+A`/`Ctrl+E`)
- 按词移动与删除(`Alt+←/→`、`Ctrl+W`)、删到行首/行尾(`Ctrl+U`/`Ctrl+K`)
- 历史上下翻(`↑`/`↓`),含 15.5 的落盘
- Tab 补全(15.4),多候选时列出、单候选时直接补全
- 反斜杠续行(15.2)与括号粘贴(15.1)
- `Ctrl+C` / `Ctrl+D` / `Esc` 按 3.2 的语义
- **光标定位按显示宽度**,不是字符数(见 14.3);中文输入下光标错位是最刺眼的失败

### 16.5 模块

```
src/ui/
  theme.ts        # 能力分级(无色/16 色/truecolor)+ 语义与品牌色板。
                  # 取代 style.ts 的角色,并向下兼容它的 Palette 形状
  chrome.ts       # 框、横幅、状态栏、右对齐行、分隔线。纯函数,输入数据输出字符串行
  editor.ts       # 行编辑器:缓冲区、光标、按键处理、历史、补全。
                  # 不碰 stdout——渲染成"行 + 光标位置"交给 live-input 画
```

- `editor.ts` **不直接写终端**。它返回"这一区域应该长什么样 + 光标在第几行第几列",由 `live-input.ts` 负责擦除和重画。这样整个编辑器能脱离终端单测,和 `width.ts` 一样。

### 16.6 确认对话框

现在的审批长这样:

```
  writes outside the project (/etc/hosts). proceed? [Y/n]
```

**要手打 `y` 再回车。** 这是整个交互里最刺眼的一处:确认是个二选一,却要求用户完成"移动到键盘、找到 y、按下、再按回车"四个动作;而且提示词、命令、选项挤在一行里,真正危险的那条命令反而没有任何视觉重量。

**改成单键选择的对话框**:

```
╭─ run this command? ──────────────────────╮
│                                          │
│  $ rm -rf ~/Documents                    │
│  writes outside the project              │
│                                          │
│  ❯ yes                                   │
│    yes, and don't ask again this session │
│    no                                    │
│                                          │
╰──────── ↑↓ choose · ⏎ confirm · esc no ──╯
```

- **`↑`/`↓` 选,`⏎` 确认,`Esc` 等于拒绝。** 不需要回车之外的任何输入。`y`/`n` 作为快捷键保留——肌肉记忆已经在那里的人不该被迫改。
- **命令单独占一行并且是视觉焦点**,原因写在它下面。现在的一行式排版把最该看清的东西埋进了句子中间。
- **"这个会话内不再问"**:同一条命令在一轮任务里常常要跑很多次(`npm test` 改一次跑一次),每次都问就是在训练用户闭眼确认——而那正是 §5.1 说的审批疲劳本身就是安全问题。范围限定在**本次进程**,不落盘:持久化的白名单是另一个量级的决策,不在这里顺手做。
- 拒绝时照旧回填 `is_error` 的 `tool_result`(见 3 节),不是静默跳过。
- **非 TTY 时退化成现在的行为**:没有方向键可用,EOF 仍然算拒绝。

**同一套选择器复用给 `/resume`**(见 15.6):现在是打印一个列表再让用户输编号,同样是"能不打字就不该打字"。

### 16.7 覆盖层

确认框和会话选择器是**覆盖层**:出现时接管按键,消失后编辑器原样恢复。

- REPL 只有**一个**按键入口,按当前是否有覆盖层分发给覆盖层或编辑器。两套并行的输入路径是 §15.1 那个数据丢失 bug 的成因,不再重复。
- 覆盖层和输入框占据屏幕的同一块区域(底部),所以擦除/重画走 §3.2 的同一套 frame 逻辑,不引入第二种绘制方式。

### 16.8 语法高亮

diff 和代码块现在是单色的。终端里区分不出关键字、字符串和注释,读代码的效率和读一段散文一样。

- **自己写粗粒度 tokenizer,不引入 highlight.js / shiki。** 那类库为浏览器设计,带几十种语言的完整语法定义和一套 CSS 主题体系;终端上只有六七种可用颜色,**粗粒度和精细高亮的观感差别很小,而依赖体积差两个数量级**。
- 分五类就够:注释、字符串、数字、关键字、其余。再细分(类型 vs 变量 vs 函数)在六色调色板里已经无法稳定区分。
- **语言从文件扩展名或 ``` 后面的标记推断;认不出就不高亮。** 猜错语言比不高亮更糟——把 Python 的 `#` 注释按 C 的方式渲染,读者会以为那是代码。
- 高亮**必须不改变显示宽度**(见 14.3),否则 3.2 的 frame 擦除会错位。

### 16.9 一行一个工具调用

现在一次工具调用占两块:调用行,然后缩进的结果块。眼睛要在两处之间跳。

```
  ⋮ read src/auth.ts                              128 lines
  ✎ src/auth.ts                                       +3 -1
     41   const token = req.headers.token
     42 - if (!token) return null
     42 + if (!token) throw new AuthError()
  $ npm test                                     exit 0 · 1.2s
     12 passing
```

- **调用与结果合成一行**,结果元数据右对齐。左边是动作,右边是结果。
- 代价:这一行只能在工具**执行完之后**才打得出来。执行期间由 spinner 承担反馈(见 14.4 P2),它本来就显示当前在跑什么。
- **例外:执行过程中自己有输出的工具**(`spawn_agent` 会实时打印子 agent 的过程)仍然先打调用行,否则子 agent 的输出会出现在它自己的标题之前。工具用一个标志声明这件事,不靠名字硬编码。
- **diff 带行号**,`-`/`+` 紧跟行号,和上下文行对齐。

### 16.10 无闪烁重绘

底部区域每次更新都是"擦掉 → 重画",而且**擦和画是两次独立的写入**。终端在两次写入之间会渲染一帧,那一帧上底部区域是空的——于是用户看到的是闪烁。spinner 每 80ms 触发一次重绘,等于每秒闪十几次。

三条一起用:

- **整帧合成一次写入。** 光标移动、擦除、内容全部拼成一个字符串,一次 `write` 交给终端。终端不会在一次写入的中间渲染,大部分闪烁到此为止。
- **同步输出(DEC 私有模式 2026)。** 更新包在 `\x1b[?2026h` 和 `\x1b[?2026l` 之间,支持的终端会把整段缓冲起来原子呈现;不支持的终端把它当成未知私有模式**静默忽略**,没有副作用。这是这一代终端解决撕裂/闪烁的标准手段。
- **内容没变就不重画。** 比较这一帧和上一帧的行与光标位置,完全相同就什么都不发。按键里有很大一部分(方向键到头、重复的补全)其实不改变画面。

**不用 alternate screen 来"解决"闪烁**——那确实能让整屏刷新变干净,但会吞掉 scrollback,而 16.1 已经定过:对一个会改代码的工具,scrollback 是审计记录。
