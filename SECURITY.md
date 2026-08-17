# SECURITY

威胁模型与控制。DSH 仍处于 developer preview，本插件的安全姿态以"最小权限、默认拒绝、失败显式"为原则。

## 1. 威胁模型（spec §14.6）

| 威胁 | 控制 |
| --- | --- |
| 命令输出泄露 secret | 输出上限（`maxCommandOutputBytes`）、确定性脱敏（`redact.ts`）、默认不保存正文 |
| 恶意仓库配置执行命令 | 仓库/workspace 配置**永不**授予权限；active 执行需部署 `autoRun` + 契约策略 + scope + 白名单四重门 |
| 路径穿越或 symlink 逃逸 | `resolveScopedPath()` canonicalize 后验证 target 位于 scope root 内；拒绝 `..`、绝对路径逃逸 |
| session event 重复造成重复样本 | `(sessionId, seq)` high-water 幂等；证据 id 确定性派生 |
| 部分写导致错误聚合 | 权威 record 先写、派生 index 后写、可重建（`repair.ts` 启动修复） |
| telemetry 意外外发 outcome | outcome 存 sidecar；不写敏感 session event |
| 用户点赞被误作任务成功 | feedback 与 verification 独立建模；rating 只是中等强度用户信号 |
| LLM Judge 自我确认 | 本版本无 Judge；未来 Judge 只能产生 weak label，且需预算/字段/opt-in 配置 |
| 证据过期仍显示通过 | workspace epoch + contract revision + verifier version + maxAge 的 freshness 失效 |
| 恶意 export 路径覆盖文件 | 导出内容由调用方写入用户选择路径；本包不写文件系统路径（见 §4） |
| 多进程并发丢写 | 文档披露：只声明单进程保证；未实现 CAS/锁前不宣称多进程安全 |
| 存储格式损坏 | storage-domain 打开时 zod 全量校验（`invalid-record` fail loud）；schema version 不匹配拒绝打开 |

## 2. Active 验证的安全规则（spec §12.3）

只有全部同时满足才允许运行命令：

1. 部署配置 `verification.autoRun: true`；
2. 契约 `verificationPolicy.autoRun: true`；
3. 契约 scope `allowActiveVerification: true`（只能由可信部署设置）；
4. verifier 在契约 `allowedVerifierIds` 白名单内（非空时）；
5. `workspaceRoot` 存在且为绝对路径；
6. 命令来源：用户显式输入（criterion 文本）、管理员可信策略或已批准项目脚本 —— 模型生成命令**不**自动获得信任。

执行方式：

- argv + cwd 调用（`spawn` + 自研 POSIX tokenizer），**绝不** shell 字符串拼接；
- cwd = scope root；目标路径 canonicalize 后验证在 scope 内；
- 环境变量 allowlist（`PATH/HOME/LANG/LC_ALL/TZ/SHELL/USER/LOGNAME`），默认不继承任何 secret 环境变量；
- 强制 timeout + 输出上限 + AbortSignal；
- 默认只读、默认无网络（内置 provider 不发起任何网络请求；沙箱级网络阻断依赖宿主 sandbox，见 §5）；
- 失败保留退出码与受限摘要，不保留含秘密日志；
- 输出先在内存中脱敏再进入 sidecar。

## 3. 路径安全（spec §14.3）

- 用户展示优先 workspace-relative path；
- sidecar 默认保存 relative path 或 digest；
- 解析后验证 target 位于允许 root（`resolveScopedPath` 拒绝 `..`、绝对路径、大小写折叠与 Windows 分隔差异）；
- 不递归扫描 `~`、`/` 或未确认的大目录；不跟随 workspace 外 symlink。

## 4. 导出安全

- 导出内容（JSONL）由调用方（命令消费者/宿主）写入用户选择的路径；本包不持有任意写路径能力；
- approval 绑定 preview digest；内容变化即失效，防止"预览后内容被替换"；
- `secret` 类证据只出计数，不出内容。

## 5. 已知限制与披露

- **网络阻断**：内置 provider 不发起网络请求，但本插件不实现 OS 级网络沙箱；依赖宿主 sandbox 策略时请配合 DSH 的 sandbox 配置使用；
- **多进程**：storage-domain 的单写链只提供单进程内串行化；跨进程并发写不做保证，未实现分布式锁前不宣称多进程安全；
- **bash 类工具的文件写入**：被动观察只对显式写文件工具 bump workspace epoch；任意 bash 内写文件不会被跟踪（证据新鲜度可能因此偏高，误报方向为"可能过期未标"；主动验证可消除该盲区）；
- **命令匹配**：被动 command-exit 匹配基于摘要近似，可能漏匹配 → 结果保守为 `unknown`，不会伪造 pass。

## 6. 报告

安全相关问题请发送至 victorzhong0110@gmail.com，或在本仓库提 issue（请勿包含真实 outcome 数据或凭据）。
