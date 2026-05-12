# Akasha Time Agent M 阶段实施总纲

> 这是 Akasha 后续开发的主路线图。`AI_time_理论.md` 与 `Time_Agent.md` 作为理论和调研参考，本文件作为工程实施基准。

**目标：** 把“时间成为 Agent 底层操作系统”的理念拆成可实现、可测试、可回退的 M 阶段。

**核心判断：** Akasha 不是更大的记忆库，而是一个以 append-only 时间事件为事实源的 Agent runtime。长期记忆、世界模型、承诺账本、反思、自我校准和跨会话连续性，都是事件流和因果链的投影。

**首个落点：** `pi-coding-agent` 的会话与工具链记忆。

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
- **先 coding-agent，后通用 runtime。** 首个稳定落点是 `pi-coding-agent` 的会话与工具链记忆，再抽象成可插拔 SDK。
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

**目标：** 为 `pi-coding-agent` 建立可选的本地时间旁路层，让会话、工具和文件生命周期进入 append-only 时间流。

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

**目标：** 把 Akasha 从 `pi-coding-agent` 内置能力抽象成可插拔时间层，接入更多 Agent runtime。

**交付物：**

- Core SDK：event schema、store interface、projection API、brief renderer、command/debug API。
- Adapter SDK：runtime hook 到 Akasha event 的映射模板。
- Runtime adapters：`pi-coding-agent` 作为 reference adapter；后续接 LangGraph/OpenClaw/AutoGPT 类工作流。
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

下一步最应该做的是 **M1.1 + M1.2**，也就是 projection 层与 temporal recall eval harness。原因是：M1 已经证明事件可以被稳定采集，但事件流本身还只是历史；projection 才能把历史转成“当前状态”，eval 才能确保 Akasha 在正确时间想起正确事情。

推荐下一轮开发标题：

```text
Akasha M1.1: Temporal State Projections and Recall Evals
```

建议第一批文件边界：

- `packages/coding-agent/src/core/akasha/projections.ts`
- `packages/coding-agent/src/core/akasha/temporal-state.ts`
- `packages/coding-agent/src/core/akasha/recall-policy.ts`
- `packages/coding-agent/test/akasha-projections.test.ts`
- `packages/coding-agent/test/akasha-recall-policy.test.ts`

建议第一批命令：

- `/akasha open-loops`
- `/akasha explain-current`

建议第一批验收：

- patch 后未测试必须出现在 open loops。
- 失败 tool 未被后续成功覆盖时必须出现在 temporal state。
- compaction/branch summary 必须能进入 explain-current，但不能压过最近用户意图。
- temporal brief 不包含 streaming update，不包含完整文件内容，不包含完整命令输出。
