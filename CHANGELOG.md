# CHANGELOG

所有显著变更记录于此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.0-beta.2] - 2026-08-18

### Added

- **导出落盘**：`/outcome export <contract> --approve <digest> --out <path> [--overwrite]` 将批准的 JSONL 原子写入（临时文件 + rename）；路径必须 workspace-relative 且不得逃逸；覆盖需显式 `--overwrite`；新增 `/outcome exports` 列出导出 manifest。
- **冷会话回放**：验证时若契约 session 无事实日志且存在可选 `sessionPersistence` 服务，先 best-effort 回放权威日志再验证（spec §8.3 规则 5）；无该服务时保守 `unknown`。
- **保留策略（enterprise-lite）**：`retention.evidenceMaxAgeMs` 配置（默认 0 = 永不过期），启动修复时按窗口裁剪过期证据，契约等权威记录永不触碰。
- **dsh-code-reference 决策证据桥（§15）**：新增 `decision` 证据类型与 `recordDecisionEvidence()` API（source/decisionId/strategy/predictedMatch/predictedEffort/policyDigest），供 code-reference 或桥接插件提交 PriorDecisionEvidence；分类 internal，永不参与验证判定。
- **ADR 文档**：`docs/adr/0001–0004`（契约入口 / active 验证门 / sidecar 存储 / 两阶段导出）。
- 新增测试：命令消费者集成（含原子写、覆盖保护、路径逃逸）、冷回放（有/无 persistence）、projection 单元、保留裁剪、decision 证据。

### Fixed

- `parseArgs` 现正确消费 `--key value` 形式（此前 `--approve <digest>` 的值会落入 positionals）；
- `/outcome criterion add-command` 不再把子命令词混入命令文本。

## [0.1.0-beta.1] - 2026-08-18

首个 beta：MVP 全部阶段（0–6）落地。

### Added

- **阶段 0 基础工程**：TypeScript strict + ESM + NodeNext + pnpm + Vitest + ESLint；`dsh.bundle` manifest（`cordis.patch.yml`）；plain Node import 冒烟。
- **阶段 1 纯领域模型**：branded ids、Task Contract、criteria/evidence/result、聚合规则（spec §7.4 规则 1–9）、freshness、failure taxonomy、export v1 schema。
- **阶段 2 被动 session observer**：`session/event` 热路径归一化（常数大小、零正文复制）、snapshot-fill 重放（live store + `session/created` + 可选 `sessionPersistence.inspect`）、`(sessionId, seq)` 幂等。
- **阶段 3 本地 sidecar**：`outcome_loop` domain v1（contracts/evidence/verification_runs/dispositions/session_cursors/exports）、CAS revision、可重建派生索引 + 启动修复、删除与重启一致性。
- **阶段 4 确定性验证**：被动适配器（command-exit/test-report/file-*/git-scope/diagnostic-count/manual）、workspace epoch + revision + verifier version + maxAge 新鲜度、冲突 → inconclusive、active verifier（默认关闭，四重策略门）。
- **阶段 5 反馈与成本桥接**：`feedback/record` digest 事实、可选 message-feedback rating 计数、durable usage 聚合（exact only，无价格表）。
- **阶段 6 查询、导出与 bundle**：`/outcome` 命令（new/criterion/list/status/verify/accept/reject/revise/abandon/export/delete）、两阶段导出（preview digest 绑定批准）、可选 Web projection consumer、pack + 安装冒烟脚本。
- 文档：README / ARCHITECTURE / PRIVACY / SECURITY / DATA_FORMAT / COMPATIBILITY；AGENTS.md 全局指导。

### Security

- 默认零模型调用、零网络、零主动命令、零原始内容复制（`test/privacy` 结构性回归测试强制执行）；
- active 验证仅在所有策略门（部署/契约/scope/白名单/绝对 root）打开时运行；argv+cwd、env allowlist、timeout、output cap、AbortSignal、默认只读。

### Fixed

- 事件归一化正确解包 `tool-result` 文本块以提取 `[exit code: N]`；
- `git status --porcelain` 解析保留状态列（trim 只去尾部空白）；
- 诊断计数避免把列号误判为错误数。

### Known limitations

见 [ARCHITECTURE.md](ARCHITECTURE.md) §6：被动命令匹配近似、bash 内写入不跟踪、冷 session 无 persistence 时事实不可重建、单进程并发保证。
