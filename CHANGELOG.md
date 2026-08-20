# CHANGELOG

所有显著变更记录于此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.0-beta.8-keeyahto.1] - 2026-08-20

> Fork pre-release merged on top of upstream `0.1.0-beta.8`. Brings in the
> upstream security/verifier/realpath changes plus our Windows-portability
> fixes (DEP-01). SemVer pre-release tag `-keeyahto.1` sorts after the
> upstream `0.1.0-beta.8` and replaces `-keeyahto.0` if you installed a
> prior dry-run tag. **Upstream-bug fix:** upstream beta.8 left
> `src/index.ts` `VERSION` at `0.1.0-beta.7` while bumping
> `package.json` to `0.1.0-beta.8`; this release synchronizes both to
> `0.1.0-beta.8-keeyahto.1`.

### Fork-specific (carry-over from beta.7-keeyahto.1)

- **Platform-aware workspaceRoot validation (DEP-01, Forge vNext §DEP-01)**:
  `validateScope` in `src/domain/aggregate.ts` previously used POSIX-only
  `startsWith('/')` and rejected every Windows absolute path (`C:\repo`,
  `C:/repo`, `D:\...`). Switched to Node's platform-aware `path.isAbsolute`,
  matching `src/verification/policy.ts:64`. Windows users on rc.7+ no longer
  hit `'workspaceRoot must be an absolute path or empty'` for valid paths.
  **Not fixed upstream yet** even at upstream beta.8, so we keep our patch.

- **Windows-only test portability**: pre-existing tests failed on Windows
  due to platform assumptions.
  - `test/privacy/privacy.test.ts` — `new URL(..., import.meta.url).pathname`
    produced `/D:/...` and `readFileSync` produced double-drive paths.
    Switched to `fileURLToPath` (real native path on every platform).
  - Upstream `0.1.0-beta.8` replaced the primitive itself (now async
    realpath-aware `resolveScopedPath`), so the old POSIX-only unit test
    was superseded by upstream's platform-neutral temp-directory test.
  - No production semantics added or changed in the fork; DEP-01 is
    the only fork-only production patch.

## [0.1.0-beta.8] - 2026-08-20

### Security（第三轮评审：P1 修复）

- **主动验证器不再产生错误的 `pass`**：新增统一基础设施失败门控——命令超时 / 启动失败（`exitCode === null`）/ 输出截断一律判定 `unknown`，绝不进入解析。此前：不存在的 `diagnostic-count` 命令产生 `0 errors / 0 warnings → pass`；非 git 目录中 `git-scope` 把 git 错误输出解析为变更路径并可 `pass`。
  - `git-scope`：`git rev-parse HEAD` 与 `git status --porcelain` 都必须成功退出（exit 0）才解析；任一失败 → `unknown`（`verifier` 未知事实，绝不用空 violations 的 git-scope 事实暗示 pass）；
  - `diagnostic-count`：非零退出且解析不到任何诊断 → `unknown`（工具崩溃）；tsc/eslint 语义保留（非零退出 + 有诊断 → `fail`）；
  - TAP test-report：超时/截断 → `unknown`；非零退出 + 合法 TAP 仍按计数判定。
- **符号链接路径逃逸修复**：新增 `src/verification/paths.ts`——现有目标（读/删/存在性）校验 `realpath(target)` 必须落在 `realpath(workspaceRoot)` 内；新建目标（写）向上回溯最近存在祖先并校验其 realpath。此前 `workspace/link.txt -> /tmp/outside/secret.txt` 可被 `file-digest` 读取并 `pass`。
  - 覆盖：`file-exists` / `file-absent` / `file-digest` / `json-schema` / JUnit `reportPath` / 契约导入（`/outcome import`）/ 导出写入（`export --out`）/ contribute approve（写目录）/ revoke（删目录）；
  - 逃逸 → `unknown`（verifier）/ `invalid-input`（命令），绝不 pass；工作区内部符号链接不受影响。

