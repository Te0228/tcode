# tcode 验证 Criteria(v1)

这份文档是 [spec.md](spec.md) 第 12 节"测试与验证策略"的**可执行版本**:spec.md 说的是"分几层测、每层测什么",这份文档把它落成一条条可以直接打勾的具体断言,每条尽量能对应到一个单测 / loop 场景测试 / 手工验证步骤。写代码/写测试时可以直接对着这份清单过,不用回 spec.md 里翻。

用法:
- 实现某个模块时,把对应小节的条目全部打勾才算这个模块做完。
- 12.5 节"第一次实现完之后怎么验证"里的手工验证,就是把下面这些条目手工过一遍。
- 以后 spec.md 有决策变化,先改 spec.md,再回来同步这份文件,避免两边不一致。
- 条目后面的 `(§x)` 指向 spec.md 对应章节,方便查为什么要这么验证。

---

## 1. CLI / REPL 基础(§2、§4)

- [x] `npm run dev`(或 link 后的 `tcode`)能进入 REPL 并展示提示符
- [x] 输入空行 / `exit` / `Ctrl+D` 能正常退出进程,没有孤儿子进程残留(尤其是 bash 工具起过子进程之后)
- [x] 不传参数启动 → 新建 session,`.tcode/sessions/` 下生成新文件,`messages` 为空
- [x] `--continue` → 加载 cwd 下 `updatedAt` 最新的 session 文件,历史正确接续,新一轮对话能看到之前的上下文
- [x] `--resume <id>` → 精确匹配存在的 session 能恢复
- [x] `--resume <不存在的id>` → 给出清晰报错,不崩溃、不静默新建
- [x] `.tcode/` 已经在 `.gitignore` 里,不会被误提交

## 2. Agent Turn 循环(§3、§12.2)

- [x] 空 `toolUses` → turn 正常结束,不再调用 LLM,提示符还给用户
- [x] 单独一个 `finish` → 执行、回填 `tool_result`、break,不再调用 LLM
- [x] `finish` 只带 `summary`(省略 `status`)→ 按 `done` 处理,不报错(§5.5)
- [x] **回归锁**:`finish` 与其他 tool_use 混在同一响应 → 全部执行、`tool_result` 全部回填、消息历史闭合;之后模拟一次 `--continue` 追加新 user 消息,不因为悬空 tool_use 报错
- [x] 工具执行抛错 → `is_error: true` 回填给模型,loop 不崩溃,模型能继续下一轮
- [x] 用户对 `bash` 拒绝确认(输入 n)→ 回填"用户拒绝"的 `is_error` 结果,不执行命令,loop 继续
- [x] **默认不设工具调用次数上限**:连续 80 轮返回 tool_use 也不会被截断(整项目改造是几十上百轮正常工作)
- [x] 设了 `MAX_TOOL_ITERATIONS` 时仍按老行为在到达时中断并打印提示,session 完整可保存
- [x] 每 `PROGRESS_EVERY_ITERATIONS` 轮打一行进度(轮数 + context + 怎么停),设 0 时不打
- [x] 单批多个非 `finish` 工具 → 按顺序串行执行(用带副作用的假工具验证执行顺序,不是并发乱序)
- [x] 模型文本输出通过 `onTextDelta` 增量打印,能观察到逐块输出而不是一次性蹦出整段
- [x] 单条 tool_result 内容超过 `MAX_OUTPUT_CHARS` 时按首尾截断规则处理,不会把巨量内容原样灌进 messages

### 2.1 中断与执行期间的输入(§3.2)

- [x] 单独按 `Esc` 能中断正在跑的 turn(注意 readline 把它报成 `meta: true`,按"无修饰键"过滤会全部漏掉)
- [x] 中断后正在跑的命令立刻停掉(SIGTERM → 2s → SIGKILL),不等 `COMMAND_TIMEOUT_MS`
- [x] 中断信号发给整个进程组,`sh -c "echo x; sleep 300"` 这类不留孤儿进程
- [x] 中断时这一批 `tool_result` 仍然全部回填,消息历史闭合;已拿到的输出照样保留
- [x] turn 执行期间提示符始终可见并固定在最下方,输出渲染在它上方,不与它共享同一行
- [x] 流式输出的半行也立刻显示,不攒到整行(中文按 2 列算宽度,擦除行数不错位)
- [x] 非 TTY(管道)时不发任何光标控制序列,输出里一个转义序列都没有
- [x] **steering**:执行期间发出的消息在当前这批工具跑完后并入**当前 turn**,不等到下一轮
- [x] steering 消息与 `tool_result` 同属一条 user 消息,且带来源前缀,模型不会当成工具输出
- [x] **回归锁**:openai-compat adapter 展开这条消息时先出全部 `tool_result` 再出 text——顺序反了直接 400
- [x] 这一批调了 `finish` 或已被中断时不注入,消息留给下一轮,不会被静默吞掉
- [x] steering 之后消息历史仍然闭合(无悬空 tool_use)

