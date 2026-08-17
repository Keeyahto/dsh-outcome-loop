# ADR-0001: Task Contract 创建入口 = 人类命令 + Host API

**状态**：已接受（2026-08-18）｜**范围**：spec §24 决策 #1

## 问题

Task Contract 需要用户输入（目标、验收条件），但默认模式禁止模型可见工具与每轮 prompt 注入。

## 候选

1. Web UI 表单（新增客户端插件）；
2. 人类命令 `/outcome`（`ctx.commands.register`，如 `/feedback`）；
3. Host API 仅限（`ctx.outcomeLoop.createContract`，供其他宿主代码调用）；
4. 可信项目配置文件（`.outcome-loop/contract.json` 自动导入）。

## 选择

**2 + 3 组合**：`/outcome new|criterion|verify|…` 作为主要入口；`createContract/reviseContract/addCriterion` 作为宿主 API 同时可用。配置自动导入（4）不做——仓库内容不可信（spec §11），自动读取文件授予契约语义属于未授权通道。

## 拒绝理由

- 1：核心 MVP 不需要浏览器 UI；projection consumer 已提供最小可显示摘要；
- 4：需要文件信任与校验机制，超出 MVP，且与"项目配置不授予权限"原则冲突。

## 影响

- 隐私/token：命令不产生模型调用、不注册模型工具、不注入 prompt；`recordInput: true` 会在 session log 记录命令原文（DSH 命令系统自身行为，非本插件新增）；
- 迁移：无；测试：`test/integration/commands.test.ts`；
- 回滚：删除 commands 插件行即可回到纯 API 入口。

# ADR-0002: Active 验证默认关闭 + 四重策略门

**状态**：已接受（2026-08-18）｜**范围**：spec §12.3、§24 决策 #2

## 问题

MVP 是否包含主动执行验证命令的能力？如何防止恶意仓库配置或模型生成的命令获得执行权限？

## 候选

1. 完全不实现 active verifier；
2. 实现但默认关闭，需部署+契约+scope+白名单四重门；
3. 实现且默认开启（按需审批）。

## 选择

**2**。`decideActiveRun()` 是唯一决策点：部署 `verification.autoRun` ∧ 契约 `verificationPolicy.autoRun` ∧ scope `allowActiveVerification` ∧（白名单为空或包含该 verifier）∧ 绝对 workspaceRoot，全部满足才执行。执行方式：argv+cwd spawn（无 shell 拼接）、env allowlist、timeout、output cap、AbortSignal、默认只读、无网络。

## 拒绝理由

- 1：file-*/git-scope 等 criterion 将永远无法机械验证，削弱产品价值；
- 3：默认开启违反"最小权限、默认拒绝"，模型生成的命令不应自动获得信任。

## 影响

- 隐私/token：默认零执行；开启后每次 active run 是一次确定性命令执行（非模型调用）；
- 迁移：无；测试：`decideActiveRun` 全分支 + active verifier 单元/集成测试；
- 回滚：把 `deploymentAutoRun` 置回 false。

# ADR-0003: Outcome 数据存独立 sidecar domain，永不写入 session log

**状态**：已接受（2026-08-18）｜**范围**：spec §8.4、§14.6

## 问题

任务结果、证据摘要、用户 disposition 存在哪里？写入 session log 会被 telemetry 镜像并进入模型相关数据面。

## 候选

1. 写入 session log（最小指针事件）；
2. 独立 storage domain sidecar（`outcome_loop`）；
3. 两者混合。

## 选择

**2**。domain `outcome_loop` v1，六张表（contracts/evidence/verification_runs/dispositions/session_cursors/exports），权威记录先写、派生 index 后写、可重建、启动修复。session log 只保留 DSH 自己的事件（本插件不 append 任何内容）。

## 拒绝理由

- 1：outcome 含可删除、可修订的用户 disposition 与导出资格；证据摘要可能敏感，不应自动进入 session telemetry；任务级聚合不是模型历史的一部分；
- 3：复杂化且仍违反最小外发原则。

## 影响

- 隐私/token：outcome 永不进入模型上下文与 telemetry；删除独立于会话历史；
- 迁移：sidecar 可随 storage backend 迁移；格式版本 fail loud；
- 测试：`test/privacy` 结构性断言（无 `.append(`）；集成测试覆盖重启恢复。

# ADR-0004: 导出 = 两阶段 digest 绑定，内容默认最小化

**状态**：已接受（2026-08-18）｜**范围**：spec §14.5、§16

## 问题

导出是显式数据外流操作；如何防止"预览后内容被替换"与敏感内容外泄？

## 候选

1. 单阶段直接导出；
2. 两阶段：preview（含 digest）→ 批准 digest → 生成。

## 选择

**2**。`previewExport` 计算候选记录、字段清单、敏感命中、许可与内容 sha256 digest；`exportJsonl` 重算内容并比对 digest，不一致即 `export-approval-invalid`。导出记录默认不含消息正文、代码正文、绝对路径、credentials、完整命令输出；explicit goal 文本只出 digest。写入由调用方完成（命令消费者原子写：临时文件 + rename、拒绝越界路径、拒绝覆盖除非 `--overwrite`）。

## 拒绝理由

- 1：预览后内容可能变化，批准无锚点；无法审计。

## 影响

- 隐私/token：零模型成本；secret 类证据只出计数；
- 迁移：导出记录 schema 版本化，导入器拒绝未知必需字段语义；
- 测试：digest 稳定性、批准失效、路径逃逸拒绝、覆盖保护；
- 回滚：移除 `exportJsonl` 的 digest 校验即回到单阶段（不推荐）。
