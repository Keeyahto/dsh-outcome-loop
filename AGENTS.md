# dsh-outcome-loop 全局开发指导

本文件作用于仓库根目录及全部子目录，是本项目面向开发者和编码 Agent 的全局开发约束。若未来某个子目录存在更具体的 `AGENTS.md`，子目录文件只可细化本文件，不得弱化本文件中的隐私、安全、用户利益、零额外 token 默认值和证据可信度要求。

本文档的直接目标是指导 `dsh-outcome-loop` 的设计与实现。它不是一般性的 DSH 插件教程，也不是训练数据采集方案。任何开发决策首先回答：它是否提高用户自己的任务成功率、降低返工或帮助用户积累可迁移的个人智能资产。

## 1. 项目定义

`dsh-outcome-loop` 是一个本地优先、用户所有、厂商中立的任务结果账本与验收插件。它把一次 DSH 会话中的目标、约束、验收条件、执行证据、用户反馈、成本和最终结果组织成可复查的任务记录。

项目首先服务使用者：

- 阻止“模型说完成了”被误当成“任务真的完成了”；
- 用测试、构建、lint、退出码、文件状态和用户验收减少返工；
- 区分成功、失败、未验证、证据过期、用户接受和用户放弃；
- 记录准确成本，帮助用户判断哪类任务适合更便宜的模型；
- 把经验保存在用户自己的环境中，允许查询、删除和导出；
- 为未来的本地路由、回归评测和 Skill 提炼提供可靠数据。

项目对训练者的价值只能是上述用户价值的可选副产品。未经用户明确授权，插件不得把会话、代码、证据、反馈或派生标签发送给 DeepSeek 或任何第三方。

一句话产品定义：

> 用尽量零 token、可机械复核的证据，帮助用户知道任务是否真的完成，并把结果沉淀为用户自己的可迁移经历。

## 2. 指令优先级与开发行为

开发时按以下优先级处理冲突：

1. 当前用户明确指令；
2. 安全、权限、隐私和法律约束；
3. 本文件及更具体目录中的 `AGENTS.md`；
4. 已批准的架构决策记录；
5. README、代码注释和历史实现。

开始任何非机械修改前必须：

1. 阅读根目录和目标目录适用的全部指导文件；
2. 用 `rg --files` 和 `rg` 检查当前实现、测试、配置和文档；
3. 查看工作树状态，保留用户已有和无关修改；
4. 写出本次任务的范围、非目标和可验证验收条件；
5. 确认所使用的 DSH API 来自当前依赖或官方文档，而非旧记忆；
6. 对涉及数据、命令执行、网络、权限或模型调用的变化先做威胁分析；
7. 选择最窄且可回滚的实现。

完成修改前必须：

1. 运行与改动表面直接对应的测试；
2. 检查默认模式是否新增模型调用、工具 schema、system prompt、网络请求或敏感数据复制；
3. 检查事件重放、重复投递、崩溃恢复和插件卸载路径；
4. 更新受影响的 README、数据格式、配置说明和变更日志；
5. 明确报告实际运行过的验证命令，不把未运行的检查描述为通过。

不要顺手重构无关模块，不要替用户删除已有修改，不要为了通过测试而弱化断言、跳过失败或隐藏错误。

## 3. 当前 DSH 基线与兼容策略

本文档于 2026-08-17 根据 DeepSeek Harness 官方仓库编写。核对时官方根包为 `0.1.0-rc.7`，使用 ESM、`pnpm@11.7.0`，Node 引擎为 `^22.19.0 || >=24.0.0`。DSH 仍处于 developer preview，并明确声明会发生破坏兼容性的变化。

这些版本信息是研究基线，不是永久事实。开始实现、升级依赖或发布版本前必须重新核对：

- DSH 根 README 和发布说明；
- `@deepseek-ai/cordis` 的插件生命周期；
- session、storage、settings、token meter、feedback 和 projection 的公开 API；
- 官方插件打包和 `dsh.bundle` manifest 规则；
- 当前 Node 与 pnpm 支持范围。

兼容原则：

- DSH 相关代码必须集中在 `src/dsh/` 适配层，纯领域层不得导入 DSH 包；
- 只使用包根或官方公开 `exports`，禁止深度导入 `src/`、`lib/internal/` 或未导出的实现；
- 不根据对象“似乎有某个方法”静默猜测版本；需要的公共能力不存在时应尽早、明确失败；
- 对可选能力使用显式的 optional adapter，不把所有可选服务放进必需 `inject`；
- 对必需服务使用 Cordis `inject`，让插件在依赖就绪后加载、依赖消失时自动卸载；
- 不为未经测试的 DSH 版本宣称兼容；
- 每个发布版本维护明确的 DSH 兼容矩阵和安装冒烟结果；
- DSH API 变化时优先更新一个适配层，不污染领域模型或数据格式。

禁止把并不存在或尚未验证的 `turn-stopping`、`before-stop` 等钩子写成硬依赖。当前可靠事实是：`turn/end` 是已经提交的 durable session event，它描述一轮为何结束，但不是可拦截的“完成前”钩子。若未来要阻止 Agent 停止，必须先找到并测试 DSH 当前公开的策略扩展点；在此之前，插件只做观察、提示和显式继续操作。

## 4. 不可妥协的产品原则

### 4.1 用户利益优先

用户支付 token 是为了完成自己的任务，不是为了免费替模型厂商生产训练数据。任何新增消耗都必须带来用户可感知、可测量的收益。

### 4.2 默认零额外模型成本

默认模式必须满足：

- 不发起额外 LLM 调用；
- 不注册模型可见工具；
- 不注入 system prompt 或每轮上下文；
- 不调用 LLM Judge；
- 不因为记录反馈而启动模型轮次；
- 不把账本内容重新发送进模型上下文。

“没有额外模型调用”不等于“零 token”。工具 schema 和固定 prompt 也会增加每次请求的输入 token，因此默认核心插件必须完全保持 model-invisible。任何模型可见工具、提示词或评审器都必须放在独立、显式启用的 Consumer 插件中，并说明预计 token 影响。

### 4.3 默认本地、默认无网络

个人模式下：

- 所有结果数据保存在用户选择的本地 DSH storage backend；
- 插件不得创建出站网络连接；
- 不配置远端 endpoint；
- 不读取或解析与任务无关的文件；
- 不把完整源代码、prompt、工具输出或绝对路径复制到账本。

### 4.4 结果必须由证据支持

验证可信度按以下顺序排列：

