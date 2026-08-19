# DEP-02A0 audit — `dsh-outcome-loop` packaging

**Date:** 2026-08-19  
**Scope:** Verify whether `dsh-outcome-loop` exhibits the same
plugin-packaging / host-dependency-identity bug that affected
`dsh-git-worktree@0.3.2` (core DSH packages declared as ordinary
`dependencies` instead of `peerDependencies`, causing a second runtime
graph of DSH core in the profile's `node_modules` and breaking
`ctx.tools[SCHEDULER_SYMBOL]` lookup because the symbol identity differs
between the two copies).

**Conclusion:** **No fix needed in this fork.** `dsh-outcome-loop` is
structurally correct — production install will not materialize a
second copy of DSH core in the profile.

## Audit method

For every `@deepseek-ai/*` and `@deepseek-ai/schemastery` reference in
`src/`, classify it as:

1. **Runtime import** (`import { x } from ...` or `import x from ...`
   in `.ts` source that survives into `lib/` build output).
2. **Type-only import** (`import type { x } from ...` — erased at build
   time, never produces a runtime `require`).
3. **Ambient declaration** (`declare module ...` — type-only).

Then check that every runtime-imported package is in `peerDependencies`,
and that nothing core-DSH appears in ordinary `dependencies`.

## Inventory

| Package | In `dependencies`? | In `peerDependencies`? | Runtime uses in `src/` | Verdict |
| --- | --- | --- | --- | --- |
| `@deepseek-ai/cordis` | no | yes (required) | type-only | OK |
| `@deepseek-ai/dsh-session` | no | yes (optional) | type-only + ambient declare | OK |
| `@deepseek-ai/dsh-storage-domain` | no | yes (optional) | **runtime** in `src/persistence/schema.ts:17` (`defineDomain`, `domainTable`) | OK |
| `@deepseek-ai/schemastery` | no | yes (required) | type-only | OK |
| `@deepseek-ai/dsh-session-persistence` | no | yes (optional) | type-only | OK |
| `@deepseek-ai/dsh-commands` | no | no | type-only in `src/consumers/commands.ts:23` and `src/consumers/contribute.ts:19` | OK (devDependency only) |
| `@deepseek-ai/dsh-llm` | no | no | none | OK (devDependency only) |
| `@deepseek-ai/dsh-message-feedback` | no | no | none | OK (devDependency only) |
| `@deepseek-ai/dsh-session-projection` | no | no | ambient declare in `src/consumers/projection.ts:15` (`declare module '@deepseek-ai/dsh-session-projection/types'`) | OK (devDependency only) |
| `@deepseek-ai/dsh-storage` | no | no | none | OK (devDependency only) |
| `@deepseek-ai/dsh-storage-json` | no | no | none | OK (devDependency only) |
| `@deepseek-ai/dsh-token-meter` | no | no | none | OK (devDependency only) |

`dependencies` block holds only `ajv` (`^8.20.0`) and `zod` (`^4.4.3`) —
no DSH core.

`devDependencies` blocks the 12 DSH-related packages above. These are
required for `pnpm typecheck` and `pnpm test` in this fork's own CI but
**do not propagate** into a `dsh plugin add`-driven install of the
published package (pnpm production installs skip `devDependencies`).

## Why this matters

The original `dsh-git-worktree@0.3.2` failure mode (the user's
`Cannot read properties of undefined (reading 'prepare')` from
`ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(...)`) was caused by
**two distinct copies** of `@deepseek-ai/dsh-tools` ending up in the
profile's `node_modules`, each carrying its own
`Symbol('@deepseek-ai/dsh-tools.scheduler')` identity. The fix is to
keep DSH core as `peerDependencies` so it resolves to the host's
single copy.

`dsh-outcome-loop` already follows that pattern. No code or
`package.json` change is needed in this fork for DEP-02A0.

## Where DEP-02A0 actually needs to land

In `dsh-git-worktree`, which the user has not forked into this
repository. The fix there is the same shape: move core DSH packages
out of `dependencies` and into `peerDependencies`. That work is
out of scope for this commit.
