# Akasha Time Agent M 阶段实施总纲

> 这是 Akasha 后续开发的主路线图。`AI_time_理论.md` 与 `Time_Agent.md` 作为理论和调研参考，本文件作为工程实施基准。

**目标：** 把“时间成为 Agent 底层操作系统”的理念拆成可实现、可测试、可回退的 M 阶段。

**核心判断：** Akasha 不是更大的记忆库，而是一个以 append-only 时间事件为事实源的 Agent runtime。长期记忆、世界模型、承诺账本、反思、自我校准和跨会话连续性，都是事件流和因果链的投影。

**首个落点：** `akasha-coding-agent` 的会话与工具链记忆。

---

## 终极状态

Akasha 的终极状态是一个具备时间连续性的 Agent：

- 它以 append-only 时间事件作为事实源，而不是以当前状态或聊天 transcript 作为唯一事实。
- 它能追踪用户意图、工具调用、文件变化、承诺、预测、失败、复盘和修正之间的因果链。
- 它能区分短期上下文、长期稳定偏好、过期事实、未闭环责任和反复出现的模式。
- 它能在行动前形成可校验预测，在行动后记录结果偏差，并把教训写回时间流。
- 它能把空间/世界模型建成时间投影：项目、文件、任务、关系、环境状态都随着事件演化。
- 它能跨会话、跨分支、跨设备保持历史连续性，同时允许用户审计、导出、删除和限制长期记忆。

## 基本原则

- **先事实，后智能。** 先保证事件流完整、可回放、可解释，再加入 embeddings、反思和自动学习。
- **先旁路，后闭环。** 早期 Akasha 不改变现有 session transcript 和 Agent loop；只有通过评估后才允许影响行动。
- **先 coding-agent，后通用 runtime。** 首个稳定落点是 `akasha-coding-agent` 的会话与工具链记忆，再抽象成可插拔 SDK。
- **先因果，后语义。** 召回排序必须优先尊重时间顺序、因果距离、未闭环责任和失败经验，再引入语义相似度。
- **先本地，后同步。** 长期记忆默认 local-first、显式开启，跨设备/团队同步放到后期。
- **所有阶段必须有评估。** 没有 temporal recall eval、causal chain eval 和 regression fixtures 的能力不进入下一阶段。

## M0：理论与事件本体冻结

**目标：** 把哲学判断转成工程不变量，固定 Akasha 的最小事件本体、时间语义和隐私边界。

**核心问题：**

- 什么是 Akasha 必须记录的原子事件？
- 哪些事件只属于短期上下文，哪些事件能进入长期历史？
- `event_time`、`recorded_time`、`sequence`、`parentEventIds`、`sourceKey` 的语义是否稳定？
- 如何避免长期记忆默认变成行为监控？

**交付物：**

- `AkashaEvent` schema 与事件命名规范。
- 事件粒度准则：消息、turn、tool、artifact、command、compaction、model/thinking change、branch summary。
- TTL policy 与 retention policy 的语义定义，但不要求立即执行物理清理。
- 隐私默认值：Akasha 默认关闭；长期记忆和 temporal brief 注入必须显式配置。

**退出标准：**

- 任何新 event kind 都能说明 actor、subject、object、parent、payload、TTL 和 importance。
- 能用事件流解释一次完整 coding-agent turn：user -> assistant -> tool request -> tool completed -> artifact/command outcome -> tool result message。
- 文档明确 M1 不做 embeddings、reflection worker、移动端 UI、跨设备同步。

## M1：Local-first Time Bus for Coding Agent

**目标：** 为 `akasha-coding-agent` 建立可选的本地时间旁路层，让会话、工具和文件生命周期进入 append-only 时间流。

**当前基线：**

- `akasha.enabled` 默认关闭。
- 默认事件日志路径为 `<agentDir>/akasha/events/<sessionId>.jsonl`。
- JSONL store 支持 append、sourceKey 幂等、recent list、by-id 查询、by-toolCallId 查询、causal chain、timeline。
- 内置 collector extension 订阅 session、turn、message、tool、compaction、model/thinking、user bash 等生命周期事件。
- `/akasha status`、`/akasha timeline [n]`、`/akasha why <eventId|toolCallId>` 可用于本地调试。
- `injectTemporalBrief` 通过 `context` hook 注入 LLM，不写入普通 session transcript。

**退出标准：**

- Akasha 关闭时，现有 session JSONL 行为完全不变。
- Akasha 开启时，能生成 sidecar event log。
- `/akasha why <toolCallId>` 能解释工具调用的父链和结果链。
- focused tests 与 coding-agent build 通过。

