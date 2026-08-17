/**
 * `/outcome` human command consumer (spec §5.1, §10, §24 decision #1).
 *
 * Human-triggered, never model-visible: registering a command adds no tool,
 * no prompt section and no per-request context. The command only calls the
 * `ctx.outcomeLoop` service — it holds no domain truth of its own.
 *
 * Subcommands:
 *   /outcome new <goal text>                     — create a contract (explicit goal)
 *   /outcome criterion add <text>                — add a manual criterion
 *   /outcome criterion add-command <cmd> [--expect N]
 *   /outcome criterion add-test [--min-passed N] [--max-failed N]
 *   /outcome criterion add-file <path> [--absent]
 *   /outcome list                                — contracts of this session
 *   /outcome status [<contract>]                 — outcome view
 *   /outcome verify [<contract>]                 — run verification
 *   /outcome accept | reject | revise | abandon [<contract>]
 *   /outcome export [<contract>]                 — two-phase preview+approve
 *   /outcome delete <contract> --yes             — remove sidecar data
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

import type { NewCriterionInput } from '../domain/aggregate.ts'
import type { OutcomeResult } from '../domain/errors.ts'
import type { ContractId } from '../domain/ids.ts'
import type { CriterionSpecification, TaskContract } from '../domain/types.ts'
import type { OutcomeLoopService } from '../service.ts'

export const name = 'outcome-loop-commands'
export const inject = ['commands', 'outcomeLoop']

const USAGE = 'Usage: /outcome <new|criterion|list|status|verify|accept|reject|revise|abandon|export|exports|delete> …'

export interface ParsedArgs {
  positionals: string[]
  options: Map<string, string>
}

export function parseArgs(input: string): ParsedArgs {
  const positionals: string[] = []
  const options = new Map<string, string>()
  const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      if (eq >= 0) {
        options.set(token.slice(2, eq), token.slice(eq + 1).replace(/^["']|["']$/g, ''))
      } else {
        const key = token.slice(2)
        const next = tokens[i + 1]
        // `--key value` (not starting with `--`) consumes the next token.
        if (next !== undefined && !next.startsWith('--')) {
          options.set(key, next.replace(/^["']|["']$/g, ''))
          i += 1
        } else {
          options.set(key, 'true')
        }
      }
    } else {
      positionals.push(token.replace(/^["']|["']$/g, ''))
    }
  }
  return { positionals, options }
}

function contractId(raw: string): ContractId {
  return raw as ContractId
}

function specForCriterion(kind: string, args: ParsedArgs): { description: string; spec: CriterionSpecification } | undefined {
  switch (kind) {
    case 'add-command': {
      const command = args.positionals.join(' ')
      if (command.length === 0) return undefined
      const expect = Number(args.options.get('expect') ?? '0')
      return {
        description: `command exits ${expect}: ${command}`,
        spec: { kind: 'command-exit', command, expectExitCode: Number.isInteger(expect) ? expect : 0 },
      }
    }
    case 'add-test': {
      const minPassed = Number(args.options.get('min-passed') ?? '1')
      const maxFailed = Number(args.options.get('max-failed') ?? '0')
      return {
        description: 'tests pass',
        spec: { kind: 'test-report', framework: 'any', minPassed, maxFailed },
      }
    }
    case 'add-file': {
      const path = args.positionals[0]
      if (path === undefined || path.length === 0) return undefined
      if (args.options.has('absent')) {
        return { description: `file absent: ${path}`, spec: { kind: 'file-absent', path } }
      }
      return { description: `file exists: ${path}`, spec: { kind: 'file-exists', path } }
    }
    case 'add': {
      const text = args.positionals.join(' ')
      if (text.length === 0) return undefined
      return { description: text, spec: { kind: 'manual', prompt: text } }
    }
    default:
      return undefined
  }
}

export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'outcome',
    description: 'task outcome ledger: create contracts, verify acceptance criteria, set disposition, export JSONL',
    input: { hint: '<new|criterion|list|status|verify|accept|reject|revise|abandon|export|delete> …' },
    recordInput: true,
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const service = ctx.outcomeLoop
      const sessionId = invocation.agent.session.id
      const args = parseArgs(invocation.rawInput)
      const command = args.positionals[0]

      try {
        switch (command) {
          case 'new': {
            const goalText = args.positionals.slice(1).join(' ')
            if (goalText.length === 0) {
              return { kind: 'error', text: `Goal text is required. ${USAGE}` }
            }
            const result = await service.createContract({
              sessionId,
              goalText,
              workspaceRoot: invocation.agent.session.header.cwd,
            })
            if (!result.ok) return { kind: 'error', text: formatError(result.error) }
            const criteria = result.value.criteria
            return {
              kind: 'success',
              text: `Contract created: ${result.value.id}\nCriteria: ${criteria.length === 0 ? 'none (add with /outcome criterion add …)' : criteria.map((c, i) => `${i + 1}. ${c.description}`).join('\n')}\nVerify with /outcome verify ${result.value.id}`,
            }
          }
          case 'criterion': {
            const kind = args.positionals[1]
            const built = specForCriterion(kind ?? '', { positionals: args.positionals.slice(2), options: args.options })
            if (built === undefined) {
              return { kind: 'error', text: 'criterion requires add <text> | add-command <cmd> [--expect N] | add-test | add-file <path> [--absent]' }
            }
            const contracts = await service.listContracts({ sessionId, limit: 1 })
            if (!contracts.ok) return { kind: 'error', text: formatError(contracts.error) }
            const contract = contracts.value[0]
            if (contract === undefined) {
              return { kind: 'error', text: 'no contract for this session — create one with /outcome new <goal>' }
            }
            const input: NewCriterionInput = {
              description: built.description,
              kind: built.spec.kind,
              specification: built.spec,
            }
            const result = await service.addCriterion(contract.id, input)
            if (!result.ok) return { kind: 'error', text: formatError(result.error) }
            const index = result.value.criteria.length
            return { kind: 'success', text: `Criterion ${index} added to ${result.value.id}: ${built.description}` }
          }
          case 'list': {
            const result = await service.listContracts({ sessionId })
            if (!result.ok) return { kind: 'error', text: formatError(result.error) }
            if (result.value.length === 0) return { kind: 'success', text: 'No contracts for this session. Create one with /outcome new <goal>' }
            return { kind: 'success', text: result.value.map((c) => `${c.id}  rev ${c.revision}  ${c.criteria.length} criteria  ${goalDigest(c)}`).join('\n') }
          }
          case 'status': {
            const id = contractId(args.positionals[1] ?? '')
            const result = await service.getOutcome(id)
            if (!result.ok) return { kind: 'error', text: formatError(result.error) }
            const view = result.value
            const lines = [
              `Contract: ${view.contract.id} (rev ${view.contract.revision})`,
              `Goal: ${goalDigest(view.contract)}`,
              `Execution: ${view.executionStatus}`,
            ]
            if (view.latestRun !== undefined) {
              lines.push(`Verification: ${view.latestRun.status} (${view.latestRun.labelStrength})`)
              for (const r of view.latestRun.results) {
                lines.push(`  ${r.status.padEnd(14)} ${criterionLabel(view.contract, r.criterionId)}${r.conflict ? ' [conflict]' : ''}${r.note ? ` — ${r.note}` : ''}`)
              }
            } else {
              lines.push('Verification: not-run (use /outcome verify)')
            }
            lines.push(`Disposition: ${view.disposition?.status ?? 'none'}`)
            return { kind: 'success', text: lines.join('\n') }
          }
          case 'verify': {
            const contracts = await resolveContracts(service, sessionId, args.positionals[1])
            if (!contracts.ok) return { kind: 'error', text: formatError(contracts.error) }
            const out: string[] = []
            for (const contract of contracts.value) {
              const result = await service.verify({ contractId: contract.id })
              if (!result.ok) return { kind: 'error', text: formatError(result.error) }
              out.push(`${contract.id}: ${result.value.status} (${result.value.labelStrength})`)
            }
            return { kind: 'success', text: out.join('\n') }
          }
          case 'accept':
          case 'reject':
          case 'revise':
          case 'abandon': {
            const statusMap: Record<string, 'accepted' | 'rejected' | 'revised' | 'abandoned'> = {
              accept: 'accepted',
              reject: 'rejected',
              revise: 'revised',
              abandon: 'abandoned',
            }
            const contracts = await resolveContracts(service, sessionId, args.positionals[1])
            if (!contracts.ok) return { kind: 'error', text: formatError(contracts.error) }
            const out: string[] = []
            for (const contract of contracts.value) {
              const result = await service.setDisposition({ contractId: contract.id, status: statusMap[command] as never })
              if (!result.ok) return { kind: 'error', text: formatError(result.error) }
              out.push(`${contract.id}: disposition = ${result.value.status}`)
            }
            return { kind: 'success', text: out.join('\n') }
          }
          case 'export': {
            const approveDigest = args.options.get('approve')
            const contracts = await resolveContracts(service, sessionId, args.positionals[1])
            if (!contracts.ok) return { kind: 'error', text: formatError(contracts.error) }
            const out: string[] = []
            for (const contract of contracts.value) {
              if (approveDigest !== undefined && approveDigest !== 'true') {
                // Phase 2: approve the preview digest and write the JSONL file.
                const outPath = args.options.get('out')
                if (outPath === undefined) {
                  return { kind: 'error', text: 'export --approve requires --out <path> to write the JSONL file' }
                }
                const result = await service.exportJsonl({ contractId: contract.id, previewDigest: approveDigest })
                if (!result.ok) return { kind: 'error', text: formatError(result.error) }
                const write = await writeExportFile(invocation, outPath, result.value.content, args.options.has('overwrite'))
                if (!write.ok) return { kind: 'error', text: formatError(write.error) }
                out.push(
                  `Export approved: ${result.value.manifest.id}`,
                  `Written: ${write.value} (${Buffer.byteLength(result.value.content)} bytes, digest ${result.value.manifest.contentDigest.slice(0, 16)}…)`,
                )
              } else {
                // Phase 1: preview with a digest to approve later.
                const preview = await service.previewExport({ contractId: contract.id })
                if (!preview.ok) return { kind: 'error', text: formatError(preview.error) }
                out.push(
                  `${contract.id}: ${preview.value.recordCount} record(s), digest ${preview.value.previewDigest}`,
                  `fields: ${preview.value.fieldManifest.join(', ')}`,
                  ...(preview.value.warnings.length > 0 ? [`warnings: ${preview.value.warnings.join('; ')}`] : []),
                  `approve with: /outcome export ${contract.id} --approve ${preview.value.previewDigest} --out <path>`,
                )
              }
            }
            return { kind: 'success', text: out.join('\n') }
          }
          case 'exports': {
            const contracts = await resolveContracts(service, sessionId, args.positionals[1])
            if (!contracts.ok) return { kind: 'error', text: formatError(contracts.error) }
            const out: string[] = []
            for (const contract of contracts.value) {
              const exports = await service.listExports(contract.id)
              if (!exports.ok) return { kind: 'error', text: formatError(exports.error) }
              if (exports.value.length === 0) {
                out.push(`${contract.id}: no exports yet (run /outcome export)`)
              } else {
                for (const manifest of exports.value) {
                  out.push(`${contract.id}: ${manifest.id}  ${manifest.recordCount} record(s)  ${manifest.contentDigest.slice(0, 16)}…`)
                }
              }
            }
            return { kind: 'success', text: out.join('\n') }
          }
          case 'delete': {
            const id = contractId(args.positionals[1] ?? '')
            if (!args.options.has('yes')) {
              return { kind: 'error', text: 'delete requires --yes; it removes ALL sidecar data for this contract (the session log is never touched)' }
            }
            const result = await service.deleteOutcome({ contractId: id, confirmed: true })
            if (!result.ok) return { kind: 'error', text: formatError(result.error) }
            const d = result.value.deleted
            return { kind: 'success', text: `Deleted sidecar data: ${d.contracts} contract, ${d.evidence} evidence, ${d.runs} runs, ${d.dispositions} dispositions, ${d.cursors} cursors, ${d.exports} exports. Session log untouched.` }
          }
          default:
            return { kind: 'error', text: USAGE }
        }
      } catch (error) {
        return { kind: 'error', text: `outcome-loop: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })
}

/**
 * Write the approved export content to a user-chosen path (spec §14.3, §14.5):
 * - path must be workspace-relative and must not escape the workspace;
 * - write is atomic (temp file + rename);
 * - an existing target requires an explicit --overwrite flag.
 */