1. 强证据：测试、编译器、lint、退出码、文件哈希、schema 校验、形式化检查、真实环境结果；
2. 中等证据：用户明确接受、拒绝或修正；
3. 弱证据：另一个模型或规则模型的主观评审；
4. 未知：没有足够证据。

未知不得自动转换为成功。模型自述“已完成”不是验收证据。`turn/end.reason.kind === 'completed'` 只表示 Agent 正常结束了一轮，不表示用户任务通过验收。

### 4.5 事实与解释分离

必须区分：

- 事实层：session event 引用、命令退出码、测试报告、文件摘要、时间、版本和用户操作；
- 解释层：失败分类、聚合状态、标签可信度、推荐的下一步。

事实层应尽量不可变、可重放；解释层可由新版本重新计算。不要把后处理判断写成不可追溯的唯一真相。

### 4.6 用户拥有并控制数据

用户必须能：

- 查看记录了哪些字段；
- 删除 outcome sidecar 数据；
- 选择导出范围；
- 在导出前预览字段和脱敏结果；
- 拒绝分享而不损失核心功能；
- 将数据迁移到其他模型或 Harness。

### 4.7 厂商中立

领域模型不得使用 DeepSeek 专属模型名称作为业务语义。provider、model 和 harness 版本属于 lineage 数据，不影响开放数据格式。未来路由器应能比较 DeepSeek、Qwen、Claude、GPT 或本地模型，而不改变结果语义。

### 4.8 失败要显式且可行动

配置错误、存储错误、证据缺失、证据冲突、版本不兼容和权限拒绝必须有稳定错误码与人类可读说明。不得把基础设施故障伪装成“任务未通过”，也不得静默跳过必需验证。

## 5. 产品模式

### 5.1 个人模式：默认且首要

- 本地存储；
- 无网络；
- 无额外模型调用；
- 确定性观察优先；
- 手动导出；
- 用户可删除；
- 经验只优化该用户自己的工作流。

### 5.2 企业模式：部署方治理

- 使用企业选择的私有 storage backend；
- 项目或组织策略可规定必需验收项、保留期和允许的验证器；
- 默认仍不外发；
- 远端企业内部 endpoint 也必须显式配置、鉴权并可审计；
- 权限和合规策略不得被项目仓库中的低信任配置覆盖；
- 不因企业模式就记录更多原始内容。

### 5.3 贡献模式：未来独立插件

贡献模式不属于 MVP，未来必须作为独立、默认未安装的插件实现。它至少需要：

- 用户主动开启，而非预勾选；
- 显示接收方、用途、许可、保留政策和补偿；
- 上传前逐批预览；
- 确定性脱敏与敏感项阻断；
- 只上传用户明确选择的字段；
- 允许只上传汇总，不上传原始会话；
- 记录同意版本、时间、范围和撤回能力；
- 训练方承担为对比、重标注或反事实分支新增的 token 成本；
- 拒绝贡献不会降低个人模式功能。

不得在核心插件中预留隐藏上传、遥测或“以后可能使用”的数据通道。

## 6. MVP 范围

MVP 只针对代码开发任务，并坚持可验证、低权限、低成本。

必须包含：

1. 观察 DSH session 的关键 durable events；
2. 建立或导入一份结构化 Task Contract；
3. 记录显式验收条件；
4. 关联测试、构建、lint、命令、文件和 Git 范围等确定性证据；
5. 计算每项 criterion 的 `pass`、`fail`、`unknown` 或 `not-applicable`；
6. 分别记录机械验证状态与用户 disposition；
7. 统计可获得的模型 usage、步骤、工具调用、耗时和错误；
8. 本地持久化 outcome sidecar；
9. 提供本地查询、删除和 JSONL 导出；
10. 对默认隐私、零模型调用和事件重放提供自动测试；
11. 以 DSH bundle 形式安装并完成打包冒烟。

MVP 可以观察已有命令结果，但不得默认自动执行模型或插件推断出的验证命令。主动执行验收命令必须由用户、项目可信配置或明确的交互审批授权。

### 6.1 MVP 非目标

以下内容不得混入 MVP：

- 自动上传训练数据；
- 自适应模型路由；
- 自动训练或微调模型；
- 自动生成并启用 Skill；
- 通用多 Agent 编排；
- 默认 LLM Judge；
- 面向所有非代码任务的通用验证；
- 修改 DSH agent loop；
- 未经确认自动重试或追加模型轮次；
- 以消息点赞/点踩替代任务级验收；
- 复制一套 DSH 已有 feedback、storage、token meter 或 telemetry 能力。

## 7. 概念模型

不要把“任务结果”压缩成一个布尔值。至少维护以下互相独立的轴：

| 轴 | 典型值 | 含义 |
| --- | --- | --- |
| 执行状态 | `active`、`ended`、`aborted`、`blocked` | Agent/流程发生了什么 |
| 验证状态 | `not-run`、`passed`、`failed`、`inconclusive` | 验收证据说明什么 |
| 用户 disposition | `none`、`accepted`、`rejected`、`revised`、`abandoned` | 用户如何处理结果 |
| 标签强度 | `strong`、`medium`、`weak`、`unknown` | 结论有多可信 |
| 数据资格 | `private-only`、`exportable`、`contribution-approved` | 数据可以被如何使用 |

机械验证失败时，用户仍可以出于其他原因接受结果；用户接受也不能抹去机械失败。两者必须同时保留。

### 7.1 Task Contract

推荐的稳定领域模型：

```ts
interface TaskContract {
  schemaVersion: number
  id: ContractId
  revision: number
  sessionId: SessionIdRef
  goal: GoalReference | ExplicitGoal
  scope: TaskScope
  constraints: readonly Constraint[]
  criteria: readonly AcceptanceCriterion[]
  verificationPolicy: VerificationPolicy
  privacyPolicy: TaskPrivacyPolicy
  createdAt: number
  updatedAt: number
}
```

要求：

- `goal` 优先引用原 session message id/seq，避免复制完整用户文本；
- 用户通过 UI、命令或 API 明确输入目标时，才存储 `ExplicitGoal`；
- contract 修改使用 compare-and-set revision；
- 修改验收条件后旧验证结果必须标记为过期，而不是沿用；
- scope 必须限定 workspace、路径集合和允许的验证行为；
- criteria 必须有稳定 id，不能靠数组位置关联证据。

### 7.2 Acceptance Criterion