## M1.1：Projection 与 Temporal State

**目标：** 把事件流投影成当前工作状态，而不是每次只扫最近事件。

**交付物：**

- `activeFilesProjection`：最近读写/patch 的文件、最后操作、失败状态。
- `toolFailureProjection`：失败工具、父链、是否已被后续成功事件覆盖。
- `turnIntentProjection`：最近用户意图、目标变更、当前 turn 归属。
- `causalGraphProjection`：事件父子边、toolCallId 归因、branch/compaction 归因。
- `openLoopsProjection`：未完成链路，例如 patch 后未测试、失败后未修复、用户要求稍后处理。

**建议文件：**

- `packages/coding-agent/src/core/akasha/projections.ts`
- `packages/coding-agent/src/core/akasha/temporal-state.ts`
- `packages/coding-agent/test/akasha-projections.test.ts`

**新增命令：**

- `/akasha open-loops`
- `/akasha explain-current`

**退出标准：**

- `/akasha explain-current` 能输出当前意图、活跃文件、未解决失败、最近分支/压缩上下文。
- `/akasha open-loops` 能列出未闭环事项，并能说明每个 loop 的 root event。
- 所有 projection 都能从 JSONL 重新构建，不依赖不可恢复内存状态。

## M1.2：Temporal Recall Eval Harness

**目标：** 为“正确时间想起正确事情”建立回归测试。

**交付物：**

- 事件流 fixture：成功编辑、失败工具、分支返回、compaction 后恢复、模型切换、用户目标改变。
- recall policy 测试：必须包含/必须排除的事件断言。
- brief snapshot 测试：确保 temporal brief 短、事实性强、无聊天污染。

**建议文件：**

- `packages/coding-agent/src/core/akasha/recall-policy.ts`
- `packages/coding-agent/test/akasha-recall-policy.test.ts`
- `packages/coding-agent/test/fixtures/akasha/*.jsonl`

**退出标准：**

- 每次调整 ranking、brief、projection 都能用测试证明没有把失败教训、活跃文件、未闭环事项漏掉。
- temporal brief 的 token 预算可控，默认不超过配置的 `maxBriefEvents`。
- streaming/tool update 类中间态不会进入 brief。

## M2：Open Loops 与 Karma Seed

**目标：** 让 Agent 开始记录“未完成因果”和“未来要校验的责任”，为 Karma Ledger 打基础。

**新增事件类型：**

- `loop.opened`
- `loop.progressed`
- `loop.blocked`
- `loop.resolved`
- `promise.created`
- `promise.updated`
- `promise.resolved`
- `prediction.made`
- `prediction.checked`
- `prediction.corrected`

**核心能力：**

- 从自然语言和工具链中识别最小 open loop：承诺跑测试、失败待修复、patch 待验证、等待用户反馈、稍后继续。
- 对每个 open loop 保存 owner、due/trigger、root event、current status、resolution evidence。
- 对 Agent 的建议和预测建立 `prediction.made`，未来事件触发 `prediction.checked`。
- 偏差发生时写入 `prediction.corrected`，而不是覆盖原预测。

**退出标准：**

- Agent 能在后续 turn 中主动引用未闭环事项，但不能把普通历史误报成承诺。
- `/akasha why <loopId>` 能解释 loop 为什么存在、从哪里来、当前卡在哪里。
- 至少覆盖三类 coding-agent loop：失败命令未处理、文件修改后未测试、用户要求稍后继续。

## M3：Reflection Worker 与 Long-term Crystals

**目标：** 把短期事件流沉淀成长期记忆晶体，但反思对象必须是事件流，而不是直接总结聊天记录。

**新增事件类型：**

- `reflection.started`
- `reflection.completed`
- `memory.crystal.created`
- `memory.crystal.updated`
- `pattern.detected`
- `preference.inferred`
- `failure.lesson_learned`
- `workflow.optimized`

**核心能力：**

- Reflection Worker 定期读取最近事件、projection 和 open loops。
- 生成稳定偏好、重复失败模式、项目工作流习惯、用户协作偏好。
- 每个 crystal 必须带时间跨度、支持事件、置信度、过期策略。
- crystal 只能作为召回候选，不能直接改写历史事件。

**退出标准：**

- 能从一周事件中提炼出“稳定偏好”和“失败教训”，并在相似情境中被 temporal recall 召回。
- crystal 的每条结论都能追到 supporting event ids。
- 反思结果不会污染当前 session transcript。

## M4：Temporal RAG 与 Embedding Timeline

**目标：** 在时间、因果、责任权重稳定后，引入 embeddings 和语义检索。