async function writeExportFile(
  invocation: { agent: { session: { header: { cwd?: string } } } },
  outPath: string,
  content: string,
  overwrite: boolean,
): Promise<OutcomeResult<string>> {
  const cwd = invocation.agent.session.header.cwd
  if (cwd === undefined) {
    return { ok: false, error: { code: 'invalid-input', message: 'this session has no workspace root (cwd) to write into' } }
  }
  const { isAbsolute, resolve, relative, dirname } = await import('node:path')
  if (isAbsolute(outPath)) {
    return { ok: false, error: { code: 'invalid-input', message: 'export path must be workspace-relative' } }
  }
  const target = resolve(cwd, outPath)
  const rel = relative(cwd, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: { code: 'invalid-input', message: `export path '${outPath}' escapes the workspace` } }
  }
  const { access, rename, writeFile, mkdir } = await import('node:fs/promises')
  if (!overwrite) {
    try {
      await access(target)
      return { ok: false, error: { code: 'permission-denied', message: `'${outPath}' already exists — pass --overwrite to replace it` } }
    } catch {
      // absent: proceed
    }
  }
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, target)
  } catch (error) {
    const { rm } = await import('node:fs/promises')
    await rm(tmp, { force: true })
    return { ok: false, error: { code: 'storage-error', message: `failed to write export: ${error instanceof Error ? error.message : String(error)}` } }
  }
  return { ok: true, value: target }
}

async function resolveContracts(
  service: OutcomeLoopService,
  sessionId: string,
  raw: string | undefined,
): Promise<OutcomeResult<readonly TaskContract[]>> {
  if (raw !== undefined && raw.length > 0) {
    const contract = await service.getContract(contractId(raw))
    if (!contract.ok) return contract
    return { ok: true, value: [contract.value] }
  }
  return service.listContracts({ sessionId, limit: 20 })
}

function goalDigest(contract: { goal: { kind: string; ref?: { sessionId: string; seq: number }; text?: string } }): string {
  if (contract.goal.kind === 'reference' && contract.goal.ref !== undefined) {
    return `goal@seq ${contract.goal.ref.seq}`
  }
  const text = contract.goal.text ?? ''
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

function criterionLabel(contract: { criteria: readonly { id: string; description: string }[] }, id: string): string {
  const criterion = contract.criteria.find((c) => c.id === id)
  return criterion?.description ?? id
}

function formatError(error: { code: string; message: string }): string {
  return `outcome-loop [${error.code}]: ${error.message}`
}
