# ADR-0002: Active 验证默认关闭 + 四重策略门

**状态**：已接受（2026-08-18）｜**范围**：spec §12.3、§24 决策 #2

## 问题

MVP 是否包含主动执行验证命令的能力？如何防止恶意仓库配置或模型生成的命令获得执行权限？

## 候选

1. 完全不实现 active verifier；
2. 实现但默认关闭，需部署 + 契约 + scope + 白名单四重门；
3. 实现且默认开启（按需审批）。

## 选择

**2**。`decideActiveRun()` 是唯一决策点：部署 `verification.autoRun` ∧ 契约 `verificationPolicy.autoRun` ∧ scope `allowActiveVerification` ∧（白名单为空或包含该 verifier）∧ 绝对 workspaceRoot，全部满足才执行。执行方式：argv+cwd spawn（无 shell 拼接）、env allowlist、timeout、output cap、AbortSignal、默认只读、默认无网络。

## 拒绝理由

- 1：file-*/git-scope 等 criterion 将永远无法机械验证，削弱产品价值；
- 3：默认开启违反"最小权限、默认拒绝"；模型生成的命令不应自动获得信任。

## 影响

- 隐私/token：默认零执行；开启后每次 active run 是一次确定性命令执行（非模型调用）；
- 迁移：无；测试：`decideActiveRun` 全分支 + active verifier 单元/集成测试；
- 回滚：把 `deploymentAutoRun` 置回 false。