**核心排序公式：**

```text
score =
  semanticSimilarity
+ timeDecay
+ causalProximity
+ unresolvedLoopWeight
+ failureLessonWeight
+ activeArtifactWeight
+ userPreferenceConfidence
```

**交付物：**

- event/crystal embedding 索引。
- time-window first retrieval：先按 session/project/time/kind 精确裁剪，再做语义重排。
- causal expansion：召回一个事件时，可自动带入必要父链和结果链。
- stale fact suppression：被后续事件推翻或过期的事实默认下沉。

**退出标准：**

- 相似任务中能召回历史失败教训，而不是只召回文本相似消息。
- 旧但关键的事件能因因果/失败权重被保留；新但无关事件不会挤掉关键上下文。
- RAG eval 同时检查 semantic relevance、temporal correctness 和 causal completeness。

## M5：Time-spatial World Model

**目标：** 把“空间”做成时间投影：项目、文件、任务、关系和环境状态不是静态对象，而是随事件演化的世界模型。

**核心投影：**

- `artifact_state`：文件/文档/资源的读写历史、当前风险、验证状态。
- `project_state`：目标、阶段、阻塞点、决策记录、技术债。
- `task_state`：任务从提出、分解、执行、失败、修复、验证到关闭的轨迹。
- `actor_state`：用户偏好、协作方式、历史承诺、信任边界。
- `environment_state`：工具可用性、模型表现、权限、外部服务状态。

**退出标准：**

- Agent 能回答“当前项目状态如何由过去哪些选择塑造”。
- Agent 能区分“文件被读过”和“文件被修改且尚未验证”。
- 世界模型任何状态都能重放事件流重新生成。

## M6：Karma Ledger 完整闭环

**目标：** 让 Agent 对自己的建议、承诺和预测承担可追踪后果。

**核心循环：**

```text
agent proposes
-> promise/prediction event
-> scheduled or observed callback
-> compare expected vs actual
-> correction / lesson event
-> future recall includes lesson
```

**核心能力：**

- 承诺账本：记录谁承诺、承诺什么、何时检查、如何判定完成。
- 预测校准：记录 Agent 预期、实际结果、误差归因。
- 自我修正：把偏差转成 `failure.lesson_learned` 或 `workflow.optimized`。
- 责任呈现：用户能看到某个当前建议背后的历史成功/失败依据。

**退出标准：**

- Agent 不再只是说“我建议”，而能说“上次类似建议失败是因为 X，所以这次我调整为 Y”。
- 每个重要建议都能被未来事件校验或关闭。
- Karma Ledger 支持审计、导出、关闭和用户级别权限控制。

## M7：Scheduler、Heartbeat 与 Cross-session Continuity

**目标：** 让 Akasha 不只在单次对话内工作，而能跨会话、跨天、跨分支持续维护时间。

**核心能力：**

- heartbeat：短期线程唤醒，继续当前 causal chain。
- cron/scheduler：长期检查 promise、prediction、open loop、TTL。
- cross-session recall：同项目下多 session 的事件融合。
- branch continuity：分支摘要与返回点作为因果节点，而不是普通文本摘要。

**退出标准：**

- 关闭并恢复 session 后，Akasha 能恢复 open loops、active artifacts、last compaction/branch context。
- scheduler 触发的回顾会写入事件流，而不是只产生一次性提醒。
- branch navigation 不破坏因果链。

## M8：Multi-runtime SDK 与 Time OS

**目标：** 把 Akasha 从 `akasha-coding-agent` 内置能力抽象成可插拔时间层，接入更多 Agent runtime。

**交付物：**

- Core SDK：event schema、store interface、projection API、brief renderer、command/debug API。
- Adapter SDK：runtime hook 到 Akasha event 的映射模板。
- Runtime adapters：`akasha-coding-agent` 作为 reference adapter；后续接 LangGraph/OpenClaw/AutoGPT 类工作流。
- Compatibility tests：同一 fixture 在不同 runtime 下生成等价事件链。

**退出标准：**

- 新 runtime 只需实现 adapter，不需要复制 Akasha 核心逻辑。
- Akasha 的 temporal recall、open loops、Karma Ledger 可跨 runtime 复用。
- 核心 store 可以从 JSONL 升级到 SQLite/Postgres，而上层 API 不变。

## M9：Governance、Retention 与 Trust

**目标：** 在 Agent 拥有长期时间之前，先让用户拥有控制长期时间的权力。

**核心能力：**