## 3. 工具集(§5)

### 3.1 `bash`(§5.1)
- [x] 默认执行前打印命令并等待确认(y 确认/n 拒绝/回车默认确认)
- [x] `--full-auto` 启动时跳过确认,直接执行
- [x] 输出超过 `MAX_OUTPUT_CHARS` 时首尾各留一半 + 截断提示
- [x] 超过 `COMMAND_TIMEOUT_MS`(默认 60s)后强制结束,返回超时错误而不是无限挂起
- [x] 返回结构包含 `stdout`/`stderr`/`exitCode`,且 `exitCode` 与实际命令一致

### 3.2 `read_file`(§5.2)
- [x] 返回内容带行号(类似 `cat -n`)
- [x] `offset`/`limit` 生效,能分段读取大文件
- [x] 文件不存在 → `is_error: true`
- [x] 路径是目录 → `is_error: true`

### 3.3 `edit_file`(§5.3)
- [x] `old_string` 唯一匹配 → 替换成功,文件内容正确
- [x] `old_string` 零匹配 → 报错,提示"未找到匹配"
- [x] `old_string` 多处匹配且 `replace_all` 非 `true` → 报错并告知匹配了几处,不做任何修改
- [x] `old_string` 多处匹配且 `replace_all: true` → 全部替换
- [x] `old_string === ""` 且文件不存在 → 视为创建新文件,内容等于 `new_string`
- [x] `old_string === ""` 且文件已存在 → 报错,提示改用 `write_file`,文件内容不变

### 3.4 `write_file`(§5.4)
- [x] 目标文件不存在 → 创建成功
- [x] 目标文件已存在 → 整体覆盖成功

### 3.5 `finish`(§5.5)
- [x] `status: "done"` 和 `status: "blocked"` 都能正确传递,CLI 对两种状态有可区分的展示
- [x] `finish` 执行后 loop 正确 break,回到 REPL 提示符

### 3.6 `spawn_agent`(§5.6)
- [x] `role: "general"` 的子 agent 能访问除 `spawn_agent` 自身外的全部工具
- [x] `role: "explore"` 的子 agent 拿不到 `edit_file`/`write_file`(调用会因为工具不存在而失败,不是被 approval 拦下)
- [x] 任意 `role` 的子 agent 工具集里都不包含 `spawn_agent` 自己(防递归验证)
- [x] 子 agent 内部的 `bash` 调用依然会触发确认(除非 `--full-auto`),不会绕过审批
- [x] 子 agent 结束后,主 session 的 `messages` 只多一条 `spawn_agent` 的 `tool_result`,不包含子 agent 内部的中间消息
- [x] 子 agent 执行过程在终端有可区分主/子的标记(比如前缀或缩进)
- [x] 子 agent 撞到 `MAX_TOOL_ITERATIONS`(只在配了上限时可达)仍未 `finish` 时,能正常把"未完成"信息回传给主 agent,不会挂起主 loop

## 4. 目录范围限制(§6)

- [x] 相对路径解析在 `ROOT` 内 → 正常读写
- [x] 路径含 `../` 试图逃逸出 `ROOT` → 拒绝,报错信息包含 "path escapes project root" 或等价说明
- [x] 绝对路径指向 `ROOT` 外 → 拒绝
- [x] 路径恰好等于 `ROOT` 本身(边界值)→ 允许
- [x] `bash` 里执行 `cd .. && ls` 之类命令不受目录检查阻止(已知限制,确认这是预期行为而非 bug,行为需要和 spec §1/§6 描述一致)

