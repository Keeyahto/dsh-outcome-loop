# ARCHITECTURE

本文件记录 `dsh-outcome-loop` 的架构决策与实现规则。权威行为约束见根目录 `AGENTS.md`（全局开发指导）；本文档与代码冲突时，以 `AGENTS.md` 与代码为准并更新本文档。

## 1. 分层与依赖方向

```text
consumers (命令/投影)  ──只调用──▶  service (ctx.outcomeLoop)
                                        │
                    ┌───────────────────┼─────────────────────┐
                    ▼                   ▼                     ▼
              verification           persistence          dsh 适配层
              (engine/policy/         (storage-domain       (observer/replay/
               registry/adapters)      sidecar)              token/feedback)
                    │                   │                     │
                    └───────── 纯 domain（无 DSH/IO/时钟）─────────┘
```

规则（`AGENTS.md` §9）：

- `domain/` 是纯 TypeScript：不访问文件、网络、时钟或 DSH；所有时间以 Unix epoch ms 传入；
- `dsh/` 只负责把 DSH 类型与事件转换为领域输入；
- `persistence/` 负责 schema、CAS、幂等、队列与修复；
- `verification/` 只通过显式 provider 接口访问外部事实；
- `export/` 是唯一允许构造可分享数据集的路径；
- UI、命令与模型工具不包含领域真相，只调用 service；
- 不允许循环依赖；不允许 domain import adapter。

## 2. 数据流

### 2.1 会话观察（`dsh/observer.ts` + `dsh/registry.ts`）

- 热路径只订阅 `session/event`（Cordis post-commit 通知，签名 `(session, event)`）；
- 每个事件经 `dsh/events.ts` 归一化为 0..n 个 `SessionFact`：常数大小、无正文复制（只存 digest/计数/seq/退出码）；
- 事实写入 per-session 内存 `FactRegistry`（可重建的派生索引），并按 `(sessionId, seq)` 去重；
- 有契约的 session 同步推进持久化 cursor（`session_cursors` 表）。

### 2.2 重放（spec §8.3）

- durable `session/event` 只发布新 append；constructor seed 不重发；
- 因此历史通过快照填充恢复：插件启动时扫描 `ctx.sessions.list()`，并在 `session/created`（resume/fork）时重新填充；
- 可选 `sessionPersistence.inspect()` 用于冷会话读取（best-effort，缺失时核心功能照常）；
- 重复投递由 high-water seq 去重；seq gap 不允许猜测 —— 无权威日志可读时，该 session 不产生事实（criterion 保守为 `unknown`）。

### 2.3 验证（`verification/engine.ts`）

1. 被动适配器从事实日志 + 先前证据行计算每个 criterion 的初步判定（spec §12.2：观察不到足够事实 → `unknown`，**绝不**为拿标签自动重跑命令）；
2. 仅当所有策略门（部署 `autoRun` + 契约 `verificationPolicy.autoRun` + scope `allowActiveVerification` + verifier 白名单 + 绝对 workspaceRoot）都打开时，才运行 active verifier（spec §12.3：argv+cwd、无 shell 拼接、env allowlist、timeout、output cap、AbortSignal、默认只读、默认无网络）；
3. 匹配事实持久化为不可变 Evidence 行（确定性 id → 幂等）；
4. 用 freshness（contract revision / verifier version / workspace epoch / maxAge）筛选当前证据；冲突证据 → `inconclusive`（规则 6）；
5. 聚合（`domain/reducer.ts` 规则 1–9）→ 持久化 `VerificationRun`。

标签强度由 `evidenceLabelStrength()` 从实际证据行的 strength 计算：strong（机械确定性）/ medium（用户确认）/ weak（仅 judge，本版本无 judge）/ unknown。

### 2.4 导出（`export/`）

preview（`previewExport`）→ 用户批准 digest（`exportJsonl` 重算并比对，内容变化即 `export-approval-invalid`）→ 写入。导出记录由权威 records 派生，永不反向修改账本。

## 3. 存储设计（spec §8.4）

- domain `outcome_loop` v1，表：`contracts` / `evidence` / `verification_runs` / `dispositions` / `session_cursors` / `exports`；
- 权威 record 先写、派生 index 后写；所有派生 index 可由权威 records 重建（`repair.ts` 在启动时清理孤儿）；
- 单进程内 storage-domain 的单写链提供每域串行化；跨进程 CAS 不做宣称（见 SECURITY.md §多进程）；
- 返回给调用方的对象一律 detached + frozen。

## 4. 为什么不在 session log 里写 outcome

- outcome 含可删除、可修订的用户 disposition 与导出资格；
- 证据摘要可能敏感，不应自动进入 session telemetry；
- 任务级聚合不是模型历史的一部分；
- 用户需要独立删除与迁移。
因此默认 sidecar；未来如需 session event，只能保存最小、非敏感、不可变关联指针。

## 5. 已做/未做的产品决策（spec §24 状态）

| 决策 | 状态 |
| --- | --- |
| Task Contract 首个创建入口 | 已定：人类命令 `/outcome new` + Host API（保守默认） |
| MVP 是否包含 active verifier | 已实现但**默认关闭**；全部策略门打开才运行 |
| outcome Web UI 与核心包同 release | 提供可选 projection consumer（headless 安全），无独立 UI 页面 |
| sidecar 默认保留期与删除交互 | 不设默认保留期；`/outcome delete --yes` 显式删除 |
| 发布方式 | 先 GitHub tag + tarball（`dsh plugin add`），npm 发布待定 |
| 首批兼容 DSH 范围 | `0.1.0-rc.7`（见 COMPATIBILITY.md） |
| Windows 支持 | 不在首个矩阵；路径代码已做跨平台防护，未宣称支持 |
| dsh-code-reference 集成 | 独立安装、单向可选（§7 设计） |
| export v1 是否允许消息正文 | 不允许；`privacy.content_included` 恒为 false |
| 企业策略文件信任机制 | 未实现；仓库内配置**永不**授予命令/网络权限 |

## 6. 已知限制（诚实声明）

- 被动 command 匹配基于工具名 + `command` 参数摘要；模型以非常规方式执行同一命令时可能不匹配 → `unknown`，不会伪造 pass；
- 任意 bash 写入不跟踪为 workspace 变更（只有显式写文件工具 bump epoch）——相关 criterion 依赖 active verification 或 import 提供 file-state 证据；
- 冷 session 且无 `sessionPersistence` 时，历史事实不可重建 → 证据缺失 → `unknown`；
- `session/event` 热路径不做磁盘 IO；写入经 per-session 队列异步完成。

## 7. 与 dsh-code-reference 的可选集成

outcome-loop 暴露 `recordEvidence`（source: `'import'`）作为通用 decision-evidence 入口；code-reference 或桥接插件可主动提交 `PriorDecisionEvidence`（决策 id、strategy、predictedMatch/effort、policyDigest）。集成方不得 import 本包内部文件；启发式相似度**不**等于真实复用收益；候选仓库完整代码/README 永不保存。
