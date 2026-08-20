# COMPATIBILITY

## 1. 验证基线（2026-08-20 核对）

| 项目 | 值 |
| --- | --- |
| DeepSeek Harness | `0.1.0-rc.8`（官方 master 根包 / npm `next`）真实宿主 E2E 验证；`0.1.0-rc.7` 基线保持兼容 |
| @deepseek-ai/cordis | `4.0.1` |
| Node | `^22.19.0 \|\| >=24.0.0`（开发/验证于 Node 22.22.3） |
| pnpm | `11.21.0`（`packageManager` 锁定） |
| 模块系统 | ESM（`"type": "module"`），NodeNext 解析，`.js` 扩展名重写 |
| 测试 | Vitest 3（151 单元/集成/隐私/冒烟；覆盖率阈值在 CI 强制执行） |

## 2. 依赖的 DSH 公共能力（均来自官方公开 exports，无私有路径）

| 能力 | 包 | 使用方式 |
| --- | --- | --- |
| `ctx.storageDomain` | `@deepseek-ai/dsh-storage-domain` | 必需 `inject`；`defineDomain` + zod 记录校验 |
| `session/event` 事件总线 | `@deepseek-ai/cordis` | `ctx.on('session/event', (session, event) => …)` |
| durable session events | `@deepseek-ai/dsh-session` | `turn/*`、`step/*`、`tool/*`、`user/message`、`assistant/message`、`request/context`、`feedback/record` |
| `ctx.sessions`（重放） | `@deepseek-ai/dsh-session` | `get/list` + `session/created`（resume/fork 填充） |
| 可选：`ctx.sessionPersistence` | `@deepseek-ai/dsh-session-persistence` | `inspect()` 冷读（best-effort） |
| 可选：`ctx.tokenMeter` | `@deepseek-ai/dsh-token-meter` | 预留估计路径（当前只用 durable usage facts） |
| 可选：`ctx.messageFeedback` | `@deepseek-ai/dsh-message-feedback` | rating 计数桥 |
| 可选：`ctx.sessionProjections` | `@deepseek-ai/dsh-session-projection` | projection consumer（headless 安全） |
| 可选：`ctx.commands` | `@deepseek-ai/dsh-commands` | `/outcome` 命令 consumer；`/contribute` 贡献 consumer（默认未安装） |

所有可选服务通过 `ctx.get()` 探测；缺失时核心功能照常工作。必需服务缺失时插件保持 pending（Cordis `inject` 语义）。

## 3. 兼容矩阵

| DSH 版本 | 状态 |
| --- | --- |
| `0.1.0-rc.8`（npm `next`，2026-08-20 实测） | ✅ 真实宿主 E2E 通过（见 §4） |
| `0.1.0-rc.7`（基线） | ✅ 已开发验证（类型级 + 集成测试 + plain Node import 冒烟） |
| `0.0.1-rc.x` | ❌ 未验证；不宣称兼容 |
| 未来版本 | 未知；升级前必须重跑测试矩阵与安装冒烟 |

**不根据对象"似乎有某个方法"静默猜测版本**：`dsh/compatibility.ts` 对事件信封与 `sessions` 服务做显式形状检查，不满足即 fail loud（`dsh-version-unsupported` 语义），绝不静默降级。禁止深度导入任何 DSH 包的 `src/`、`lib/internal/` 或未导出实现。

## 4. 安装冒烟与真实宿主 E2E（发布前必须执行）

1. `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage`；
2. `pnpm build`；
3. `node test/smoke/import-smoke.mjs`（plain Node 导入 lib/ 入口）；
4. `pnpm pack` 并解包验证 `files` 内容（lib/、cordis.patch.yml、文档、LICENSE）；
5. **真实宿主生命周期 E2E（2026-08-20，DSH rc.8 实测通过）**：
   - `dsh plugin --profile <p> add <tarball>` → `--dump-config`（三个插件行注入）；
   - 启动（`boot()` 全树加载，0 错误）：`outcome-loop` / `outcome-loop-commands` / `outcome-loop-projection` 全部 ACTIVE，`ctx.outcomeLoop` 可用，`outcome_loop` storage domain 打开；
   - 真实 agent + 真实命令：`/outcome new` → 契约创建；`/outcome criterion add-command` → 验收标准添加；`/outcome verify` → `inconclusive (unknown)`（命令验收受政策门控，未被观察到的命令绝不伪造 pass）；`/outcome status` 完整双轴视图；
   - 重启读取：新进程 `agents.resume` 同一持久化 session → 上一进程写入的契约可读、状态完整；
   - 卸载：`dsh plugin --profile <p> remove dsh-outcome-loop` → profile 清理。

### 前置条件（真实宿主发现，beta.8 文档化）

`ctx.storageDomain` 是必需服务，但 DSH 官方 **`dsh-base` bundle 不含 storage 行**（只有 `@deepseek-ai/dsh-web-app` 等上层 bundle 提供）。在只含 `dsh-base` 的 profile（如新建的 headless profile）上安装本插件会因 `storageDomain` 缺失而启动失败（fail loud，`waiting for service: storageDomain`）。修复配方：

```bash
dsh plugin --profile <name> add @deepseek-ai/dsh-storage-domain@0.1.0-rc.8   # 依赖包
# 编辑 ~/.dsh/profiles/<name>/cordis.patch.yml，追加：
# - insert:
#     - id: storage
#       name: "@deepseek-ai/dsh-storage"
#     - id: storage-json
#       name: "@deepseek-ai/dsh-storage-json"
#       config:
#         root: !!js dshHomePath("storages")
#     - id: storage-domain
#       name: "@deepseek-ai/dsh-storage-domain"
#       config:
#         backend: json
```

`web` profile 自带 storage 行，无需此步骤。CI 覆盖 1–4；第 5 步需要安装 dsh CLI 的环境。

## 5. 已知的 API 演变风险点

- `SessionEventMap` 是 merge-extensible union：遇到未知事件类型时插件记录 `unknown` fact 并继续（spec：不允许因 unknown event 崩溃）；
- `turn/end.reason` 是 merge-extensible map：未知 reasonKind 归入 `ended` 执行状态并保留原始字符串；
- 本插件不依赖任何 `turn-stopping`/`before-stop` 类钩子（不存在或未验证的能力不做硬依赖）。

## 6. 数据格式兼容

- sidecar domain v1：schema version 变化需要迁移/拒绝策略（当前 fail loud）；
- 导出 `outcome-loop.export.v1`：枚举新增遵循兼容策略，导入器拒绝未知必需字段语义；
- `evidenceLabelStrength` 等解释层可随版本重新计算；事实层（events/evidence）保持可重放。