### Added

- **双语 README**：`README.md`（英文，含运行时图）与 `README.zh.md`（中文镜像）；`files` 清单纳入 `README.zh.md`。
- 覆盖度量不再排除 `src/consumers/**`（AGENTS.md 禁止排除安全关键文件），并设置项目级阈值（statements 80 / branches 68 / functions 80 / lines 80）；CI 新增 `pnpm test:coverage` 强制执行。
- **真实宿主生命周期 E2E（DSH rc.8 实测通过）**：`dsh plugin add` → `--dump-config`（三行注入）→ 真实 `boot()` 全树加载（0 错误，三行 ACTIVE，`outcome_loop` domain 打开）→ 真实 agent + 真实 `/outcome new / criterion add-command / verify / status` 命令 → 新进程 resume 同一 session 重启读取上一进程契约 → 卸载。E2E 同时发现并文档化了 `storageDomain` 前置条件：官方 `dsh-base` bundle 不含 storage 行，裸 profile 安装需补 `@deepseek-ai/dsh-storage-domain` + patch 行（配方见 README/COMPATIBILITY §4）。

### Changed

- 测试 148 → **151**（verifier 门控、git 真实仓库正/反例、符号链接逃逸回归、realpath 边界单元测试）。
- `package.json` 升至 `0.1.0-beta.8`；本 fork 进一步把 `src/index.ts` 的 `VERSION` 与 `package.json` 对齐到 `0.1.0-beta.8-keeyahto.1`（upstream beta.8 内部已经存在版本字符串漂移，本 fork 在发布时修复）。

## [0.1.0-beta.7] - 2026-08-18

### Fixed

- **声明缺失的运行时 peer**（Awesome 收录指南 §peerDependencies）：`@deepseek-ai/schemastery` 被 config/commands/contribute 在运行时 import，此前只存在于 devDependencies——pnpm 严格依赖布局下 `dsh plugin add` 后可能解析失败。现声明为必需 peer（`^3.18.1`）；`@deepseek-ai/dsh-session-persistence` 被公开类型引用，声明为 optional peer。无行为变化。

## [0.1.0-beta.6] - 2026-08-18

### Changed

- **peer ranges 兼容修复**（Awesome 收录要求）：`@deepseek-ai/dsh-session` 与 `@deepseek-ai/dsh-storage-domain` 的 peer range 由 `>=0.0.1-rc.1` 改为 `>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0`——旧范围无法匹配 `0.1.0-rc.7`（预发布语义），新范围同时覆盖已发布的 `0.0.1-rc.x` 与 `0.1.0-rc.x` 系列。无行为变化。

## [0.1.0-beta.5] - 2026-08-18

### Added

- **Skill 候选报告（阶段 7 第 5 项，§21.7.5/§22）**：`/outcome skills [--out <path>]` 从用户自己的账本聚合主题（CJK 二元组 + 英文关键词）、各主题的通过率/失败率、criterion 种类使用计数、常见失败注记与 token 分布；当某主题 ≥2 个通过契约都带有同一验收种类时给出候选建议——**纯展示、人工评估，插件绝不自动应用规则或修改 skill**（§22 禁令有测试断言）。报告可写入 workspace 文件。
- **贡献模式插件（阶段 7 第 6 项，ADR-0005 落地）**：独立消费者 `outcome-loop-contribute`，**不在默认 patch**（用户手动添加行）且 `contribute.enabled` 默认 false（关闭时注册零命令）：
  - `/contribute preview <contract>`：批次预览（记录数、字段、敏感命中、digest、secret 阻断提示）；
  - `/contribute approve <digest> <contract> --out <dir> [--summary-only]`：确定性脱敏门（任何 redaction 命中即阻断整批，`policy-denied`）→ 写入 `manifest.json`（版本化同意记录：范围/许可/保留/补偿/撤回方式/字段清单）+ `records.jsonl`（导出 v1 记录，无消息/代码/凭据）或 `summary.json`（仅聚合）；目录已存在则拒绝；
  - `/contribute revoke <contract> --out <dir> --yes`：撤回 = 删除数据集目录；
  - 无任何上传通道（recipient: user-delivered）；路径 workspace 内、防逃逸。