## 5. Provider / 多模型(§8)

- [x] `PROVIDER=anthropic`(或未设置,默认值)时只要求 `ANTHROPIC_API_KEY` 存在,`DEEPSEEK_*` 缺失不影响启动
- [x] `PROVIDER=deepseek` 时只要求 `DEEPSEEK_API_KEY` 存在,`ANTHROPIC_*` 缺失不影响启动
- [x] 当前 provider 必需的 `*_API_KEY` 缺失 → `resolveProviderConfig` 直接抛错(`MissingApiKeyError`);`index.ts` 尚未接入,"启动直接报错退出不进入 REPL" 这半句留到 CLI 落地时再验
- [x] `llm/adapters/anthropic.ts` 和 `openai-compat.ts` 的归一化类型往返转换(message/tool_use/tool_result/system)结果一致,无字段丢失
- [ ] 用同一个真实任务(如"新建一个文件并跑测试")分别跑 Anthropic 和 DeepSeek 各一遍,两边都能正常完成、不因 adapter 转换问题崩溃 —— **DeepSeek 侧已实跑通过**(新建文件 + `node` 验证 + `edit_file` 改写),Anthropic 侧待验:本机 `.env` 里 `ANTHROPIC_API_KEY` 为空
- [ ] 恢复一个由 provider A 创建的 session,当前配置是 provider B → 启动时给出提示,但仍能正常继续对话,不报错 —— 提示逻辑已实现(`index.ts` 比对 `session.provider`),同样等有第二个 provider 的 key 才能实跑

## 6. 会话持久化(§4)

- [x] `messages` 落盘为归一化内部格式(不是某个 provider 的原始 wire 格式)
- [x] session JSON 里 `provider`/`model` 字段与实际使用的 provider/model 一致
- [x] `--continue` 选中的确实是 `updatedAt` 最新的文件(有多个 session 时验证)
- [x] `tcode sessions` 列出当前目录全部会话,按时间倒序,标出 `--continue` 会选中哪一条
- [x] 列表里的消息数不含 `tool_result` 载体消息(数的是对话,不是管道)
- [x] 单个损坏/半截写入的 session 文件被跳过,不会让整个列表和 `--continue` 一起失效
- [x] 目录下有历史会话且没带恢复参数时,启动横幅多打一行告诉用户怎么接上;干净目录不打
- [x] `tcode --continue` 实跑:上一轮让它记住一个数字,重进后能答出来

## 7. 项目级记忆(§9)

- [x] 项目根目录存在 `AGENTS.md` 时,内容被正确拼进 system prompt
- [x] 不存在 `AGENTS.md`/`TCODE.md` 时静默跳过,不报错、不阻塞启动
- [x] `AGENTS.md` 和 `TCODE.md` 同时存在时,优先使用 `AGENTS.md`

## 7.5 终端呈现(§14)

> 对应 spec §14。P0-P3 已实施并实跑验证。

P0 —— 工具结果可见:
- [x] 每个工具调用下面缩进显示结果摘要,默认最多 6 行,超出显示 `… +N lines`
- [x] 给人的摘要和给模型的 `tool_result` 是两条独立的路径,截断摘要不影响模型拿到的完整内容
- [x] `bash` exit code 非 0 时标红并显示 stderr,一眼能和成功区分开
- [x] `edit_file`/`write_file` 显示 diff(`+` 绿 `-` 红),不是只打一行 `✎ edit path`
- [x] `read_file` 只显示行数,不把文件内容重复打到终端

P1 —— 颜色与层次:
- [x] 语义色板生效:用户输入/助手文本/工具调用/结果/错误/完成/元信息 各有稳定的样式
- [x] `NO_COLOR` 设置后完全无色(不管值是什么);`TERM=dumb` 同样无色
- [x] `FORCE_COLOR` 能在非 TTY 下强制上色
- [x] **回归锁**:非 TTY 且未设 `FORCE_COLOR` 时,输出里一个转义序列都没有(管道/CI 场景)
- [x] 上色后 §3.2 的 frame 擦除行数仍然正确(宽度计算先剥 ANSI)

P2 —— 状态指示:
- [x] 执行中显示 spinner + 已用秒数,画在输入行上方,不干扰输入
- [x] "在等模型"和"在跑工具"视觉上可区分
- [x] 非 TTY 时不打 spinner,日志里不出现刷屏