```ts
interface AcceptanceCriterion {
  id: CriterionId
  description: string
  kind: CriterionKind
  required: boolean
  severity: 'blocking' | 'warning'
  specification: CriterionSpecification
  freshness: EvidenceFreshnessPolicy
}
```

首批支持的 `CriterionKind`：

- `command-exit`：可信命令以期望退出码结束；
- `test-report`：TAP、JUnit 或受支持测试报告满足规则；
- `file-exists` / `file-absent`：限定路径状态；
- `file-digest`：文件内容摘要符合预期；
- `json-schema`：JSON 文件满足 schema；
- `git-scope`：变更只位于允许路径或不包含禁止路径；
- `diagnostic-count`：lint、typecheck 或编译诊断满足阈值；
- `manual`：用户明确确认；
- `custom`：由已注册的确定性 verifier provider 处理。

不得用自然语言字符串加 `eval` 解释 criterion。每种 specification 必须是可验证、可版本化的判别联合。

### 7.3 Evidence

```ts
interface Evidence {
  schemaVersion: number
  id: EvidenceId
  contractId: ContractId
  criterionId?: CriterionId
  source: EvidenceSource
  sourceRef?: SessionEventReference
  observedAt: number
  workspaceState: WorkspaceStateReference
  fact: EvidenceFact
  strength: 'strong' | 'medium' | 'weak'
  sensitivity: SensitivityClass
  digest?: string
}
```

Evidence 默认只存结构化事实：

- 命令标识或 argv 摘要；
- 退出码；
- 开始与结束时间；
- 输出字节数和截断状态；
- 已脱敏的短摘要；
- 报告计数；
- 相关 session id、event seq、turn 和 step；
- workspace 或变更集的摘要；
- provider/model/插件版本等 lineage。

不要默认复制完整 tool arguments、tool result、终端输出、源文件、prompt 或 assistant message。原始事实已经存在于其权威来源时，只保存引用和必要摘要。

### 7.4 Verification Result

每项 criterion 的结果：

```ts
type CriterionStatus = 'pass' | 'fail' | 'unknown' | 'not-applicable'
```

聚合规则：

1. 任一 required + blocking criterion 为 `fail`，总验证为 `failed`；
2. 没有失败，但至少一个 required criterion 为 `unknown`，总验证为 `inconclusive`；
3. 所有 required criteria 为 `pass` 或经规则允许的 `not-applicable`，总验证为 `passed`；
4. 没有执行验证时为 `not-run`；
5. warning criterion 不改变 passed/failed，但必须展示；
6. 互相冲突的当前证据默认导致 `inconclusive`，不得挑选对成功有利的一条；
7. contract revision、相关文件变化或 workspace state 变化可使旧证据 `stale`，stale evidence 不参与当前 pass；
8. 用户 acceptance 不改变机械验证结果，只改变 disposition；
9. LLM Judge 不能单独产生 `strong` 标签。

### 7.5 Failure Taxonomy

错误码使用稳定的 lower-kebab-case。至少区分：

- `criterion-failed`；
- `evidence-missing`；
- `evidence-stale`；
- `evidence-conflict`；
- `verification-command-failed`；
- `verification-timeout`；
- `verification-output-limit`；
- `policy-denied`；
- `permission-denied`；
- `tool-error`；
- `model-error`；
- `max-tokens`；
- `turn-aborted`；
- `task-blocked`；
- `storage-error`；
- `schema-version-unsupported`；
- `dsh-version-unsupported`；
- `plugin-disposed`；
- `unknown`。

基础设施错误不得被计入模型能力失败；用户取消不得被计入 verifier 失败；证据缺失不得被计入 criterion fail。

## 8. DSH 集成规则

### 8.1 插件与生命周期

DSH 插件是导出 `apply(ctx, config)` 的 TypeScript/ESM 模块。使用 Cordis 时：

- 插件提供服务时使用 `Service` class，并通过 declaration merging 扩展 `Context`；
- 必需服务写入 `inject`；
- 事件、注册、定时器和资源必须属于当前 Fiber；
- 使用 `ctx.on()`、registry `register()` 和 `ctx.effect()`，依赖 Cordis 自动卸载；
- 多个异步 disposer 没有串行完成保证；有顺序要求的清理放进同一个 disposer 内串行 await；
- 插件卸载后拒绝新写入，排空已接受的 per-key queue，再关闭 storage domain；
- HMR 必须不遗留监听器、服务、文件句柄或定时器。

### 8.2 Cordis events 与 session events

必须严格区分：

- `session/event` 是 Cordis 的实时 post-commit 通知；
- `turn/*`、`step/*`、`tool/*`、`assistant/message` 等是 durable session event types；
- 监听 durable events 时应监听 `session/event` 并检查 `event.type`；
- 不能把同名字符串当成 Cordis event 直接监听；
- `SessionEventMap` 是可扩展联合，`switch` 必须保留安全的 `default`，不得 `assertNever`；
- `session/event` listener 的异常会被容纳，不能依赖抛错回滚已提交 event；
- hot path listener 只做轻量归一化和入队，不做同步磁盘、网络、全日志扫描或昂贵解析。

核心关注事件：

- `turn/start` / `turn/end`；
- `step/start` / `step/end`；
- `user/message`；
- `assistant/message` 及其中可用的 usage；
- `tool/call` / `tool/result`；
- `request/context`；
- plugin-contributed `feedback/record`、goal change 等经确认相关的事件。

默认不逐条保存 `assistant/chunk`，以避免复制大量流式内容。若 token accounting 需要 usage chunk，应由专门的折叠逻辑消费并只保存聚合数值。

### 8.3 重放、恢复与幂等

`session/event` 只发布当前进程的新 append；constructor seed 不重新发布。实现必须同时支持已有历史和 live tail。

每个 session 维护已持久化 cursor，并遵守：

1. 处理键为 `(sessionId, event.seq)`；
2. 同一个事件重复到达不得生成重复 evidence 或重复累计 token；
3. 只有 sidecar 写入成功后才推进 cursor；
4. 发现 seq gap 时从 session 的权威 log 补齐，不凭邻接猜测；
5. restart 后从 cursor 下一位继续；
6. event 派生 id 必须确定性生成或保存稳定 idempotency key；
7. session fork 使用新 session identity，不把父 session 的用户 disposition 当成子任务反馈；
8. compaction 只改变模型 surface，不删除 canonical log；outcome 引用使用 durable seq；
9. `session/end-seed` 是生命周期边界，不是用户活动或任务结果；
10. 插件必须测试 live、resume、fork、重复、gap 和 crash-tail 场景。