### Security

- 贡献数据集默认零模型调用、默认无网络；secret 类证据内容被确定性阻断（测试覆盖）；字段清单 = 导出 v1 最小集。

## [0.1.0-beta.4] - 2026-08-18

### Added

- **企业策略（阶段 7 第 2 项，spec §5.2/§11）**：`enterprise` 配置段（`requireCriteria`/`minCriteria`/`mustIncludeKinds`/`allowedVerifierIds`），仅在 `mode: 'enterprise'` 时生效；`createContract`/`reviseContract` 纯函数强制（`enforceEnterprisePolicy`）。策略只存在于部署配置，仓库内容永不授予策略（ADR-0006）。
- **决策校准报告（阶段 7 第 3 项，§15）**：`/outcome calibration [<contract>]` 关联 decision 证据（predictedMatch/predictedEffort/strategy）与实际结果（验证状态、criterion 通过数、token、disposition、标签强度），输出逐条 observation（predicted-and-passed 等）+ 汇总（预测均值、confirmed reuse）。纯描述性、本地、确定性，不驱动路由。
- **成本汇总（阶段 7 第 4 项，§8.6）**：`/outcome cost --summary` 输出多契约聚合（总调用、总 in/out token、out/in 比），作为用户判断任务成本画像的校准数据；不自动路由、不硬编码价格。
- **ADR-0005（贡献插件设计）**：记录贡献模式的独立、默认未安装实现要求（§5.3 全项：主动开启、披露、逐批预览、脱敏阻断、字段选择、摘要模式、同意记录、撤回、零模型调用），排期在 LLM Judge 之前。

### Security

- 企业策略字段全部可选、默认关闭；personal 模式完全不受影响；不允许通过 revise 绕过策略。

## [0.1.0-beta.3] - 2026-08-18

### Added

- **结构化测试报告解析**（阶段 7 第 1 项）：
  - TAP 解析器（`tap.ts`）在事件归一化时从测试命令输出中提取真实计数（passed/failed/skipped/planned），只存计数、不存正文；`test-report` 验收从"退出码代理"升级为结构化计数，`--min-passed/--max-failed` 生效；
  - JUnit XML 解析器（`junit.ts`）；active 验证可读取 workspace 内 `reportPath` 的 JUnit 报告，或运行 `command` 解析其 TAP 输出（四重策略门不变）；
  - `test-report` specification 新增可选 `command` / `reportPath`（向后兼容）。
- **Task Contract 导入/导出**（spec §6 必须项 #2）：版本化文件格式 `outcome-loop.contract.v1`；`/outcome import <path>`（用户显式指向、全字段校验、session 匹配检查、路径防逃逸）、`/outcome export-contract <id> --out <path>`。
- **本地成本报告**（spec §8.6）：默认只报 token 数（exact usage 优先）；`cost.priceTable` 可选配置（每条含 provider/model/currency/单价/effectiveFrom/source，加载时校验）；`/outcome cost` 仅在存在匹配条目时计算货币成本，其余情况明确标注 tokens-only。价格永不硬编码。
- **热路径性能护栏**（spec §13）：5000 事件归一化耗时上限 + per-kind 事实保留上限 + 每事件事实数 ≤ 2 的断言。
- `parseArgs` 支持 `--key value` 消费（beta.2 修复的回归测试补全）。

### Security

- 导入契约文件不自动发现、不隐式信任：必须用户显式 `/outcome import <path>`，路径 workspace 内，逐字段 zod 校验，导入后仍套用保守策略默认值。

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