- retention policy：session、short-term、long-term、permanent 的实际清理策略。
- redaction event：删除/隐藏不是静默抹除，而是可审计修正事件。
- export/import：用户可导出自己的 Akasha 时间线。
- visibility scopes：private、project、team、public/redacted。
- memory review UI/API：用户能查看、编辑、禁用 crystal 与 promise。

**退出标准：**

- 用户能回答“Akasha 记住了什么、为什么记住、何时会忘、如何删除”。
- 删除或 redaction 后 projection 可重建，并且不会引用已撤回 payload。
- 长期记忆开启必须是显式选择。

## M10：Time OS Control Plane

**目标：** 让 Akasha 从“可被查询的记忆层”进入“行动前会影响 Agent 的本地时间控制层”。

**核心能力：**

- Action Gate：在每次 LLM 行动前注入隐藏的时间控制事实，包含当前项目目标、活跃文件、未闭环事项、Karma 压力、用户长期偏好与历史纠错。
- Heartbeat Maintenance：在 session 存活期间按墙钟时间运行维护 pass，不再只依赖 turn end。
- User Timeline：从所有本地 Akasha session 中投影用户级时间线，独立于项目 `cwd`，记录长期目标、偏好、协作方式、开放承诺、到期预测与纠错记录。
- Slash Command Inspection：通过 `/akasha user-timeline` 和 `/akasha action-gate` 审计控制层输入。

**退出标准：**

- Action Gate 是 opt-in，且只进入隐藏 context，不写入普通 session transcript。
- Heartbeat 是 opt-in，并在 session shutdown 时停止。
- User Timeline 可从 JSONL 重建，不依赖内存状态。
- Action Gate 的每条重要事实能追溯到 supporting event ids。

## M11：Runtime Enforcement 与 Memory Governance

**目标：** 把 M10 的软控制上下文推进到可执行的本地运行时约束，并让用户可以治理长期记忆。

**核心能力：**

- Hard Tool Gate：在工具执行前拦截高风险动作，例如 destructive shell command，必要时写入 `tool.blocked` 事件。
- Detached Maintenance Runner：不依赖当前 turn 的维护入口，可扫描 session/project/all Akasha logs 并运行 scheduler、open-loop 和 reflection 维护。
- Memory Governance：用户可以 append-only 地 pin、unpin、suppress 或 redact 某条长期记忆事实，projection 必须尊重这些治理事件。

**退出标准：**

- 硬门控默认关闭，只有显式开启后才会阻断工具。
- 被阻断工具必须留下可解释的 `tool.blocked` 时间事件。
- Detached runner 可被 slash command 调用，也可以被后续 CLI/cron 复用。
- User Timeline 默认应用 redaction 和 suppression，不把被撤回事实继续注入行动上下文。

## M12：Policy Kernel、Daemon Queue 与 Typed Task Model

**目标：** 把时间事实从“可查询、可阻断、可维护”推进到“可被统一策略解释、可由时间回调驱动、可投影为任务/目标/风险模型”。

**核心能力：**

- Policy Kernel：将行动前判断统一抽象为 `allow`、`block`、`require_confirmation`、`require_validation`、`defer` 等策略决策，不再把所有规则散落在 tool gate 内。
- Daemon Callback Queue：从 promise、prediction、retention、reflection 中派生 `time.callback.due`，让未来责任成为时间流中的一等事件。
- Typed Task Model：从事件流重建 goals、tasks、decisions、risks，让 Akasha 开始具备“当前工作状态”的统一类型投影。
- Slash Command Inspection：通过 `/akasha queue` 和 `/akasha task-model` 审计 daemon 队列与任务模型，而不是只看原始 timeline。

**新增事件类型：**

- `policy.evaluated`
- `daemon.tick`
- `time.callback.scheduled`
- `time.callback.due`
- `time.callback.completed`

**退出标准：**

- tool gate 使用 Policy Kernel 给出统一可解释决策。
- detached maintenance 能追加 daemon tick，并把 due callback 写回事件流。
- `/akasha queue` 可预览当前会话中已到期的 promise、prediction、retention、reflection callback。
- `/akasha task-model` 能输出当前目标、任务、决策与风险，且全部可从 JSONL 重建。
- temporal recall 会优先保留 due callback、非 allow policy、blocked tool、未验证文件等关键时间事实。

## M13：Temporal Kernel 与可审计运行时

**目标：** 把 M10-M12 的多个时间模块收束成一个更接近 Time OS 的运行时切片：有统一内核入口、可审计行动前上下文、可执行策略语义、完整 callback 生命周期和更可靠的事件日志写入。

**核心能力：**