不要假设所有 outcome 数据都必须进入 SessionEventMap。默认选择 sidecar，原因见下一节。

### 8.4 存储边界

DSH session log 是模型交互的权威事件源；`ctx.storageDomain` 用于持久化非 session-log 数据。Outcome records 属于 sidecar，默认存入独立 domain，例如 `outcome_loop`。

选择 sidecar 的原因：

- outcome 含可删除、可修订的用户 disposition 和导出资格；
- 证据摘要可能敏感，不应自动进入 session telemetry；
- session telemetry 默认可以镜像 plugin-contributed session events；
- task-level 聚合不是模型历史的一部分；
- 用户需要独立删除和迁移。

禁止默认向 session log 追加包含源代码、命令输出、criterion、反馈备注或导出授权的 outcome event。若未来确需 session event，只能保存最小、非敏感、不可变的关联指针，并单独评估 telemetry 后果。

推荐 domain 表：

- `contracts`：每个 Task Contract 的当前快照和 revision；
- `evidence`：按 EvidenceId 保存不可变事实；
- `verification_runs`：每次聚合结果；
- `dispositions`：用户任务级 disposition，使用 CAS revision；
- `session_cursors`：事件消费 cursor；
- `exports`：只保存导出 manifest、同意记录和摘要，不保存第二份导出内容。

DSH storage domain 不提供跨表事务，因此：

- 权威 record 先写，派生 index 后写；
- index 必须可由权威 records 重建；
- 不允许只有 index 才保存的事实；
- 每个 contract 或 session 使用串行 promise queue；
- 单次 write 失败不得提前更新内存；
- partial failure 要可检测并在下一次加载时修复；
- schema version 不匹配时 fail loud，不静默丢字段；
- 返回给调用方的对象必须 detached/frozen，调用方不得原地修改存储对象。

### 8.5 现有 feedback 能力

不要重复实现消息反馈系统。

DSH 当前存在两类不同反馈：

1. `@deepseek-ai/dsh-message-feedback` 的 `ctx.messageFeedback`：对 finalized assistant message 的可编辑 positive/negative rating 和可选 note，存储在 sidecar，不进入模型，也不自动交给 telemetry；
2. `@deepseek-ai/dsh-command-feedback` 的 `/feedback`：追加不可变 `feedback/record { text }` session event，可能在 feedback-only telemetry 模式下触发 session prefix 分享。

集成规则：

- task outcome 与 message rating 是不同概念；
- 可把最终 assistant message id 与 task contract 关联，并把 rating 作为中等强度用户信号；
- 不复制完整 note；优先保存 message id、feedback version 和用户信号引用；
- `/feedback` 文本只有在明确指向当前任务结果时才可用作标签；否则只是一般反馈；
- 不改变 DSH 原有分享披露；
- 不把用户未授权的 message feedback 转成训练贡献；
- message feedback service 缺失时核心结果验证仍应工作。

### 8.6 Token meter 与成本

优先复用 `ctx.tokenMeter` 和 durable usage，而不是重新估算模型内容。保存时必须区分：

- provider 报告的 exact usage；
- token meter 的 conservative/heuristic estimate；
- 缺失或未知；
- 输入、输出、cache 和总量中实际可得的字段；
- 当前任务的 seq 范围，而非整个 session 的无界累计。

不要硬编码随时间变化的模型价格。货币成本只在用户配置了带版本和来源的 price table 时计算；否则只报告 token 数。任何 price table 必须记录 provider、model、有效时间和币种。

插件自身开销单独统计：

- 新增 LLM calls；
- 新增 input/output tokens；
- 新增 wall-clock latency；
- 新增命令执行；
- 新增磁盘字节；
- 新增网络请求。

默认个人模式的前两项必须为零，网络请求必须为零。

### 8.7 Session projection 与 UI

若需要在 Web client 显示当前 outcome，可选地注册 pure session projection：

- projection 的 `init/apply/view` 必须同步且纯；
- uninterested event 返回同一 state reference；
- state 是 plain JSON；
- 修改 fold 语义或持久化字段时提升 `stateVersion`；
- projection 只提供当前可显示摘要，不承载权威 evidence；
- 没有 `sessionProjections` 服务的 headless 环境必须仍可运行核心插件。

### 8.8 Telemetry

`sessionTelemetry` 是出站报告能力，不是本项目的本地账本。核心插件不得依赖或自动启用它。

如果部署已经安装 telemetry：

- outcome sidecar 不应被自动发送；
- 不向 session log 添加敏感 outcome payload；
- 不把 best-effort handoff 当作持久化或成功证明；
- 贡献模式必须拥有独立同意、脱敏和交付语义，不能借用既有 telemetry 配置推断训练授权。

## 9. 推荐代码结构

在空仓库初始化时采用单 npm package、内部清晰分层；只有两个角色需要独立演进时才拆成多个包。

```text
.
├── AGENTS.md
├── README.md
├── ARCHITECTURE.md
├── PRIVACY.md
├── SECURITY.md
├── DATA_FORMAT.md
├── COMPATIBILITY.md
├── CHANGELOG.md
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── cordis.patch.yml
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── service.ts
│   ├── domain/
│   │   ├── ids.ts
│   │   ├── types.ts
│   │   ├── errors.ts
│   │   ├── reducer.ts
│   │   ├── aggregate.ts
│   │   └── freshness.ts
│   ├── dsh/
│   │   ├── events.ts
│   │   ├── observer.ts
│   │   ├── replay.ts
│   │   ├── feedback-bridge.ts
│   │   ├── token-bridge.ts
│   │   └── compatibility.ts
│   ├── persistence/
│   │   ├── schema.ts
│   │   ├── repository.ts
│   │   ├── queue.ts
│   │   └── repair.ts
│   ├── verification/
│   │   ├── registry.ts
│   │   ├── engine.ts
│   │   ├── policy.ts
│   │   └── adapters/
│   ├── export/
│   │   ├── schema.ts
│   │   ├── redact.ts
│   │   ├── preview.ts
│   │   └── jsonl.ts
│   └── consumers/
│       ├── commands.ts
│       ├── projection.ts
│       └── model-tools.ts
├── test/
│   ├── unit/
│   ├── integration/
│   ├── compatibility/
│   ├── privacy/
│   ├── fixtures/
│   └── smoke/
└── examples/
    └── cordis.patch.yml
```

分层规则：

