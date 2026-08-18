# ADR-0006: 企业策略只存在于部署配置，仓库内容永不授予策略

**状态**：已接受（2026-08-18，v0.1.0-beta.4 实现）｜**范围**：spec §5.2、§11、§24 决策 #10（保守默认）

## 问题

企业模式的强制策略（必需验收项、verifier 白名单、保留期）放在哪里？仓库内策略文件由不可信代码提交者控制，不能自动信任；签名机制超出 MVP。

## 候选

1. workspace 内策略文件（`.outcome-loop/policy.json`）；
2. 部署配置（`cordis.yml` / DSH user settings 的可信子集）；
3. 签名策略文件（需要密钥分发与验证基础设施）。

## 选择

**2**。`enterprise` 配置段（`requireCriteria` / `minCriteria` / `mustIncludeKinds` / `allowedVerifierIds`），仅在 `mode: 'enterprise'` 时生效，在 `createContract`/`reviseContract` 处纯函数强制（`enforceEnterprisePolicy`）。仓库/workspace 内容**永不**被读取为策略（与 active 验证的信任模型一致：项目配置不授予权限）。

## 拒绝理由

- 1：不可信内容自动获得强制力，违反 §11；
- 3：签名机制需要密钥轮换/吊销/审计，§24 #10 未决策前不做；未来可作为可选增强（策略文件 + 部署配置里的公钥指纹）。

## 影响

- 隐私/token：零模型成本；企业模式不记录更多原始内容；
- 迁移：策略字段全部可选、默认关闭，personal 模式完全不受影响；
- 测试：enterprise 强制在 create/revise 的拒绝路径；
- 回滚：`mode` 回到 `personal` 即全部解除。