- Temporal Kernel Facade：新增 `AkashaTemporalKernel`，集中 append、state projection、action context、policy evaluation、daemon pass、callback complete/cancel 等入口。
- Auditable Action Gate：新增 `action_gate.injected` 事件，记录 hidden action gate 的 source event ids、sections、content hash 和 token estimate。
- Executable Policy Semantics：`require_validation` 不再只是普通 block，而会携带 validation plan；`defer` 写入 scheduled callback；confirmation 语义保留为显式确认要求。
- Callback Lifecycle：补齐 `time.callback.scheduled`、`time.callback.due`、`time.callback.completed`、`time.callback.cancelled`，并提供 slash command 完成/取消 callback。
- Safer JSONL Store：append 时加 lock、锁内 reload、sourceKey 再去重、严格校验新事件后写入。

**退出标准：**

- collector 的 action context 与 policy 关键路径通过 Temporal Kernel。
- 每次 Action Gate hidden context 注入都能找到对应 `action_gate.injected` 审计事件。
- daemon maintenance 能为未来 promise/prediction 写入 scheduled callback，并在到期时写入 due callback。
- `/akasha callback-complete <callbackId>` 与 `/akasha callback-cancel <callbackId>` 能关闭 callback 生命周期。
- JSONL store 在多实例 append 同一 sourceKey 时不会重复写入，且非法新事件会被拒绝。

## M14：Akasha Product Entry 与 Dogfood Shell

**目标：** 让 Akasha 不只是隐藏在 Akasha runtime 里的能力，而是有可日常启动、可初始化、可检查的产品入口，同时保留底层 runtime 和配置兼容性。

**核心能力：**

- CLI Alias：新增 `akasha` binary，复用现有 coding-agent runtime，但以 Akasha entrypoint 启动。
- Dogfood Preset：新增本地优先 Akasha preset，开启事件采集、temporal brief、action gate、destructive command guard、maintenance 和 heartbeat，默认关闭 embeddings 与 reflection。
- Entrypoint Commands：新增 `akasha init [--global]`、`akasha enable [--global]`、`akasha status`。
- In-session Commands：在已启用 Akasha 的会话里支持 `/akasha init [global]` 与 `/akasha enable [global]`。
- Quickstart Docs：新增 Akasha quickstart，并在 README 与 settings docs 中说明入口和 preset。

**退出标准：**

- `akasha init` 默认写入当前项目 `.akasha/settings.json`，`--global` 写入全局 settings。
- `akasha status` 能显示 resolved Akasha 状态和 settings/event log 路径。
- `akasha` 不改变 `akasha` 原有入口行为。
- 用户能从 README/docs 直接完成初始化、启动和检查。

## M15：Temporal Task Graph

**目标：** 把 M12 的 `goals/tasks/decisions/risks` 列表投影升级为可解释的任务图，让 Akasha 不只知道“有哪些状态”，还知道它们如何互相约束。

**核心能力：**

- Task Graph Nodes：目标、任务、决策、风险、artifact、callback 都成为 typed graph node。
- Task Graph Edges：用 `belongs_to`、`blocks`、`tracks`、`validates`、`references` 表达任务归属、风险阻塞、callback 追踪、验证证据和 artifact 引用。
- Backward Compatible Model：保留原有 `AkashaTaskModel.goals/tasks/decisions/risks`，新增 `callbacks` 与 `graph` 字段。
- Slash Command Inspection：`/akasha task-model` 输出 graph node/edge 计数和关键边，方便审计当前工作状态。

**退出标准：**

- promise/open loop 能作为 task node 进入 graph。
- artifact risk 能通过 `blocks` edge 指向对应 artifact 或 task。
- callback 能通过 `tracks` edge 指向被追踪的 task/artifact。
- 验证命令能通过 `validates` edge 连接 artifact。

## M16：Governance Propagation

**目标：** 让用户治理不只作用于单个事件，也能传播到由该事件派生出的长期事实，避免 suppressed/redacted 源继续通过 preference、crystal、summary 或 brief 泄漏。

**核心能力：**

- Suppression Closure：`memory.suppressed` 会隐藏目标事件及其 causal descendants、`supportingEventIds`、`sourceEventIds`、`evidenceEventIds` 等派生事实。
- Redaction-derived Filtering：redaction 保留并脱敏原始事件，但从投影中移除依赖该事件的派生事实。
- Governed Projection：新增统一治理投影，供 user timeline、project timeline、action gate、temporal brief 复用。
- Append-only Trust：治理仍然通过事件表达，不物理改写历史。

**退出标准：**

- suppress 原始用户消息后，由它推导出的 preference/crystal 不再进入 user timeline 或 hidden brief。
- redact 原始 payload 后，原始事件保留但派生事实不再泄漏 redacted 内容。
- action gate 和 project timeline 使用治理后的事件投影。

