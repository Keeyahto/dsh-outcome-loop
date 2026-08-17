# DATA_FORMAT

sidecar 存储表结构与开放导出格式。本文件只描述格式；schema 的权威定义在 `src/persistence/schema.ts`（zod）与 `src/export/schema.ts`，两者冲突时以代码为准并更新本文档。

## 1. Sidecar domain：`outcome_loop` v1

存储于 DSH storage backend（默认 `json`，可路由到 `sqlite`），与 session log 完全分离。

| 表 | key | value（摘要） | 备注 |
| --- | --- | --- | --- |
| `contracts` | `ContractId` | TaskContract 全量快照（含 `revision`） | CAS 基于 revision |
| `evidence` | `EvidenceId` | Evidence + `contractRevision` + `verifierVersion` | 不可变；确定性 id 幂等 |
| `verification_runs` | `VerificationRunId` | VerificationRun 全量 | 不可变；每次聚合一条 |
| `dispositions` | `ContractId` | TaskDisposition（`revision` CAS） | 用户任务级 disposition |
| `session_cursors` | `SessionId` | `{ lastSeq, updatedAt }` | 事件消费水位 |
| `exports` | `ExportId` | ExportManifest（只存 manifest，不存第二份内容） | 批准记录 |

schema version 不匹配时打开失败（`version-mismatch`/`invalid-record` fail loud），不做静默字段丢弃。

### 关键结构（摘要）

```ts
interface TaskContract {
  schemaVersion: 1
  id: ContractId
  revision: number            // CAS
  sessionId: string
  goal: { kind: 'reference'; ref: { sessionId; seq } } | { kind: 'explicit'; text }
  scope: { workspaceRoot; pathPrefixes; allowActiveVerification }
  constraints: Constraint[]
  criteria: AcceptanceCriterion[]   // 稳定 id，绝不按位置关联证据
  verificationPolicy: { autoRun; commandTimeoutMs; maxCommandOutputBytes; allowedVerifierIds }
  privacyPolicy: { dataEligibility; exportAllowed; contentIncluded }
  createdAt / updatedAt: number     // Unix epoch ms
}

interface AcceptanceCriterion {
  id: CriterionId
  description: string
  kind: 'command-exit' | 'test-report' | 'file-exists' | 'file-absent'
      | 'file-digest' | 'json-schema' | 'git-scope' | 'diagnostic-count'
      | 'manual' | 'custom'
  required: boolean
  severity: 'blocking' | 'warning'
  specification: <判别联合，见 domain/types.ts>
  freshness: { maxAgeMs?; invalidateOnWorkspaceChange }
}

interface Evidence {
  schemaVersion: 1
  id: EvidenceId               // 确定性派生（contract, criterion, fact）
  contractId: ContractId
  criterionId?: CriterionId
  source: 'session-event' | 'user' | 'verifier' | 'feedback' | 'token-meter' | 'import'
  sourceRef?: { sessionId; seq }   // 指向权威日志，不复制正文
  observedAt: number
  workspaceState: { epoch; gitHeadDigest?; changedPathsDigest? }
  fact: <判别联合：command/test-report/file-state/git-scope/diagnostic-count/
         turn/usage/user-confirmation/feedback/tool-outcome/verifier>
  strength: 'strong' | 'medium' | 'weak'
  sensitivity: 'public' | 'internal' | 'confidential' | 'secret' | 'personal-data' | 'unknown-sensitive'
  digest?: string
}
```

## 2. 错误码（spec §7.5，稳定 lower-kebab-case）

`criterion-failed` · `evidence-missing` · `evidence-stale` · `evidence-conflict` · `verification-command-failed` · `verification-timeout` · `verification-output-limit` · `policy-denied` · `permission-denied` · `tool-error` · `model-error` · `max-tokens` · `turn-aborted` · `task-blocked` · `storage-error` · `schema-version-unsupported` · `dsh-version-unsupported` · `plugin-disposed` · `unknown`，另加业务码：`contract-not-found` · `contract-revision-conflict` · `criterion-not-found` · `invalid-input` · `export-approval-invalid`。

基础设施错误（storage/版本/卸载）以 reject 或 `storage-error` 呈现，**永不**伪装成业务失败；用户取消不算 verifier 失败；证据缺失不算 criterion fail。

## 3. 开放导出格式：`outcome-loop.export.v1`

JSONL，一行一条记录，稳定键序，可独立解析，可 diff。每行示例（合成数据）：

```json
{
  "schema_version": "outcome-loop.export.v1",
  "record_id": "olc-3f2a…",
  "task": {
    "contract_id": "olc-3f2a…",
    "goal_ref": { "session_id": "session-7", "seq": 12 },
    "goal_digest": "9f2c…",
    "criteria": [
      { "id": "olcr-…", "description": "tests pass", "kind": "test-report",
        "required": true, "severity": "blocking" }
    ]
  },
  "trajectory": {
    "session_id": "session-7",
    "seq_start": 1,
    "seq_end": 120,
    "model_routes": [ { "provider": "deepseek", "model": "deepseek-chat" } ]
  },
  "verification": {
    "status": "passed",
    "criteria": [
      { "criterion_id": "olcr-…", "status": "pass",
        "evidence_count": 1, "stale_count": 0, "conflict": false, "note": null }
    ],
    "label_strength": "strong"
  },
  "user_disposition": { "status": "accepted", "revision": 1, "updated_at": 1720000000000 },
  "cost": { "usage_kind": "exact", "input_tokens": 4200, "output_tokens": 900,
            "total_tokens": 5100, "calls": 4 },
  "privacy": { "content_included": false, "redaction_version": "outcome-loop.redact.v1",
               "license": "private-only" },
  "lineage": { "outcome_loop_version": "0.1.0-beta.1", "dsh_version": "0.1.0-rc.7",
               "config_digest": "1f2e…" }
}
```

### 要求

- schema 显式版本；导入器拒绝未知必需字段语义（zod strict）；
- record id 稳定且不泄露原始路径；
- exact usage 与 estimate 不混合（`usage_kind` 明确）；provider/model 只是 lineage，不是成功因果；
- 不含消息正文、代码正文、绝对路径、credentials、完整命令输出；
- 数据集视图由导出记录派生，不反向修改账本；SFT/DPO/tool-use/router 等训练视图属于后续独立 curator；
- 只有 strong/medium 且无冲突的记录才可能进入训练候选，最终仍需独立治理。