- `domain/` 必须是纯 TypeScript，不访问文件、网络、时钟或 DSH；
- `dsh/` 只负责把 DSH 类型和事件转换为领域输入；
- `persistence/` 负责 schema、CAS、幂等、队列和修复；
- `verification/` 只通过显式 provider 接口访问外部事实；
- `export/` 是唯一允许构造可分享数据集的路径；
- `consumers/model-tools.ts` 默认不装载；
- UI、命令和模型工具不得包含领域真相，只调用 service；
- 不允许循环依赖；
- 不允许 domain import adapter。

## 10. 服务接口设计

核心服务建议命名为 `ctx.outcomeLoop`，通过 `OutcomeLoopService extends Service` 提供。公开接口使用 branded ids、判别联合和显式 revision。

推荐能力：

```ts
interface OutcomeLoopApi {
  createContract(input: CreateContractInput): Promise<Result<TaskContract, OutcomeError>>
  reviseContract(ref: ContractRef, patch: ReviseContractInput): Promise<Result<TaskContract, OutcomeError>>
  getContract(id: ContractId): Promise<TaskContract | undefined>
  listContracts(query: ContractQuery): Promise<readonly TaskContractSummary[]>
  recordEvidence(input: RecordEvidenceInput): Promise<Result<Evidence, OutcomeError>>
  verify(input: VerifyInput): Promise<Result<VerificationRun, OutcomeError>>
  setDisposition(input: SetDispositionInput): Promise<Result<TaskDisposition, OutcomeError>>
  getOutcome(id: ContractId): Promise<TaskOutcomeView | undefined>
  previewExport(input: ExportRequest): Promise<Result<ExportPreview, OutcomeError>>
  exportJsonl(input: ApprovedExportRequest): Promise<Result<ExportReceipt, OutcomeError>>
  deleteOutcome(input: DeleteOutcomeRequest): Promise<Result<DeleteOutcomeReceipt, OutcomeError>>
}
```

接口要求：

- 所有 mutation 明确拥有者、revision 和幂等语义；
- business error 返回稳定判别联合；基础设施故障可以 reject，但不可伪装成 business error；
- list 有分页和上限；
- 输出是 detached immutable snapshot；
- delete 明确删除哪些 sidecar records，不声称删除 DSH canonical session log；
- export 先 preview，approval 必须引用 preview digest，防止预览后内容变化；
- plugin disposal 开始后拒绝新 mutation；
- 同一 contract 的 mutation 串行化；
- 不接受裸任意文件路径，路径先解析为 scope 内 target。

## 11. 配置设计

所有部署可调值必须出现在 Schemastery `Config` 中，并在插件加载时验证。不要导出同名 plain object 冒充 schema。

推荐安全默认值：

```yaml
mode: personal
capture:
  enabled: true
  rawToolArguments: false
  rawToolResults: false
  rawMessages: false
  pathMode: relative
  maxExcerptBytes: 4096
verification:
  observeExisting: true
  autoRun: false
  llmJudge: disabled
  commandTimeoutMs: 120000
  maxCommandOutputBytes: 65536
privacy:
  network: disabled
  export: manual
  redactSecrets: true
  redactPersonalData: true
feedback:
  messageFeedback: optional
projection:
  enabled: true
logging:
  level: info
  includeContent: false
```

字段名称可在实现前调整，但默认语义不得变弱。

配置分层：

- `cordis.yml` 保存部署/管理员配置；
- DSH user settings 只承载用户可编辑的安全子集；
- 企业强制策略不得被 workspace 内配置覆盖；
- secret 使用 DSH credential reference 或宿主安全机制，不写入普通配置；
- project policy 被视为仓库内容，可能由不可信代码提交者控制，不能自动授权命令、网络或数据上传；
- HMR 更新时必须完整替换 config 并安全卸载旧实例。

## 12. 验证引擎

### 12.1 Provider 接口

Verifier provider 必须声明：

- 支持的 criterion kind 和 schema version；
- 是否只观察、是否执行命令、是否访问网络；
- 所需权限；
- timeout 和输出上限；
- 产生的 evidence strength；
- freshness 计算方式；
- 可取消和清理语义。

Provider 只返回事实，不直接决定整个任务成功。

### 12.2 被动观察优先

优先从已有 session events 和工具结果中提取：

- 命令 argv 摘要；
- cwd；
- exit code；
- duration；
- test/lint/build 的结构化结果；
- 文件变更引用；
- 工具错误码。

观察不到足够事实时返回 `unknown`，不要为了得到标签自动再跑命令。

### 12.3 主动执行安全规则

启用 active verification 时：

- 命令来源必须是用户显式输入、管理员可信策略或已批准项目脚本；
- 模型生成命令不自动获得信任；
- 优先 argv + cwd 调用，避免拼接 shell string；
- cwd 必须位于 contract workspace scope；
- 环境变量使用 allowlist，默认不继承全部 secrets；
- 必须设置 timeout、output cap 和 AbortSignal；
- 默认禁止网络；
- 默认只读；需要写入、安装依赖、修改数据库或启动服务时再次审批；
- 不使用宽泛 glob、未解析变量或用户 home 作为破坏性目标；
- 记录执行政策和审批引用；
- 输出先在内存中脱敏再写入 sidecar；
- 失败时保留退出码与受限摘要，不保留整个含秘密日志。

### 12.4 Evidence freshness

测试通过只证明当时的 workspace state。至少用以下信息判断新鲜度：

- contract revision；
- Git HEAD（若有）；
- 相关 diff digest；
- 受影响路径的 digest 或 mtime/size 组合；
- verification 结束后的后续文件写事件；
- verifier 版本与配置 digest。

如果相关文件在测试后发生变化，测试 evidence 应标记 stale。无法判断影响范围时保守地标记 unknown，而不是继续 pass。

### 12.5 不同来源冲突

示例：测试通过，但用户报告功能仍错误。应记录：

- mechanical verification: passed；
- user disposition: rejected；
- overall label strength: conflicting/inconclusive；
- next action: 新增能复现用户问题的 criterion。

绝不能删除测试通过事实，也不能忽略用户拒绝。

## 13. Token 与性能预算

默认模式的硬门槛：

- LLM 调用数增量为 0；
- model-visible tool 数增量为 0；
- system prompt 字节增量为 0；
- 网络请求增量为 0。

性能规则：