## M17：Artifact Verification Integrity

**目标：** 修正“任意成功验证命令验证所有修改文件”的过宽逻辑，让文件验证变成有 scope 和 confidence 的时间事实。

**核心能力：**

- Validation Inference：新增共享 validation 推断，识别 validation command、scope、targetPaths 和 confidence。
- Scoped Verification：只有命令显式引用 artifact path、basename 或 stem 时，才把该 artifact 标记为 `modified_verified`。
- Broad Validation Observed：项目级 `npm test`、`tsc`、`build`、`lint` 会被记录为 observed evidence，但不会自动验证所有修改文件。
- Loop Integrity：artifact open loop 只有在 scoped validation 覆盖该 artifact 后才会 resolved。

**退出标准：**

- 修改多个文件后运行 broad `npm test` 不会把所有文件标记 verified。
- `npm test -- app` 可以验证 `src/app.ts` 这类明确命中的 artifact。
- 读取文件不会清除已有 unverified 修改状态。
- Tool gate 和 task risk 基于 scoped artifact state 工作。

## M18：Explicit Time Syscalls

**目标：** 把承诺和预测从自然语言副产物升级为显式时间系统调用，减少正则抽取误判。

**核心能力：**

- Time Syscall API：新增创建/关闭 commitment、创建/检查 prediction 的 append-only helper。
- LLM-callable Tools：注册 `akasha_create_commitment`、`akasha_resolve_commitment`、`akasha_create_prediction`、`akasha_check_prediction`。
- Source Metadata：显式事件带 `source: "syscall"`、confidence、resolution criteria、source event ids、toolCallId 和 correlation。
- Heuristic Fallback：自然语言抽取仍保留，但当 assistant 已调用 Akasha syscall tool 时不重复生成 promise/prediction。

**退出标准：**

- Agent 能通过工具写入 `promise.created`、`promise.resolved`、`prediction.made`、`prediction.checked/corrected`。
- 显式事件进入 Karma Ledger、Task Graph、Action Gate 和 Callback Queue。
- 显式 syscall 与 heuristic extraction 不重复。

## M19：Temporal Behavior Eval Fixtures

**目标：** 把“时间行为正确性”变成可回归测试，不只测试 recall ranking。

**核心能力：**

- Behavior Eval：新增评测器检查 open promises、unverified artifacts、governed suppression、Action Gate 内容和 Task Graph edges。
- Fixture JSONL：新增跨能力 fixture 覆盖 commitment、due callback、suppression、artifact patch 和 broad validation。
- Diagnostic Output：失败时输出 case name 和具体缺失/意外行为。

**退出标准：**

- fixture 能证明 due callback 会进入 action gate。
- fixture 能证明 suppressed 派生事实不会进入 governed projection。
- fixture 能证明 broad validation 不会误关闭 artifact risk。

## M20+：Reflection Crystals 与 Temporal RAG Hardening

**目标：** 加固长期记忆沉淀与语义召回，让 memory crystal 更可信、更可追溯，并遵守治理投影。

**核心能力：**

- Governed Reflection：Reflection Worker 只基于 governed events 生成 crystal。
- Crystal Source Chain：crystal 和 memory crystal payload 都带 `sourceEventIds`，便于治理传播和审计。
- Embedding Text Hardening：embedding 文本优先提取 statement、claim、actual、correction、resolution criteria 等关键字段。
- Local-first Default：reflection/embedding 仍默认关闭，只加固开启后的行为。

**退出标准：**

- suppressed/redacted source 不会被反思沉淀成长期 crystal。
- crystal 召回能携带 source chain。
- prediction correction 和 failure lesson 能作为高权重 RAG 事实进入 temporal recall。

## M21：Projection Cache and Compaction Boundary

**目标：** 让事件流继续作为事实源，同时为常用时间投影建立可删除、可重建、可校验的新索引层。

**核心能力：**

- Projection Cache：新增 versioned cache，记录 source log paths、file fingerprint、event high-water mark、schema/projection version。
- Session State Cache：`AkashaTemporalKernel.buildState()` 可复用 session projection cache，避免每次重建 temporal/project/task model。
- Project/User Timeline Cache：跨 session project timeline 和 user timeline 使用相同 cache 机制，source log 改变后自动失效。
- Doctor Freshness：`/akasha doctor` 显示 projection cache path、fresh/stale/missing/invalid 和失效原因。

**退出标准：**

- 删除 cache 后可从 JSONL 重建。
- source event log append 后旧 cache 被判定 stale。
- cache 不成为事实源；所有 projection 仍能从 JSONL 重放生成。