P3 —— markdown:
- [x] 粗体/行内代码/标题/列表/引用 按行渲染
- [x] **回归锁**:半行仍然立刻流式输出(§3.2 优先),换行到达后再重绘该行的 markdown
- [x] 跨 chunk 的标记(`**bold**` 的两个星号分在两次 delta)不会渲染错乱

## 7.6 交互便利性(§15)

> 对应 spec §15,已实施并实跑验证。

- [x] **数据丢失回归锁**:一次粘贴 5 行,5 行全部进入同一条消息,一行都不丢(§15.1)
- [x] 括号粘贴模式下,粘贴内容含换行也只产生一条消息,不拆成多个 turn
- [x] 终端不支持括号粘贴时退化成逐行,但空闲期到达的行进队列而不是被丢弃
- [x] `\` 结尾续行:不提交,提示符变成续行标记(§15.2)
- [x] `/help` 列出全部命令与快捷键(§15.3)
- [x] `/sessions` `/resume` `/new` `/compact` `/context` `/model` 各自生效,且不进 `session.messages`
- [x] 未知的 `/xxx` 给出提示并列出可用命令,不发给模型
- [x] Tab 补全文件路径,补全项不越出项目目录(§15.4/§6)
- [x] `@path` 把文件内容随消息送出,终端上折叠成一行;越界路径被拒绝
- [x] 输入历史落盘到 `<project>/.tcode/history`,重启后上翻仍在(§15.5)
- [x] `tcode --resume` 不带 id 时列出并交互选择(§15.6)
- [x] `tcode -p "<任务>"` 一次性执行后退出
- [x] turn 结束时汇总本轮改动的文件

## 7.7 现代化终端呈现(§16)

- [x] 输入框全程可见:欢迎横幅、圆角输入框、常驻状态栏(模型 · context · 快捷键)
- [x] 框宽跟随终端宽度,上限 100 列、下限 40 列;窄于下限退化成裸提示符
- [x] 每一行框宽严格一致,含 CJK 内容与上色后
- [x] 终端未上报宽度(报 0)时按普通终端处理,不会第一帧无框、后续有框导致擦除错位
- [x] 光标按显示宽度定位,中文输入下不错位
- [x] truecolor / 16 色 / 无色 三级能力检测;NO_COLOR、TERM=dumb、管道仍然无色
- [x] **确认框单键完成**:↑↓ 选、⏎ 确认、Esc 拒绝,y/n/数字键作为快捷键;不需要打字
- [x] 确认框把命令单独成行并作为视觉焦点,原因写在下面
- [x] "本会话不再问"生效且只在本进程内,不落盘
- [x] `/resume` 不带 id 时用同一套选择器,不需要输编号
- [x] 行编辑器覆盖:插入/退格/Delete/左右/Home/End/Ctrl+A/E/U/K/W、按词移动、历史上下翻、Tab 补全、反斜杠续行、括号粘贴
- [x] 接管输入层后仍然自己设置 raw mode,退出时恢复(否则终端回显与编辑器渲染互相覆盖)

## 7.8 语法高亮与一行一调用(§16.8/§16.9)

- [x] diff 与代码块按语言粗粒度高亮(注释/字符串/数字/关键字),不引入高亮库
- [x] **回归锁**:高亮不改变显示宽度(否则 §3.2 的 frame 擦除会错位)
- [x] 语言从扩展名或 fence 标记推断,认不出就不高亮,不猜
- [x] 注释一直延伸到行尾,行内的关键字不会被重新着色
- [x] 一次工具调用只占一行,结果元数据右对齐(`128 lines` / `+3 -1` / `exit 0`)
- [x] 执行中自己有输出的工具(`spawn_agent`)仍然先打调用行,靠标志声明而不是硬编码名字
- [x] diff 带行号,行号宽度随文件长度变化,标记列始终对齐
- [x] **回归锁**:输入超过框宽时横向滚动,任何一行都不会超出框宽导致折行

## 7.9 无闪烁重绘(§16.10)

- [x] 每次更新是**一次** write:光标移动、擦除、内容拼成一个字符串再发
- [x] 每次更新包在同步输出(DEC 2026)标记之间;不支持的终端静默忽略
- [x] **回归锁**:同步块之外没有任何裸擦除序列
- [x] 内容与光标都没变时不发任何字节
- [x] spinner 状态行在整个 turn 内常驻,不在工具之间消失导致输入框上下跳
- [x] 非 TTY 时不发同步标记,也不发光标控制

## 7.10 终端设计系统(§17)

- [x] 边杆分轨道:轮次标题实心条,正文细条;框只留给模态
- [x] **折行后边杆仍在**——自己按内容宽度折行并逐行加边杆,不交给终端折
- [x] 时间线:每轮带序号与时间;结束时右侧显示总耗时
- [x] 双强调色分工固定(主色品牌 / 副色交互),语义色不参与品牌
- [x] diff 增删行整行铺底,只在 truecolor 下启用,16 色退化成纯前景
- [x] **回归锁**:带背景色的行截到正好宽度,不会折行导致整块背景错位
- [x] 状态栏整行铺底常驻
- [x] 头部一行,不是框
- [x] 无色时边杆退化成 ASCII,版式结构保留
- [x] **架构**:`agent.ts` 不含任何排版,只发事件;版式只在 `ui/transcript.ts` 一处实现
- [x] `finish` 不单独打一行——收尾行已经带了它的 summary

## 7.11 命令菜单与轮次计数(§17.5b)

- [x] 敲 `/` 立刻浮出命令菜单,继续输入实时过滤
- [x] 菜单打开时 `↑↓` 归菜单,关闭后归历史
- [x] `Tab` 补全到输入行,`⏎` 直接执行选中项(而不是已输入的前缀)
- [x] 有参数了或不匹配任何命令时菜单消失,输入照常发给模型
- [x] 菜单与 `/help` 用同一份数据,不会各写一份而漂移
- [x] 光标始终停在输入行(菜单在它上方)
- [x] 轮次序号只数用户自己发的消息——steering 和中断说明也是 role user,算进去会让序号翻倍

## 7.12 完整命令集(§17.5c)

- [x] 命令集由 tcode 的实际能力推导:凡是只能靠重启进程或改环境变量才能触达的,都有一条命令
- [x] `/model <name>` **真的切换** provider,不是只显示;历史照常接续(归一化格式)
- [x] `/undo` 把最近一轮改过的文件放回去(不存在的删掉),只保留一轮
- [x] `/undo` 的快照由工具在 `ToolOutcome` 里回报——只有它知道改动前是什么
- [x] `/diff` 在 git 仓库里用 `git diff`,否则列出本会话写过的文件
- [x] `/export` 产出可读 markdown(会话本身是 JSON,那是用来重放的)
- [x] `/status` `/tools` `/approvals` `/memory` `/view` `/retry` `/init` `/clear` 各自生效
- [x] `/quit` 是 `/exit` 的别名,`/help` 里不重复列出

## 8. 测试基础设施本身(§12)

- [x] `tests/unit/` 覆盖 `security`/`edit_file`/`session`/`adapters`/`approval`/`spawn_agent`,且都能独立运行、不需要网络
- [x] `tests/loop/agent-loop.test.ts` 覆盖 §12.2 列出的全部 8 条场景,用假 `llm.send()`,不接真实网络
- [ ] `tests/fixtures/<provider>/` 下每个 provider 至少有"纯文本回复"“单 tool_use”“多 tool_use”三种 fixture,回放测试能跑通
- [ ] `tests/e2e/smoke.test.ts` 至少覆盖:新建文件、`edit_file` 唯一匹配成功、`edit_file` 多匹配报错后重试成功、读不存在文件报错、`bash` 跑测试 这 5 个代表性任务
- [ ] CI 中单测 + loop 场景测试作为必过项(阻塞合并);fixture 回放测试和 e2e 冒烟作为独立 job,允许失败但需要人工定期查看

---

## 验收标准

第 1-7 节的条目**全部打勾**,视为 v1 达到 spec.md 里定义的完成状态,可以进入日常 dogfooding 阶段(§12.5 第 7 步)。第 8 节是测试基础设施自身的完整性检查,建议和第 1-7 节同步推进,而不是等功能全部做完再补——尤其是"回归锁"那几条,越早固化成自动化测试,后续加功能时越不容易踩到已经修过的坑。