- `session/event` callback 只做常数级筛选、生成轻量引用和入队；
- 磁盘写入在 per-session/contract queue 中异步完成；
- 不在每个 chunk 上写磁盘；
- 聚合写入要有明确的 flush 点和 crash 语义；
- 输出、日志、export 和 list 都有大小/分页上限；
- 大 session 重放必须从 cursor 增量处理；
- 所有 benchmark 都报告事件数、session 大小、机器和 DSH 版本；
- 性能优化不得牺牲幂等、隐私或正确性。

任何 opt-in LLM Judge 必须要求用户设置：

- provider/model；
- 单任务最大调用次数；
- 最大输入/输出 token；
- 哪些字段允许发送；
- 预算超限行为；
- judge 结果只作为 weak label。

## 14. 隐私与安全

### 14.1 数据最小化

默认只保存完成结果判断所需的最少字段。特别禁止默认保存：

- 完整用户 prompt；
- 完整 assistant response；
- 完整 tool arguments/result；
- 源代码正文；
- 终端完整输出；
- `.env` 内容；
- access token、cookie、authorization header；
- 用户 home 的绝对路径；
- 第三方个人信息；
- 未经选择的附件内容。

优先保存 `sessionId + event.seq + messageId/callId` 引用、计数、状态、摘要和 digest。

### 14.2 敏感信息分类

至少支持：

- `public`；
- `internal`；
- `confidential`；
- `secret`；
- `personal-data`；
- `unknown-sensitive`。

未知内容默认按敏感处理。`secret` 永不进入 export preview 的正文，只显示命中类型和位置计数。

### 14.3 路径安全

- 用户展示优先 workspace-relative path；
- sidecar 默认保存 relative path 或 salted digest；
- 解析后验证 target 仍位于允许 root；
- 防范 `..`、符号链接跳出、大小写折叠和 Windows 路径差异；
- 不递归扫描 `~`、`/` 或未确认的大目录；
- 不跟随 workspace 外 symlink；
- export 前再次规范化和脱敏路径。

### 14.4 日志

- 结构化日志只包含稳定 id、event type、计数、错误码和 duration；
- 默认 `includeContent: false`；
- debug 模式也不得记录 secrets；
- catch 后日志说明哪个操作失败，保留 error chain，但先脱敏；
- 不空 catch；确需吞掉的错误必须命名并解释为何安全；
- 不使用 console 输出原始事件。

### 14.5 导出

导出是显式的两阶段操作：

1. `previewExport` 计算候选记录、字段清单、敏感命中、脱敏变化、许可和摘要 digest；
2. 用户批准该 digest 后 `exportJsonl` 生成确定版本的文件。

预览后数据变化必须使 approval 失效。导出默认：

- 不含消息正文；
- 不含代码正文；
- 不含绝对路径；
- 不含 credentials；
- 不含完整命令输出；
- 不含弱标签伪装的 success；
- 带 schema version、插件版本、DSH 版本、脱敏版本和许可；
- 每行可独立解析；
- 稳定排序，便于 diff 和复现。

### 14.6 主要威胁与控制

| 威胁 | 必须的控制 |
| --- | --- |
| 命令输出泄露 secret | 输出上限、deterministic redaction、默认不保存正文 |
| 恶意仓库配置执行命令 | 仓库配置不授予权限，主动执行需可信来源/审批 |
| 路径穿越或 symlink 逃逸 | canonicalize 后验证 scope，禁止跟随外部链接 |
| session event 重复造成重复样本 | `(sessionId, seq)` 幂等 cursor |
| 部分写导致错误聚合 | 权威记录优先、可重建 index、启动修复 |
| telemetry 意外外发 outcome | outcome 存 sidecar，不写敏感 session event |
| 用户点赞被误作任务成功 | feedback 与 verification 独立建模 |
| LLM Judge 自我确认 | 仅 weak label，预算和 opt-in |
| 证据过期仍显示通过 | workspace state 与 freshness invalidation |
| 恶意 export 路径覆盖文件 | scoped target、拒绝 symlink、显式 overwrite 审批 |
| 多进程并发丢写 | 文档披露限制；实现 CAS/锁前不得宣称多进程安全 |
| 存储格式损坏 | schema validation、fail loud、备份/修复说明 |

## 15. 与 dsh-code-reference 的可选集成

`dsh-code-reference` 负责开发前的候选发现与复用决策；`dsh-outcome-loop` 负责开发后的事实校验。二者应保持独立安装和单向可选集成。

不要让 outcome-loop import code-reference 的内部文件。推荐由 outcome-loop 暴露通用 decision evidence API，code-reference 或桥接插件主动提交：

```ts
interface PriorDecisionEvidence {
  source: 'dsh-code-reference' | string
  decisionId: string
  strategy: 'reuse' | 'adapt' | 'dependency' | 'rewrite'
  candidateRef?: string
  predictedMatch?: number
  predictedEffort?: EffortEstimate
  policyDigest?: string
}
```

开发后可记录：

- 实际修改文件数和行数区间；
- 测试是否通过；
- 新增依赖及许可证事实；
- 实际工具调用、token 和耗时；
- 最终是否更换 strategy；
- 用户是否接受结果。

这些数据只用于用户自己的校准，默认不上传。不得把启发式相似度当作真实复用收益；不得保存候选仓库的完整代码或 README 副本。

## 16. 开放导出格式

JSONL 顶层记录建议：

```json
{
  "schema_version": "outcome-loop.export.v1",
  "record_id": "...",
  "task": {
    "contract_id": "...",
    "goal_ref": { "session_id": "...", "seq": 0 },
    "criteria": []
  },
  "trajectory": {
    "session_id": "...",
    "seq_start": 0,
    "seq_end": 0,
    "model_routes": []
  },
  "verification": {
    "status": "inconclusive",
    "criteria": [],
    "label_strength": "unknown"
  },
  "user_disposition": { "status": "none" },
  "cost": { "usage_kind": "unknown" },
  "privacy": {
    "content_included": false,
    "redaction_version": "...",
    "license": "private-only"
  },
  "lineage": {
    "outcome_loop_version": "...",
    "dsh_version": "...",
    "config_digest": "..."
  }
}
```

要求：

- schema 使用显式版本；
- 枚举新增遵循兼容策略；
- 导入器拒绝未知必需字段语义；
- record id 稳定且不泄露原始路径；
- exact usage 与 estimate 不混合；
- provider/model 作为 lineage，不作为成功因果；
- 数据集视图由 export record 派生，不反向修改账本；
- SFT、DPO、tool-use、router 等训练视图属于后续 curator，不在核心包里生成；
- 只有 strong/medium 且无冲突的记录才可能进入训练候选，最终仍需独立治理。