## M22：Callback Runner

**目标：** 把 callback lifecycle 从“到期列表”推进到可执行、可审计的 daemon runner。

**核心能力：**

- Callback Execution Events：新增 `time.callback.claimed`、`time.callback.dispatched`、`time.callback.failed`。
- Runner Flow：daemon tick -> due callback -> claim -> policy evaluation -> dispatch/fail。
- Slash Commands：新增 `/akasha daemon status`、`/akasha daemon tick`、`/akasha daemon run`。
- Idempotent Dispatch：同一个 callback 已 dispatched/failed/completed/cancelled 后不会重复执行。

**退出标准：**

- due callback 能被 runner claim 和 dispatch。
- callback dispatch 写入 `policy.evaluated`。
- runner 重复执行不会重复 claim/dispatch 同一 callback。

## M23：Universal Policy Surface

**目标：** 把 policy 从 tool gate 扩展为 Time OS runtime action 的统一策略面。

**核心能力：**

- Runtime Action Types：覆盖 `tool_call`、`context_injection`、`temporal_recall`、`callback_dispatch`、`reflection`、`embedding_index`、`memory_projection`、`export`、`syscall`。
- Runtime Policy Evaluation：新增通用 `evaluateAkashaRuntimePolicy()`。
- Audited Non-tool Actions：context injection 和 callback dispatch 会写入 `policy.evaluated`，进入 `/akasha why` 因果链。

**退出标准：**

- Action Gate 注入前有 policy audit。
- Callback dispatch 前有 policy audit。
- 后续 runtime action 能复用同一策略接口，不需要再增加散落规则。

## M24：Syscall Audit Mode

**目标：** 让承诺/预测 syscall 从“推荐工具”变成可审计协议。

**核心能力：**

- Audit Events：新增 `time_syscall.audit`、`time_syscall.missing`、`time_syscall.repaired`。
- Soft Fallback：assistant 表达未来责任但没有 syscall 时，写入 `time_syscall.missing`，并把 heuristic promise/prediction parent 到 audit event。
- Satisfied Audit：assistant 已调用 Akasha syscall tool 时，写入 satisfied audit，不再重复 heuristic extraction。

**退出标准：**

- 自然语言承诺缺少 syscall 时有可审计 missing event。
- fallback promise/prediction 能追溯到 missing audit。
- 显式 syscall 不产生重复 heuristic commitment。

## M25：Causal Task Graph

**目标：** 把 task graph 从文本启发式升级为因果优先的工作图。

**核心能力：**

- Edge Metadata：graph edge 增加 `source`、`confidence`、`sourceEventIds`。
- Causal Edges：优先使用 `parentEventIds`、`sourceEventIds`、`evidenceEventIds`、`targetEventId`、`resolverEventId` 等事件字段建立边。
- Heuristic Fallback：文本 path/basename 匹配保留为低置信度 fallback。
- Slash Command Audit：`/akasha task-model` 显示 edge source/confidence。

**退出标准：**

- promise/task 能通过 `parentEventIds` 连接到目标或上游事件。
- callback/risk/validation 的显式引用优先于文本匹配。
- graph edge 的来源和置信度可被用户审计。

## M26：Daemon Execution and Trust Boundary

**目标：** 让 Akasha 从“会话内可运行的时间层”推进到“会话外也能推动时间责任的本地时间运行时”，同时加固 cache 与 embedding 治理边界。

**核心能力：**

- Real Callback Dispatcher：callback runner 支持 `record_only`、`terminal_notification`、`agent_prompt_file`。其中 `agent_prompt_file` 会写入 `<agentDir>/akasha/inbox/pending-callbacks.jsonl`。
- CLI Daemon：新增 shell 级 `akasha daemon status|tick|run --scope current|project|all --dispatch ...`，不需要进入 interactive session。
- Cache Commands：新增 shell 级 `akasha cache status|clear|rebuild` 与 session 内 `/akasha cache status|clear|rebuild`。
- Projection Cache Hardening：project timeline cache 只跟踪匹配 cwd 的 session logs，cache fingerprint 支持 fast 与 strong SHA-256 模式。
- Embedding Governance：embedding store 支持 tombstone、purge、compact，maintenance 会 tombstone suppressed/redacted/omitted event embeddings。

**退出标准：**

- due callback 能在 CLI daemon 中被 claim、policy evaluate、dispatch，并写入 pending callback inbox。
- Akasha 在没有 active chat session 时也能 tick/run daemon。
- project cache 不再因为无关 cwd 的 session log 改变而失效。
- suppress/redact 后相关 embedding records 不再进入 search/list，并可 compact/purge。

