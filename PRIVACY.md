# PRIVACY

`dsh-outcome-loop` 的隐私承诺与默认硬门槛。用户支付 token 是为了完成自己的任务，不是为了免费替模型厂商生产训练数据；任何新增消耗都必须带来用户可感知、可测量的收益。

## 1. 默认模式硬门槛（测试在 `test/privacy/` 强制执行）

| 门槛 | 默认值 | 验证 |
| --- | --- | --- |
| 额外 LLM 调用 | **0** | 结构性扫描：bundle 不 import `dsh-llm` 等 |
| 模型可见工具 | **0** | 核心插件不注册任何 model tool |
| system prompt 字节增量 | **0** | 无 prompt section 贡献 |
| 网络请求 | **0** | 不 import `node:http(s)/net/dgram/tls`，无 fetch |
| session log 写入 | **0** | service/observer 从不调用 `session.append` |
| 原始内容复制 | **0** | 事件归一化只产生 digest/计数/seq/退出码 |
| 模型价格表 | **无** | 永不硬编码价格；货币成本永不计算 |

配置中任何试图打开这些门的组合都会在插件加载时 `validateConfig` 直接抛错（`rawMessages/rawToolArguments/rawToolResults`、`llmJudge != disabled`、`privacy.network != disabled`）。

## 2. 数据最小化（spec §14.1）

默认**只**保存完成结果判断所需的最少字段。禁止默认保存：

- 完整用户 prompt、完整 assistant response、完整 tool arguments/result；
- 源代码正文、终端完整输出、`.env` 内容；
- access token、cookie、authorization header；
- 用户 home 的绝对路径（导出时替换为 `~`，sidecar 内用 relative path 或 digest）；
- 第三方个人信息、未经选择的附件内容。

优先保存 `sessionId + event.seq + messageId/callId` 引用、计数、状态、摘要与 digest。唯一例外：explicit goal 文本（用户主动通过命令输入的目标）以 `ExplicitGoal` 形式保存在契约中，但**永不进入导出**（导出只带 `goal_digest`）。

## 3. 敏感信息分类（spec §14.2）

`public` / `internal` / `confidential` / `secret` / `personal-data` / `unknown-sensitive`。未知内容默认按敏感处理。`secret` 永不进入导出正文，只显示命中类型与位置计数。

证据事实的默认分类（`src/export/redact.ts`）：

| 事实 | 分类 |
| --- | --- |
| command / file-state | `confidential` |
| user-confirmation | `personal-data` |
| turn / usage | `public` |
| test-report / git-scope / diagnostic-count / feedback / tool-outcome / verifier | `internal` |

## 4. 导出（spec §14.5）

两阶段显式操作：

1. `previewExport`：计算候选记录、字段清单、敏感命中、脱敏变化、许可与内容 digest；
2. 用户批准该 digest 后 `exportJsonl` 生成确定版本；预览后内容变化 → 批准失效（`export-approval-invalid`）。

导出默认：不含消息正文、不含代码正文、不含绝对路径、不含 credentials、不含完整命令输出、不含弱标签伪装的 success；带 schema version、插件版本、DSH 版本、脱敏版本与许可；每行可独立解析；稳定排序可 diff。

## 5. 拒绝与删除

- 拒绝导出/拒绝分享不损失核心功能；
- `/outcome delete <id> --yes` 删除该契约的全部 sidecar 数据（契约、证据、验证运行、disposition、cursor、export manifest）；
- 删除**永不**声称删除 DSH canonical session log（receipt 显式声明 `sessionLogUntouched: true`）；
- 所有数据可以迁移到其他模型或 Harness（开放 JSONL 格式 + 厂商中立 lineage）。

## 6. 反馈数据（spec §8.5）

- 任务 outcome 与消息 rating 是不同概念；本插件只保存 `feedback/record` 的 digest 与 seq，以及可选 message-feedback 服务的 rating **计数**（不复制 note）；
- 不改变 DSH 原有分享披露；不把用户未授权的 message feedback 转成训练贡献。

## 7. 遥测（spec §8.8）

`sessionTelemetry` 是出站报告能力，不是本项目的本地账本。核心插件不依赖、不自动启用它；outcome sidecar 永不自动发送；不向 session log 添加敏感 outcome payload。