## 17. TypeScript 与代码规范

空仓库初始化时采用：

- TypeScript strict mode；
- ESM，`package.json` 使用 `"type": "module"`；
- NodeNext 或与实际构建器一致的显式模块解析；
- 支持当前测试矩阵中的 Node 22.19 和 Node 24；
- pnpm，锁文件提交；
- Vitest 作为单元/集成测试框架，除非仓库初始化时明确选择 `node:test` 并能保持同等 TypeScript 与 coverage 能力；
- Zod/Schemastery 分别用于持久化/公开输入与 Cordis 配置，避免重复手写不一致类型。

代码要求：

- 禁止无说明的 `any`；
- 跨进程、文件、JSON、模型/tool、配置和 durable storage 边界做运行时验证；
- 已由同进程静态类型保证的内部值不要重复做敌意输入校验；
- 使用判别联合和 exhaustive switch 处理封闭领域联合；
- 对 DSH merge-extensible union 保留 documented default；
- 时间统一为 Unix epoch milliseconds，duration 明确单位；
- ids 使用 branded types；
- 公开函数和非直观不变量写简洁 JSDoc；
- 注释描述约束、失败、所有权和时序，不复述代码；
- 一处定义一项事实，避免 README、类型和实现各自复制默认值；
- tunable 从 Config 注入，协议常量和安全不变量才可固定；
- 文件恰好一个 trailing newline；
- 不在库代码中使用进程级全局 mutable singleton；
- 不直接读写用户 home；
- 不调用 `process.exit()`；
- 不使用动态 `eval` 或 `Function`；
- 不默认开启网络或 shell。

本地 import extension 规则由初始化后的 `tsconfig` 和 build smoke 固定，整个仓库只采用一种方式；不得混用或依赖仅在 tsx 下成立、在发布的 plain Node 中失败的解析行为。

## 18. 包与发布

推荐 npm 包名为 `dsh-outcome-loop`，Cordis plugin name 为 `outcome-loop`。若命名在首次发布前改变，必须一次性更新 manifest、patch、README、exports、测试和示例。

`package.json` 至少包含：

- `type: module`；
- built runtime 与 type declarations 的 `exports`；
- `files` allowlist；
- `engines`；
- `packageManager`；
- `dsh.bundle.patch` 指向 `cordis.patch.yml`；
- `@deepseek-ai/cordis` 作为 peer + dev dependency；
- 使用到的 DSH service definition 包采用兼容的 peer dependency；
- 可选集成用 `peerDependenciesMeta.optional`；
- build、typecheck、lint、test、coverage、pack smoke scripts；
- 明确 license 和 repository。

发布原则：

- npm/tarball 分发预构建 `lib/`，优先避免 git install 的 `prepare` 执行授权；
- 如支持 git install，`prepare` 必须从独立 checkout 自包含构建，并文档说明 pnpm `allowBuilds` 风险；
- `pnpm pack` 后解包验证实际文件，而不只看源目录；
- 用新 DSH profile 执行 `dsh plugin add`、`--dump-config`、启动、卸载冒烟；
- tag 与 changelog 对应；
- pre-1.0 仍需明确 breaking change；
- CI 第三方 action 固定到 commit SHA；
- 不从未固定的 main 分支指导生产安装；
- release 附校验和或使用 registry provenance；
- 不把 API key、测试凭据、真实 outcome 数据或导出 fixture 发布进包。

## 19. 测试策略

### 19.1 单元测试

纯 domain 必须覆盖：

- aggregate 规则；
- required/optional/warning criteria；
- pass/fail/unknown/not-applicable；
- evidence conflict 与 stale；
- contract revision invalidation；
- label strength；
- exact vs estimated cost；
- failure taxonomy；
- deterministic ids；
- redaction；
- export schema；
- path normalization。

安全关键的 reducer、redaction、scope 和 export approval 代码目标为 100% branch coverage；全项目 coverage 不得通过排除关键文件来美化。

### 19.2 集成测试

使用真实 Cordis Context 和可控 provider 测试：

- plugin pending/loading/active/dispose；
- required service 出现、消失和 HMR 重载；
- session event live capture；
- seed replay；
- duplicate event；
- seq gap；
- fork；
- turn completed/aborted/error/max-tokens；
- tool call/result 配对；
- storage write failure；
- restart/cursor resume；
- partial index repair；
- per-session concurrent mutation；
- disposal drain；
- optional feedback/token/projection service 缺失。

### 19.3 隐私回归测试

默认 composition 必须证明：

- 没有 LLM service 调用；
- 没有 model tool 注册；
- 没有 system prompt 贡献；
- 没有网络请求；
- outcome payload 未追加进 session log；
- secret fixture 不出现在 storage、日志、preview 和 export；
- 绝对 home path 不出现在 export；
- raw tool/message 内容默认不复制；
- 拒绝 export 时不产生文件；
- preview digest 变化后旧 approval 失效。

### 19.4 验证器测试

每个 active verifier 测试：

- 成功；
- 非零退出；
- timeout；
- cancellation；
- output cap；
- invalid cwd；
- symlink escape；
- permission denied；
- secret redaction；
- plugin disposal；
- Windows/Linux 路径差异（若宣称跨平台）。

### 19.5 打包与兼容测试

- `pnpm typecheck`；
- `pnpm lint`；
- `pnpm test`；
- `pnpm test:coverage`；
- `pnpm build`；
- `pnpm pack` 内容检查；
- plain Node import built entry；
- 在声明支持的 DSH 最低版和当前版各运行一次 profile smoke；
- Node 22.19 与 Node 24 CI；
- 安装、dump config、启动、记录一条 outcome、重启读取、卸载。

真实模型 API 不应是 MVP 测试的前提。默认测试在没有 `DEEPSEEK_API_KEY` 时完整通过。

## 20. Definition of Done

一个功能只有同时满足以下条件才算完成：

- 行为与本次批准范围一致；
- 验收条件有自动化证据；
- 默认模式未新增 token、模型工具、prompt 或网络；
- 新 durable 字段有 schema、版本和迁移/拒绝策略；
- 重放和重复投递幂等；
- 错误具有稳定 code 与可行动说明；
- 取消、timeout 和 dispose 正确释放资源；
- 敏感数据经过最小化和脱敏；
- 相关 unit/integration/privacy 测试通过；
- build 和 package smoke 通过；
- README/PRIVACY/SECURITY/DATA_FORMAT/CHANGELOG 按需更新；
- 没有未解释的 TODO、跳过测试或宽泛类型；
- 实际运行的命令和任何未验证风险已报告。

