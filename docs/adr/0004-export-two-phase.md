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

- 1：预览后内容可能变化，批准无锚点，无法审计。

## 影响

- 隐私/token：零模型成本；secret 类证据只出计数；
- 迁移：导出记录 schema 版本化，导入器拒绝未知必需字段语义；
- 测试：digest 稳定性、批准失效、路径逃逸拒绝、覆盖保护；
- 回滚：移除 `exportJsonl` 的 digest 校验即回到单阶段（不推荐）。
