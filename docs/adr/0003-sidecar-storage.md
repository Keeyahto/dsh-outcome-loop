# ADR-0003: Outcome 数据存独立 sidecar domain，永不写入 session log

**状态**：已接受（2026-08-18）｜**范围**：spec §8.4、§14.6

## 问题

任务结果、证据摘要、用户 disposition 存在哪里？写入 session log 会被 telemetry 镜像并进入模型相关数据面。

## 候选

1. 写入 session log（最小指针事件）；
2. 独立 storage domain sidecar（`outcome_loop`）；
3. 两者混合。

## 选择

**2**。domain `outcome_loop` v1，六张表（contracts / evidence / verification_runs / dispositions / session_cursors / exports），权威记录先写、派生 index 后写、可重建、启动修复。本插件不向 session log append 任何内容。

## 拒绝理由

- 1：outcome 含可删除、可修订的用户 disposition 与导出资格；证据摘要可能敏感，不应自动进入 session telemetry；任务级聚合不是模型历史的一部分；
- 3：复杂化且仍违反最小外发原则。

## 影响

- 隐私/token：outcome 永不进入模型上下文与 telemetry；删除独立于会话历史；
- 迁移：sidecar 可随 storage backend 迁移；格式版本不匹配 fail loud；
- 测试：`test/privacy` 结构性断言（无 `.append(`）；集成测试覆盖重启恢复与删除。