## 21. 开发阶段

### 阶段 0：基础工程

- 初始化 TypeScript ESM、pnpm、测试、lint、build 和 bundle manifest；
- 建立 compatibility smoke；
- 写 README、PRIVACY、SECURITY 和数据格式骨架；
- 验证空插件安装、HMR 和卸载。

完成门槛：没有业务功能，但可作为 DSH bundle 安装并通过 plain Node import。

### 阶段 1：纯领域模型

- branded ids；
- Task Contract；
- criteria/evidence/result；
- aggregate/freshness/failure taxonomy；
- export v1 schema；
- 全部纯函数测试。

完成门槛：不依赖 DSH 即可重放 fixture 并稳定产生 outcome。

### 阶段 2：被动 session observer

- 监听 `session/event`；
- seed + live replay；
- cursor/idempotency；
- turn/tool/usage 归一化；
- 默认不复制正文。

完成门槛：重复、重启、fork、gap 测试通过，hot path 无同步 IO。

### 阶段 3：本地 sidecar

- storage domain schemas；
- per-session/contract queues；
- CAS revision；
- repairable indexes；
- delete 与 restart。

完成门槛：故障注入不产生错误 success，重启后结果一致。

### 阶段 4：确定性验证

- 被动 command/test/file/git evidence；
- freshness；
- conflict；
- 人类可读缺口和 next action；
- active verifier 仍默认关闭。

完成门槛：能对真实小型代码任务输出 passed/failed/inconclusive，并给出可追溯证据。

### 阶段 5：反馈与成本桥接

- optional messageFeedback link；
- `/feedback` event reference；
- tokenMeter/usage 聚合；
- mechanical result 与 user disposition 双轴展示。

完成门槛：没有 feedback/token service 时仍退化为完整可用的核心功能。

### 阶段 6：查询、导出和 bundle 发布

- status/list/delete；
- preview + digest approval + JSONL；
- 安装文档；
- package smoke；
- 首个 beta release。

完成门槛：用户能查看、删除和导出自己的数据，默认无外发。

### 阶段 7：后续能力

按顺序评估：

1. 更多确定性 verifier provider；
2. 企业策略与 retention；
3. `dsh-code-reference` 决策校准；
4. 本地成本路由建议；
5. 经过回放验证的 Skill 候选；
6. 独立贡献插件；
7. 最后才考虑 LLM Judge 和自动路由。

每一阶段都必须先证明用户收益大于新增复杂度和成本。

## 22. 明确禁止事项

- 禁止默认上传；
- 禁止隐藏 telemetry；
- 禁止默认注册模型工具或 prompt；
- 禁止用 turn completed 代表任务成功；
- 禁止用用户沉默代表接受；
- 禁止用点赞/点踩覆盖机械证据；
- 禁止把 LLM Judge 标成客观强证据；
- 禁止在 session log 中写敏感 outcome payload；
- 禁止保存完整代码或命令输出作为默认账本；
- 禁止从恶意项目配置获得命令执行或网络权限；
- 禁止硬编码模型价格；
- 禁止绕开 Cordis effect 生命周期；
- 禁止依赖 DSH 私有路径；
- 禁止吞掉 storage、schema 或 compatibility 错误；
- 禁止遇到 unknown event 就崩溃；
- 禁止在未经测试的版本上宣称兼容；
- 禁止自动修改自己的 Skill、策略或路由；
- 禁止把一次成功轨迹直接固化为规则；
- 禁止为追求 coverage 排除安全关键文件；
- 禁止提交真实用户轨迹、凭据或私有源代码 fixture。

## 23. 架构决策与文档维护

以下变化必须新增 ADR 或等价设计记录：

- 新增网络能力；
- 新增模型调用或 model-visible content；
- 新增主动命令执行；
- 修改 outcome 聚合规则；
- 修改 evidence strength；
- 新增 session event；
- 修改 durable schema；
- 修改 export 默认字段；
- 修改同意或贡献流程；
- 宣称多进程安全；
- 拆分或合并 package；
- 改变 DSH 最低兼容版本。

ADR 必须记录：问题、约束、候选方案、选择、拒绝理由、隐私/token 影响、迁移、测试和回滚。

文档中的当前事实应与代码同一 PR 更新。不要在多个文档复制同一 schema；生成表格或链接到权威定义。示例数据必须是合成数据。

## 24. 实现前仍需做出的产品决策

以下决策不能由编码 Agent私自扩大范围，应在对应阶段获得用户或维护者确认：

1. Task Contract 的首个创建入口：Web UI、human command、host API 或可信项目配置；
2. MVP 是否包含任何 active verifier；
3. outcome Web UI 是否与核心包同一 release；
4. sidecar 默认保留期和删除交互；
5. 是否发布到 npm，或先以 GitHub tag + tarball 分发；
6. 首批兼容的 DSH 版本范围；
7. Windows 是否属于首个支持矩阵；
8. `dsh-code-reference` 集成是内置 optional adapter 还是独立 bridge；
9. export v1 是否允许用户选择包含消息正文；
10. 企业策略文件的信任和签名机制。

在这些决策未完成时，使用本文件规定的最保守默认值，并把尚未选择的能力保持关闭。

## 25. 官方参考

实现时优先核对以下官方来源：

- DeepSeek Harness README：<https://github.com/deepseek-ai/deepseek-harness>
- 官方 AGENTS.md：<https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md>
- 插件入门：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md>
- 插件配置：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md>
- 插件打包：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md>
- Cordis events：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/events.md>
- Cordis services：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/service.md>
- Session：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md>
- Storage：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/storage.md>
- Settings：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/settings.md>
- Token Meter：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/token-meter.md>
- Session Projection：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session-projection.md>
- Session Telemetry：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session-telemetry.md>
- Message Feedback：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/feedback/message-feedback/README.md>
- Command Feedback：<https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/feedback/command-feedback>
- dsh-code-reference：<https://github.com/victorzhong0110/dsh-code-reference>

当本文档与当前官方公共 API 冲突时，不要静默照抄本文档中的接口名。先确认上游变化，更新 compatibility adapter、测试和本文件，再实现功能。无论上游如何变化，本文件中的用户利益、默认零额外 token、默认无网络、用户授权、证据优先和事实/解释分离原则持续有效。