## 阶段依赖图

```text
M0 Event Ontology
  -> M1 Local Time Bus
    -> M1.1 Projections
    -> M1.2 Recall Evals
      -> M2 Open Loops / Karma Seed
        -> M3 Reflection Crystals
          -> M4 Temporal RAG
            -> M5 Time-spatial World Model
              -> M6 Karma Ledger
	                -> M7 Scheduler / Cross-session
	                  -> M8 Multi-runtime SDK
	                    -> M9 Governance / Trust
	                      -> M10 Time OS Control Plane
	                        -> M11 Runtime Enforcement / Governance
	                          -> M12 Policy Kernel / Daemon Queue / Task Model
	                            -> M13 Temporal Kernel / Auditable Runtime
	                              -> M14 Product Entry / Dogfood Shell
	                                -> M15 Temporal Task Graph
	                                  -> M16 Governance Propagation
	                                    -> M17 Artifact Verification Integrity
	                                      -> M18 Explicit Time Syscalls
	                                        -> M19 Temporal Behavior Evals
	                                          -> M20 Reflection / RAG Hardening
	                                            -> M21 Projection Cache
	                                              -> M22 Callback Runner
	                                                -> M23 Universal Policy Surface
	                                                  -> M24 Syscall Audit Mode
	                                                    -> M25 Causal Task Graph
	                                                      -> M26 Daemon Execution / Trust Boundary
	                                                        -> M40 Resume Inbox Protocol
	                                                          -> M41 Resume Closure Protocol
	                                                            -> M42 Gateway Callback Modes
	                                                              -> M43 Strict Syscall Repair Loop
	                                                                -> M44 Policy Profiles
```

## 每阶段通用质量门槛

- **事实可重建：** 所有派生状态都能从事件流重建。
- **因果可解释：** 重要输出必须能追溯 supporting events 或 causal chain。
- **关闭可回退：** 关闭 Akasha 后原有 session 行为不变。
- **默认保守：** Akasha 默认关闭；长期 retention 和 LLM brief 注入显式开启。
- **测试优先：** 每个新能力先添加 fixture/eval，再实现 ranking/projection/worker。
- **不存大内容：** 文件全文、完整命令输出、大型 payload 不进入事件；只存路径、摘要、长度、diff preview 或引用。
- **不让摘要成为事实源：** compaction、reflection、crystal 都是派生事实，不能替代原始事件。

## 当前优先级

当前已完成 **M42-M44** 第一轮切片：

- **M42 Gateway Callback Modes：** Telegram gateway callback delivery 支持 `notify_only`、`inbox_only`、`ask_before_run`、`auto_run_safe`，默认仍是保守通知模式。
- **M43 Strict Syscall Repair Loop：** strict temporal protocol 会把未修复的 `time_syscall.missing` 注入下一次行动前上下文，并记录 `time_syscall.repair_prompt.injected`。
- **M44 Policy Profiles：** `akasha.policyProfile` 支持 `observe`、`dogfood`、`strict`、`autonomous`，Temporal Kernel、callback runner 和 gateway 共享同一策略规则选择。

推荐下一轮开发标题：

```text
Akasha M45: Autonomous Callback Execution and End-to-end Temporal Closure Eval
```

建议第一批文件边界：

- `packages/coding-agent/src/gateway/runner.ts`
- `packages/coding-agent/src/core/akasha/callback-runner.ts`
- `packages/coding-agent/src/core/akasha/callback-inbox.ts`
- `packages/coding-agent/src/core/akasha/collector-extension.ts`
- `packages/coding-agent/src/core/akasha/policy-kernel.ts`
- `packages/coding-agent/src/core/akasha/time-syscall-audit.ts`
- `packages/coding-agent/test/akasha-temporal-behavior-eval.test.ts`
- `packages/coding-agent/test/gateway-runner.test.ts`

建议第一批命令：

- `akasha gateway status`
- `akasha daemon run --dispatch auto_run_safe`
- `akasha inbox status`
- `/akasha why <eventId>`

建议第一批验收：

- 构建一条端到端 fixture：commitment -> callback due -> gateway/inbox dispatch -> context injection -> syscall resolve -> callback/inbox completed -> later recall。
- `auto_run_safe` 只自动执行经过 policy 判定的低风险 callback，高风险 callback 留在 inbox/manual review。
- strict repair prompt 被处理后能自动关闭对应 `time_syscall.missing` 的 repair gap。
- `/akasha why` 能解释 gateway callback delivery、auto-run、reply、syscall closure 的完整因果链。
